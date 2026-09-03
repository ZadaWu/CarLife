/**
 * 车辆角色校验（施工单 M48-03，FL-55 F-55-04）。
 *
 * # 它回答一个问题：这个人对这辆车是什么角色
 *
 * 判定本身在 `enterprise/backend/shared/db` 的 `roleFor`（唯一入口）。这里只是把它接到 HTTP 上：
 * 从请求里取出 vin → 查角色 → 非成员直接拒 → 是成员就把角色交给下游。
 *
 * # 撤销的生效机制就是这个中间件
 *
 * 每个带 vin 的请求都查一次库（设计裁决 R11）。车主移除成员之后，
 * 那个人的**下一次请求**就在这里被挡住——不需要撤销名单，也就没有
 * "名单过期了但 refresh 还没到期"那段窗口。
 *
 * # 为什么拒绝用 404 而不是 403
 *
 * 与既有车辆路由的约定一致（`vehicle_not_found`）：**无权限与不存在必须
 * 不可区分**，否则拿 VIN 挨个试就能问出"这辆车在不在这个系统里"（AC-55-7）。
 * 403 会把"存在但你没权限"这件事直接说出来。
 *
 * # 为什么不做成全局中间件
 *
 * 带 vin 的路由散在 path param / body / query 三种形态里，全局中间件要认全它们，
 * 认漏一个就是一个可见域缺口，而且**漏了不会有任何现象**。
 * 所以这里给的是显式的 `resolveVehicleRole(req, vin)`：调用点自己把 vin 交出来，
 * 少调一次是编译期就能看见的缺失（下游拿不到 `grantRole`）。
 */

import type { Response } from "express";

import type { ResolvedRole, VehicleGrantRepository } from "@carlife/db";

import type { AuthedRequest } from "./index";

export interface VehicleRoleRequest extends AuthedRequest {
  /** 本次请求的主体对目标车辆的角色；`null` = 非成员。 */
  grantRole?: ResolvedRole;
}

/** 与既有车辆路由逐字一致：无权限与不存在同一句（AC-55-7）。 */
export function vehicleNotFound(res: Response): void {
  res.status(404).json({ error: "vehicle_not_found" });
}

/**
 * 解析角色并写进 `req.grantRole`。
 *
 * 车辆级 token（车机）此刻没有"人"——它的 `userId` 为空。这种请求在本函数里
 * 一律判非成员：**车机要先声明"现在是谁"**（M48-05），在那之前它不能以任何人的
 * 身份读写车辆数据。这不是限制，是 R4 的直接后果。
 */
export async function resolveVehicleRole(
  grants: Pick<VehicleGrantRepository, "roleFor">,
  req: VehicleRoleRequest,
  vin: string,
): Promise<ResolvedRole> {
  /*
   * 已解析过就直接用（M48-03）。中间件在路由之前跑过一次，端点又调
   * `requireVehicleMember` 是常态——不复用的话每个请求查两次库，
   * 而这条路径上每一次多余的查询都乘以全部车辆端点的调用量。
   *
   * 复用不影响撤销的时效：同一个请求内角色不会变，跨请求本来就会重查。
   */
  if (req.grantRole !== undefined) return req.grantRole;
  if (!req.userId || !vin) {
    req.grantRole = null;
    return null;
  }
  const role = await grants.roleFor(req.userId, vin);
  req.grantRole = role;
  return role;
}

/**
 * 这次请求是不是**这辆车自己的车机**（M52-01）。
 *
 * 车辆级 token 没有 `userId`，`resolveVehicleRole` 因此一律判它非成员——
 * 那条规则本身是对的（R4：车机不代表任何人，读写车辆数据前必须先声明谁在用）。
 * 但它与上车声明有一处直接冲突：**车机得先看到成员名单才选得出人**，
 * 而名单本身就是 `GET /v1/vehicles/:vin/grants`。于是绑定成功后车机拿不到名单，
 * 声明屏进不去——2026-08-31 走查 W8 撞上的就是这个（现象是 `server: status=404`，
 * 因为端上把任何非 200 都归成 `NetError::Server`）。
 *
 * 放行的边界卡在两条上，缺一不可：
 *  1. **只有绑到这辆车的车机**算数——`vehicleVin` 来自设备记录（`auth/index.ts:65`
 *     校验过 token 的 vin 与库里的 `device.vehicleVin` 一致），不是 token 自称的；
 *  2. **只放行成员名单这一个读**。它是声明流程的前置，且内容只有各账号自设的
 *     displayName（不含 VehicleMember 档案称呼那类他人 PII，FL-46 F-46-13）。
 *
 * **不要**把它推广成"车机等于成员"。车机能读名单，不代表它能读这辆车的行程、
 * 用车画像或任何个人域数据——那些仍然要等声明之后按 `activeUserId` 走。
 */
