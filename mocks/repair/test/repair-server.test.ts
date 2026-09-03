/**
 * mock-repair 的行为测试（施工单 M41-01）。
 *
 * 起真服务打真 HTTP（mock-dealer dealer.test.ts 同款形态）：这些端点马上要被
 * `enterprise/backend/shared/tools` 的 http 后端消费，测到 socket 层才算数。
 */
import assert from "node:assert/strict";
import { afterEach, before, after, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { createRepairServer, __resetBookings } from "../src/index";
import { HISTORY, historyOf, generateRepairSlots, parseRepairSlotId } from "../src/store";

const VIN_EV = "DEM00SEED0M0DELY1";
const VIN_ICE = "DEM00SEED0MAL1BU1";

let base = "";
const server = createRepairServer();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
afterEach(() => __resetBookings());

async function get(path: string): Promise<{ code: number; body: any }> {
  const r = await fetch(`${base}${path}`);
  return { code: r.status, body: await r.json() };
}
async function post(path: string, payload: unknown): Promise<{ code: number; body: any }> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { code: r.status, body: await r.json() };
}

describe("种子一致性", () => {
  it("种子 VIN 恰为 demo:seed 的两辆车——改错这里演示车就查不到历史", () => {
    const vins = new Set(HISTORY.map((r) => r.vin));
    assert.deepEqual([...vins].sort(), [VIN_EV, VIN_ICE].sort());
  });

  it("每辆车的历史按时间与里程都单调递增——4S 记录里程倒着走会被使用者一眼看穿", () => {
    for (const vin of [VIN_EV, VIN_ICE]) {
      const rows = historyOf(vin);
      assert.ok(rows.length >= 2, `${vin} 至少两条历史`);
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i].at > rows[i - 1].at, "时间单调");
        assert.ok(rows[i].odometerKm > rows[i - 1].odometerKm, "里程单调");
      }
    }
  });

  it("EV 历史里程不超过 demo:seed 的当前表显 41,280km（ICE 同理 118,640km）", () => {
    for (const r of historyOf(VIN_EV)) assert.ok(r.odometerKm <= 41_280);
    for (const r of historyOf(VIN_ICE)) assert.ok(r.odometerKm <= 118_640);
  });
});

describe("GET /health", () => {
  it("报出种子规模与 provenance", async () => {
    const { code, body } = await get("/health");
    assert.equal(code, 200);
    assert.equal(body.ok, true);
    assert.equal(body.stations, 3);
    assert.ok(body.historyRecords >= 5);
    assert.equal(body.provenance, "simulated");
  });
});

describe("GET /vehicles/:vin/repairs", () => {
  it("已知 VIN 返回全部历史且 known:true", async () => {
    const { code, body } = await get(`/vehicles/${VIN_ICE}/repairs`);
    assert.equal(code, 200);
    assert.equal(body.known, true);
    assert.equal(body.records.length, 3);
    assert.equal(body.provenance, "simulated");
  });

  it("未知 VIN 是 200 空数组 known:false——没修过是事实不是错误", async () => {
    const { code, body } = await get("/vehicles/UNKNOWN0000000000/repairs");
    assert.equal(code, 200);
    assert.deepEqual(body.records, []);
    assert.equal(body.known, false);
  });
});

describe("GET /vehicles/:vin/quotes", () => {
  it("in_progress 报价单 total = partsFee + laborFee 且分项合计一致", async () => {
    const { code, body } = await get(`/vehicles/${VIN_EV}/quotes?status=in_progress`);
    assert.equal(code, 200);
    assert.equal(body.quotes.length, 1);
    const q = body.quotes[0];
    assert.equal(q.total, q.partsFee + q.laborFee);
    const itemsParts = q.items.reduce((s: number, i: any) => s + i.partsFee, 0);
    const itemsLabor = q.items.reduce((s: number, i: any) => s + i.laborFee, 0);
    assert.equal(q.partsFee, itemsParts);
    assert.equal(q.laborFee, itemsLabor);
    assert.equal(body.provenance, "simulated");
  });

  it("没有报价单的 VIN 返回空数组", async () => {
    const { body } = await get("/vehicles/UNKNOWN0000000000/quotes");
    assert.deepEqual(body.quotes, []);
  });
});

