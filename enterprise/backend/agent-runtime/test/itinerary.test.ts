/**
 * 多天行程编排（施工单 M12-03）。
 *
 * 三层各守一件事：
 *  - 路由：多天判据与**粘性**——「第一天再细化」一个多天词都没有，没粘性草案就断；
 *  - 汇聚：装配与校验在代码里——估算标注由代码补、失败分支进 missing、细化只跑该跑的；
 *  - 状态：tripPlan 跨轮存活——这是与 agentResults 的本质差别。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideRoute, REFINE_PATTERNS, branchFor } from "../src/graph/route";
import {
  mergeItinerary,
  refineTargets,
  describeItineraryPlan,
  runItineraryFanout,
  wantsCommit,
  wantsCancel,
  wantsCancelAll,
} from "../src/graph/subgraphs/itinerary";
import { parseIntent } from "../src/graph/intent";
import { buildChatGraph } from "../src/graph/supervisor";
import type { ChatStreamer } from "../src/llm";
import type { BranchResult } from "../src/graph/fanout";

const intent = (goal: string) => ({ goal, constraints: [], context: "", riskBoundary: "" });

// ── 路由 ────────────────────────────────────────────────────

test("出行一律 itinerary：多天与当天同一个去处；「后天」不把保养劫走", () => {
  assert.equal(decideRoute(intent("去广州玩"), "我们去广州玩4天，帮我安排行程").agent, "itinerary");
  assert.equal(decideRoute(intent("周边游"), "想来个三天两夜的周边游").agent, "itinerary");
  // M13-13 起单程不再有独立链路：当天出发也进 itinerary。
  // 从前这句被判成「不是多天」而落到 trip，那条链路没有落库出口——
  // 用户说"就这样定了"时既不弹确认也不进主页，正是这么来的。
  assert.equal(decideRoute(intent("行程"), "今天下午三点出发去南通，帮我规划行程").agent, "itinerary");
  // 但含"天"字不等于出行：保养仍归 service。
  assert.equal(decideRoute(intent("保养"), "后天上午十点去做保养").agent, "service");
});

// ── 处置判定：LLM 的 action 优先，正则兜底（M13-14）──────────────

test("action=commit 认下正则永远追不完的说法", () => {
  // 这两句是车主真说过、而当时判不出来的（turn-7481f04c / turn-d65a0a10）。
  // 表现不是报错：又跑一轮 fan-out，不弹确认窗，行程也没落库。
  for (const text of ["你这样安排可以的。", "帮我创建该行程", "帮我创建该线程"]) {
    assert.equal(wantsCommit(text), false, `${text} 不该被正则认出来（认出来了这条断言就失去意义）`);
    assert.equal(wantsCommit(text, { action: "commit" }), true, text);
  }
});

test("正则仍是兜底：意图降级时老判据照旧管用", () => {
  // 模型抽风 / JSON 解不出时 action 是 undefined，那一轮不能连"就这样定了"都认不出。
  assert.equal(wantsCommit("就这样定了"), true);
  assert.equal(wantsCancel("把上海到广州的行程取消掉"), true);
  assert.equal(wantsCancelAll("所有行程都取消"), true);
});

test("取消压过确认；细化式取消否决两个信号", () => {
  assert.equal(wantsCommit("行程取消掉", { action: "commit" }), false, "取消词在场时不许落库");
  assert.equal(wantsCancel("取消第二天的行程", { action: "cancel" }), false, "改一天不是作废整份");
  assert.equal(wantsCancelAll("取消第二天的行程", { action: "cancel_all" }), false);
  // cancel_all 同时也是 cancel——单份取消路径要能接住它。
  assert.equal(wantsCancel("都不要了", { action: "cancel_all" }), true);
});

test("parseIntent 收下 action，表外值当没给", () => {
  const ok = parseIntent('{"goal":"定下来","action":"commit"}', "原话");
  assert.equal(ok.action, "commit");
  const bad = parseIntent('{"goal":"定下来","action":"落库"}', "原话");
  assert.equal(bad.action, undefined, "表外的值不能透传，否则下游拿它去比较永远不等");
  const none = parseIntent('{"goal":"还在改","action":"none"}', "原话");
  assert.equal(wantsCommit("第二天换个酒店", none), false);
});

test("粘性：有活跃草案时细化句粘回 itinerary；reason 写明粘性", () => {
  const r = decideRoute(intent("细化"), "第一天再细化一下", { hasActiveTripPlan: true });
  assert.equal(r.agent, "itinerary");
  assert.match(r.reason, /粘性/);
  // 同一句话没有草案时不粘——decideRoute 不带 opts 的行为必须与从前逐字一致。
  assert.notEqual(decideRoute(intent("细化"), "第一天再细化一下").agent, "itinerary");
});

test("粘性不劫持：闲聊不粘、强信号改道", () => {
  // 「你好」既无细化指涉也无行程指涉——不粘。
  assert.equal(decideRoute(intent("打招呼"), "你好", { hasActiveTripPlan: true }).agent, "general");
  // 故障强信号（异响 3×3=9）压过粘性——用户换话题优先。
  assert.equal(
    decideRoute(intent("故障"), "车子有异响，第二天还能出发吗", { hasActiveTripPlan: true }).agent,
    "service",
  );
});

test("branchFor：itinerary → itineraryPlan", () => {
  assert.equal(branchFor({ agent: "itinerary" }), "itineraryPlan");
});

test("REFINE_PATTERNS 与 refineTargets 是两张不同的表", () => {
  // 前者管"要不要粘回来"，后者管"粘回来之后跑哪几支"——合并成一张表迟早有人
  // 往一边加词把另一边带坏。
  assert.ok(REFINE_PATTERNS.test("换个酒店"));
  assert.deepEqual(refineTargets("换个酒店"), ["hotel"]);
  assert.deepEqual(refineTargets("第二天想去的景点换一换"), ["tour"]);
  assert.deepEqual(refineTargets("高铁方案再看看"), ["transit"]);
  // 判不出 → 四支全跑，宁可慢不能漏。
  assert.equal(refineTargets("整体再优化下").length, 4);
});

// ── 汇聚 ────────────────────────────────────────────────────

const ok = (agent: string, json: unknown): BranchResult => ({
  agent,
  status: "ok",
  text: `好的。${JSON.stringify(json)}`,
  startedAt: 0,
  endedAt: 1,
});

const INPUT = {
  goal: "广州4天带娃",
  constraints: [],
  userText: "我们去广州玩4天",
  turnId: "t-1",
};

test("骨架汇聚：tour 主干 + hotel 挂天 + 估算标注由代码补", () => {
  const out = mergeItinerary(
    [
      ok("tour-task", {
        destination: "广州",
        days: [
          { day: 1, theme: "亲子动物园", area: "番禺", spots: [{ name: "长隆野生动物世界" }], rainBackup: "正佳广场" },
          { day: 2, theme: "城央地标", area: "天河", spots: [{ name: "广州塔" }] },
        ],
      }),
      // estPrice 没写"估算"两个字——代码必须补上，不赌模型守规矩。
      ok("hotel-task", { hotels: [{ name: "长隆酒店", area: "番禺", rating: "4.8", estPrice: "约800-1200/晚" }] }),
      ok("transit-task", {
        trains: [{ no: "G253(上海虹桥-广州南)", durationMin: 503, costYuan: 883 }],
        flightAdvice: { durationHint: "约2.5小时", priceEstimate: "约800-1400元" },
      }),
      ok("drive-task", { legMinutes: [300, 400], stops: ["服务区A"] }),
    ],
    INPUT,
    ["drive", "hotel", "tour", "transit"],
  );

  assert.equal(out.plan.destination, "广州");
  assert.equal(out.plan.days, 2);
  assert.equal(out.plan.skeleton[0].hotel?.name, "长隆酒店"); // 片区匹配挂到第 1 天
  assert.match(out.plan.skeleton[0].hotel?.estPrice ?? "", /估算/); // 代码补的标注
  assert.match(out.plan.skeleton[0].notes?.[0] ?? "", /雨天备选/);
  assert.match(out.plan.transit?.summary ?? "", /G253/);
  assert.match(out.plan.transit?.summary ?? "", /自驾约11小时40分/);
  assert.ok(out.plan.caveats.some((c) => c.includes("估算")));
  assert.equal(out.solverDegraded, false);
});

test("分支超时 → missing + solverDegraded；成功分支照常入骨架", () => {
  const out = mergeItinerary(
    [
      ok("tour-task", { destination: "广州", days: [{ day: 1, theme: "亲子", spots: ["长隆"] }] }),
      { agent: "hotel-task", status: "timeout", text: "", startedAt: 0, endedAt: 1 },
    ],
    INPUT,
    ["hotel", "tour"],
  );
  assert.ok(out.missing.some((m) => m.includes("hotel-task 分支超时")));
  assert.equal(out.solverDegraded, true);
  assert.equal(out.plan.skeleton.length, 1);
  const text = describeItineraryPlan(out);
  assert.match(text, /缺失的信息（必须标注，不要假装有）/);
});

test("细化轮：局部覆盖——没重跑的分支字段原样保留", () => {
  const skeleton = mergeItinerary(
    [
      ok("tour-task", { destination: "广州", days: [{ day: 1, theme: "亲子", area: "番禺", spots: ["长隆"] }] }),
      ok("hotel-task", { hotels: [{ name: "长隆酒店", area: "番禺", estPrice: "约800/晚（估算）" }] }),
      ok("transit-task", { trains: [{ no: "G253", durationMin: 503, costYuan: 883 }] }),
    ],
    INPUT,
    ["hotel", "tour", "transit"],
  ).plan;

  // 细化只跑 hotel：换一家酒店，tour 骨架与 transit 摘要必须原样在。
  const refined = mergeItinerary(
    [ok("hotel-task", { hotels: [{ name: "广州花园酒店", area: "越秀", rating: "4.6", estPrice: "约500-700/晚（估算）" }] })],
    { ...INPUT, userText: "换个酒店", plan: skeleton, turnId: "t-2" },
    ["hotel"],
  );
  assert.equal(refined.plan.status, "refining");
  assert.equal(refined.plan.skeleton[0].theme, "亲子"); // tour 未跑，保留
  assert.match(refined.plan.transit?.summary ?? "", /G253/); // transit 未跑，保留
  assert.equal(refined.plan.skeleton[0].hotel?.name, "广州花园酒店"); // hotel 更新
  assert.equal(refined.plan.updatedTurnId, "t-2");
});

test("细化轮 tour 重排骨架：酒店按天号接回来，不能跟着被抹掉（M13-14）", () => {
  const skeleton = mergeItinerary(
    [
      ok("tour-task", {
        destination: "广州",
        days: [
          { day: 1, theme: "亲子", area: "番禺", spots: ["长隆"] },
          { day: 2, theme: "城央", area: "天河", spots: ["广州塔"] },
        ],
      }),
      ok("hotel-task", {
        hotels: [
          { name: "长隆酒店", area: "番禺", estPrice: "约800/晚（估算）" },
          { name: "天河希尔顿", area: "天河", estPrice: "约600/晚（估算）" },
        ],
      }),
    ],
    INPUT,
    ["hotel", "tour"],
  ).plan;
  assert.equal(skeleton.skeleton[0].hotel?.name, "长隆酒店");
  assert.equal(skeleton.skeleton[1].hotel?.name, "天河希尔顿");

  /*
   * 车主说「一天只有一个公园太少了」（turn-8bdf0923）——只跑 tour。
   * 从前这里整段重建 skeleton，四天的酒店**一起被抹掉且零报错**；
   * 下一轮他问「酒店每天都要订的呀」（turn-e721b3ef），拿到的还是空。
   */
  const refined = mergeItinerary(
    [
      ok("tour-task", {
        destination: "广州",
        days: [
          { day: 1, theme: "亲子", area: "番禺", spots: ["长隆", "香江野生动物园"] },
          { day: 2, theme: "城央", area: "天河", spots: ["广州塔", "正佳极地海洋世界"] },
        ],
      }),
    ],
    { ...INPUT, userText: "一天只安排一个太少了", plan: skeleton, turnId: "t-3" },
    ["tour"],
  );
  assert.equal(refined.plan.skeleton[0].spots.length, 2, "景点确实加了");
  assert.equal(refined.plan.skeleton[0].hotel?.name, "长隆酒店", "第1天的酒店不能没");
  assert.equal(refined.plan.skeleton[1].hotel?.name, "天河希尔顿", "第2天的酒店不能没");
  assert.ok(!refined.missing.some((m) => m.includes("酒店")), "酒店还在就不该报缺口");
});

