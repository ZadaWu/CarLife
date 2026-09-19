/**
 * [F-18-01][AC-18-1] Plan 层 1c `planDecide`（施工单 M86-03，ACR-037）。
 *
 * 兜底是这份测试的骨头：超时、分支失败、没有提交、提交不合法——四种情形都得回落 1b 骨架、逐字相同。
 * 提交通道用 `recordSubmission` 模拟工具落槽（与 tools-endpoint 同一入口），正文回落用注入的 `parseText`。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { __resetSubmissions, recordSubmission } from "../src/branch-submissions";
import { PLAN_DECIDE_TIMEOUT_MS } from "../src/graph/trip-plan-layer/config";
import { DECIDE_AGENT, DECIDE_SLOT, planDecide, renderDecidePrompt, validateDecision } from "../src/graph/trip-plan-layer/decide";
import type { PlanSpot, TripSkeleton } from "../src/graph/trip-plan-layer/types";
import type { ChatStreamer } from "../src/llm";

const s = (name: string, lat: number, lon: number, district: string, indoor = false): PlanSpot => ({ name, lat, lon, district, indoor, rating: "4.5" });

/** 1b 产出的两天骨架：荔湾（到达日，2 点 + 2 备选）、天河（离开日，2 点 + 1 备选），雨备池 1 个室内馆。 */
function base(): TripSkeleton {
  return {
    destination: "广州",
    days: [
      { day: 1, area: "荔湾区", centroid: { lat: 23.117, lon: 113.242 }, roles: ["arrival"], spots: [s("陈家祠", 23.126, 113.246, "荔湾区"), s("沙面", 23.108, 113.239, "荔湾区")], alternates: [s("永庆坊", 23.115, 113.238, "荔湾区"), s("上下九", 23.117, 113.244, "荔湾区")] },
      { day: 2, area: "天河区", centroid: { lat: 23.112, lon: 113.323 }, roles: ["departure"], spots: [s("广州塔", 23.106, 113.324, "天河区"), s("珠江新城", 23.118, 113.322, "天河区")], alternates: [s("海心沙", 23.112, 113.322, "天河区")] },
    ],
    rainPool: [s("广东省博物馆", 23.114, 113.323, "天河区", true)],
    source: "group",
    searchCalls: 5,
  };
}

const SESSION = "sess-decide";
const TURN = "turn-1";

/** 假 tour-plan 会话：像真工具那样把提交落进槽，再吐一句正文。 */
function submitting(payload: unknown): ChatStreamer {
  return async function* (_m, hooks) {
    assert.equal(hooks?.agent, DECIDE_AGENT);
    recordSubmission({ sessionId: SESSION, turnId: TURN, agent: DECIDE_SLOT }, "submit_tour_days", payload);
    await new Promise((r) => setTimeout(r, 5));
    yield "已提交。";
  };
}
const texting = (text: string): ChatStreamer =>
  async function* () {
    yield text;
  };
const parseText = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

afterEach(() => __resetSubmissions());

