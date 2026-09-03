/**
 * mock-cabin 的端点行为。
 *
 * 盯三条主线，与 mock-dealer 的测试同一哲学：
 *
 *  1. **防编**：车辆必须先创建；编一个 vehicleId 会被 404 拒掉——
 *     宽容地"顺手建一辆"会让模型编的 id 变成一辆真实存在的车。
 *  2. **诚实**：越界要夹并说明、此车没有的功能要跳过并说明、安全域要拒绝——
 *     上游拿到的每个字段结果都必须够它如实转述"哪些设好了、哪些没有、为什么"。
 *  3. **可复现**：同款车型两辆车的能力表必须逐字相同（种子外靠确定性合成），
 *     不然演示时的表现是"我朋友的车有座椅通风、我的没有"，看起来像 bug。
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Server } from "node:http";

import { createCabinServer, __resetAll } from "../src/index";

let server: Server;
let base = "";

before(async () => {
  server = createCabinServer();
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => server.close());
beforeEach(() => __resetAll());

const get = async (path: string) => {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

/** 造一辆车，返回 vehicleId。大多数用例的公共起点。 */
const createCar = async (model = "Model Y"): Promise<string> => {
  const r = await post("/vehicles", { model });
  assert.equal(r.status, 201);
  return r.body.vehicleId as string;
};

describe("POST /vehicles：先造车，后使用", () => {
  it("不带车型 → 400 model_required", async () => {
    const r = await post("/vehicles", {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "model_required");
  });

  it("指定车型创建：发号返回 vehicleId，能力按车型配置，状态是默认态", async () => {
    const r = await post("/vehicles", { model: "Model Y" });
    assert.equal(r.status, 201);
    assert.match(r.body.vehicleId, /^VEH-\d{6}$/);
    assert.equal(r.body.model, "Model Y");
    assert.equal(r.body.source, "seed");
    assert.deepEqual(r.body.capabilities.climate.zones, ["driver", "passenger"]);
    assert.equal(r.body.state.climate.driver.tempC, 22);
    assert.equal(r.body.provenance, "simulated");
  });

  it("两次创建是两辆车：id 不同、状态互相独立", async () => {
    const a = await createCar();
    const b = await createCar();
    assert.notEqual(a, b);
    await post(`/vehicles/${a}/apply`, { ops: [{ domain: "climate", zone: "driver", set: { tempC: 26 } }] });
    const stateB = await get(`/vehicles/${b}/state`);
    assert.equal(stateB.body.state.climate.driver.tempC, 22, "改 A 不影响 B");
  });

  it("任意车型都造得出，同款两辆车能力表逐字相同", async () => {
    const a = await post("/vehicles", { model: "小鹏G6" });
    const b = await post("/vehicles", { model: "小鹏G6" });
    assert.equal(a.body.source, "synthesized");
    assert.deepEqual(a.body.capabilities, b.body.capabilities);
  });
});

describe("按 id 取能力与状态", () => {
  it("GET /vehicles/:id/capabilities 返回这辆车的能力，车型是返回属性", async () => {
    const id = await createCar("Model 3");
    const r = await get(`/vehicles/${id}/capabilities`);
    assert.equal(r.status, 200);
    assert.equal(r.body.model, "Model 3");
    assert.equal(r.body.capabilities.seats.driver.ventilationLevels, 0);
  });

  it("编一个 vehicleId → 404，capabilities/state/apply 一律如此", async () => {
    const caps = await get("/vehicles/VEH-999999/capabilities");
    assert.equal(caps.status, 404);
    assert.equal(caps.body.error, "vehicle_not_found");
    const state = await get("/vehicles/VEH-999999/state");
    assert.equal(state.status, 404);
    const apply = await post("/vehicles/VEH-999999/apply", {
      ops: [{ domain: "climate", set: { tempC: 23 } }],
    });
    assert.equal(apply.status, 404);
  });
});

describe("apply：逐字段裁决", () => {
  it("正常设置 → applied，状态真的变了；未动的分区不受影响", async () => {
    const id = await createCar();
    const r = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "climate", zone: "driver", set: { tempC: 23, fanLevel: 3 } }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].status, "applied");
    assert.equal(r.body.state.climate.driver.tempC, 23);
    assert.equal(r.body.state.climate.driver.fanLevel, 3);
    assert.equal(r.body.state.climate.passenger.tempC, 22);
  });

  it("越界温度被夹到边界并说明（35 → 28）", async () => {
    const id = await createCar();
    const r = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "climate", zone: "driver", set: { tempC: 35 } }],
    });
    const op = r.body.results[0];
    assert.equal(op.status, "partial");
    assert.equal(op.clamped.tempC.applied, 28);
    assert.equal(r.body.state.climate.driver.tempC, 28);
  });

  it("温度对齐步进（23.3 → 23.5）", async () => {
    const id = await createCar();
    const r = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "climate", zone: "driver", set: { tempC: 23.3 } }],
    });
    assert.equal(r.body.state.climate.driver.tempC, 23.5);
  });

  it("此车没有的功能被跳过并说明（Model Y 后排无通风），支持的照常生效", async () => {
    const id = await createCar();
    const r = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "seat", zone: "rearLeft", set: { heating: 2, ventilation: 2 } }],
    });
    const op = r.body.results[0];
    assert.equal(op.status, "partial");
    assert.equal(op.applied.heating, 2);
    assert.match(op.skipped.ventilation, /unsupported_on_this_vehicle/);
    assert.equal(r.body.state.seats.rearLeft.heating, 2);
    assert.equal(r.body.state.seats.rearLeft.ventilation, 0);
  });

  it("编一个分区名 → invalid，且什么都不改", async () => {
    const id = await createCar();
    const r = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "climate", zone: "rear", set: { tempC: 26 } }],
    });
    assert.equal(r.body.results[0].status, "invalid");
    assert.match(r.body.results[0].reason, /unknown_zone/);
    assert.equal(r.body.state.climate.driver.tempC, 22);
  });

  it("无香氛车型的香氛操作 → rejected", async () => {
    const id = await createCar();
    const r = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "fragrance", set: { intensity: "low" } }],
    });
    assert.equal(r.body.results[0].status, "rejected");
    assert.match(r.body.results[0].reason, /unsupported_on_this_vehicle/);
  });

  it("zone 省略 = all：氛围灯全区生效", async () => {
    const id = await createCar();
    const r = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "ambientLight", set: { brightness: 60 } }],
    });
    assert.equal(r.body.results[0].status, "applied");
    assert.deepEqual(r.body.results[0].zones, ["front"]);
    assert.equal(r.body.state.ambientLight.front.brightness, 60);
  });

  it("一单多操作互相独立：一个 invalid 不拖垮其它", async () => {
    const id = await createCar();
    const r = await post(`/vehicles/${id}/apply`, {
      ops: [
        { domain: "climate", zone: "driver", set: { tempC: 24 } },
        { domain: "nosuch", set: { x: 1 } },
      ],
    });
    assert.equal(r.body.results[0].status, "applied");
    assert.equal(r.body.results[1].status, "invalid");
    assert.equal(r.body.state.climate.driver.tempC, 24);
  });
});

