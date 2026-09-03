/**
 * 设备注册与车机绑定（施工单 M48-04，F-56-01/02/03 / F-07-04/11）。
 *
 * 盯得最紧的四条：
 *  - **配对码三分支**：过期 / 重放 / 限速，任一失守都让"扫码绑定"变成"猜六位数"。
 *  - **只有车主能发码**：否则借车人能把自己的设备绑上去。
 *  - **车机凭证不代表任何人**：换到的是 `kind: vehicle` 的 token，没有 userId。
 *  - **同型号不合并**：两台同款 iPad 是两条记录（AC-56-1）。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import express from "express";

import type { Device } from "@carlife/shared";
import type { ResolvedRole } from "@carlife/db";

import type { AuthedRequest } from "../src/auth";
import { verifyToken } from "../src/auth/jwt";
import {
  createDeviceRouter,
  createDevicePairingRouter,
  PAIRING_ISSUE_LIMIT,
} from "../src/http/device";
import { createMemoryPairingStore, type PairingStore } from "../src/http/pairing-store";

const TEST_JWT_KEY = "test-jwt-key-0123456789abcdef";
let savedSecret: string | undefined;

before(() => {
  savedSecret = process.env.CARLIFE_JWT_SECRET;
  process.env.CARLIFE_JWT_SECRET = TEST_JWT_KEY;
});
after(() => {
  if (savedSecret === undefined) delete process.env.CARLIFE_JWT_SECRET;
  else process.env.CARLIFE_JWT_SECRET = savedSecret;
});

const OWNER = "u-owner";
const DRIVER = "u-driver";
const VIN = "LSJTEST0000000042";
const COCKPIT_ID = "dev-cockpit-1";

/** 内存设备仓储替身。只实现路由用到的方法。 */
function devicesOf(initial: Device[] = []) {
  const rows = new Map(initial.map((d) => [d.id, { ...d }]));
  return {
    rows,
    async register(input: {
      id: string;
      userId: string;
      deviceType: Device["deviceType"];
      modelName: string;
      vehicleVin?: string;
    }) {
      const now = new Date();
      const row: Device = {
        id: input.id,
        userId: input.userId,
        deviceType: input.deviceType,
        modelName: input.modelName,
        ...(input.vehicleVin ? { vehicleVin: input.vehicleVin } : {}),
        registeredAt: rows.get(input.id)?.registeredAt ?? now,
        lastActiveAt: now,
      };
      rows.set(input.id, row);
      return row;
    },
    async findActive(id: string) {
      const d = rows.get(id);
      return d && !d.revokedAt ? d : null;
    },
    async listByUser(userId: string) {
      return [...rows.values()].filter((d) => d.userId === userId && !d.vehicleVin && !d.revokedAt);
    },
    async listByVehicle(vin: string) {
      return [...rows.values()].filter((d) => d.vehicleVin === vin && !d.revokedAt);
    },
    async revoke(id: string) {
      const d = rows.get(id);
      if (!d || d.revokedAt) return false;
      d.revokedAt = new Date();
      return true;
    },
    async touch() {
      /* no-op */
    },
  };
}

const grantsOf = (roles: Record<string, ResolvedRole>) => ({
  async roleFor(userId: string, vin: string): Promise<ResolvedRole> {
    return vin === VIN ? (roles[userId] ?? null) : null;
  },
});

function appWith(
  devices: ReturnType<typeof devicesOf>,
  pairing: PairingStore,
  userId: string | null,
  roles: Record<string, ResolvedRole> = { [OWNER]: "owner", [DRIVER]: "driver" },
) {
  const app = express();
  app.use((req, _res, next) => {
    (req as AuthedRequest).userId = userId ?? undefined;
    next();
  });
  // 配对确认不需要鉴权（车机此刻还没凭证）——与真实装配顺序一致。
  app.use(createDevicePairingRouter({ devices: devices as never, pairing }));
  app.use(
    createDeviceRouter({ devices: devices as never, grants: grantsOf(roles), pairing }),
  );
  return app;
}

