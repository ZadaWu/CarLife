/**
 * 常用人员端点（施工单 M17-04，FL-46 F-46-11）。
 *
 * GET    /v1/vehicles/:vin/members       → 这辆车的名单
 * POST   /v1/vehicles/:vin/members       → 新增 / 更新（带 id 即更新）
 * DELETE /v1/vehicles/:vin/members/:id   → 删除（级联删画像、清流水归属）
 *
 * # 与 `vehicle.ts` 同一套纪律
 *
 * - 校验（词表、长度）是治理，留在网关；推算与判定不在网关。
 * - `ownerId` 只认鉴权上下文；按 vin / id 写前校验归属。
 * - **空名单是 200 `{members: []}` 而不是 404**：还没登记是常态不是异常，
 *   404 会让端上反复告警（`GET /v1/vehicles` 同一条）。
 *
 * # 不过权限门
 *
 * 权限门管的是 **Agent 替用户做事**；用户在自己设备上维护自己维护的名单是用户自己做事，
 * 与建档同理（见 `vehicle.ts` 文件头）。删除的二次确认在端上做。
 *
 * # 审计只记 id，不记称呼
 *
 * 称呼是**他人的**可识别信息。`detail` 里只有 `memberId` 与动作
 * ——与 M3-01 的"`detail` 禁止写入密钥、token 或完整用户消息原文"同一条纪律。
 */

import { validateCabinPreference as validateCabinPreferenceShared, CabinPreferenceError } from "@carlife/shared";
import { Router, json } from "express";
import type { Response } from "express";

import {
  removeMemberCascade,
  CombinationValidationError,
  type CombinationStore,
  validateMember,
  MemberValidationError,
  type MemberProfilePurger,
  type MemberStore,
  type TripStore,
  type VehicleStore,
} from "@carlife/memory";

import type { AuthedRequest } from "../auth";
import { hasVehicleAccess, type VehicleRoleRequest } from "../auth/vehicle-role";

export interface MemberRouterDeps {
  members: MemberStore;
  vehicles: VehicleStore;
  trips: TripStore;
  /** Mem0 侧的画像清理；未接入时删除仍会删档案与归属（降级而非拒绝）。 */
  purger?: MemberProfilePurger;
  /** 组合偏好存储（M24-06/09）。未接入时：删除不失效组合、组合端点 503——降级而非拒绝。 */
  combinations?: CombinationStore;
  /** 审计。缺省不记——不让审计不可用阻塞用户操作。 */
  audit?: (entry: {
    actor: string;
    action: string;
    target?: string;
    detail?: Record<string, unknown>;
    result: "ok" | "denied" | "error";
  }) => void;
}

/** 画像清理未接入时的空实现：删档案照常，画像留待补偿任务处理。 */
const NOOP_PURGER: MemberProfilePurger = {
  async getAll() {
    return { results: [] };
  },
  async delete() {},
};