test("分支输出两个 JSON 对象时仍取到约定的那个（M13-14）", () => {
  /*
   * 细化轮的提示词开头就把整份草案 JSON 塞给模型，还写着"其余保持不变"——
   * 模型很自然地先回一遍草案、再附上要求的对象。从前的抽取是贪婪正则
   * `/\{[\s\S]*\}/`，从第一个 { 吃到最后一个 }，拿到 `{…}\n{…}` 解析失败，
   * **整支分支的产出被静默丢弃**，而轨迹上分支还是 status: ok。
   */
  const twoObjects =
    '好的，这是更新后的草案：\n{"status":"refining","skeleton":[]}\n\n' +
    '{"hotels":[{"name":"广州花园酒店","area":"越秀","estPrice":"约500/晚"}],"findings":[]}';
  const out = mergeItinerary(
    [{ agent: "hotel-task", status: "ok", text: twoObjects, startedAt: 0, endedAt: 1 }],
    INPUT,
    ["hotel"],
  );
  assert.equal(out.plan.skeleton.length, 0);
  assert.ok(!out.missing.some((m) => m.includes("hotel 分支未返回")), "解析得出来就不该记缺口");
});

test("酒店缺口写明成因——三种成因不能共用一句话（M13-14）", () => {
  const withDay = mergeItinerary(
    [ok("tour-task", { destination: "广州", days: [{ day: 1, theme: "亲子", spots: ["长隆"] }] })],
    INPUT,
    ["tour"],
  ).plan;
  const noJson = mergeItinerary(
    [{ agent: "hotel-task", status: "ok", text: "我看了一下，附近酒店挺多的。", startedAt: 0, endedAt: 1 }],
    { ...INPUT, plan: withDay, turnId: "t-4" },
    ["hotel"],
  );
  assert.match(noJson.missing.join("|"), /没有可解析的 JSON/);

  const wrongShape = mergeItinerary(
    [{ agent: "hotel-task", status: "ok", text: '{"findings":["查了番禺"]}', startedAt: 0, endedAt: 1 }],
    { ...INPUT, plan: withDay, turnId: "t-5" },
    ["hotel"],
  );
  assert.match(wrongShape.missing.join("|"), /没有 hotels 字段/);
});