async function call(app: express.Express, path: string, init: RequestInit = {}) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await r.text();
    return { status: r.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  } finally {
    server.close();
  }
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("[F-56-01][AC-56-1] 设备注册", () => {
  it("**两台同型号是两条独立记录**，不按型号合并", async () => {
    const devices = devicesOf();
    const app = appWith(devices, createMemoryPairingStore(), OWNER);
    for (const id of ["ipad-a", "ipad-b"]) {
      const r = await call(
        app,
        "/v1/devices/register",
        post({ deviceId: id, deviceType: "pad", modelName: "iPad Pro 12.9-inch" }),
      );
      assert.equal(r.status, 200);
    }
    const list = await call(app, "/v1/devices");
    const rows = list.json.devices as Array<{ id: string; modelName: string }>;
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((d) => d.modelName)).size, 1, "型号相同是常态");
    assert.equal(new Set(rows.map((d) => d.id)).size, 2, "id 不同才是区分依据");
  });

  it("重复注册是幂等的（每次启动都会调）", async () => {
    const devices = devicesOf();
    const app = appWith(devices, createMemoryPairingStore(), OWNER);
    const body = post({ deviceId: "ipad-a", deviceType: "pad", modelName: "iPad" });
    await call(app, "/v1/devices/register", body);
    await call(app, "/v1/devices/register", body);
    assert.equal(((await call(app, "/v1/devices")).json.devices as unknown[]).length, 1);
  });

  it("非法 deviceType 被拒——受控词表不接受自由字符串", async () => {
    const app = appWith(devicesOf(), createMemoryPairingStore(), OWNER);
    const r = await call(
      app,
      "/v1/devices/register",
      post({ deviceId: "x", deviceType: "toaster", modelName: "m" }),
    );
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "invalid_device_type");
  });

  it("车辆级 token（无 userId）注册不了私人设备——它不代表任何人", async () => {
    const app = appWith(devicesOf(), createMemoryPairingStore(), null);
    const r = await call(
      app,
      "/v1/devices/register",
      post({ deviceId: "x", deviceType: "mobile", modelName: "m" }),
    );
    assert.equal(r.status, 401);
  });

  it("车机不出现在任何人的私人设备列表里（它绑车不绑人）", async () => {
    const devices = devicesOf([
      {
        id: COCKPIT_ID,
        userId: OWNER,
        deviceType: "cockpit",
        modelName: "车机",
        vehicleVin: VIN,
        registeredAt: new Date(),
        lastActiveAt: new Date(),
      },
    ]);
    const list = await call(appWith(devices, createMemoryPairingStore(), OWNER), "/v1/devices");
    assert.deepEqual(list.json.devices, []);
  });
});

describe("[F-56-03][AC-56-2] 车机绑定", () => {
  it("全流程：车主发码 → 车机确认 → 拿到车辆级凭证", async () => {
    const devices = devicesOf();
    const pairing = createMemoryPairingStore();
    const asOwner = appWith(devices, pairing, OWNER);

    const issued = await call(
      asOwner,
      "/v1/devices/bind-request",
      post({ deviceId: COCKPIT_ID, vin: VIN }),
    );
    assert.equal(issued.status, 200);
    const code = issued.json.code as string;
    assert.match(code, /^\d{6}$/, "六位数字，前导零保留");
    assert.equal(issued.json.vinSuffix, VIN.slice(-4), "车主要能核对绑的是自己那辆车");
    assert.ok(!JSON.stringify(issued.json).includes(VIN), "**不回完整 VIN**（会进截图与日志）");

    // 车机确认——这条路径没有鉴权头
    const anon = appWith(devices, pairing, null);
    const bound = await call(
      anon,
      "/v1/devices/bind-confirm",
      post({ deviceId: COCKPIT_ID, code, modelName: "车机" }),
    );
    assert.equal(bound.status, 200);
    assert.equal(bound.json.vin, VIN);

    const claims = verifyToken(bound.json.accessToken as string);
    assert.equal(claims?.kind, "vehicle", "拿到的是车辆级凭证");
    assert.equal(claims?.sub, COCKPIT_ID, "subject 是设备不是人");
    assert.equal(claims?.vin, VIN);
  });

  it("**只有车主能发码**：driver 扫码得到与'车不存在'同一响应", async () => {
    const app = appWith(devicesOf(), createMemoryPairingStore(), DRIVER);
    const r = await call(app, "/v1/devices/bind-request", post({ deviceId: COCKPIT_ID, vin: VIN }));
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: "vehicle_not_found" });
  });

  it("**一次性**：同一枚码用第二次即失效（防重放）", async () => {
    const devices = devicesOf();
    const pairing = createMemoryPairingStore();
    const issued = await call(
      appWith(devices, pairing, OWNER),
      "/v1/devices/bind-request",
      post({ deviceId: COCKPIT_ID, vin: VIN }),
    );
    const anon = appWith(devices, pairing, null);
    const body = post({ deviceId: COCKPIT_ID, code: issued.json.code, modelName: "车机" });
    assert.equal((await call(anon, "/v1/devices/bind-confirm", body)).status, 200);
    assert.equal((await call(anon, "/v1/devices/bind-confirm", body)).status, 400);
  });

  it("**码与设备必须对得上**：只拿到码换不出东西", async () => {
    const devices = devicesOf();
    const pairing = createMemoryPairingStore();
    const issued = await call(
      appWith(devices, pairing, OWNER),
      "/v1/devices/bind-request",
      post({ deviceId: COCKPIT_ID, vin: VIN }),
    );
    const r = await call(
      appWith(devices, pairing, null),
      "/v1/devices/bind-confirm",
      post({ deviceId: "attacker-device", code: issued.json.code, modelName: "x" }),
    );
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "invalid_pairing_code");
  });

  it("码不对、过期、已用过——**同一句**，不给爆破者进度条", async () => {
    const app = appWith(devicesOf(), createMemoryPairingStore(), null);
    const wrong = await call(
      app,
      "/v1/devices/bind-confirm",
      post({ deviceId: COCKPIT_ID, code: "000000", modelName: "x" }),
    );
    assert.deepEqual(wrong.json, { error: "invalid_pairing_code" });
  });

  it("过期的码换不出东西", async () => {
    const devices = devicesOf();
    const pairing = createMemoryPairingStore();
    // 直接以 0 秒 TTL 落一枚，绕开端点的固定 60 秒
    await pairing.put("123456", { deviceId: COCKPIT_ID, vin: VIN, requestedBy: OWNER }, 0);
    const r = await call(
      appWith(devices, pairing, null),
      "/v1/devices/bind-confirm",
      post({ deviceId: COCKPIT_ID, code: "123456", modelName: "x" }),
    );
    assert.equal(r.status, 400);
  });

  it(`[AC-56-3] 发码限速：同一设备每小时至多 ${PAIRING_ISSUE_LIMIT} 次`, async () => {
    const app = appWith(devicesOf(), createMemoryPairingStore(), OWNER);
    const body = post({ deviceId: COCKPIT_ID, vin: VIN });
    for (let i = 0; i < PAIRING_ISSUE_LIMIT; i += 1) {
      assert.equal((await call(app, "/v1/devices/bind-request", body)).status, 200, `第 ${i + 1} 次`);
    }
    const over = await call(app, "/v1/devices/bind-request", body);
    assert.equal(over.status, 429);
    assert.equal(over.json.error, "too_many_pairing_requests");
  });
});

