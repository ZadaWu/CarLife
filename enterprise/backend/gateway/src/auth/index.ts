/**
 * auth —— 端上鉴权（施工单 M48-02，FL-07 F-07-01/02）。
 *
 * # 从 demo-token 到 JWT：这一单删掉了什么
 *
 * M48-02 之前这里是一行硬编码比对：`Bearer demo-token` → `req.userId = "demo-user"`。
 * 那是 M2-02 的简化形态，注释里写着"FL-07 落地前"。现在它落地了，**回退删除**——
 * 留着它等于留一个人人可用的万能钥匙，而且是那种"平时看不出来"的留法。
 *
 * # 错误信息统一
 *
 * 没带 token、token 坏、token 过期、用户不存在、口令错——对外**一律** 401 `unauthorized`。
 * 区分它们就是账号存在性的探测通道（FL-07 F-07-13 边界）。
 *
 * # 撤销：每次请求查库，不建名单
 *
 * 设备被撤销、账号被删，都在这里的 `resolveIdentity` 里查出来。
 * 不引 Redis 撤销名单（设计裁决 R11）：第二真相源会带来 TTL 与库不一致的窗口，
 * 而那个窗口里一个已被撤销的设备还能用。
 */

import type { NextFunction, Request, Response } from "express";

import type { DeviceRepository, UserRepository } from "@carlife/db";

import { verifyToken, type TokenClaims } from "./jwt";

export interface AuthedRequest extends Request {
  /** 登录账号 id。车辆级 token 没有它——车机上"谁在用"由上车声明回答（M48-05）。 */
  userId?: string;
  /** 发起请求的设备。 */
  deviceId?: string;
  /** 车辆级 token 绑定的车。 */
  vehicleVin?: string;
  /** token 类别，下游据此区分"人"与"车机"。 */
  tokenKind?: TokenClaims["kind"];
}

export interface AuthDeps {
  users: Pick<UserRepository, "findById">;
  devices: Pick<DeviceRepository, "findActive" | "touch">;
}

function bearer(req: Request): string | null {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * 解析身份：token 有效 + 主体仍然存在 + 设备未被撤销。
 *
 * 三者缺一即 null。**设备撤销必须在这里查**——只验签名的话，
 * 一个被撤销的设备在 access token 自然过期前（15 分钟）仍然畅通。
 */
async function resolveIdentity(
  deps: AuthDeps,
  claims: TokenClaims,
): Promise<Pick<AuthedRequest, "userId" | "deviceId" | "vehicleVin" | "tokenKind"> | null> {
  if (claims.use !== "access") return null;

  if (claims.kind === "vehicle") {
    const device = await deps.devices.findActive(claims.sub);
    if (!device?.vehicleVin) return null;
    // 车机 token 里的 vin 必须与设备当前绑定的一致：解绑后旧 token 立即失效。
    if (claims.vin && claims.vin !== device.vehicleVin) return null;
    return {
      deviceId: device.id,
      vehicleVin: device.vehicleVin,
      tokenKind: "vehicle",
    };
  }

  const user = await deps.users.findById(claims.sub);
  if (!user) return null;
  if (claims.deviceId) {
    const device = await deps.devices.findActive(claims.deviceId);
    if (!device || device.userId !== user.id) return null;
  }
  return {
    userId: user.id,
    ...(claims.deviceId ? { deviceId: claims.deviceId } : {}),
    tokenKind: "user",
  };
}

/** 鉴权中间件。挂在端上路由之前（后台路由自带鉴权，挂在它之前）。 */
export function createJwtAuth(deps: AuthDeps) {
  return async function jwtAuth(
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const token = bearer(req);
    const claims = token ? verifyToken(token) : null;
    if (!claims) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    let identity: Awaited<ReturnType<typeof resolveIdentity>>;
    try {
      identity = await resolveIdentity(deps, claims);
    } catch (err) {
      // 库不可用是 500 不是 401：把它报成 401 会让排障的人去查密钥。
      console.error("[auth] 身份解析失败", err);
      res.status(503).json({ error: "auth_backend_unavailable" });
      return;
    }
    if (!identity) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    Object.assign(req, identity);
    if (identity.deviceId) {
      // 活跃时刻是尽力而为：更新失败不该让请求失败。
      void deps.devices.touch(identity.deviceId).catch(() => undefined);
    }
    next();
  };
}

export { verifyToken, issueToken, ACCESS_TTL_SEC, REFRESH_TTL_SEC, JwtConfigError } from "./jwt";
export { hashPassword, verifyPassword, LOCKED_PASSWORD_HASH } from "./password";
