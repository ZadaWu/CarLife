/**
 * 座舱直接控制路径（施工单 M24-04）。
 *
 * 三条主线：**解析器的拿不准落陪聊**（返回 null，不动手）、**混合单确认在前**
 * （儿童模式被拒 → 整单零下发）、**四态转述穷举**（clamped 带两个值、skipped 带
 * 原因、部分成功不得说成全部成功——断言到文本）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCabinCommands } from "../src/graph/cabin-commands";
import { describeCabinResults, runCabinControl } from "../src/graph/subgraphs/cabin";
import type { CabinOpResult } from "@carlife/tools";

describe("parseCabinCommands：封闭语汇，拿不准落陪聊", () => {
  it("陪聊话术 → null（一动不动）", () => {
    assert.equal(parseCabinCommands("今天有点困，随便聊聊吧"), null);
    assert.equal(parseCabinCommands("空调怎么用？"), null, "咨询不是指令——没有动作词");
  });

  it("「空调调到 23 度，座椅加热开 2 档」→ 两条舒适域 op", () => {
    const p = parseCabinCommands("空调调到 23 度，座椅加热开 2 档")!;
    assert.deepEqual(p.child, []);
    assert.deepEqual(p.comfort, [
      { domain: "climate", set: { tempC: 23 } },
      { domain: "seat", zone: "driver", set: { heating: 2 } },
    ]);
  });

  it("「后排通风开一下，温度 35 度」→ 后排两个座位 + 温度（越界交给车机裁决）", () => {
    const p = parseCabinCommands("后排通风开一下，温度 35 度")!;
    assert.deepEqual(p.comfort, [
      { domain: "seat", zone: "rearLeft", set: { ventilation: 2 } },
      { domain: "seat", zone: "rearRight", set: { ventilation: 2 } },
      { domain: "climate", set: { tempC: 35 } },
    ]);
  });

  it("「后排放儿歌，音量上限 40，屏幕锁上」→ 舒适域 + child 分组", () => {
    const p = parseCabinCommands("后排放儿歌，音量上限 40，屏幕锁上")!;
    assert.deepEqual(p.comfort, [
      { domain: "media", zone: "rear", set: { source: "kids", contentTag: "儿歌" } },
      { domain: "media", set: { volumeLimit: 40 } },
    ]);
    assert.deepEqual(p.child, [{ domain: "childMode", set: { screenLock: true } }]);
  });

  it("**多字动词**：「帮我启动座椅按摩」是指令（turn-85f920d4 回归）", () => {
    // 真跑踩到：整句一个单字动词都不命中 → 静默落陪聊，助手答"操作不了"。
    // 这正是 M24-01 为之收窄硬禁的那一句——闸门开了，车却没开过去。
    const p = parseCabinCommands("帮我启动座椅按摩")!;
    assert.deepEqual(p.comfort, [{ domain: "seat", zone: "driver", set: { massage: "wave" } }]);
  });

  it("「开启氛围灯」给中等亮度；「关掉」给 0（顺序：关 > 明暗 > 光秃秃的开）", () => {
    assert.deepEqual(parseCabinCommands("开启氛围灯")!.comfort, [{ domain: "ambientLight", set: { brightness: 50 } }]);
    assert.deepEqual(parseCabinCommands("把氛围灯关掉")!.comfort, [{ domain: "ambientLight", set: { brightness: 0 } }]);
  });

  it("**问怎么做 ≠ 让你做**：疑问句一律落陪聊，不擅自动手", () => {
    for (const q of ["座椅加热怎么开", "座椅按摩怎么启动", "空调支持分区吗", "氛围灯在哪调"]) {
      assert.equal(parseCabinCommands(q), null, `应落陪聊：${q}`);
    }
  });

  it("像设置但没有值 →进 unparsed（追问，不瞎猜）", () => {
    const p = parseCabinCommands("把温度调一下")!;
    assert.deepEqual(p.comfort, []);
    assert.equal(p.unparsed.length, 1);
  });

  it("同域同区合并成一条 op（温度+风量不拆两条流水）", () => {
    const p = parseCabinCommands("空调 23 度风量 3")!;
    assert.equal(p.comfort.length, 1);
    assert.deepEqual(p.comfort[0]!.set, { tempC: 23, fanLevel: 3 });
  });
});

describe("describeCabinResults：四态穷举", () => {
  const results: CabinOpResult[] = [
    {
      index: 0, domain: "climate", zones: ["driver"], status: "partial",
      applied: { tempC: 28 },
      clamped: { tempC: { requested: 35, applied: 28, note: "范围 16~28℃，步进 0.5" } },
      skipped: {},
    },
    {
      index: 1, domain: "seat", zones: ["rearLeft"], status: "partial",
      applied: { heating: 2 }, clamped: {}, skipped: { ventilation: "unsupported_on_this_vehicle: rearLeft 无座椅通风" },
    },
    { index: 2, domain: "fragrance", zones: [], status: "rejected", applied: {}, clamped: {}, skipped: {}, reason: "此车型无香氛系统" },
  ];

  it("clamped 带两个值、skipped 带原因、rejected 进没做到", () => {
    const d = describeCabinResults(results);
    assert.deepEqual(d.done, ["后排左座椅加热：2 档"]);
    assert.match(d.adjusted[0]!, /您要 35℃/);
    assert.match(d.adjusted[0]!, /28℃ 执行/);
    assert.equal(d.undone.length, 2);
    assert.match(d.undone[0]!, /无座椅通风/);
    assert.match(d.undone[1]!, /无香氛系统/);
  });
});

describe("runCabinControl：混合单与降级", () => {
  const ctx = { sessionId: "s1", turnId: "t1", agent: "cabin" as const };

  it("儿童模式被拒 → **整单零下发**（舒适域也不发）", async () => {
    const invoked: string[] = [];
    const out = await runCabinControl({
      query: "后排屏幕锁上，空调 23 度",
      userId: "u1",
      ctx,
      gate: { async check() { return { decision: "deny", reason: "用户取消" }; } },
      invoke: (async (name: string) => {
        invoked.push(name);
        throw new Error("不该被调用");
      }) as never,
    });
    assert.ok(out);
    assert.equal(invoked.length, 0, "拒绝后没有任何下发");
    assert.match(out!.context, /什么都没有下发/);
    assert.equal(out!.trace.childDenied, true);
  });

  it("混合单确认通过 → child 先行、comfort 随后；转述覆盖全部条目", async () => {
    const invoked: string[] = [];
    const out = await runCabinControl({
      query: "后排屏幕锁上，空调 23 度",
      userId: "u1",
      ctx,
      gate: { async check() { return { decision: "allow" }; } },
      invoke: (async (name: string) => {
        invoked.push(name);
        return {
          data: {
            vin: "V", model: "M", requestId: `rq-${invoked.length}`, duplicate: false, rebuilt: false, state: {},
            results: [
              name === "cabin_child_mode"
                ? { index: 0, domain: "childMode", zones: ["rearLeft"], status: "applied", applied: { screenLock: true }, clamped: {}, skipped: {} }
                : { index: 0, domain: "climate", zones: ["cabin"], status: "applied", applied: { tempC: 23 }, clamped: {}, skipped: {} },
            ],
          },
        };
      }) as never,
    });
    assert.deepEqual(invoked, ["cabin_child_mode", "cabin_control"], "确认在前、下发在后");
    assert.match(out!.context, /后排屏幕锁：开/);
    assert.match(out!.context, /温度：23℃/);
    assert.match(out!.context, /必须覆盖以上全部条目/);
    assert.equal(out!.trace.requestIds.length, 2);
  });

  it("工具层降级（车机没连上）→ 原话进转述，明令不许说已调好", async () => {
    const out = await runCabinControl({
      query: "空调 23 度",
      userId: "u1",
      ctx,
      invoke: (async () => {
        throw new Error("[cabin] 车机没连上（fetch failed）——这次设置不了");
      }) as never,
    });
    assert.match(out!.context, /车机没连上/);
    assert.match(out!.context, /不要说任何"已调好\/已设置"/);
  });

  it("陪聊话术返回 null——陪聊路径行为归 runCabinContext（回归在既有测试）", async () => {
    const out = await runCabinControl({ query: "随便聊聊", userId: "u1", ctx });
    assert.equal(out, null);
  });
});
