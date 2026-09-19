/**
 * [F-19-07][AC-19-4] 无草案调整与行程提醒播报（施工单 M72-05）。
 *
 * 守两件离根因很远的事：
 *  - 新会话里「调整行程 <id>：…」**不能**被当成新规划送进 fan-out 排一份无关的新行程——
 *    要先把库里那份装进图状态（`committedPlanId` 保住），再走既有的细化 → 确认 → `trip_plan_update`；
 *  - 「【行程提醒】…」是端上替车主发的报告式一句话，只转述并问一句，**零 fan-out**。
 */

import { test, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { setTripPlanStore, type TripPlanStore } from "@carlife/tools";
import { adjustPlanIdOf, adjustPrompt, adjustStructurePrompt, type TripPlanSnapshot } from "@carlife/shared";

import { GuardGate, CONFIRM_REQUIRED_TOOLS } from "../src/guard/http-endpoint";
import { setGuardGate } from "../src/tools-endpoint";
import { buildChatGraph } from "../src/graph/supervisor";
import { decideRoute } from "../src/graph/route";
import { PLAN_ACTIONS, parseIntent } from "../src/graph/intent";
import {
  describeAdjustNotFound,
  describeReviewNotice,
  reviewNoticeIntent,
  wantsAdjust,
  wantsCommit,
} from "../src/graph/subgraphs/itinerary";
import type { Intent } from "../src/graph/state";
import type { ChatStreamer } from "../src/llm";

const PLAN_ID = "cmts378i000028o3jjb57e1pj";
const bare: Intent = { goal: "", constraints: [], context: "", riskBoundary: "" };

const CHANGES = [
  { kind: "weather" as const, day: 2, before: "多云", after: "雷阵雨", severity: "notice" as const, text: "第 2 天：多云 → 雷阵雨" },
];
const ADJUST_TEXT = adjustPrompt(PLAN_ID, CHANGES);
const NOTICE_TEXT = "【行程提醒】青岛 行程：第 1 天：新增暴雨橙色预警，要不要我把相关安排调整一下";

/** 结构变更那一支的入参（M83-05）：只要拼得出分句，天数与站名够用就行。 */
const STRUCT_PLAN: TripPlanSnapshot = {
  status: "confirmed",
  destination: "徐州",
  days: 3,
  skeleton: [
    { day: 1, theme: "一", spots: [{ name: "淮海战役烈士纪念塔" }] },
    { day: 2, theme: "二", spots: [{ name: "云龙湖旅游景区" }] },
    { day: 3, theme: "三", spots: [{ name: "户部山古民居" }, { name: "戏马台" }] },
  ],
  caveats: [],
  updatedTurnId: "t",
};

describe("判据与路由", () => {
  it("PLAN_ACTIONS 含 adjust；模型给 adjust 时 parseIntent 收下", () => {
    assert.ok((PLAN_ACTIONS as readonly string[]).includes("adjust"));
    assert.equal(parseIntent('{"goal":"改行程","action":"adjust"}', "x").action, "adjust");
  });

  it("wantsAdjust：LLM 优先、固定开头兜底；普通细化人话不算", () => {
    assert.equal(wantsAdjust(ADJUST_TEXT), true);
    assert.equal(wantsAdjust("把我那趟青岛第二天改成室内", { action: "adjust" }), true);
    assert.equal(wantsAdjust("换个酒店"), false);
    assert.equal(wantsAdjust("调整行程 abc：x"), false, "短 id 不认");
  });

  it("两句固定开头在意图降级时也进 itinerary（不掉进单程 fan-out）", () => {
    assert.equal(decideRoute(bare, ADJUST_TEXT).agent, "itinerary");
    assert.equal(decideRoute(bare, NOTICE_TEXT).agent, "itinerary");
    assert.equal(reviewNoticeIntent(NOTICE_TEXT), true);
    assert.equal(reviewNoticeIntent("行程提醒一下我"), false);
  });

  it("话术：找不到时如实说且不退回新规划；提醒只转述并问一句", () => {
    const nf = describeAdjustNotFound(PLAN_ID);
    assert.match(nf, new RegExp(PLAN_ID));
    assert.match(nf, /不要把这句话当成新的规划请求/);
    const rn = describeReviewNotice(NOTICE_TEXT);
    assert.match(rn, /要不要调整/);
    assert.doesNotMatch(rn, /【行程提醒】/, "前缀是给判据用的，不该念出来");
  });
});

// ── 图级 ─────────────────────────────────────────────────────

const STORED: TripPlanSnapshot = {
  status: "confirmed",
  destination: "青岛",
  startDate: "2026-09-12",
  days: 2,
  skeleton: [
    { day: 1, theme: "海边", spots: [{ name: "栈桥" }] },
    { day: 2, theme: "老城", spots: [{ name: "八大关" }] },
  ],
  caveats: [],
  updatedTurnId: "t0",
};

function store(): TripPlanStore & { updated: string[]; committed: number } {
  const st = {
    updated: [] as string[],
    committed: 0,
    async commit() {
      st.committed += 1;
      return { planId: "plan-new", committedAt: new Date(0) };
    },
    async cancelCurrent() {
      return null;
    },
    async cancelById() {
      return null;
    },
    async update(_u: string, planId: string) {
      st.updated.push(planId);
      return { planId, committedAt: new Date(0) };
    },
    async setNav() {
      return null;
    },
    async list() {
      return [
        { planId: "plan-other", plan: { ...STORED, destination: "徐州" }, committedAt: new Date(0) },
        { planId: PLAN_ID, plan: STORED, committedAt: new Date(0) },
      ];
    },
    async query() {
      return [];
    },
  };
  return st as unknown as TripPlanStore & { updated: string[]; committed: number };
}

/** 假流：记下每个被调的 `-task` 分支（fan-out 有没有跑就看它），应答 prompt 记进 answers。 */
const fakeStreamer = (tasks: string[], answers: string[]): ChatStreamer =>
  async function* (m, hooks) {
    const agent = hooks?.agent ?? "?";
    if (agent.endsWith("-task")) {
      tasks.push(agent);
      yield agent === "tour-task"
        ? '{"destination":"青岛","days":[{"day":1,"theme":"海边","spots":["栈桥"]},{"day":2,"theme":"室内","spots":["青岛啤酒博物馆"]}]}'
        : '{"findings":[]}';
      return;
    }
    answers.push(m.map((x) => x.content).join("\n"));
    yield "[答]";
  };

beforeEach(() => setTripPlanStore(undefined));

test("新会话「调整行程 <id>：…」：装载库里那份 → 细化 → 确认走 trip_plan_update，不落新行", async () => {
  const st = store();
  setTripPlanStore(st);
  const interrupts: string[] = [];
  const gate = new GuardGate({
    onInterrupt: ({ interruptId, request }) => {
      interrupts.push(request.tool);
      queueMicrotask(() => gate.resume(interruptId, true));
    },
  });
  setGuardGate(gate);
  const tasks: string[] = [];
  const answers: string[] = [];
  const graph = buildChatGraph(fakeStreamer(tasks, answers), { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-adjust", userId: "u1", emit: { onDelta: () => {} } } };

  const s1 = await graph.invoke({ messages: [{ role: "user", content: ADJUST_TEXT }] }, cfg);
  assert.equal(s1.tripPlan?.committedPlanId, PLAN_ID, "必须装载指定的那份，不是列表首条");
  assert.equal(s1.tripPlan?.destination, "青岛");
  assert.equal(s1.tripPlan?.status, "refining", "装载后接着细化，是草案不是 confirmed");
  assert.equal(s1.tripPlan?.nav, undefined);
  assert.ok(tasks.length > 0, "细化要真的跑 fan-out");
  assert.equal(st.committed, 0);

  const s2 = await graph.invoke({ messages: [{ role: "user", content: "就这样定了" }] }, cfg);
  assert.ok(CONFIRM_REQUIRED_TOOLS.has("trip_plan_update"));
  assert.ok(interrupts.includes("trip_plan_update"), `应弹 trip_plan_update，实际 ${interrupts.join(",")}`);
  assert.deepEqual(st.updated, [PLAN_ID], "原地改写那一行");
  assert.equal(st.committed, 0, "不能落新行");
  assert.equal(s2.tripPlan?.status, "confirmed");
});

test("id 不属于本用户 / 不存在：如实说，零 fan-out，不排新行程", async () => {
  const st = store();
  setTripPlanStore(st);
  setGuardGate(new GuardGate({ onInterrupt: () => {} }));
  const tasks: string[] = [];
  const answers: string[] = [];
  const graph = buildChatGraph(fakeStreamer(tasks, answers), { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-adjust-nf", userId: "u1", emit: { onDelta: () => {} } } };

  const s = await graph.invoke(
    { messages: [{ role: "user", content: adjustPrompt("plan-not-mine-0001", CHANGES) }] },
    cfg,
  );
  assert.equal(s.tripPlan, undefined, "找不到就不装载，也不排新的");
  assert.deepEqual(tasks, [], "零 fan-out");
  assert.match(answers.at(-1) ?? "", /没有找到编号为 plan-not-mine-0001/);
});

test("「【行程提醒】…」：只转述并问一句，零 fan-out、不碰状态", async () => {
  const st = store();
  setTripPlanStore(st);
  setGuardGate(new GuardGate({ onInterrupt: () => {} }));
  const tasks: string[] = [];
  const answers: string[] = [];
  const graph = buildChatGraph(fakeStreamer(tasks, answers), { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-notice", userId: "u1", emit: { onDelta: () => {} } } };

  const s = await graph.invoke({ messages: [{ role: "user", content: NOTICE_TEXT }] }, cfg);
  assert.deepEqual(tasks, []);
  assert.equal(s.tripPlan, undefined);
  assert.match(answers.at(-1) ?? "", /要不要调整/);
});

/**
 * 这一条**改判了**（INC-0157）。
 *
 * 原来的断言是「有草案时不查库装载」——粘性优化，理由是"手上正改着的就是它"。
 * 可这个用例里手上那份是一份新排的青岛 2 天草案（没有确认血统），
 * 而 `ADJUST_TEXT` 点名的是另一份已落库的行程。两者根本不是同一趟，
 * 于是"粘性"的实际效果是：**车机端点了 A 的「让暖暖调整」，改的是 B**。
 *
 * 真跑里它就是这么发作的：点名一份苏州 3 天的，手上那件指着一份安徽 4 天的，
 * 安徽那份的第 1~3 天被苏州内容覆盖、第 4 天（宏村、黟县古城）留着，
 * 确认之后 trip_plan_update 写回安徽那一行。
 *
 * 粘性本身保留，只是判据换成「点名的那份**是不是**手上这份」——见下一条。
 */
test("点名的是另一份时：按点名的那一份装载，不拿手上的草案顶替", async () => {
  const st = store();
  let listed = 0;
  const origList = st.list.bind(st);
  st.list = async (...args: Parameters<TripPlanStore["list"]>) => {
    listed += 1;
    return origList(...args);
  };
  setTripPlanStore(st);
  setGuardGate(new GuardGate({ onInterrupt: () => {} }));
  const tasks: string[] = [];
  const graph = buildChatGraph(fakeStreamer(tasks, []), { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-sticky", userId: "u1", emit: { onDelta: () => {} } } };

  await graph.invoke({ messages: [{ role: "user", content: "我们去青岛玩2天，帮我安排行程" }] }, cfg);
  const before = listed;
  const s = await graph.invoke({ messages: [{ role: "user", content: ADJUST_TEXT }] }, cfg);
  assert.ok(listed > before, "点名的那份不是手上这份 → 必须去查库把它取回来");
  assert.equal(s.tripPlan?.committedPlanId, PLAN_ID, "改的、以及将来落库的，都得是他点名的那一份");
});

test("点名的就是手上这份时：走粘性路径，不重复装载（列表不该被查）", async () => {
  const st = store();
  let listed = 0;
  const origList = st.list.bind(st);
  st.list = async (...args: Parameters<TripPlanStore["list"]>) => {
    listed += 1;
    return origList(...args);
  };
  setTripPlanStore(st);
  setGuardGate(new GuardGate({ onInterrupt: () => {} }));
  const graph = buildChatGraph(fakeStreamer([], []), { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-sticky-same", userId: "u1", emit: { onDelta: () => {} } } };

  // 第一句把那一份装进会话（手上没草案 → 走装载分支）
  await graph.invoke({ messages: [{ role: "user", content: ADJUST_TEXT }] }, cfg);
  const before = listed;
  // 同一份再来一句：这才是粘性该生效的场合
  const s = await graph.invoke({ messages: [{ role: "user", content: ADJUST_TEXT }] }, cfg);
  assert.equal(listed, before, "同一份不重复查库");
  assert.equal(s.tripPlan?.committedPlanId, PLAN_ID);
});

/**
 * [F-18-15][AC-18-11] 端上换了话术，服务端一个字不用改（施工单 M83-05）。
 *
 * M83-01 给结构变更另拼了一句话（`adjustStructurePrompt`），它与 `adjustPrompt` 的
 * 尾句不同、分句形状也不同——**但开头同样是 `ADJUST_PREFIX`**。
 * 服务端认的是那个开头（端上的协议，不是要理解的措辞），所以这一组守的是：
 * 换了内容之后 `wantsAdjust` / `adjustPlanIdOf` / 路由仍然照旧。
 */
describe("结构变更的话：服务端照旧认得", () => {
  const STRUCT_TEXT = adjustStructurePrompt(PLAN_ID, STRUCT_PLAN, [
    { kind: "remove", day: 1, spot: "淮海战役烈士纪念塔" },
    { kind: "move", day: 2, spot: "云龙湖旅游景区", toDay: 3 },
    { kind: "reorder", day: 3, order: ["户部山古民居", "戏马台"] },
  ]);

  it("wantsAdjust 认它（模型没表态也认——那是端上的协议）", () => {
    assert.equal(wantsAdjust(STRUCT_TEXT), true);
  });

  it("planId 取得回来", () => {
    assert.equal(adjustPlanIdOf(STRUCT_TEXT), PLAN_ID);
  });

  it("意图降级时也落 itinerary，不掉进单程 fan-out", () => {
    assert.equal(decideRoute(bare, STRUCT_TEXT).agent, "itinerary");
  });

  /*
   * 2026-09-14 真跑实测（M83-05）：尾句只说「重排时间、其它不动」时，模型三条改动全做对、
   * 装的也是库里那份，但把结果当**草案**收尾——回一句"想定下来说一声「就这样定了」"。
   * 于是确认弹窗不出现、`trip_plan_update` 不发生，库里那份原封不动，
   * 而车主刚按的是「保存调整」。尾句因此带上处置意图。
   */
  it("尾句命中处置判定，这一轮才走得到确认弹窗（不是停在草案）", () => {
    assert.equal(wantsCommit(STRUCT_TEXT), true);
  });

  it("与「环境变了」那一支尾句不同，但两者都被同一条路认下", () => {
    assert.ok(STRUCT_TEXT.includes("请按这些变化重排每天的时间"));
    assert.ok(ADJUST_TEXT.includes("请按这些变化调整行程"));
    assert.equal(wantsAdjust(ADJUST_TEXT), true);
  });
});
