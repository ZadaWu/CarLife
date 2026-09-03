/**
 * 车辆成员授权端点（施工单 M48-03，FL-55 F-55-03）。
 *
 * `GET    /v1/vehicles/:vin/grants`          这辆车当前有哪些成员（含车主）
 * `POST   /v1/vehicles/:vin/grants`          按 username 添加 driver / passenger
 * `DELETE /v1/vehicles/:vin/grants/:userId`  移除（软删，下一次请求即失效）
 *
 * # 与「常用人员」端点（`vehicle-member.ts`）是两条路，不要合并
 *
 * 那边管的是**影子成员档案**（车上常有谁，可以没有账号，FL-46）；
 * 这边管的是**使用授权**（谁能登录用这辆车，必须有账号）。
 * 两者生命周期独立：删档案不撤授权、撤授权不删档案（AC-55-6），
 * 所以端上也是两块 UI 两组端点——合并成一个"成员管理"会让用户以为删掉一个
 * 就两边都没了。
 *
 * # 名单里只出现账号自设的 displayName
 *
 * **绝不 join `vehicle_members.display_name`**——那是车主给家人起的叫法（"妈"），
 * 属他人 PII（FL-46 F-46-13），而这份名单车上任何成员都看得见（上车声明要用它）。
 */

import { Router, json, type Response } from "express";

import type { UserRepository, VehicleGrantRepository } from "@carlife/db";
import { GrantAlreadyActiveError, OwnerCannotBeGrantedError } from "@carlife/db";
import type { GrantableRole, VehicleMemberAccount } from "@carlife/shared";
import { isGrantableRole } from "@carlife/shared";

import {
  isBoundCockpit,
  requireVehicleMember,
  requireVehicleOwner,
  type VehicleRoleRequest,
} from "../auth/vehicle-role";

export interface VehicleGrantRouterDeps {
  grants: VehicleGrantRepository;
  users: Pick<UserRepository, "findByUsername" | "publicByIds">;
  /** 取车主 id——所有权在车表，不在授权表（设计裁决 R1）。 */
  ownerOf(vin: string): Promise<string | null>;
}

export function createVehicleGrantRouter(deps: VehicleGrantRouterDeps): Router {
  const router = Router();

  /**
   * 成员名单。**成员都能看**——上车声明要用它选人（M48-05）。
   *
   * 绑到这辆车的**车机**也能看（M52-01）：它此刻还没有"人"，而选人正是它要做的事。
   * 判据与理由见 `auth/vehicle-role.ts` 的 `isBoundCockpit`——只放行这一个读，
   * 不等于把车机当成员。
   */
  router.get("/v1/vehicles/:vin/grants", async (req: VehicleRoleRequest, res: Response) => {
    const vin = String(req.params.vin);
    if (!isBoundCockpit(req, vin) && !(await requireVehicleMember(deps.grants, req, res, vin)))
      return;

    const ownerId = await deps.ownerOf(vin);
    const active = await deps.grants.listActiveByVin(vin);
    const ids = [...(ownerId ? [ownerId] : []), ...active.map((g) => g.userId)];
    const profiles = await deps.users.publicByIds(ids);

    const members: VehicleMemberAccount[] = [];
    if (ownerId) {
      members.push({
        userId: ownerId,
        displayName: profiles.get(ownerId)?.displayName,
        role: "owner",
      });
    }
    for (const g of active) {
      members.push({
        userId: g.userId,
        displayName: profiles.get(g.userId)?.displayName,
        role: g.role,
      });
    }
    res.json({ members });
  });

  /** 添加成员。owner-only。 */
  router.post(
    "/v1/vehicles/:vin/grants",
    json(),
    async (req: VehicleRoleRequest, res: Response) => {
      const vin = String(req.params.vin);
      if (!(await requireVehicleOwner(deps.grants, req, res, vin))) return;

      const { username, role } = (req.body ?? {}) as { username?: unknown; role?: unknown };
      if (typeof username !== "string" || !username.trim()) {
        res.status(400).json({ error: "invalid_username" });
        return;
      }
      if (!isGrantableRole(role)) {
        // owner 不在可授予集合里：车主是 vehicles.owner_id 的事（R1），不经这里。
        res.status(400).json({ error: "invalid_role", allowed: ["driver", "passenger"] });
        return;
      }

      const target = await deps.users.findByUsername(username.trim());
      /*
       * 找不到账号与已是成员**返回同一句**：区分它们等于给车主一个查询接口
       * ——输入任意用户名就能问出"这个人在不在这个系统里"。
       */
      if (!target) {
        res.status(409).json({ error: "grant_failed" });
        return;
      }
      try {
        await deps.grants.grant({ userId: target.id, vin, role: role as GrantableRole });
      } catch (err) {
        if (err instanceof GrantAlreadyActiveError || err instanceof OwnerCannotBeGrantedError) {
          res.status(409).json({ error: "grant_failed" });
          return;
        }
        throw err;
      }
      res.status(201).json({ userId: target.id, role });
    },
  );

  /** 移除成员。owner-only。软删——下一次请求即失效（F-55-04）。 */
  router.delete(
    "/v1/vehicles/:vin/grants/:userId",
    async (req: VehicleRoleRequest, res: Response) => {
      const vin = String(req.params.vin);
      if (!(await requireVehicleOwner(deps.grants, req, res, vin))) return;

      const target = String(req.params.userId);
      const removed = await deps.grants.revoke(target, vin);
      // 幂等：本来就不是成员时也回 200。移除一个已经不在的人不是错误。
      res.json({ removed });
    },
  );

  return router;
}
