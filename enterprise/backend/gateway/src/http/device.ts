/**
 * 设备注册与车机绑定（施工单 M48-04，FL-56 F-56-02/03 / FL-07 F-07-04/11）。
 *
 * `POST   /v1/devices/register`      私人终端注册（登录后每次启动都调，幂等）
 * `GET    /v1/devices`               我的私人设备列表
 * `DELETE /v1/devices/:id`           撤销设备（本人的私人设备 / 车主的车机）
 * `POST   /v1/devices/bind-request`  车主扫码后发一枚配对码
 * `POST   /v1/devices/bind-confirm`  车机输入配对码换车辆级凭证
 *
 * # 车机免密的实现形状
 *
 * 车机上**不输入任何账号口令**（FL-07 F-07-04）。它展示自己的 deviceId 二维码，
 * 车主用已登录的手机扫码 → 服务端确认"扫码的人是这辆车的车主" → 发一枚 60 秒
 * 一次性配对码 → 车机输入 → 换到车辆级 refresh token。
 *
 * 口令始终只在手机上出现过，车机拿到的凭证也**不代表任何人**——
 * 它只证明"这台设备属于这辆车"。谁在用由上车声明回答（M48-05）。
 *
 * # 为什么配对码这一跳不能省
 *
 * 只扫码不输码的话，攻击者拿一张伪造的二维码给车主扫，就能把**自己的设备**
 * 绑到车主的车上。配对码要求扫码的人把一个值带回到那台设备上，
 * 而伪造二维码的人拿不到车主手机上显示的那个值。
 */

import { Router, json, type Response } from "express";
import { randomInt } from "node:crypto";

import type { DeviceRepository, VehicleGrantRepository } from "@carlife/db";
import { isDeviceType } from "@carlife/shared";

import type { AuthedRequest } from "../auth";
import { issueToken, ACCESS_TTL_SEC } from "../auth/jwt";
import { requireVehicleOwner, type VehicleRoleRequest } from "../auth/vehicle-role";
import type { PairingStore } from "./pairing-store";

/** 配对码有效期。短到让钓鱼来不及转手，长到够人把六位数敲进车机。 */
export const PAIRING_TTL_SEC = 60;
/** 同一 deviceId 每小时发码次数上限。 */
export const PAIRING_ISSUE_LIMIT = 5;

export interface DeviceRouterDeps {
  devices: DeviceRepository;
  grants: Pick<VehicleGrantRepository, "roleFor">;
  pairing: PairingStore;
}

