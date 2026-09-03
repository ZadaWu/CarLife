/**
 * 登录与刷新端点（施工单 M48-02，FL-07 F-07-01/02）。
 *
 * # 这条路由挂在鉴权中间件**之前**
 *
 * 登录本来就是"还没有身份"的时候调的。它与后台路由一样属于"自带鉴权"的那一类，
 * 只不过它的鉴权就是口令本身。
 *
 * # 刷新为什么也要查库
 *
 * refresh 有效期 14 天（车机长离线）。如果刷新只验签名，那么一个被撤销的设备
 * 在 14 天里可以一直换出新的 access token——撤销就等于没做。
 * 所以刷新路径与请求路径查同样的东西：账号还在吗、设备还生效吗。
 */

import { Router, json, type Response } from "express";

import type { DeviceRepository, UserRepository } from "@carlife/db";

import { issueToken, verifyToken, ACCESS_TTL_SEC } from "../auth/jwt";
import { verifyPassword } from "../auth/password";

export interface AuthRouterDeps {
  users: Pick<UserRepository, "findByUsername" | "findById">;
  devices: Pick<DeviceRepository, "findActive">;
}

/** 登录/刷新失败一律这一句。**不区分原因**——区分即账号存在性探测通道。 */
function unauthorized(res: Response): void {
  res.status(401).json({ error: "unauthorized" });
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();

  /**
   * 登录。`deviceId` 可选：带上则 token 与设备绑定，
   * 之后该设备被撤销时这枚 token 立刻失效（`createJwtAuth` 会查）。
   */
  router.post("/v1/auth/login", json(), async (req, res) => {
    const { username, password, deviceId } = (req.body ?? {}) as {
      username?: unknown;
      password?: unknown;
      deviceId?: unknown;
    };
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      unauthorized(res);
      return;
    }

    const user = await deps.users.findByUsername(username);
    /*
     * 用户不存在时**照样跑一次口令校验**：直接返回会让"不存在"比"口令错"
     * 快一个数量级（scrypt 是刻意慢的），响应时间就成了账号枚举通道。
     * 拿一个不可能匹配的散列去比，耗时与真实路径同量级。
     */
    const stored = user?.passwordHash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const ok = await verifyPassword(password, stored);
    if (!ok || !user) {
      unauthorized(res);
      return;
    }

    const boundDevice = typeof deviceId === "string" && deviceId ? deviceId : undefined;
    res.json({
      accessToken: issueToken({ sub: user.id, kind: "user", use: "access", deviceId: boundDevice }),
      refreshToken: issueToken({
        sub: user.id,
        kind: "user",
        use: "refresh",
        deviceId: boundDevice,
      }),
      expiresIn: ACCESS_TTL_SEC,
      user: { id: user.id, displayName: user.displayName ?? null },
    });
  });

  /** 刷新。人 token 与车辆 token 都走这里，区别只在查什么。 */
  router.post("/v1/auth/refresh", json(), async (req, res) => {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: unknown };
    if (typeof refreshToken !== "string" || !refreshToken) {
      unauthorized(res);
      return;
    }
    const claims = verifyToken(refreshToken);
    if (!claims || claims.use !== "refresh") {
      unauthorized(res);
      return;
    }

    if (claims.kind === "vehicle") {
      const device = await deps.devices.findActive(claims.sub);
      if (!device?.vehicleVin) {
        unauthorized(res);
        return;
      }
      /*
       * **必须把 vin 回给端上**。这里读的 `device.vehicleVin` 是
       * 绑定的当前真相——车辆补录 VIN（`PEND-xxx` → 真 VIN）或换绑之后，
       * 它与端上配对当时记下的那个值就不是一回事了。
       *
       * 此前只回 accessToken：新 vin 签在 token 里，端上却没有任何渠道知道它，
       * 于是 `bound_vin()` 永久停在已经不存在的 `PEND-` 上。表现是车机
       * "已绑定"却列不出成员（404 vehicle_not_found），而界面提示指向网关地址，
       * 把人引到一个与根因无关的地方——重装、重连 Wi-Fi 都不会好。
       */
      res.json({
        accessToken: issueToken({
          sub: device.id,
          kind: "vehicle",
          use: "access",
          deviceId: device.id,
          vin: device.vehicleVin,
        }),
        expiresIn: ACCESS_TTL_SEC,
        vin: device.vehicleVin,
      });
      return;
    }

    const user = await deps.users.findById(claims.sub);
    if (!user) {
      unauthorized(res);
      return;
    }
    if (claims.deviceId) {
      const device = await deps.devices.findActive(claims.deviceId);
      if (!device || device.userId !== user.id) {
        unauthorized(res);
        return;
      }
    }
    res.json({
      accessToken: issueToken({
        sub: user.id,
        kind: "user",
        use: "access",
        ...(claims.deviceId ? { deviceId: claims.deviceId } : {}),
      }),
      expiresIn: ACCESS_TTL_SEC,
    });
  });

  return router;
}
