/**
 * 问诊轮的配合请求提议（施工单 M106-03）。
 *
 * 两层：纯函数（定界 JSON、拼输入、提示词里的上限不手抄）；图级（与应答并发、只在问诊轮起、
 * 超时 / 抛错 / 吐坏都只是少几张卡——这一跳不允许让车主这一轮少拿一个字）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import { INTERACTION_LIMITS, type DiagnosisReport } from "@carlife/shared";
import { setRagClient } from "@carlife/tools";

import { PROMPT_BUDGET } from "../src/graph/prompt-budget";
import { SERVICE_ASKS_AGENT, SERVICE_ASKS_SYSTEM, buildServiceAsksMessages, parseProposals, serviceAsksEnabled, serviceAsksGraceMs, startProposals } from "../src/graph/service-asks";
import { buildChatGraph } from "../src/graph/supervisor";
import type { ChatStreamer, ChatTurnMessage } from "../src/llm";

const SRC = readFileSync(new URL("../src/graph/service-asks.ts", import.meta.url), "utf8");
const SUPERVISOR = readFileSync(new URL("../src/graph/supervisor.ts", import.meta.url), "utf8");

const ASK = { kind: "single", text: "副驾座位上放东西了吗？", options: ["放了", "没放"], allowOther: false };
const GUIDE = { kind: "guidance", title: "检查副驾安全带卡扣", steps: ["把副驾座位上的物品拿走", "把插舌拔出再插到底"], source: "用户手册 › 座椅与安全带", outcomes: ["灯灭了", "还亮着"] };

describe("[F-20-09][AC-20-7] parseProposals：只定界，不理解", () => {
  it("纯数组 / 前后带解释 / 带 ```json 围栏 / 字符串里有括号，都取得出来", () => {
    const json = JSON.stringify([ASK]);
    assert.deepEqual(parseProposals(json), [ASK]);
    assert.deepEqual(parseProposals(`好的，以下是提议：\n${json}\n希望有帮助`), [ASK]);
    assert.deepEqual(parseProposals("```json\n" + json + "\n```"), [ASK]);
    const tricky = [{ ...ASK, text: "灯是不是像 ] 或 } 这样的形状？" }];
    assert.deepEqual(parseProposals(JSON.stringify(tricky)), tricky);
    assert.deepEqual(parseProposals("[]"), []);
  });

  it("坏 JSON、没配上、不是数组、空文本 ⇒ []", () => {
    for (const bad of ["", "没有可提的", "[{\"kind\":", "[1, 2", "{\"kind\":\"single\"}", "[fake:main] 你好"]) {
      assert.deepEqual(parseProposals(bad), [], bad);
    }
  });

  it("不在这里校验条目——那是预算器的事，一处校验", () => {
    assert.deepEqual(parseProposals('[{"kind":"nonsense"}, 42]'), [{ kind: "nonsense" }, 42]);
    assert.ok(!SRC.includes("validateInteractionPrompt"));
  });
});

describe("[F-20-08][AC-20-6] 提示词与输入", () => {
  it("上限数字来自 INTERACTION_LIMITS，不手抄", () => {
    const L = INTERACTION_LIMITS;
    for (const frag of [`options ${L.minOptions}~${L.maxOptions} 个`, `steps ${L.minSteps}~${L.maxSteps} 步`, `outcomes ${L.minOutcomes}~${L.maxOutcomes} 枚`, `≤${L.maxTitleChars} 字`, `≤${L.maxStepChars} 字`]) {
      assert.ok(SERVICE_ASKS_SYSTEM.includes(frag), frag);
    }
    // 提示词那一段的源码里不该出现写死的上限数字（"2~5" 这种）。
    const promptSrc = SRC.slice(SRC.indexOf("export const SERVICE_ASKS_SYSTEM"), SRC.indexOf("const RISK_ZH"));
    assert.ok(!/\d\s*~\s*\d/.test(promptSrc), "上限要从常量拼");
    // 一轮几张卡是**预算器**的数（M107-01 补）：这句话手抄过一版，调 PROMPT_BUDGET 时不会跟着变。
    assert.match(SERVICE_ASKS_SYSTEM, new RegExp(`一轮最多 ${PROMPT_BUDGET.guidance} 张引导、${PROMPT_BUDGET.capture} 张拍照、${PROMPT_BUDGET.asks} 道题`));
    assert.ok(!/最多 \d 张引导/.test(promptSrc), "张数也要从 PROMPT_BUDGET 拼");
  });

  it("四条守住的规则写在提示词里（M107-01 按离线对照台的量测改写过）", () => {
    // 引导是**期望**不是允许：只有禁止没有召唤时，模型的默认是不提（基线 6%）。
    assert.match(SERVICE_ASKS_SYSTEM, /只要出现了车主自己就能做的动作，就提一张引导/);
    // 高风险不提引导，但**别整轮沉默**——这半句缺了，基线里高风险轮 7/8 回 []。
    assert.match(SERVICE_ASKS_SYSTEM, /风险等级为「高」时不提操作引导/);
    assert.match(SERVICE_ASKS_SYSTEM, /但问题和拍照照常提/);
    // 出处与步骤同源：编的步骤挂个沾边出处比 source:null 更糟。
    assert.match(SERVICE_ASKS_SYSTEM, /`source` 和 steps 必须是同一段/);
    assert.match(SERVICE_ASKS_SYSTEM, /不下结论/);
  });

  it("输入 = narrator 的同一份消息 + 一段任务说明（风险、代码会问的、问过的）", () => {
    const base: ChatTurnMessage[] = [{ role: "user", content: "这个灯怎么回事" }];
    const out = buildServiceAsksMessages({ answerMessages: base, bankTexts: ["车现在是停着的吗？"], askedTexts: [], riskLevel: "medium" });
    assert.equal(out.length, 2);
    assert.equal(out[0], base[0]);
    assert.match(out[1]!.content, /当前风险等级：中/);
    assert.match(out[1]!.content, /代码已经会问的题：\n- 车现在是停着的吗？/);
    assert.match(out[1]!.content, /已经问过的：\n（无）/);
  });

  it("开关与宽限期：缺省 on / 3000ms；off 与数字可配", () => {
    assert.equal(serviceAsksEnabled({}), true);
    assert.equal(serviceAsksEnabled({ CARLIFE_SERVICE_ASKS: "off" }), false);
    assert.equal(serviceAsksGraceMs({}), 3000);
    assert.equal(serviceAsksGraceMs({ SERVICE_ASKS_GRACE_MS: "50" }), 50);
    assert.equal(serviceAsksGraceMs({ SERVICE_ASKS_GRACE_MS: "abc" }), 3000);
  });
});

describe("[F-20-09][AC-20-7] startProposals：永不 reject", () => {
  const ctx = { answerMessages: [{ role: "user" as const, content: "x" }], bankTexts: [], askedTexts: [], riskLevel: "low" as const };

  it("没有 proposer ⇒ off，不起调用", async () => {
    assert.deepEqual(await startProposals(undefined, ctx).settle(10), { proposals: [], outcome: "off" });
  });

  it("正常 ⇒ ok；带 agent 名与 signal", async () => {
    let hooksSeen: { agent?: string; signal?: AbortSignal } | undefined;
    const ok: ChatStreamer = async function* (_m, hooks) {
      hooksSeen = hooks;
      yield JSON.stringify([ASK]);
    };
    const r = await startProposals(ok, ctx).settle(1000);
    assert.equal(r.outcome, "ok");
    assert.deepEqual(r.proposals, [ASK]);
    assert.equal(hooksSeen?.agent, SERVICE_ASKS_AGENT);
    assert.ok(hooksSeen?.signal instanceof AbortSignal);
  });

  it("永不返回 ⇒ 宽限期后 timeout，并主动中止那次调用", async () => {
    let aborted = false;
    const hang: ChatStreamer = async function* (_m, hooks) {
      hooks?.signal?.addEventListener("abort", () => (aborted = true));
      await new Promise(() => {});
      yield "";
    };
    const t0 = Date.now();
    const r = await startProposals(hang, ctx).settle(40);
    assert.equal(r.outcome, "timeout");
    assert.deepEqual(r.proposals, []);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(aborted, true, "超时后那次调用还在烧 token，要主动中止");
  });

  it("抛错 ⇒ error，不向上抛", async () => {
    const boom: ChatStreamer = async function* () {
      throw new Error("upstream 500");
    };
    const r = await startProposals(boom, ctx).settle(1000);
    assert.equal(r.outcome, "error");
  });
});

describe("[F-20-08][AC-20-6] 图级：与应答并发，只在问诊轮起，坏了只是少几张卡", () => {
  beforeEach(() => {
    setRagClient({
      async retrieve() {
        return [{ content: "副驾座椅上放置较重物品时安全带提醒灯也会点亮", source: { document: "用户手册" }, score: 0.9 }];
      },
    });
    process.env.SERVICE_ASKS_GRACE_MS = "60";
  });
  afterEach(() => {
    setRagClient(undefined);
    delete process.env.SERVICE_ASKS_GRACE_MS;
  });

  const main: ChatStreamer = async function* () {
    yield "[main]";
  };
  // 观察层的产物形状照 `diagnosis.test.ts` 的夹具。这一轮不带照片：观察节点只沿用**还新鲜**的上一份
  // （`PHOTO_INHERIT_WINDOW_MS`），所以 `observedAt` 给当下。
  const seatbelt = {
    handle: "handle_photo",
    observedAt: Date.now(),
    unreadable: false,
    frame: { cut_off_sides: [], cutOffSource: "none", quality: {} },
    items: [
      {
        category: "warning_light",
        shape: "person",
        color: "red",
        state: "lit",
        elements: ["diagonal_band"],
        text: [],
        confidence: 0.9,
        colorAgreement: "agree",
        undeterminable: [],
        match: { symbolId: "seatbelt_unfastened", name: "安全带未系提醒", class: "reminder", severity: "info", manualAnchor: "手册 › 指示灯", verified: true, evidence: "" },
      },
    ],
    notes: [],
    caveats: [],
    retakeHints: [],
    timings: {},
    model: {},
    alerts: [],
    noActiveAlerts: false,
  };

  async function run(opts: { text: string; proposer?: ChatStreamer; observed: boolean }) {
    const events: string[] = [];
    const traces: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const narrator: ChatStreamer = async function* () {
      events.push("answer:start");
      await new Promise((r) => setTimeout(r, 15));
      yield "[voice]";
      events.push("answer:end");
    };
    const proposer: ChatStreamer | undefined = opts.proposer
      ? async function* (m, h) {
          events.push("propose:start");
          yield* opts.proposer!(m, h);
        }
      : undefined;
    const graph = buildChatGraph(main, { enableIntent: false, narrator, proposer });
    let out = "";
    const state = await graph.invoke(
      { messages: [{ role: "user", content: opts.text }], ...(opts.observed ? { photoObservation: seatbelt as never } : {}) },
      { configurable: { thread_id: `t-${Math.random().toString(36).slice(2, 8)}`, emit: { onDelta: (t: string) => (out += t) }, onTrace: (e: { kind: string; data: Record<string, unknown> }) => traces.push(e) } },
    );
    return { out, events, traces, report: state.diagnosis as DiagnosisReport | undefined };
  }

  const TEXT = "我这车仪表上这个灯亮了是怎么回事";

  it("问诊轮：提议先于应答结束就已起跑；模型的卡进报告；轨迹里有 prompts 一条", async () => {
    const proposer: ChatStreamer = async function* () {
      yield JSON.stringify([ASK, GUIDE]);
    };
    const { out, events, traces, report } = await run({ text: TEXT, proposer, observed: true });
    assert.equal(out, "[voice]");
    assert.ok(report, "这一轮该有报告");
    assert.ok(events.indexOf("propose:start") < events.indexOf("answer:end"), `并发：${events.join(" → ")}`);
    assert.deepEqual(report.prompts.map((p) => [p.kind, p.origin]), [["guidance", "model"], ["single", "model"], ["single", "code"]]);
    const t = traces.find((e) => e.kind === "prompts");
    assert.ok(t);
    assert.equal(t.data.outcome, "ok");
    assert.equal(t.data.proposed, 2);
  });

  it("提议永不返回 ⇒ 宽限期后照常收尾，卡只有代码两路", async () => {
    const hang: ChatStreamer = async function* () {
      await new Promise(() => {});
      yield "";
    };
    const { out, report, traces } = await run({ text: TEXT, proposer: hang, observed: true });
    assert.equal(out, "[voice]");
    assert.deepEqual(report?.prompts.map((p) => p.id), ["parked", "since"]);
    assert.equal(traces.find((e) => e.kind === "prompts")?.data.outcome, "timeout");
  });

  it("提议抛错 / 吐的不是 JSON ⇒ 同上，回答一个字不少", async () => {
    const boom: ChatStreamer = async function* () {
      throw new Error("500");
    };
    const junk: ChatStreamer = async function* () {
      yield "我觉得可以问问车主座位上有没有东西";
    };
    for (const proposer of [boom, junk]) {
      const { out, report } = await run({ text: TEXT, proposer, observed: true });
      assert.equal(out, "[voice]");
      assert.deepEqual(report?.prompts.map((p) => p.id), ["parked", "since"]);
    }
  });

  it("非问诊轮：proposer 一次都不调，也没有报告", async () => {
    let calls = 0;
    const counting: ChatStreamer = async function* () {
      calls += 1;
      yield "[]";
    };
    const { report, traces } = await run({ text: "我这车空调怎么开", proposer: counting, observed: false });
    assert.equal(calls, 0);
    assert.equal(report, undefined);
    assert.ok(!traces.some((e) => e.kind === "prompts"));
  });

  it("源码：起在应答流之前、收在它之后；吃不带图的 messages", () => {
    const at = (needle: string) => SUPERVISOR.indexOf(needle);
    assert.ok(at("const proposalsHandle = startProposals(") < at("const answerIter = answerStreamer("));
    assert.ok(at("const answerIter = answerStreamer(") < at("await proposalsHandle.settle()"));
    assert.ok(at("await proposalsHandle.settle()") < at("questionBudgetLeft: promptBudget.asksLeft"));
    assert.match(SUPERVISOR, /answerMessages: messages,/);
  });
});