export function createVehicleMemberRouter(deps: MemberRouterDeps): Router {
  const router = Router();
  const audit = deps.audit ?? (() => {});

  /**
   * 归属校验。`need`（M48-03）：`owner` = 维护名单（增删改，只有车主，
   * 设计 §4.2 与 FL-46 F-46-04 一致）；`member` = 只读名单（被授权成员可读）。
   * 不区分"车不存在"与"车不属于你"——不泄露他人车辆的存在性。
   */
  async function canAccess(
    req: VehicleRoleRequest,
    vin: string,
    need: "member" | "owner" = "owner",
  ): Promise<boolean> {
    const v = await deps.vehicles.get(vin);
    return Boolean(v && hasVehicleAccess(req, v.ownerId, need));
  }

  router.get("/v1/vehicles/:vin/members", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const vin = String(req.params.vin);
    if (!(await canAccess(req, vin, "member"))) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }
    const members = await deps.members.listByVehicle(req.userId, vin);
    res.json({ members });
  });

  router.post("/v1/vehicles/:vin/members", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const vin = String(req.params.vin);
    if (!(await canAccess(req, vin))) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = {
      id: typeof body.id === "string" ? body.id : undefined,
      vin,
      ownerId: req.userId,
      displayName: String(body.displayName ?? ""),
      relation: typeof body.relation === "string" ? body.relation : undefined,
      roles: (body.roles ?? []) as never,
      ageBand: body.ageBand as never,
      needs: (body.needs ?? []) as never,
      note: typeof body.note === "string" ? body.note : undefined,
    };
    try {
      // 校验用 `@carlife/memory` 的同一个函数——网关不写第二份规则，
      // 两份规则迟早不一致，而不一致的表现是"端上过了、库里拒了"。
      validateMember(input);
    } catch (err) {
      if (err instanceof MemberValidationError) {
        res.status(400).json({ error: "invalid_body", detail: err.message, field: err.field });
        return;
      }
      throw err;
    }
    // 更新时先确认这条属于自己：仓储虽然也校验，但网关要给出正确的 404 而不是新建一条。
    if (input.id && !(await deps.members.get(req.userId, input.id))) {
      res.status(404).json({ error: "member_not_found" });
      return;
    }
    const member = await deps.members.upsert(input);
    audit({
      actor: req.userId,
      action: input.id ? "member.update" : "member.create",
      target: member.id,
      // **只记 id 与动作**，不记称呼
      detail: { vin, roles: member.roles },
      result: "ok",
    });
    res.status(input.id ? 200 : 201).json({ member });
  });

  router.delete("/v1/vehicles/:vin/members/:id", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const vin = String(req.params.vin);
    if (!(await canAccess(req, vin))) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }
    const id = String(req.params.id);
    const result = await removeMemberCascade(
      deps.members,
      deps.purger ?? NOOP_PURGER,
      deps.trips,
      req.userId,
      id,
      deps.combinations,
    );
    audit({
      actor: req.userId,
      action: "member.delete",
      target: id,
      detail: {
        vin,
        profilesDeleted: result.profilesDeleted,
        tripsDetached: result.tripsDetached,
        combinationsInvalidated: result.combinationsInvalidated.map((c) => c.id),
      },
      result: "ok",
    });
    // 未命中返回 `{removed:false}` 而不是 404：删除是幂等的，
    // 端上重试或双端同时删都会走到这里，404 会被当成故障。
    res.json({
      removed: result.removed !== null,
      memberId: result.removed,
      profilesDeleted: result.profilesDeleted,
      tripsDetached: result.tripsDetached,
      // 失效的组合带 label 回端上——提示"这些组合因删人失效"（AC-50-10）
      combinationsInvalidated: result.combinationsInvalidated,
    });
  });


  // ── 座舱偏好（M24-09，F-50-12）────────────────────────────
  //
  // 校验用 shared 的同一个函数（网关不写第二份规则）；写入走 upsert 读-改-写，
  // 其它字段原样保留——upsert 对 phone 等是整条覆盖语义。

  router.put(
    "/v1/vehicles/:vin/members/:id/cabin-preference",
    json(),
    async (req: AuthedRequest, res: Response) => {
      if (!req.userId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const vin = String(req.params.vin);
      if (!(await canAccess(req, vin))) {
        res.status(404).json({ error: "vehicle_not_found" });
        return;
      }
      const member = await deps.members.get(req.userId, String(req.params.id));
      if (!member || member.vin !== vin) {
        res.status(404).json({ error: "member_not_found" });
        return;
      }
      let preference;
      try {
        preference = validateCabinPreferenceShared((req.body ?? {}).preference ?? {});
      } catch (err) {
        if (err instanceof CabinPreferenceError) {
          res.status(400).json({ error: "invalid_preference", detail: err.message, field: err.field });
          return;
        }
        throw err;
      }
      const updated = await deps.members.upsert({
        id: member.id,
        vin: member.vin,
        ownerId: member.ownerId,
        displayName: member.displayName,
        relation: member.relation,
        roles: member.roles,
        ageBand: member.ageBand,
        needs: member.needs,
        note: member.note,
        phone: member.phone,
        cabinPreference: preference,
      });
      deps.audit?.({
        actor: req.userId,
        action: "member.cabin_preference",
        target: member.id,
        // 只记字段名不记值：偏好值无 PII，但纪律统一比逐字段争论便宜
        detail: { vin, fields: Object.keys(preference) },
        result: "ok",
      });
      res.json({ member: { id: updated.id, cabinPreference: updated.cabinPreference ?? null } });
    },
  );

  // ── 组合偏好 CRUD（M24-09，F-50-03/12）───────────────────

  router.get("/v1/vehicles/:vin/combinations", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const vin = String(req.params.vin);
    if (!(await canAccess(req, vin, "member"))) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }
    if (!deps.combinations) {
      res.status(503).json({ error: "combinations_unconfigured" });
      return;
    }
    // 含失效的：端上要展示失效原因与重建入口（AC-50-10）
    res.json({ combinations: await deps.combinations.listByVehicle(req.userId, vin) });
  });

  router.post("/v1/vehicles/:vin/combinations", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const vin = String(req.params.vin);
    if (!(await canAccess(req, vin))) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }
    if (!deps.combinations) {
      res.status(503).json({ error: "combinations_unconfigured" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const combination = await deps.combinations.upsert({
        vin,
        ownerId: req.userId,
        label: String(body.label ?? ""),
        memberIds: (body.memberIds ?? []) as string[],
        override: (body.override ?? {}) as never,
      });
      deps.audit?.({
        actor: req.userId,
        action: "combination.upsert",
        target: combination.id,
        detail: { vin, members: combination.memberIds.length },
        result: "ok",
      });
      res.json({ combination });
    } catch (err) {
      if (err instanceof CombinationValidationError) {
        res.status(400).json({ error: "invalid_combination", detail: err.message, field: err.field });
        return;
      }
      throw err;
    }
  });

  router.delete("/v1/vehicles/:vin/combinations/:id", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const vin = String(req.params.vin);
    if (!(await canAccess(req, vin))) {
      res.status(404).json({ error: "vehicle_not_found" });
      return;
    }
    if (!deps.combinations) {
      res.status(503).json({ error: "combinations_unconfigured" });
      return;
    }
    const removed = await deps.combinations.remove(req.userId, String(req.params.id));
    deps.audit?.({ actor: req.userId, action: "combination.delete", target: String(req.params.id), detail: { vin }, result: "ok" });
    // 删除幂等：删不到也是 200（与人员删除同语义）
    res.json({ removed: removed !== null });
  });

  return router;
}