describe("POST /repair-bookings", () => {
  async function firstSlotId(): Promise<string> {
    const { body } = await get("/stations/RS-SH-01/slots");
    return body.slots[0].slotId as string;
  }

  it("正常预约成功，同幂等键重放返回同一单", async () => {
    const slotId = await firstSlotId();
    const payload = {
      vin: VIN_EV,
      slotId,
      items: ["常规保养"],
      contact: { name: "张先生", phone: "13800000000" },
      idempotencyKey: "sess-test:slot-1",
    };
    const a = await post("/repair-bookings", payload);
    assert.equal(a.code, 200);
    assert.equal(a.body.status, "confirmed");
    assert.deepEqual(a.body.disclosed, ["称呼", "手机号"]);

    const b = await post("/repair-bookings", payload);
    assert.equal(b.code, 200);
    assert.equal(b.body.orderId, a.body.orderId);
    assert.equal(b.body.duplicate, true);
  });

  it("编造的 slotId 被 404 拒掉——防编设计的地基", async () => {
    const { code } = await post("/repair-bookings", {
      vin: VIN_EV,
      slotId: "RS-SH-01#2099-01-01T25:00:00",
      contact: { name: "张先生", phone: "13800000000" },
    });
    assert.equal(code, 404);
  });

  it("时段占满返回 409", async () => {
    const slotId = await firstSlotId();
    for (let i = 0; i < 2; i++) {
      const r = await post("/repair-bookings", {
        vin: VIN_EV,
        slotId,
        contact: { name: `车主${i}`, phone: "13800000000" },
      });
      assert.equal(r.code, 200);
    }
    const full = await post("/repair-bookings", {
      vin: VIN_EV,
      slotId,
      contact: { name: "第三位", phone: "13800000000" },
    });
    assert.equal(full.code, 409);
    assert.equal(full.body.error, "slot_full");
  });

  it("缺 contact.phone 是 400", async () => {
    const slotId = await firstSlotId();
    const { code, body } = await post("/repair-bookings", { vin: VIN_EV, slotId, contact: { name: "张先生" } });
    assert.equal(code, 400);
    assert.equal(body.error, "contact_required");
  });

  it("预约成功后 GET /repair-orders/:orderId 能查回", async () => {
    const slotId = await firstSlotId();
    const { body } = await post("/repair-bookings", {
      vin: VIN_EV,
      slotId,
      contact: { name: "张先生", phone: "13800000000" },
    });
    const q = await get(`/repair-orders/${body.orderId}`);
    assert.equal(q.code, 200);
    assert.equal(q.body.slotId, slotId);
  });
});

describe("时段生成", () => {
  it("同参数两次生成逐字相同（确定性）；slotId 可解析回站点与时刻", () => {
    const a = generateRepairSlots({ stationId: "RS-HZ-01", now: new Date("2026-08-29T10:00:00+08:00") });
    const b = generateRepairSlots({ stationId: "RS-HZ-01", now: new Date("2026-08-29T10:00:00+08:00") });
    assert.deepEqual(a, b);
    assert.ok(a.length > 0);
    const parsed = parseRepairSlotId(a[0].slotId)!;
    assert.equal(parsed.stationId, "RS-HZ-01");
    assert.equal(parsed.startAt, a[0].startAt);
  });

  it("全部时段都在 now 之后", () => {
    const now = new Date("2026-08-29T10:00:00+08:00");
    for (const s of generateRepairSlots({ stationId: "RS-SH-01", now })) {
      assert.ok(Date.parse(s.startAt) > now.getTime());
    }
  });
});