export function isBoundCockpit(req: VehicleRoleRequest, vin: string): boolean {
  return !req.userId && !!req.vehicleVin && req.vehicleVin === vin;
}

/**
 * 路径级角色注入中间件。
 *
 * 匹配 `/v1/vehicles/:vin/...`，把角色写进 `req.grantRole` 后放行——**它自己不拒绝**。
 * 拒绝留在各端点：那里才知道这次是读还是写，而读与写的门槛不同
 * （成员可读、只有车主能写，设计 §4.2）。
 *
 * 只认路径里的 vin。body / query 里带 vin 的端点要自己调 `requireVehicleMember`
 * / `requireVehicleOwner`——**这是有意的**：让"漏了校验"表现成下游拿不到
 * `grantRole`（编译期或用例能看见），而不是一个静默放行的全局兜底。
 */
export function createVehicleRoleMiddleware(
  grants: Pick<VehicleGrantRepository, "roleFor">,
): (req: VehicleRoleRequest, res: Response, next: () => void) => void {
  return (req, _res, next) => {
    const match = /^\/v1\/vehicles\/([^/]+)(?:\/|$)/.exec(req.path);
    if (!match) {
      next();
      return;
    }
    let vin: string;
    try {
      vin = decodeURIComponent(match[1]!);
    } catch {
      vin = match[1]!;
    }
    void resolveVehicleRole(grants, req, vin)
      .catch(() => {
        // 库出问题时判非成员（fail closed）。放行才是危险的那一边。
        req.grantRole = null;
      })
      .finally(() => next());
  };
}

/** 成员即可（读路径）。非成员时已写好响应，调用方直接 return。 */
export async function requireVehicleMember(
  grants: Pick<VehicleGrantRepository, "roleFor">,
  req: VehicleRoleRequest,
  res: Response,
  vin: string,
): Promise<ResolvedRole> {
  const role = await resolveVehicleRole(grants, req, vin);
  if (!role) vehicleNotFound(res);
  return role;
}

/**
 * 判定本次请求能不能碰这辆车，给**已经查出车辆档案**的路由用。
 *
 * @param need `"member"` = 成员即可（读车辆共享域）；`"owner"` = 只有车主（写）。
 *
 * # 为什么要"没有中间件时回落到 ownerId 比较"
 *
 * `createVehicleRoleMiddleware` 是在 `index.ts` 里统一挂的，而各路由的既有单测
 * 是**单独挂载这一个 router** 跑的——那里没有中间件，`grantRole` 是 `undefined`。
 * 回落到 M48-03 之前的语义（只有车主能过），既让既有用例继续有意义，
 * 又保证"忘了挂中间件"的后果是**更严**而不是更松（fail closed）。
 *
 * 注意 `null` 与 `undefined` 在这里语义不同：`null` = 中间件查过了，不是成员；
 * `undefined` = 中间件没跑。合并成一个假值处理就会把"没查"当成"查过且不是成员"。
 */
export function hasVehicleAccess(
  req: VehicleRoleRequest,
  vehicleOwnerId: string,
  need: "member" | "owner",
): boolean {
  const role = req.grantRole;
  if (role === undefined) return vehicleOwnerId === req.userId;
  if (need === "owner") return role === "owner";
  return role !== null;
}

/**
 * 必须是车主（写路径与管理路径）。
 *
 * 权限矩阵里"写④车辆档案""管理成员授权""绑定车机""设置默认车"都只有 owner
 * （设计 §4.2 / 裁决 R7）。driver 读得到但改不了。
 */
export async function requireVehicleOwner(
  grants: Pick<VehicleGrantRepository, "roleFor">,
  req: VehicleRoleRequest,
  res: Response,
  vin: string,
): Promise<boolean> {
  /*
   * 由上车声明得来的身份**不行使车主权限**（M54-13，设计裁决 R7 + 架构 §13-23）。
   *
   * 声明只校验"这个人在成员名单里"，不校验就是本人——车上任何人都能点车主
   * 那一格。让它拿到车主权限，等于把"改车辆档案、增删成员授权、绑定车机"
   * 交给一次未经验证的点选。读自己的东西可以，管理这辆车不行。
   */
  if ((req as { actingViaBoarding?: boolean }).actingViaBoarding) {
    vehicleNotFound(res);
    return false;
  }
  const role = await resolveVehicleRole(grants, req, vin);
  if (role !== "owner") {
    vehicleNotFound(res);
    return false;
  }
  return true;
}