// ── 子图驱动：细化轮只发该跑的分支 ─────────────────────────

test("runItineraryFanout：骨架轮四支 + 续航；细化轮只发选中的（M13-13）", async () => {
  const seen: string[] = [];
  const fake: ChatStreamer = async function* (_m, hooks) {
    seen.push(hooks?.agent ?? "?");
    yield '{"hotels":[{"name":"X酒店","estPrice":"约300/晚（估算）"}]}';
  };

  await runItineraryFanout(fake, { ...INPUT });
  /*
   * 续航评估（`ownership-task`）并进来了（M13-13）：路由层不再区分单程与多天之后，
   * 「去嘉定怎么走」这类请求也走这条链路，而续航原先只在单程 fan-out 里有——
   * 不带过来，纯电车主就再也拿不到"到得了吗、哪儿补能"。
   */
  assert.deepEqual(
    [...seen].sort(),
    ["drive-task", "hotel-task", "ownership-task", "tour-task", "transit-task"],
  );

  seen.length = 0;
  await runItineraryFanout(fake, {
    ...INPUT,
    userText: "换个酒店",
    plan: {
      status: "skeleton", destination: "广州", days: 1,
      skeleton: [{ day: 1, theme: "亲子", spots: [{ name: "长隆" }] }],
      caveats: [], updatedTurnId: "t-1",
    },
  });
  // 细化轮**不跑续航**：改酒店/换景点与"到不到得了"无关，再跑一次是白花时间。
  assert.deepEqual(seen, ["hotel-task"]);
});

