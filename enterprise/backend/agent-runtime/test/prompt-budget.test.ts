/**
 * 统一问题预算（施工单 M106-02）。
 *
 * 守的是一条车主视角的不变量：**一轮里向他要的东西有上限，而且这个上限是对所有来源一起算的**。
 * 在这之前问诊追问与事实补录各守各的上限，合起来三个问题一起上。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isAskPrompt } from "@carlife/shared";

import { PROMPT_BUDGET, RETAKE_DEFAULT_HINT, budgetPrompts, captureFromRetakeHints } from "../src/graph/prompt-budget";
import { QUESTION_BANK, budgetInputFor, buildDiagnosisReport } from "../src/graph/diagnosis";
import { createElicitationService, type ElicitationDeps } from "../src/elicitation/service";

const bank = (...ids: string[]) => ids.map((id) => QUESTION_BANK.find((q) => q.id === id)!);
const ask = (text: string, extra: Record<string, unknown> = {}) => ({ kind: "single", text, options: ["是", "不是"], allowOther: true, ...extra });
const guidance = (title = "检查副驾安全带卡扣") => ({
  kind: "guidance",
  title,
  steps: ["把副驾座位上的物品拿走", "把安全带插舌拔出再插到底"],
  source: "用户手册 › 座椅与安全带",
  outcomes: ["灯灭了", "还亮着", "做不了"],
});
const capture = (title = "拍一下副驾座椅") => ({ kind: "capture", title, hint: "看看座位上有没有放东西" });
const base = { bank: [], retakeHints: [], proposals: [], riskLevel: "medium" } as const;

describe("[F-20-09][AC-20-7] 预算：问题位 2、跨轮去重、至多两轮", () => {
  it("只有题库两题 ⇒ 两张芯片题，单选多选各按题自己说的，问题位用完", () => {
    const r = budgetPrompts({ ...base, bank: bank("parked", "since") });
    // `since` 是多选（一张照片上不止一盏灯，「刚才亮的」与「一直亮着的」可以各指一盏）；`parked` 三项互斥仍是单选。
    assert.deepEqual(r.prompts.map((p) => [p.id, p.kind, p.origin]), [["parked", "single", "code"], ["since", "multi", "code"]]);
    assert.equal(r.asksLeft, 0);
    assert.equal(PROMPT_BUDGET.asks, 2);
  });

  it("模型 1 问 + 题库 2 题 ⇒ 模型那条 + 题库第一条——两路都不被饿死", () => {
    const r = budgetPrompts({ ...base, bank: bank("parked", "since"), proposals: [ask("副驾座位上放东西了吗？")] });
    assert.deepEqual(r.prompts.map((p) => p.origin), ["model", "code"]);
    assert.equal(r.prompts[1]!.id, "parked");
    assert.deepEqual(r.dropped, [{ reason: "no_ask_slot", id: "since", kind: "multi" }]);
  });

  it("模型 3 问 + 题库 0 ⇒ 前两条", () => {
    const r = budgetPrompts({ ...base, proposals: [ask("问一？"), ask("问二？"), ask("问三？")] });
    assert.equal(r.prompts.length, 2);
    assert.equal(r.dropped.filter((d) => d.reason === "no_ask_slot").length, 1);
  });

  it("失败追问占掉一位 ⇒ 只出一条；两位都被占 ⇒ 零问", () => {
    assert.equal(budgetPrompts({ ...base, bank: bank("parked", "since"), reservedAsks: 1 }).prompts.length, 1);
    assert.equal(budgetPrompts({ ...base, bank: bank("parked", "since"), reservedAsks: 2 }).prompts.length, 0);
  });

  it("已经问过两轮 ⇒ 零问，但拍照与引导照出（它们不计轮）", () => {
    const r = budgetPrompts({
      ...base,
      bank: bank("when", "worse"),
      retakeHints: ["右侧没拍到，请补一张"],
      proposals: [guidance()],
      previous: { askedRounds: 2, askedIds: [] },
    });
    assert.deepEqual(r.prompts.map((p) => p.kind), ["capture", "guidance"]);
    assert.equal(r.asksLeft, 0, "轮次用完时也不给 elicitation 留位——车主已经被问了两轮");
    assert.ok(r.dropped.every((d) => d.reason === "rounds_exhausted"));
  });

  it("问过的不再问：题库按 id，模型按内容哈希（同一句话两轮 id 相同）", () => {
    const first = budgetPrompts({ ...base, proposals: [ask("副驾座位上放东西了吗？", { id: "q1" })] });
    const again = budgetPrompts({ ...base, proposals: [ask("副驾座位上放东西了吗？", { id: "anything-else" })] });
    const mid = first.prompts[0]!.id;
    assert.match(mid, /^m-single-[0-9a-f]{8}$/, "模型自报的 id 不可信，由代码按内容重写");
    assert.equal(again.prompts[0]!.id, mid);
    const r = budgetPrompts({ ...base, bank: bank("parked"), proposals: [ask("副驾座位上放东西了吗？")], previous: { askedRounds: 1, askedIds: ["parked", mid] } });
    assert.deepEqual(r.prompts, []);
    assert.deepEqual(r.dropped.map((d) => d.reason), ["asked_before", "asked_before"]);
  });

  it("同一轮里模型把一句话提了两遍 ⇒ 留第一条", () => {
    const r = budgetPrompts({ ...base, proposals: [ask("问一？"), ask("问一？")] });
    assert.equal(r.prompts.length, 1);
    assert.deepEqual(r.dropped.map((d) => d.reason), ["duplicate"]);
  });
});

describe("[F-20-08][AC-20-6] 预算：引导与拍照各一张，渲染顺序固定", () => {
  it("high 不放行引导——报告正在说「建议立即停止」", () => {
    const high = budgetPrompts({ ...base, riskLevel: "high", proposals: [guidance()] });
    assert.deepEqual(high.prompts, []);
    assert.equal(high.dropped[0]!.reason, "high_risk_no_guidance");
    for (const riskLevel of ["medium", "low"] as const) {
      assert.equal(budgetPrompts({ ...base, riskLevel, proposals: [guidance()] }).prompts[0]!.kind, "guidance");
    }
  });

  it("观察层的补拍压过模型的拍照；多条提示拼成说明，只有一条时给缺省说明", () => {
    const r = budgetPrompts({ ...base, retakeHints: ["右侧没拍到", "离近一点"], proposals: [capture()] });
    assert.equal(r.prompts.length, 1);
    const c = r.prompts[0]!;
    assert.ok(c.kind === "capture" && c.origin === "code" && c.title === "右侧没拍到" && c.hint === "离近一点");
    assert.equal(r.dropped[0]!.reason, "code_capture_wins");
    const solo = captureFromRetakeHints(["右侧没拍到，请补一张"]);
    assert.ok(solo?.kind === "capture" && solo.hint === RETAKE_DEFAULT_HINT);
    assert.equal(captureFromRetakeHints([]), null);
  });

  it("同一句补拍提示第二轮还在 ⇒ 照出：车主补的那张还是没拍到", () => {
    const first = budgetPrompts({ ...base, retakeHints: ["右侧没拍到"] });
    const again = budgetPrompts({ ...base, retakeHints: ["右侧没拍到"], previous: { askedRounds: 0, askedIds: [first.prompts[0]!.id] } });
    assert.equal(again.prompts.length, 1);
  });

  it("没有观察层补拍时模型的拍照留第一张；引导留第一张", () => {
    const r = budgetPrompts({ ...base, proposals: [capture("拍一下副驾座椅"), capture("拍一下卡扣"), guidance("检查卡扣"), guidance("检查座椅")] });
    assert.deepEqual(r.prompts.map((p) => p.kind), ["capture", "guidance"]);
    assert.deepEqual(r.dropped.map((d) => d.reason).sort(), ["over_capture", "over_guidance"]);
  });

  it("全满 ⇒ 4 张，顺序 拍照 → 引导 → 提问", () => {
    const r = budgetPrompts({ ...base, bank: bank("when", "worse"), retakeHints: ["右侧没拍到"], proposals: [guidance(), ask("问一？"), ask("问二？")] });
    assert.deepEqual(r.prompts.map((p) => p.kind), ["capture", "guidance", "single", "multi"]);
    assert.equal(r.prompts.length, PROMPT_BUDGET.total);
    assert.equal(r.prompts.filter(isAskPrompt).length, PROMPT_BUDGET.asks);
  });
});

describe("[F-20-09][AC-20-7] 预算：模型的字进报告之前过校验、硬禁、脱敏", () => {
  it("不合法的条目逐条丢，不连坐", () => {
    const r = budgetPrompts({ ...base, proposals: [ask("选项太多？", { options: ["一", "二", "三", "四", "五", "六"] }), "一句话", null, ask("这条是好的？")] });
    assert.equal(r.prompts.length, 1);
    assert.equal(r.dropped.filter((d) => d.reason === "invalid").length, 3);
  });

  it("模型自称 origin: code 也没用", () => {
    const r = budgetPrompts({ ...base, proposals: [ask("问一？", { origin: "code", id: "parked" })] });
    assert.equal(r.prompts[0]!.origin, "model");
    assert.notEqual(r.prompts[0]!.id, "parked", "冒用题库 id 也不行——否则能把题库那道挤成 duplicate");
  });

  it("命中硬禁的引导被丢（「肯定是…坏了」是确定性结论）", () => {
    const bad = { ...guidance("肯定是传感器坏了，需要更换"), steps: ["把副驾座位上的物品拿走", "直接去换传感器"] };
    const r = budgetPrompts({ ...base, proposals: [bad] });
    assert.deepEqual(r.prompts, []);
    assert.equal(r.dropped[0]!.reason, "hard_block");
  });

  it("文案里的手机号被掩码", () => {
    const r = budgetPrompts({ ...base, proposals: [{ kind: "open", text: "是 13812345678 这个号吗？" }] });
    const p = r.prompts[0]!;
    assert.ok(p.kind === "open");
    assert.ok(!p.text.includes("13812345678"), p.text);
  });
});

describe("[F-53-05][AC-53-4] 问诊追问与事实补录共用一份预算", () => {
  const report = { vin: "LSJA24U91NS654321", items: [{ item: "odometer", verdict: "stale", reason: "97 天没更新" }], suggested: ["odometer"] };
  let freshnessCalls = 0;
  const declines: string[] = [];
  const deps = (): ElicitationDeps => ({
    async freshness() {
      freshnessCalls += 1;
      return report;
    },
    async listCooldown() {
      return [] as never;
    },
    async decline(input) {
      declines.push(input.kind);
      return undefined;
    },
    cooldownDays: () => 30,
    now: () => Date.UTC(2026, 8, 18),
    async extract() {
      return undefined;
    },
    async confirm() {
      return true;
    },
    async write() {
      return undefined;
    },
  });

  it("问题位为 0 ⇒ 不问、不查库、**不记成问过**", async () => {
    freshnessCalls = 0;
    declines.length = 0;
    const s = createElicitationService(deps());
    const turn = { sessionKey: "s-budget", userId: "u-m106", agent: "service", answered: true } as const;
    assert.equal(await s.next({ ...turn, questionBudgetLeft: 0 }), undefined);
    assert.equal(freshnessCalls, 0);
    // 要是上面那次被记成「问过」，这句「不用了」会被当成对它的拒答留痕进冷却——车主从此 30 天不再被问。
    await s.settle("s-budget", "t-budget", "u-m106", "不用了");
    assert.deepEqual(declines, []);
    // 同一个会话下一轮有位了，照常问得出来。
    assert.match((await s.next({ ...turn, questionBudgetLeft: 1 })) ?? "", /多少公里/);
    assert.match((await s.next({ ...turn, sessionKey: "s-unlimited" })) ?? "", /多少公里/, "不传 = 不限，旧调用方不变");
  });

  it("[F-54-10][AC-54-10] 车主明说要出发的那一轮给补录留一位：问诊只出一题，剩一位给过期即废的能源余量", () => {
    const r = budgetPrompts({ bank: [QUESTION_BANK[0]!, QUESTION_BANK[1]!], retakeHints: [], proposals: [], riskLevel: "medium", reserveForElicitation: true });
    assert.equal(r.asksUsed, 1);
    assert.equal(r.asksLeft, 1);
    // 失败追问已经占了一位时，留的那一位就是最后一位：问诊零题，补录那一问照样有位。
    const tight = budgetPrompts({ bank: [QUESTION_BANK[0]!], retakeHints: [], proposals: [], riskLevel: "medium", reservedAsks: 1, reserveForElicitation: true });
    assert.equal(tight.asksUsed, 0);
    assert.equal(tight.asksLeft, 1);
  });

  it("[F-54-10][AC-54-10] 问诊轮出了两题 ⇒ 留给补录的位是 0；只出一题 ⇒ 留 1", () => {
    const lamp = { items: [], unreadable: false, retakeHints: [], alerts: [] } as never;
    const full = budgetPrompts({ ...budgetInputFor({ photoObservation: lamp }), proposals: [] });
    assert.equal(full.asksUsed, 2);
    assert.equal(full.asksLeft, 0);
    const r1 = buildDiagnosisReport({ threadId: "t", agent: "service", photoObservation: lamp, budget: full, answer: "a" });
    const next = budgetPrompts({ ...budgetInputFor({ photoObservation: lamp, previous: { ...r1, askedIds: ["when"] } }), proposals: [] });
    assert.equal(next.asksUsed, 1);
    assert.equal(next.asksLeft, 1);
  });
});