/** 六位数字，前导零保留（`randomInt` 而不是 Math.random：这是安全值）。 */
function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function createDeviceRouter(deps: DeviceRouterDeps): Router {
  const router = Router();

  /** 私人终端注册。每次启动都调，幂等（upsert + 刷新活跃时刻）。 */
  router.post("/v1/devices/register", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      // 车辆级 token 不能注册私人设备——它不代表任何人。
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { deviceId, deviceType, modelName } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof deviceId !== "string" || !deviceId.trim()) {
      res.status(400).json({ error: "invalid_device_id" });
      return;
    }
    if (!isDeviceType(deviceType)) {
      res.status(400).json({ error: "invalid_device_type" });
      return;
    }
    const device = await deps.devices.register({
      id: deviceId.trim(),
      userId: req.userId,
      deviceType,
      modelName: typeof modelName === "string" && modelName.trim() ? modelName.trim() : "未知设备",
    });
    res.json({
      id: device.id,
      deviceType: device.deviceType,
      modelName: device.modelName,
      registeredAt: device.registeredAt,
    });
  });

  /**
   * 我的私人设备。**同型号会重复出现**——那正是要的：两台同款 iPad 就是两条，
   * 按注册时间可区分（AC-56-1）。合并同名会让人以为只有一台。
   */
  router.get("/v1/devices", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.json({ devices: [] });
      return;
    }
    const devices = await deps.devices.listByUser(req.userId);
    res.json({
      devices: devices.map((d) => ({
        id: d.id,
        deviceType: d.deviceType,
        modelName: d.modelName,
        registeredAt: d.registeredAt,
        lastActiveAt: d.lastActiveAt,
      })),
    });
  });

  /** 撤销设备。私人设备限本人；车机限该车车主。 */
  router.delete("/v1/devices/:id", async (req: VehicleRoleRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const id = String(req.params.id);
    const device = await deps.devices.findActive(id);
    // 不存在与无权按同一句处理：不泄露"这个设备 id 存不存在"。
    if (!device) {
      res.status(404).json({ error: "device_not_found" });
      return;
    }
    if (device.vehicleVin) {
      const role = await deps.grants.roleFor(req.userId, device.vehicleVin);
      if (role !== "owner") {
        res.status(404).json({ error: "device_not_found" });
        return;
      }
    } else if (device.userId !== req.userId) {
      res.status(404).json({ error: "device_not_found" });
      return;
    }
    res.json({ revoked: await deps.devices.revoke(id) });
  });

  /**
   * 车主扫码 → 发配对码。
   *
   * 响应里带 **VIN 末 4 位**：车主要能核对"我扫的这台机器要绑的是我这辆车"。
   * 不带的话，伪造二维码把 vin 换成别人的车，车主也看不出来。
   */
  router.post("/v1/devices/bind-request", json(), async (req: VehicleRoleRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { deviceId, vin } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof deviceId !== "string" || !deviceId.trim() || typeof vin !== "string" || !vin) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    // 只有车主能把设备绑到这辆车上。非车主与车不存在同一句（防枚举）。
    if (!(await requireVehicleOwner(deps.grants, req, res, vin))) return;

    if (!(await deps.pairing.allowIssue(deviceId.trim(), PAIRING_ISSUE_LIMIT))) {
      res.status(429).json({ error: "too_many_pairing_requests" });
      return;
    }
    const code = newPairingCode();
    await deps.pairing.put(
      code,
      { deviceId: deviceId.trim(), vin, requestedBy: req.userId },
      PAIRING_TTL_SEC,
    );
    res.json({
      code,
      expiresInSec: PAIRING_TTL_SEC,
      /** 供车主核对的车辆尾号。**不回完整 VIN**：它会出现在手机截图与日志里。 */
      vinSuffix: vin.slice(-4),
    });
  });

  return router;
}

/**
 * 配对确认（M48-04，F-56-03）——**必须挂在鉴权中间件之前**。
 *
 * 车机走到这一步时还没有任何凭证：它就是来换凭证的。挂在 jwtAuth 之后会被
 * 401 掉，而那个 401 看起来像"配对码不对"，会把人引到完全错误的方向。
 * 与 `/v1/auth/login` 同一类：自带鉴权（凭据是配对码本身）。
 */
export function createDevicePairingRouter(
  deps: Pick<DeviceRouterDeps, "devices" | "pairing">,
): Router {
  const router = Router();

  /**
   * 车机输入配对码 → 换车辆级凭证。
   *
   * **这条路径不需要鉴权**（车机此刻还没有任何凭证），安全性来自配对码本身：
   * 60 秒、一次性、且必须与请求里的 deviceId 对得上——
   * 只拿到码而不是那台设备，换不出东西。
   */
  router.post("/v1/devices/bind-confirm", json(), async (req: AuthedRequest, res: Response) => {
    const { deviceId, code, modelName } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof deviceId !== "string" || typeof code !== "string") {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const pending = await deps.pairing.take(code);
    // 码不对、过期、已用过——全都同一句：区分它们等于给爆破者一个进度条。
    if (!pending || pending.deviceId !== deviceId.trim()) {
      res.status(400).json({ error: "invalid_pairing_code" });
      return;
    }

    const device = await deps.devices.register({
      id: pending.deviceId,
      // 车机的 userId 记的是**绑定操作者**（必是车主），仅供审计——
      // 它不代表"谁在用这台车机"（设计裁决 R4）。
      userId: pending.requestedBy,
      deviceType: "cockpit",
      modelName: typeof modelName === "string" && modelName.trim() ? modelName.trim() : "车机",
      vehicleVin: pending.vin,
    });

    res.json({
      accessToken: issueToken({
        sub: device.id,
        kind: "vehicle",
        use: "access",
        deviceId: device.id,
        vin: pending.vin,
      }),
      refreshToken: issueToken({
        sub: device.id,
        kind: "vehicle",
        use: "refresh",
        deviceId: device.id,
        vin: pending.vin,
      }),
      expiresIn: ACCESS_TTL_SEC,
      vin: pending.vin,
    });
  });

  return router;
}
