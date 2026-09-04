/**
 * 维修预约引导子图（施工单 M44-02）。
 *
 * 三条主线与试驾测试同源：指代解析不猜、图直调必须自己过权限门与带外发项、
 * 没确认就绝不说已经约好。整图用例照 test-drive.test.ts 的形态：
 * stub 后端 + answerOnly 流 + 假权限门，断言**喂给应答节点的上下文**。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  setRepairBackend,
  setMemberStores,
  setAppointmentBackend,
  setVehicleStore,
  createRepairAppointmentBackend,
  type RepairBackend,
} from "@carlife/tools";
import type { VehicleProfile } from "@carlife/memory";

import { buildChatGraph } from "../src/graph/supervisor";
import { setGuardGate } from "../src/tools-endpoint";
import {
  repairBookingIntent,
  REPAIR_BOOKING_REFINE,
  pickRepairItems,
  startsNewRepairBooking,
  runRepairBooking,
} from "../src/graph/subgraphs/repair-booking";
import type { ChatStreamer } from "../src/llm";

// ── 意图门与解析（纯函数）────────────────────────────────────

describe("意图门：判得窄，含糊句走双路", () => {
  it("预约类说法命中", () => {
    for (const q of [
      "帮我预约明天上午9点做机油保养",
      "帮我预约 9 月 1 号上午 9 点在上海浦东前滩服务中心做机油保养",
      "想约个维修",
      "帮我约一下保养",
      "保养能约个时间吗",
    ]) {
      assert.ok(repairBookingIntent(q), q);
    }
  });

  it("查询/留档/症状类不命中——那些归双路与留档路径", () => {
    for (const q of [
      "我这辆车最近修过什么",
      "帮我记录一下今天做了保养",
      "刹车有异响要不要紧",
      "保养周期是多久",
      "这次维修保险能报多少",
    ]) {
      assert.ok(!repairBookingIntent(q), q);
    }
  });

  it("粘性判据认选择类句式", () => {
    for (const q of ["就第一家吧", "上午9点那个", "周一的", "我姓张 13800001234", "确认"]) {
      assert.ok(REPAIR_BOOKING_REFINE.test(q), q);
    }
    assert.ok(!REPAIR_BOOKING_REFINE.test("今天天气怎么样"));
  });

  it("维修项目词表：抓到记原词，抓不到给 undefined（上层默认常规保养）", () => {
    assert.equal(pickRepairItems("帮我约机油保养"), "机油、保养");
    assert.equal(pickRepairItems("轮胎该换了帮我约"), "轮胎");
    assert.equal(pickRepairItems("帮我约一下"), undefined);
  });

  it("已下单的计划：明说再约/新预约才重开", () => {
    const booked = { orderId: "RB-1", status: "booked" } as never;
    assert.ok(startsNewRepairBooking("再帮我约一次保养", booked));
    assert.ok(startsNewRepairBooking("帮我预约下周的维修", booked));
    assert.ok(!startsNewRepairBooking("我那单约的几点来着", booked));
  });
});

// ── 整图：多步引导 → 权限门 → 下单 ───────────────────────────

const answerPrompts: string[] = [];
const answerOnly: ChatStreamer = async function* (m) {
  answerPrompts.push(m.map((x) => x.content).join("\n"));
  yield "[答]";
};
const lastPrompt = () => answerPrompts.at(-1) ?? "";

const VIN = "DEM00SEED0M0DELY1";

const PROFILE: VehicleProfile = {
  vin: VIN,
  ownerId: "u1",
  model: "Model Y",
  modelYear: 2023,
  purchasedAt: Date.parse("2024-07-01"),
  odometerKm: 41280,
  maintenance: [],
  repairs: [],
  updatedAt: Date.now(),
};

const STATIONS = [
  { stationId: "RS-SH-01", name: "上海浦东前滩服务中心", city: "上海", district: "浦东新区", services: ["保养"] },
  { stationId: "RS-SH-02", name: "上海闵行虹桥服务中心", city: "上海", district: "闵行区", services: ["保养"] },
];

const SLOTS = [
  { slotId: "RS-SH-01#2026-09-01T09:00:00+08:00", stationId: "RS-SH-01", startAt: "2026-09-01T09:00:00+08:00", remaining: 2 },
  { slotId: "RS-SH-01#2026-09-01T11:00:00+08:00", stationId: "RS-SH-01", startAt: "2026-09-01T11:00:00+08:00", remaining: 2 },
  { slotId: "RS-SH-02#2026-09-02T09:00:00+08:00", stationId: "RS-SH-02", startAt: "2026-09-02T09:00:00+08:00", remaining: 2 },
];

let bookedArgs: Record<string, unknown> | undefined;

const fakeRepair = (): RepairBackend => ({
  async history() {
    return { vin: VIN, records: [], known: false };
  },
  async stations() {
    return { stations: STATIONS as never, matched: STATIONS.length };
  },
  async slots(a) {
    return { slots: SLOTS.filter((s) => s.stationId === a.stationId) as never };
  },
  async book(a) {
    bookedArgs = a as never;
    return { orderId: "RB-000042", status: "confirmed", stationName: "上海浦东前滩服务中心", startAt: a.slotId.split("#")[1] };
  },
  async quotes() {
    return { quotes: [], matched: 0 };
  },
});

function installStores(withPhone: boolean): void {
  setVehicleStore({
    async get() {
      return PROFILE;
    },
    async listByOwner() {
      return [PROFILE];
    },
    async upsert() {},
    async setDefault() {},
  } as never);
  setMemberStores(
    {
      async listByVehicle() {
        return [];
      },
      async listByOwner() {
        return withPhone
          ? [{ id: "mem-1", vin: VIN, ownerId: "u1", displayName: "张先生", roles: ["driver"], needs: [], phone: "13912345613", updatedAt: Date.now() } as never]
          : [];
      },
      async get(_o: string, id: string) {
        return withPhone && id === "mem-1"
          ? ({ id: "mem-1", vin: VIN, ownerId: "u1", displayName: "张先生", roles: ["driver"], needs: [], phone: "13912345613", updatedAt: Date.now() } as never)
          : null;
      },
      async upsert(m: never) {
        return m;
      },
      async remove() {
        return null;
      },
    } as never,
    undefined as never,
  );
}

const cfg = (id: string) => ({
  configurable: { thread_id: id, userId: "u1", emit: { onDelta: () => {} } },
});

describe("整图：维修预约多步引导与下单", () => {
  beforeEach(() => {
    answerPrompts.length = 0;
    bookedArgs = undefined;
    const repair = fakeRepair();
    setRepairBackend(repair);
    setAppointmentBackend(createRepairAppointmentBackend(repair));
    installStores(true);
    setGuardGate({ check: async () => ({ decision: "allow", reason: "ok" }) } as never);
  });
  afterEach(() => {
    setRepairBackend(undefined);
    setVehicleStore(undefined);
    setMemberStores(undefined, undefined as never);
  });

  it("一步到位：站名+窗口时间+档案号 → 一轮走到权限门并下单，VIN 进 subject", async () => {
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("t-rb-1");
    const s = await graph.invoke(
      { messages: [{ role: "user", content: "帮我预约 9 月 1 号上午 9 点在上海浦东前滩服务中心做机油保养" }] },
      c,
    );
    assert.equal((s.repairBookingPlan as { status: string }).status, "booked");
    assert.equal((s.repairBookingPlan as { orderId: string }).orderId, "RB-000042");
    assert.equal(bookedArgs?.vin, VIN, "VIN 经 subject 前缀抵达维修系统");
    assert.match(lastPrompt(), /已下单成功/);
    assert.match(lastPrompt(), /尾号 5613/, "档案路：告知尾号不念星号");
  });

  it("多步引导：不带信息 → 列站；每一步都带『没约上就别说约好』拦截", async () => {
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("t-rb-2");
    const s1 = await graph.invoke({ messages: [{ role: "user", content: "帮我约个保养" }] }, c);
    assert.equal((s1.repairBookingPlan as { status: string }).status, "choosing_station");
    assert.match(lastPrompt(), /上海浦东前滩服务中心/);
    assert.match(lastPrompt(), /本轮没有约上任何时段/);

    const s2 = await graph.invoke({ messages: [{ role: "user", content: "就第一家吧" }] }, c);
    assert.equal((s2.repairBookingPlan as { status: string }).status, "choosing_slot");
    assert.match(lastPrompt(), /进厂时段/);

    const s3 = await graph.invoke({ messages: [{ role: "user", content: "9 月 1 号上午 9 点那个" }] }, c);
    assert.equal((s3.repairBookingPlan as { status: string }).status, "booked");
  });

  it("『上午』命中两个时段 → 回去问，不替他挑", async () => {
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("t-rb-3");
    await graph.invoke({ messages: [{ role: "user", content: "帮我约个保养" }] }, c);
    await graph.invoke({ messages: [{ role: "user", content: "第一家" }] }, c);
    const s = await graph.invoke({ messages: [{ role: "user", content: "上午吧" }] }, c);
    assert.equal((s.repairBookingPlan as { status: string }).status, "choosing_slot");
    assert.match(lastPrompt(), /本轮没有约上任何时段/);
  });

  it("权限门拒绝 → 不下单、退回选时段、明说没约上", async () => {
    setGuardGate({ check: async () => ({ decision: "deny", reason: "用户拒绝" }) } as never);
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("t-rb-4");
    const s = await graph.invoke(
      { messages: [{ role: "user", content: "帮我预约 9 月 1 号上午 9 点在上海浦东前滩服务中心做保养" }] },
      c,
    );
    assert.equal(bookedArgs, undefined, "没有下单");
    assert.equal((s.repairBookingPlan as { status: string }).status, "choosing_slot");
    assert.match(lastPrompt(), /没有下单/);
    assert.match(lastPrompt(), /绝不要说已经约好/);
  });

  it("档案无号：走到联系方式一步会开口问，口述后用口述号下单", async () => {
    installStores(false);
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("t-rb-5");
    const s1 = await graph.invoke(
      { messages: [{ role: "user", content: "帮我预约 9 月 1 号上午 9 点在上海浦东前滩服务中心做保养" }] },
      c,
    );
    assert.equal((s1.repairBookingPlan as { status: string }).status, "confirming");
    assert.match(lastPrompt(), /还差联系方式/);

    const s2 = await graph.invoke({ messages: [{ role: "user", content: "我姓李，13900001111" }] }, c);
    assert.equal((s2.repairBookingPlan as { status: string }).status, "booked");
    assert.equal((bookedArgs?.contact as { phone: string }).phone, "13900001111");
  });

  it("没有车辆档案（缺 VIN）→ 引导建档，不查站不下单", async () => {
    setVehicleStore(undefined);
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("t-rb-6");
    await graph.invoke({ messages: [{ role: "user", content: "帮我约个保养" }] }, c);
    assert.match(lastPrompt(), /缺 VIN|车辆档案/);
    assert.ok(!lastPrompt().includes("上海浦东前滩服务中心"), "缺档案时不报站名");
  });

  it("维修系统被杀：如实说没连通，一个站名都不说", async () => {
    setRepairBackend(undefined);
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("t-rb-7");
    await graph.invoke({ messages: [{ role: "user", content: "帮我约个保养" }] }, c);
    assert.match(lastPrompt(), /没连通|未接入/);
    assert.ok(!lastPrompt().includes("上海浦东前滩服务中心"));
  });
});

describe("runRepairBooking：booking args 形状", () => {
  it("档案路：memberId/userId 进 args、明文不进图状态、幂等键含 slotId", async () => {
    const repair = fakeRepair();
    setRepairBackend(repair);
    installStores(true);
    const ctx = { sessionId: "s-shape", agent: "service" as const, mode: "real" as const };
    let turn = await runRepairBooking({ raw: "帮我约保养", vin: VIN, userId: "u1", ctx, sessionId: "s-shape" });
    turn = await runRepairBooking({ raw: "第一家", vin: VIN, userId: "u1", prior: turn.plan, ctx, sessionId: "s-shape" });
    turn = await runRepairBooking({ raw: "9月1号上午9点", vin: VIN, userId: "u1", prior: turn.plan, ctx, sessionId: "s-shape" });
    assert.ok(turn.booking, "第三轮应产出 booking");
    const a = turn.booking!.args as Record<string, unknown>;
    assert.equal(a.kind, "service");
    assert.equal(a.memberId, "mem-1");
    assert.equal(a.userId, "u1");
    assert.equal(a.contact, undefined, "档案路不带明文 contact");
    assert.match(String(a.subject), /^VIN:DEM00SEED0M0DELY1 /);
    assert.equal(a.idempotencyKey, "s-shape:RS-SH-01#2026-09-01T09:00:00+08:00");
    assert.ok(turn.booking!.disclosures.some((d) => d.includes("···****5613")), "披露带掩码尾号");
    assert.ok(!JSON.stringify(turn.plan).includes("13912345613"), "真号不进图状态");
    setRepairBackend(undefined);
    setVehicleStore(undefined);
    setMemberStores(undefined, undefined as never);
  });
});

/**
 * goal 门（ACR-023 / M69-03）：副任务轮里原话是「顺路把保养做了，帮我安排」，过不了 BOOKING_RE；
 * 意图层改写的 goal「在杭州预约一次保养」过得了。supervisor 的门改成"原话或 goal 任一命中"——
 * 不是加正则，是让模型的改写结果也能当输入。
 */
describe("[F-20-12][AC-20-9] 副任务的 goal 也能过预约门（M69-03）", () => {
  it("原话「顺路把保养做了，帮我安排」过不了字面门——这就是为什么要看 goal", () => {
    assert.equal(repairBookingIntent("下周末带父母去杭州自驾，顺路把保养做了，帮我安排"), false);
  });
  it("意图层改写的规范说法过得了", () => {
    assert.equal(repairBookingIntent("在杭州预约一次保养"), true);
    assert.equal(repairBookingIntent("预约一次新车试驾"), false, "试驾不是维修预约");
  });
});