// ── 图级：tripPlan 跨轮存活 + 应答会话复用 trip ───────────────

test("tripPlan 跨 invoke 存活；itinerary 的应答会话落到 trip", async () => {
  const answered: string[] = [];
  const fake: ChatStreamer = async function* (_m, hooks) {
    const agent = hooks?.agent ?? "?";
    if (agent.endsWith("-task")) {
      yield agent === "tour-task"
        ? '{"destination":"广州","days":[{"day":1,"theme":"亲子","spots":["长隆"]}]}'
        : '{"findings":[]}';
      return;
    }
    answered.push(agent);
    yield "[答]";
  };

  const graph = buildChatGraph(fake, { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-plan", emit: { onDelta: () => {} } } };

  const s1 = await graph.invoke({ messages: [{ role: "user", content: "我们去广州玩4天，帮我安排行程" }] }, cfg);
  assert.equal(s1.tripPlan?.destination, "广州");
  assert.equal(answered.at(-1), "trip"); // itinerary 应答复用 trip 会话

  // 第二轮：细化句无多天词，靠粘性（读到上一轮的 tripPlan）回到 itinerary。
  const s2 = await graph.invoke({ messages: [{ role: "user", content: "换个酒店" }] }, cfg);
  assert.equal(s2.route?.agent, "itinerary");
  assert.match(s2.route?.reason ?? "", /粘性/);
  assert.equal(s2.tripPlan?.status, "refining");
  assert.equal(s2.tripPlan?.updatedTurnId, "t-plan");
});

test("特化压制：意图释义给 trip 叠分也不能吞掉多天请求（实测 turn-ffe8c0b2）", () => {
  // 真实翻车样本：原话 18 分，trip 靠 goal 里的出发/长途词叠到 23 分赢了——
  // 走单程 fan-out，链路里没有酒店分支，用户问的酒店凭空消失。
  const r = decideRoute(
    {
      goal: "下周从上海出发自驾去广州旅游四天，安排每天行程和酒店",
      constraints: ["长途出行", "带六岁小朋友"],
      context: "",
      riskBoundary: "",
    },
    "我们一家三口下周去广州玩四天开车去帮我安排行程和酒店",
  );
  assert.equal(r.agent, "itinerary");
});