describe("[F-18-01][AC-18-1] validateDecision：四条合法性判据 + 配额按代码裁", () => {
  it("合法提交：换了一个备选、给了主题 → source decide、坐标来自候选池、theme 进天、被换下的点回到 alternates", () => {
    const v = validateDecision({ days: [{ day: 1, theme: "老城慢逛", spots: [{ name: "陈家祠" }, { name: "永庆坊" }] }, { day: 2, theme: "江边夜景", spots: [{ name: "广州塔" }] }], findings: [] }, base());
    assert.ok(v.ok);
    assert.equal(v.skeleton.source, "decide");
    assert.deepEqual(v.skeleton.days.map((d) => d.theme), ["老城慢逛", "江边夜景"]);
    assert.deepEqual(v.skeleton.days[0]!.spots.map((x) => [x.name, x.lat, x.lon]), [["陈家祠", 23.126, 113.246], ["永庆坊", 23.115, 113.238]]);
    assert.deepEqual(v.skeleton.days[0]!.alternates.map((x) => x.name), ["沙面", "上下九"]);
    assert.deepEqual(v.skeleton.days[1]!.alternates.map((x) => x.name), ["珠江新城", "海心沙"]);
    // area / roles 沿用 1b，不由模型改
    assert.deepEqual(v.skeleton.days.map((d) => [d.area, d.roles]), [["荔湾区", ["arrival"]], ["天河区", ["departure"]]]);
  });

  it("天数 ≠ K / 名字差一字 / 某天 0 个点 / 同一个点排两天 / 天号重复 → 各自的原因串", () => {
    const b = base();
    const r = (sub: unknown) => {
      const v = validateDecision(sub, b);
      return v.ok ? "ok" : v.reason;
    };
    assert.equal(r({ days: [{ day: 1, spots: [{ name: "陈家祠" }] }] }), "days:1≠2");
    assert.equal(r({ days: [{ day: 1, spots: [{ name: "陈家祠堂" }] }, { day: 2, spots: [{ name: "广州塔" }] }] }), "unknown-name:陈家祠堂");
    assert.equal(r({ days: [{ day: 1, spots: [] }, { day: 2, spots: [{ name: "广州塔" }] }] }), "empty-day:1");
    assert.equal(r({ days: [{ day: 1, spots: [{ name: "广州塔" }] }, { day: 2, spots: [{ name: "广州塔" }] }] }), "duplicate-name:广州塔");
    assert.equal(r({ days: [{ day: 1, spots: [{ name: "陈家祠" }] }, { day: 1, spots: [{ name: "广州塔" }] }] }), "day-number:1");
    assert.equal(r({ findings: [] }), "no-days");
    assert.equal(r("nope"), "no-days");
  });

  it("超出配额不判不合法：到达日交 3 个点 → 留 2 个、第三个进 alternates 最前，trimmed 记 1；雨备池的名字也认", () => {
    const v = validateDecision({ days: [{ day: 1, spots: [{ name: "陈家祠" }, { name: "沙面" }, { name: "永庆坊" }] }, { day: 2, spots: [{ name: "广东省博物馆" }] }] }, base());
    assert.ok(v.ok);
    assert.equal(v.trimmed, 1);
    assert.deepEqual(v.skeleton.days[0]!.spots.map((x) => x.name), ["陈家祠", "沙面"]);
    assert.deepEqual(v.skeleton.days[0]!.alternates.map((x) => x.name), ["永庆坊", "上下九"]);
    assert.deepEqual(v.skeleton.days[1]!.spots.map((x) => [x.name, x.indoor]), [["广东省博物馆", true]]);
  });

  it("提示词：每天一段带角色与配额、备选与雨备池在场、硬要求写明 K", () => {
    const p = renderDecidePrompt(base(), { constraintText: "必须满足的硬约束：\n- 带老人" });
    assert.match(p, /第 1 天（到达日，只有半天，最多 2 个点）｜片区：荔湾区/);
    assert.match(p, /已排：陈家祠｜评分 4.5、沙面/);
    assert.match(p, /同片区备选：永庆坊/);
    assert.match(p, /雨备池.*广东省博物馆（室内）/);
    assert.match(p, /days 恰好 2 项/);
    assert.match(p, /带老人/);
    assert.match(p, /submit_tour_days/);
  });
});

