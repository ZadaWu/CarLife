/**
 * cabin_control / cabin_child_mode / cabin_status（施工单 M24-03）。
 *
 * 盯三条：**域边界**（cabin_control 拒收 childMode——方案 B 的地基，收了它权限门
 * 就被绕过了）、**requestId 派生的确定性**（同轮同单同 id，新轮新 id）、
 * **rebuilt/duplicate 透传**（转述层的输入不能在工具层丢掉）。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  cabinChildModeTool,
  cabinControlTool,
  cabinStatusTool,
  deriveRequestId,
  setCabinClient,
  ToolError,
  type CabinApplyOp,
  type CabinClient,
} from "../src/index";
import { setVehicleStore } from "../src/vehicle-profile";
import type { VehicleStore } from "@carlife/memory";

const VIN = "LSJA24U91NS662403";

const fakeVehicles = {
  async get() {
    return null;
  },
  async listByOwner() {
    return [{ vin: VIN, ownerId: "u1", model: "Model Y", modelYear: 2024, purchasedAt: 0, odometerKm: 0, maintenance: [], repairs: [], updatedAt: 0 }];
  },
} as unknown as VehicleStore;

function fakeClient(log: Array<{ vin: string; requestId?: string; ops: CabinApplyOp[] }>): CabinClient {
  return {
    async bind() {
      throw new Error("not used");
    },
    async status(vin) {
      return { vehicleId: "VEH-1", model: "Model Y", capabilities: {} as never, state: { ok: 1 }, updatedAt: "t", rebuilt: true };
    },
    async apply(vin, a) {
      log.push({ vin, requestId: a.requestId, ops: a.ops });
      return { vehicleId: "VEH-1", model: "Model Y", requestId: a.requestId, results: [], state: {}, duplicate: false, rebuilt: false };
    },
    async changes() {
      return { changes: [] };
    },
    // 媒体三件（M27）在这组用例里用不到，但接口是全的——留 throw 而不是留空实现：
    // 真被调到时要当场炸，不能返回一个"看起来正常"的空播放器。
    async mediaLibrary() {
      throw new Error("not used");
    },
    async mediaPlayer() {
      throw new Error("not used");
    },
    async mediaCommand() {
      throw new Error("not used");
    },
  };
}

afterEach(() => {
  setCabinClient(undefined);
  setVehicleStore(undefined);
});

const ctx = { sessionId: "s1", turnId: "t1" };

describe("域边界（方案 B 的地基）", () => {
  it("cabin_control 拒收 childMode，并把人引到 cabin_child_mode", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(fakeClient([]));
    await assert.rejects(
      () => cabinControlTool.call({ userId: "u1", ops: [{ domain: "childMode", set: { childLock: true } }] }, ctx),
      (e: unknown) => e instanceof ToolError && /cabin_child_mode/.test(e.message),
    );
  });

  it("cabin_child_mode 只收 childMode", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(fakeClient([]));
    await assert.rejects(
      () => cabinChildModeTool.call({ userId: "u1", ops: [{ domain: "climate", set: { tempC: 23 } }] }, ctx),
      (e: unknown) => e instanceof ToolError && /域不在本工具范围/.test(e.message),
    );
  });

  it("超过 20 条操作拒绝（车机契约上限）", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(fakeClient([]));
    const ops = Array.from({ length: 21 }, () => ({ domain: "climate", set: { tempC: 23 } }));
    await assert.rejects(
      () => cabinControlTool.call({ userId: "u1", ops }, ctx),
      (e: unknown) => e instanceof ToolError && /最多 20 条/.test(e.message),
    );
  });
});

describe("requestId 派生", () => {
  const ops: CabinApplyOp[] = [{ domain: "climate", set: { tempC: 23 } }];

  it("同轮同单 → 同 id（重发命中 mock 幂等）；新轮 → 新 id", () => {
    const a = deriveRequestId({ sessionId: "s1", turnId: "t1" }, ops);
    const b = deriveRequestId({ sessionId: "s1", turnId: "t1" }, ops);
    const c = deriveRequestId({ sessionId: "s1", turnId: "t2" }, ops);
    assert.equal(a, b);
    assert.notEqual(a, c, "新一轮\"再调一次同样的\"是新操作，不能被幂等吞掉");
  });

  it("无 turnId 退回随机——宁可失去幂等，不能把两轮真实操作误判成重复", () => {
    const a = deriveRequestId({ sessionId: "s1" }, ops);
    const b = deriveRequestId({ sessionId: "s1" }, ops);
    assert.notEqual(a, b);
  });
});

describe("透传", () => {
  it("apply 带上派生 requestId 与默认车 vin；status 透传 rebuilt", async () => {
    const log: Array<{ vin: string; requestId?: string; ops: CabinApplyOp[] }> = [];
    setVehicleStore(fakeVehicles);
    setCabinClient(fakeClient(log));
    const r = await cabinControlTool.call({ userId: "u1", ops: [{ domain: "seat", zone: "driver", set: { heating: 2 } }] }, ctx);
    assert.equal(log[0]?.vin, VIN);
    assert.match(log[0]?.requestId ?? "", /^creq-/);
    assert.equal(r.data.requestId, log[0]?.requestId);

    const st = await cabinStatusTool.call({ userId: "u1" }, ctx);
    assert.equal(st.data.rebuilt, true, "重建标记不能在工具层丢掉——转述要靠它说\"车机重新连接了\"");
  });
});
