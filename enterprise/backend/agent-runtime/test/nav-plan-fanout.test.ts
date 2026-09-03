/**
 * 出发导航的 fan-out（施工单 M66-02）：提交即收工、超时直连、轮结束清扫。
 * 假 streamer 与 `fanout-submit.test.ts` 同款；提交经真实的 branch-submissions 落槽，
 * 候选经真实的 route-candidates 记录——测的是这三层接在一起对不对。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recordSubmission } from "../src/branch-submissions";
import {
  DEFAULT_LEG_CAVEAT,
  DEFAULT_LEG_MINUTES,
  NO_SUBMISSION_CAVEAT,
  runNavPlan,
  runNavPlanFanout,
  type NavPlanInput,
} from "../src/graph/subgraphs/nav-plan";
import type { ChatStreamer } from "../src/llm";
import { peekRestStopCandidates, recordRestStopCandidates } from "../src/route-candidates";

const input: NavPlanInput = {
  origin: { lat: 31.23, lon: 121.47, source: "fix" },
  destination: { name: "灵隐寺", lat: 30.24, lon: 120.1 },
  strategy: "highway",
  strategyReason: "默认走高速",
  constraints: [],
  maxLegMinutes: 90,
  needs: [],
  caveats: [],
};

const STOP = { name: "南湖服务区", lat: 30.741319, lon: 120.934428, type: "高速服务区", atKm: 80, atMinute: 70, detourM: 900 };
const SUMMARY = { distanceKm: 180, durationMin: 150, tollYuan: 76, trafficLights: 2 };

/** 挂起直到 abort 的假 streamer；`onStart` 里模拟工具回流（记候选、提交）。 */
function hangingStreamer(onStart: (hooks: { threadId?: string; agent?: string }) => void): ChatStreamer {
  return async function* (_messages, hooks) {
    onStart({ threadId: hooks?.threadId, agent: hooks?.agent });
    await new Promise<void>((_r, reject) => {
      hooks?.signal?.addEventListener("abort", () => reject(new Error("本轮已取消（测试）")), { once: true });
    });
  };
}

describe("runNavPlanFanout", () => {
  it("分支是 nav-task；工具经 threadId/turnId 归轮记候选、提交即收工，方案带通过校验的途经点", async () => {
    const threadId = "nav-thread-1";
    const turnId = "nav-turn-1";
    let agentSeen: string | undefined;
    const streamer = hangingStreamer(({ agent }) => {
      agentSeen = agent;
      // 模拟 map_route 与 submit_nav_plan 从 pi 侧回流：tools-endpoint 里 ctx.sessionId 就是 threadId
      setTimeout(() => {
        recordRestStopCandidates({ sessionId: threadId, turnId, agent: "nav" }, [STOP], SUMMARY);
        recordSubmission({ sessionId: threadId, turnId, agent: "nav" }, "submit_nav_plan", {
          strategy: "highway",
          waypoints: [{ name: STOP.name, lat: STOP.lat, lon: STOP.lon, reason: "中点" }, { name: "编的", lat: 1, lon: 1 }],
          legMinutes: [70, 80],
        });
      }, 10);
    });
    const t0 = Date.now();
    const { plan, branch } = await runNavPlanFanout(streamer, input, { threadId, turnId, timeoutMs: 5_000 });
    assert.equal(agentSeen, "nav-task");
    assert.equal(branch?.status, "ok");
    assert.ok(Date.now() - t0 < 4_000, "提交落地即收工，不等超时");
    assert.deepEqual(plan.waypoints.map((w) => w.name), ["南湖服务区"]);
    assert.deepEqual(plan.legMinutes, [70, 80]);
    assert.equal(plan.summary.tollYuan, 76);
    assert.ok(plan.caveats.some((c) => c.includes("2 个休息点，1 个通过校验")));
    // 轮结束清扫：候选白名单已空
    assert.deepEqual(peekRestStopCandidates(threadId, turnId).stops, []);
  });

  it("runNavPlan：没有同行者约束时按默认 120 分钟一歇，并在 caveat 里说出来；③偏好读不到按默认高速", async () => {
    let promptSeen = "";
    const streamer: ChatStreamer = async function* (messages) {
      promptSeen = JSON.stringify(messages);
      yield "";
    };
    const plan = await runNavPlan(
      { streamer, listPreferences: async () => ({ results: [], degraded: true }), timeoutMs: 2_000 },
      { userId: "u1", origin: { lat: 31.23, lon: 121.47, source: "home" }, destination: input.destination },
    );
    assert.equal(plan.maxLegMinutes, DEFAULT_LEG_MINUTES);
    assert.ok(plan.caveats.includes(DEFAULT_LEG_CAVEAT));
    assert.ok(plan.caveats.some((c) => c.includes("常住地")));
    assert.ok(plan.caveats.some((c) => c.includes("偏好未读到")));
    assert.equal(plan.strategy, "highway");
    assert.match(promptSeen, /maxLegMinutes 必须传 120/);
  });

  it("提交从未到达 → 超时，方案退化为直连 + NO_SUBMISSION_CAVEAT，不抛", async () => {
    const streamer = hangingStreamer(() => {});
    const { plan, branch } = await runNavPlanFanout(streamer, input, { threadId: "nav-thread-2", turnId: "nav-turn-2", timeoutMs: 60 });
    assert.equal(branch?.status, "timeout");
    assert.deepEqual(plan.waypoints, []);
    assert.ok(plan.caveats.includes(NO_SUBMISSION_CAVEAT));
    assert.equal(plan.destination.name, "灵隐寺");
  });
});