describe("[F-18-01][AC-18-1] planDecide：合法用 1c 的，四种失败都回落 1b", () => {
  it("提交通道：合法提交 → outcome ok、source submission、骨架 source decide", async () => {
    const out = await planDecide(base(), {
      streamer: submitting({ days: [{ day: 1, theme: "老城", spots: [{ name: "陈家祠" }] }, { day: 2, theme: "江边", spots: [{ name: "广州塔" }] }], findings: [] }),
      threadId: SESSION,
      turnId: TURN,
    });
    assert.equal(out.outcome, "ok");
    assert.equal(out.source, "submission");
    assert.equal(out.skeleton.source, "decide");
    assert.deepEqual(out.skeleton.days.map((d) => d.theme), ["老城", "江边"]);
  });

  it("超时：流静默 → outcome timeout，骨架逐字等于 1b", async () => {
    const b = base();
    const silent: ChatStreamer = async function* (_m, hooks) {
      yield "想想";
      await new Promise<void>((r) => hooks?.signal?.addEventListener("abort", () => r()));
    };
    const out = await planDecide(b, { streamer: silent, threadId: SESSION, turnId: TURN, timeoutMs: 40 });
    assert.equal(out.outcome, "timeout");
    assert.deepEqual(out.skeleton, b);
  });

  it("分支失败：streamer 抛错 → outcome failed 带 reason，回落 1b", async () => {
    const b = base();
    const broken: ChatStreamer = async function* () {
      throw new Error("pi down");
    };
    const out = await planDecide(b, { streamer: broken, threadId: SESSION, turnId: TURN });
    assert.equal(out.outcome, "failed");
    assert.match(out.reason ?? "", /pi down/);
    assert.deepEqual(out.skeleton, b);
  });

  it("没有提交、正文也没有 JSON → missing；正文有合法 JSON → 走同一份校验（source text）", async () => {
    const b = base();
    const none = await planDecide(b, { streamer: texting("我觉得都挺好"), threadId: SESSION, turnId: TURN, parseText });
    assert.equal(none.outcome, "missing");
    assert.deepEqual(none.skeleton, b);

    const viaText = await planDecide(b, {
      streamer: texting(JSON.stringify({ days: [{ day: 1, spots: [{ name: "沙面" }] }, { day: 2, spots: [{ name: "海心沙" }] }] })),
      threadId: SESSION,
      turnId: TURN,
      parseText,
    });
    assert.equal(viaText.outcome, "ok");
    assert.equal(viaText.source, "text");
    assert.deepEqual(viaText.skeleton.days.map((d) => d.spots.map((x) => x.name)), [["沙面"], ["海心沙"]]);
  });

  it("提交不合法（名字差一字）→ invalid 带原因，回落 1b；没有 parseText 时正文不回落", async () => {
    const b = base();
    const bad = await planDecide(b, { streamer: submitting({ days: [{ day: 1, spots: [{ name: "陈家祠堂" }] }, { day: 2, spots: [{ name: "广州塔" }] }] }), threadId: SESSION, turnId: TURN });
    assert.equal(bad.outcome, "invalid");
    assert.equal(bad.reason, "unknown-name:陈家祠堂");
    assert.deepEqual(bad.skeleton, b);

    const noParse = await planDecide(b, { streamer: texting(JSON.stringify({ days: [{ day: 1, spots: [{ name: "沙面" }] }, { day: 2, spots: [{ name: "海心沙" }] }] })), threadId: SESSION, turnId: TURN });
    assert.equal(noParse.outcome, "missing");
  });

  it("发之前清槽：上一轮躺在槽里的提交不会被当成这一轮的结论", async () => {
    recordSubmission({ sessionId: SESSION, turnId: TURN, agent: DECIDE_SLOT }, "submit_tour_days", { days: [{ day: 1, spots: [{ name: "沙面" }] }, { day: 2, spots: [{ name: "海心沙" }] }] });
    const out = await planDecide(base(), { streamer: texting("没提交"), threadId: SESSION, turnId: TURN, parseText });
    assert.equal(out.outcome, "missing");
  });

  it("超时层级：1c 的 60 s 独立超时 < 四条腿的分支超时 300 s，且分支超时 + 30 s ≤ ACP 的 prompt 超时", () => {
    assert.equal(PLAN_DECIDE_TIMEOUT_MS, 60_000);
    const itinerary = readFileSync(new URL("../src/graph/subgraphs/itinerary.ts", import.meta.url), "utf8");
    const branch = Number(/ITINERARY_BRANCH_TIMEOUT_MS = ([\d_]+)/.exec(itinerary)![1]!.replace(/_/g, ""));
    assert.ok(PLAN_DECIDE_TIMEOUT_MS < branch, `${PLAN_DECIDE_TIMEOUT_MS} < ${branch}`);
    const acp = readFileSync(new URL("../../shared/acp/src/connection.ts", import.meta.url), "utf8");
    const prompt = /PROMPT_TIMEOUT_MS = ([\d_]+)/.exec(acp);
    assert.ok(prompt, "shared/acp/src/connection.ts 里应有 PROMPT_TIMEOUT_MS");
    assert.ok(branch + 30_000 <= Number(prompt[1]!.replace(/_/g, "")));
  });
});
