/**
 * 出发前能源余量确认（施工单 M26-07，F-54-03/04/08/09，AC-54-1/2/8/9/10）。
 *
 * 三条负向断言是重点：
 *  - **未知能源类型不问**（问错单位比不问更糟）；
 *  - **余量不落库**（`Vehicle` 表零变更，这是本 Sprint 唯一能靠 schema 断言守住的红线）；
 *  - **规划阶段不问、同一次行程只问一次**。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  PHEV_FUEL_DOMINANT_KM,
  decisiveEnergyFor,
  energyAskPrompt,
  parseDistanceKm,
  parseEnergyLevel,
} from "../src/graph/energy";
import { energySlotFor, looksLikeDeparting, pickElicitation } from "../src/graph/elicitation";
import { createElicitationService, type ElicitationDeps } from "../src/elicitation/service";

describe("energyAskPrompt：按能源类型问对单位", () => {
  it("燃油与增程问**升**", () => {
    for (const t of ["icev", "phev"] as const) {
      const a = energyAskPrompt(t);
      assert.equal(a?.unit, "L");
      assert.match(a?.ask ?? "", /多少升/);
    }
  });

  it("纯电问**百分比**", () => {
    const a = energyAskPrompt("bev");
    assert.equal(a?.unit, "%");
    assert.match(a?.ask ?? "", /百分之多少/);
  });

  it("**能源类型未知 → 不问**：问错单位比不问更糟", () => {
    assert.equal(energyAskPrompt(undefined), undefined);
  });

  it("问句一句话说完、不要求点任何控件（车机驾驶态）", () => {
    for (const t of ["icev", "phev", "bev"] as const) {
      const ask = energyAskPrompt(t)!.ask;
      assert.ok(ask.length <= 40, `${t} 的问句太长：${ask.length} 字`);
      assert.equal(/点击|打开设置|填一下|表单/.test(ask), false);
    }
  });
});

describe("decisiveEnergyFor：增程车一轮只问一种（F-54-09）", () => {
  it("非增程原样返回", () => {
    assert.equal(decisiveEnergyFor("bev", 500), "bev");
    assert.equal(decisiveEnergyFor("icev", 10), "icev");
    assert.equal(decisiveEnergyFor(undefined, 500), undefined);
  });

  it("增程 + 长途 → 问油", () => {
    assert.equal(decisiveEnergyFor("phev", PHEV_FUEL_DOMINANT_KM), "icev");
    assert.equal(decisiveEnergyFor("phev", 500), "icev");
  });

  it("增程 + 短途 → 问电", () => {
    assert.equal(decisiveEnergyFor("phev", PHEV_FUEL_DOMINANT_KM - 1), "bev");
  });

  it("增程 + 里程未知 → 按油（车主对「还有多少油」的答案更稳定）", () => {
    assert.equal(decisiveEnergyFor("phev", undefined), "icev");
  });

  it("**不做成两问表单**：任何情况下只返回一种能源", () => {
    for (const km of [10, 149, 150, 999, undefined]) {
      const r = decisiveEnergyFor("phev", km);
      assert.ok(r === "icev" || r === "bev");
    }
  });
});

describe("parseEnergyLevel / parseDistanceKm：兜底解析", () => {
  it("升与百分比各按各的单位解析，不互相串", () => {
    assert.deepEqual(parseEnergyLevel("大概还有 45 升吧", "L"), { value: 45, unit: "L" });
    assert.deepEqual(parseEnergyLevel("还剩 40%", "%"), { value: 40, unit: "%" });
    assert.equal(parseEnergyLevel("还剩 40%", "L"), undefined, "问升却答百分比 ⇒ 解析不出");
  });

  it("百分比超过 100 直接不认", () => {
    assert.equal(parseEnergyLevel("还有 140%", "%"), undefined);
  });

  it("里程从车主的话里取，超出合理范围不认", () => {
    assert.equal(parseDistanceKm("这趟大概 500 公里"), 500);
    assert.equal(parseDistanceKm("大概 300km"), 300);
    assert.equal(parseDistanceKm("就去楼下，5 公里"), undefined);
    assert.equal(parseDistanceKm("要跑 8000 公里"), undefined);
    assert.equal(parseDistanceKm("我要出发了"), undefined);
  });
});

describe("looksLikeDeparting：出发信号", () => {
  for (const t of ["我要出发了", "准备出发", "上路了", "这就出发", "出门了"]) {
    it(`认得出「${t}」`, () => assert.ok(looksLikeDeparting(t)));
  }
  for (const t of ["帮我规划一下去黄山", "国庆想带我妈去黄山看看"]) {
    it(`**规划阶段不认**：「${t}」`, () => assert.equal(looksLikeDeparting(t), false));
  }
});

describe("energySlotFor：规划阶段不问、只问一次、未知先补类型", () => {
  it("不是出发前 → 没有槽位", () => {
    assert.equal(energySlotFor(undefined), undefined);
  });

  it("这一趟已经问过 → 没有槽位（AC-54-1）", () => {
    assert.equal(energySlotFor({ energyType: "icev", alreadyAsked: true }), undefined);
  });

  it("能源类型未知 → 先补 `energy_type`，**不问余量**", () => {
    const s = energySlotFor({ alreadyAsked: false });
    assert.equal(s?.kind, "energy_type");
  });

  it("类型已知 → `energy_level`，且是 perishable", () => {
    const s = energySlotFor({ energyType: "bev", alreadyAsked: false });
    assert.equal(s?.kind, "energy_level");
    assert.equal(s?.timeliness, "perishable");
  });

  it("**出发前它压过 ④ 的两项**（AC-54-10）", () => {
    const energy = energySlotFor({ energyType: "icev", alreadyAsked: false })!;
    const picked = pickElicitation({
      slots: [
        { kind: "odometer", reason: "", weight: 10, timeliness: "deferrable", state: "pending" },
        { kind: "last_service", reason: "", weight: 20, timeliness: "deferrable", state: "pending" },
        energy,
      ],
      agent: "trip",
      answered: true,
      cooldown: new Set(),
    });
    assert.equal(picked?.kind, "energy_level");
  });
});

describe("服务层：问的是哪种单位，结算就按哪种解析", () => {
  let gapCalls: Array<Record<string, unknown>> = [];
  const deps = (energyType: "bev" | "icev"): ElicitationDeps => ({
    async freshness() {
      return { vin: "V1", items: [], suggested: [] };
    },
    async listCooldown() {
      return [];
    },
    async decline() {
      return undefined;
    },
    cooldownDays: () => 30,
    now: () => Date.now(),
    async extract() {
      return undefined;
    },
    async confirm() {
      return false;
    },
    async write() {
      return undefined;
    },
    async pretrip(_u, _t, markAsked) {
      return { energyType, distanceKm: 500, alreadyAsked: markAsked("plan-1") };
    },
    async energyGap(input) {
      gapCalls.push(input as unknown as Record<string, unknown>);
      return "【求解结果】缺 21 升";
    },
  });

  beforeEach(() => {
    gapCalls = [];
  });

  it("燃油：问升 → 车主答「45 升」→ 缺口测算收到 L 与里程", async () => {
    const s = createElicitationService(deps("icev"));
    const q = await s.next({
      sessionKey: "s",
      userId: "u",
      agent: "trip",
      answered: true,
      pretrip: { energyType: "icev", distanceKm: 500, alreadyAsked: false },
    });
    assert.match(q ?? "", /多少升/);
    const ctx = await s.settle("s", "t", "u", "大概还有 45 升");
    assert.equal(ctx, "【求解结果】缺 21 升");
    assert.deepEqual(gapCalls[0].level, { value: 45, unit: "L" });
    assert.equal(gapCalls[0].distanceKm, 500, "里程要留到结算那一轮");
  });

  it("纯电：问百分比 → 答「还剩 40%」→ 收到 %", async () => {
    const s = createElicitationService(deps("bev"));
    const q = await s.next({
      sessionKey: "s",
      userId: "u",
      agent: "trip",
      answered: true,
      pretrip: { energyType: "bev", distanceKm: 300, alreadyAsked: false },
    });
    assert.match(q ?? "", /百分之多少/);
    await s.settle("s", "t", "u", "还剩 40%");
    assert.deepEqual(gapCalls[0].level, { value: 40, unit: "%" });
  });

  it("**答不出来 → 不算缺口**，也不编（AC-54-7）", async () => {
    const s = createElicitationService(deps("icev"));
    await s.next({
      sessionKey: "s",
      userId: "u",
      agent: "trip",
      answered: true,
      pretrip: { energyType: "icev", distanceKm: 500, alreadyAsked: false },
    });
    const ctx = await s.settle("s", "t", "u", "不知道，没注意");
    assert.equal(ctx, undefined);
    assert.deepEqual(gapCalls, []);
  });

  it("余量提问**不走复述确认**——没有副作用就不该有弹窗", async () => {
    let confirms = 0;
    const d = deps("icev");
    const s = createElicitationService({
      ...d,
      async confirm() {
        confirms += 1;
        return true;
      },
    });
    await s.next({
      sessionKey: "s",
      userId: "u",
      agent: "trip",
      answered: true,
      pretrip: { energyType: "icev", distanceKm: 500, alreadyAsked: false },
    });
    await s.settle("s", "t", "u", "还有 45 升");
    assert.equal(confirms, 0, "余量不落库 ⇒ 不是敏感动作 ⇒ 不弹窗");
  });
});

describe("AC-54-8：余量绝不落库（schema 级断言）", () => {
  it("`Vehicle` 表**没有任何实时余量字段**", () => {
    const schema = fs.readFileSync(
      path.join(process.cwd(), "../../../enterprise/backend/shared/db/prisma/schema.prisma"),
      "utf8",
    );
    const begin = schema.indexOf("model Vehicle {");
    const end = schema.indexOf("}", begin);
    const body = schema.slice(begin, end);
    for (const needle of ["fuelLevel", "currentFuel", "soc", "batteryLevel", "energyLevel", "remainingFuel"]) {
      assert.equal(
        new RegExp(needle, "i").test(body),
        false,
        `Vehicle 不该有「${needle}」——余量是此刻的值，写进不衰减的 ④ 就是一条明天就错的事实`,
      );
    }
  });

  it("能源余量的类型**只存在于图/服务层**，不出现在 `VehicleProfile` 上", () => {
    const store = fs.readFileSync(
      path.join(process.cwd(), "../../../enterprise/backend/shared/memory/src/vehicle-store.ts"),
      "utf8",
    );
    const begin = store.indexOf("export interface VehicleProfile");
    const end = store.indexOf("}", begin);
    const body = store.slice(begin, end);
    assert.equal(/fuel|soc|energyLevel/i.test(body), false);
  });
});

describe("fail-open：补录侧抛错不该掀翻这一轮回答", () => {
  it("`answerNode` 里那次 `resolveElicitation` 被 try/catch 包着", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/graph/supervisor.ts"),
      "utf8",
    );
    const at = src.indexOf("resolveElicitation?.({");
    assert.ok(at > 0, "找不到调用点");
    // 往前找 400 字符内必须有 try {
    const before = src.slice(Math.max(0, at - 400), at);
    assert.ok(
      before.includes("try {"),
      "resolveElicitation 必须在 try 里——它抛错会让车主这一轮一个字都拿不到",
    );
  });

  it("`pretripOf` 抛错时 `next` 不抛，只是不问", async () => {
    const s = createElicitationService({
      async freshness() {
        return { vin: "V1", items: [], suggested: [] };
      },
      async listCooldown() {
        return [];
      },
      async decline() {
        return undefined;
      },
      cooldownDays: () => 30,
      now: () => Date.now(),
      async extract() {
        return undefined;
      },
      async confirm() {
        return false;
      },
      async write() {
        return undefined;
      },
      async pretrip() {
        throw new Error("库挂了");
      },
    });
    // pretripOf 自己会把异常抛给调用方，而调用方（turn-runner/answerNode）负责兜住。
    await assert.rejects(() => s.pretripOf!("u", "我要出发了"));
    // 但 next 本身在没有 pretrip 时照常工作
    assert.equal(
      await s.next({ sessionKey: "s", userId: "u", agent: "trip", answered: true }),
      undefined,
    );
  });
});