describe("媒体音量上限：设备层就把限住", () => {
  it("设了上限之后，超限音量被夹到上限；同单先应用上限", async () => {
    const id = await createCar();
    const r = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "media", zone: "cabin", set: { volume: 80, volumeLimit: 40, source: "kids" } }],
    });
    const op = r.body.results[0];
    assert.equal(op.applied.volumeLimit, 40);
    assert.equal(op.clamped.volume.applied, 40);
    assert.match(op.clamped.volume.note, /上限/);
    assert.equal(r.body.state.media.cabin.volume, 40);
    assert.equal(r.body.state.media.cabin.source, "kids");
  });

  it("上限压下来时现播音量跟着降", async () => {
    const id = await createCar();
    await post(`/vehicles/${id}/apply`, { ops: [{ domain: "media", zone: "cabin", set: { volume: 70 } }] });
    const r = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "media", zone: "cabin", set: { volumeLimit: 30 } }],
    });
    assert.equal(r.body.state.media.cabin.volume, 30);
  });
});

describe("儿童锁：只能上、不能远程解", () => {
  it("上锁 applied；解锁 skipped 且标 safety_domain，状态不变", async () => {
    const id = await createCar();
    const lock = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "childMode", zone: "rearLeft", set: { childLock: true } }],
    });
    assert.equal(lock.body.results[0].status, "applied");
    assert.equal(lock.body.state.childMode.rearLeft.childLock, true);

    const unlock = await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "childMode", zone: "rearLeft", set: { childLock: false } }],
    });
    assert.equal(unlock.body.results[0].status, "rejected");
    assert.match(unlock.body.results[0].skipped.childLock, /safety_domain/);
    assert.equal(unlock.body.state.childMode.rearLeft.childLock, true);
  });
});

describe("幂等与变更记录", () => {
  it("同 requestId 重发不改第二遍状态，回 duplicate", async () => {
    const id = await createCar();
    const body = {
      requestId: "req-1",
      ops: [{ domain: "climate", zone: "driver", set: { tempC: 25 } }],
    };
    const first = await post(`/vehicles/${id}/apply`, body);
    assert.equal(first.body.duplicate, undefined);

    // 中途状态被别的请求改掉
    await post(`/vehicles/${id}/apply`, { ops: [{ domain: "climate", zone: "driver", set: { tempC: 20 } }] });

    const replay = await post(`/vehicles/${id}/apply`, body);
    assert.equal(replay.body.duplicate, true);
    // 重放返回的是第一次的结果，且没有把 20 改回 25
    const now = await get(`/vehicles/${id}/state`);
    assert.equal(now.body.state.climate.driver.tempC, 20);
  });

  it("changes 记录实际发生的变化，未变的字段不记", async () => {
    const id = await createCar();
    await post(`/vehicles/${id}/apply`, {
      ops: [{ domain: "climate", zone: "driver", set: { tempC: 23, fanLevel: 2 } }], // fanLevel 本来就是 2
    });
    const r = await get(`/vehicles/${id}/changes`);
    const fields = (r.body.changes as Array<{ field: string }>).map((c) => c.field);
    assert.ok(fields.includes("tempC"));
    assert.ok(!fields.includes("fanLevel"), "写入同值不算变化");
  });
});

describe("reset 与 health", () => {
  it("reset 回默认态，保留车型", async () => {
    const id = await createCar();
    await post(`/vehicles/${id}/apply`, { ops: [{ domain: "climate", zone: "driver", set: { tempC: 26 } }] });
    const r = await post(`/vehicles/${id}/reset`, {});
    assert.equal(r.body.state.climate.driver.tempC, 22);
    assert.equal(r.body.model, "Model Y");
  });

  it("health 报服务身份、在册车辆数与合成能力", async () => {
    await createCar();
    const r = await get("/health");
    assert.equal(r.body.ok, true);
    assert.equal(r.body.service, "mock-cabin");
    assert.equal(r.body.vehicles, 1);
    assert.equal(r.body.synthesizesAnyModel, true);
  });
});