describe("[F-07-11][AC-56-8] 设备撤销", () => {
  it("本人可撤销自己的私人设备；别人的撤不了（与不存在同一句）", async () => {
    const devices = devicesOf([
      {
        id: "phone-owner",
        userId: OWNER,
        deviceType: "mobile",
        modelName: "iPhone",
        registeredAt: new Date(),
        lastActiveAt: new Date(),
      },
    ]);
    const pairing = createMemoryPairingStore();
    const byDriver = await call(appWith(devices, pairing, DRIVER), "/v1/devices/phone-owner", {
      method: "DELETE",
    });
    assert.equal(byDriver.status, 404);
    assert.deepEqual(byDriver.json, { error: "device_not_found" });

    const byOwner = await call(appWith(devices, pairing, OWNER), "/v1/devices/phone-owner", {
      method: "DELETE",
    });
    assert.equal(byOwner.status, 200);
    assert.equal(byOwner.json.revoked, true);
  });

  it("**车机的解绑只有该车车主能做**，不是最后绑定它的人", async () => {
    const devices = devicesOf([
      {
        id: COCKPIT_ID,
        // 绑定操作者恰好是 driver（比如车主换过人）——不影响判定
        userId: DRIVER,
        deviceType: "cockpit",
        modelName: "车机",
        vehicleVin: VIN,
        registeredAt: new Date(),
        lastActiveAt: new Date(),
      },
    ]);
    const pairing = createMemoryPairingStore();
    assert.equal(
      (await call(appWith(devices, pairing, DRIVER), `/v1/devices/${COCKPIT_ID}`, { method: "DELETE" }))
        .status,
      404,
      "driver 即便是绑定操作者也不能解绑",
    );
    assert.equal(
      (await call(appWith(devices, pairing, OWNER), `/v1/devices/${COCKPIT_ID}`, { method: "DELETE" }))
        .status,
      200,
    );
  });

  it("撤销后设备查不到——鉴权路径据此拒绝（M48-02 已验）", async () => {
    const devices = devicesOf([
      {
        id: "phone-x",
        userId: OWNER,
        deviceType: "mobile",
        modelName: "iPhone",
        registeredAt: new Date(),
        lastActiveAt: new Date(),
      },
    ]);
    const app = appWith(devices, createMemoryPairingStore(), OWNER);
    await call(app, "/v1/devices/phone-x", { method: "DELETE" });
    assert.equal(await devices.findActive("phone-x"), null);
    assert.equal((await call(app, "/v1/devices/phone-x", { method: "DELETE" })).status, 404);
  });
});
