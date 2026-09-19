/**
 * 提交期望：内容不齐就退回，让模型在会话里当场重交（真跑 turn-dc5da219）。
 *
 * 那一轮骨架 3 天、tour 只交了第 1 天，形状合法所以照收，「提交即收工」随即掐流，
 * 第 2、3 天靠骨架守卫接回、整天没有时段。对照台同一份输入重放 20/20 交齐——随机退化，
 * 提示词对不准，所以钉的是**犯了会被当场退回**这件事，以及它的两条不变量：
 *  1. 拒收有上限，到顶照收（不让模型陷在重交循环里）；
 *  2. 拒收不能让结果比不拒收更差（被退的那份留作兜底，fanout 在提交没赢时取走）。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { invokeTool, setBranchSubmissionSink, ToolError } from "@carlife/tools";

import {
  __resetSubmissions,
  clearSubmission,
  expectSubmission,
  heldSubmission,
  peekSubmission,
  recordSubmission,
  submissionRejections,
  waitSubmission,
} from "../src/branch-submissions";
import { runFanout } from "../src/graph/fanout";
import { tourDaysExpectation, TOUR_DAYS_MAX_REJECTS } from "../src/graph/trip-plan-layer";
import type { TripSkeleton } from "../src/graph/trip-plan-layer";
import type { ChatStreamer } from "../src/llm";

const spot = (name: string) => ({ name, lat: 31.3, lon: 120.6, indoor: false });
const skeleton: TripSkeleton = {
  destination: "苏州",
  source: "decide",
  searchCalls: 9,
  rainPool: [],
  days: [1, 2, 3].map((day) => ({
    day,
    area: "姑苏区",
    centroid: { lat: 31.3, lon: 120.6 },
    roles: [],
    spots: [spot(`景点${day}`)],
    alternates: [],
  })),
};
const dayOf = (day: number) => ({ day, spots: [{ name: `景点${day}`, estStart: "09:00", estEnd: "11:00" }] });
/** turn-dc5da219 那一份：只有第 1 天。 */
const PARTIAL = { destination: "苏州", days: [dayOf(1)], findings: [] };
const FULL = { destination: "苏州", days: [dayOf(1), dayOf(2), dayOf(3)], findings: [] };

const ctx = { sessionId: "s1", turnId: "t1", agent: "tour" };

beforeEach(() => {
  __resetSubmissions();
  setBranchSubmissionSink({ record: (c, tool, payload) => recordSubmission(c, tool, payload) });
});
afterEach(() => setBranchSubmissionSink(undefined));

describe("tourDaysExpectation：判据只有天号覆盖", () => {
  const exp = tourDaysExpectation(skeleton);

  it("交齐 → 收下；只交第 1 天 → 原因里点出缺第 2、3 天", () => {
    assert.equal(exp.check("submit_tour_days", FULL), undefined);
    const reason = exp.check("submit_tour_days", PARTIAL);
    assert.match(String(reason), /骨架是 3 天/);
    assert.match(String(reason), /只交了第 1 天/);
    assert.match(String(reason), /缺第 2、3 天/);
    assert.match(String(reason), /一次交齐全部 3 天/);
  });

  it("天号没给就按下标 + 1——与 mergeItinerary 同一口径，否则这里放行的会在那边被判缺天", () => {
    const noNumbers = { days: [{ spots: [] }, { spots: [] }, { spots: [] }] };
    assert.equal(exp.check("submit_tour_days", noNumbers), undefined);
    assert.match(String(exp.check("submit_tour_days", { days: [{ spots: [] }] })), /缺第 2、3 天/);
  });

  it("空数组 → 「一天都没交」；没有 days 数组 → 不判（那是形状问题，归 zod）", () => {
    assert.match(String(exp.check("submit_tour_days", { days: [] })), /你一天都没交/);
    assert.equal(exp.check("submit_tour_days", {}), undefined);
    assert.equal(exp.check("submit_tour_days", null), undefined);
  });

  it("别的工具不归它管；多交的天不算缺", () => {
    assert.equal(exp.check("submit_hotels", { hotels: [] }), undefined);
    assert.equal(exp.check("submit_tour_days", { days: [dayOf(1), dayOf(2), dayOf(3), dayOf(4)] }), undefined);
  });
});

describe("暂存区：按期望退回", () => {
  it("残缺提交**不写入、不通知**，原因返回；交齐后才兑现等待者", async () => {
    expectSubmission("s1", "t1", "tour", tourDaysExpectation(skeleton));
    let fired: unknown;
    void waitSubmission("s1", "t1", "tour").then((s) => (fired = s.payload));

    const r = recordSubmission(ctx, "submit_tour_days", PARTIAL);
    assert.equal(typeof r, "object");
    assert.match((r as { rejected: string }).rejected, /缺第 2、3 天/);
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(fired, undefined, "通知了就等于『提交即收工』把会话掐掉——模型没机会重交");
    assert.equal(peekSubmission("s1", "t1", "tour"), undefined);
    assert.equal(submissionRejections(), 1);

    assert.equal(recordSubmission(ctx, "submit_tour_days", FULL), true);
    await new Promise((res) => setTimeout(res, 5));
    assert.deepEqual(fired, FULL);
    assert.equal(heldSubmission("s1", "t1", "tour"), undefined, "收下合格的一份之后，兜底那份作废");
  });

  it("**拒收有上限**：连退 maxRejects 次之后照收，不让模型陷在重交循环里", () => {
    expectSubmission("s1", "t1", "tour", tourDaysExpectation(skeleton));
    for (let i = 0; i < TOUR_DAYS_MAX_REJECTS; i += 1) {
      assert.equal(typeof recordSubmission(ctx, "submit_tour_days", PARTIAL), "object", `第 ${i + 1} 次该被退回`);
    }
    assert.equal(recordSubmission(ctx, "submit_tour_days", PARTIAL), true, "到顶照收，缺的天交给骨架守卫");
    assert.deepEqual(peekSubmission("s1", "t1", "tour")?.payload, PARTIAL);
  });

  it("被退的那份留作兜底；`clearSubmission`（新的一跳）把额度与兜底一起清掉", () => {
    expectSubmission("s1", "t1", "tour", tourDaysExpectation(skeleton));
    recordSubmission(ctx, "submit_tour_days", PARTIAL);
    assert.deepEqual(heldSubmission("s1", "t1", "tour")?.payload, PARTIAL);

    clearSubmission("s1", "t1", "tour");
    assert.equal(heldSubmission("s1", "t1", "tour"), undefined, "上一跳被退的那份不该顶到这一跳头上");
    // 期望留着、额度重计：追发同样要完整的一份。
    for (let i = 0; i < TOUR_DAYS_MAX_REJECTS; i += 1) {
      assert.equal(typeof recordSubmission(ctx, "submit_tour_days", PARTIAL), "object");
    }
  });

  it("期望按槽隔离：tour 的期望管不到 tour-plan（1c 裁决）与别的轮", () => {
    expectSubmission("s1", "t1", "tour", tourDaysExpectation(skeleton));
    assert.equal(recordSubmission({ ...ctx, agent: "tour-plan" }, "submit_tour_days", PARTIAL), true);
    assert.equal(recordSubmission({ ...ctx, turnId: "t2" }, "submit_tour_days", PARTIAL), true);
  });

  it("没登记期望 = 行为与从前逐字相同；判据自己抛错 = 照收", () => {
    assert.equal(recordSubmission(ctx, "submit_tour_days", PARTIAL), true);
    __resetSubmissions();
    expectSubmission("s1", "t1", "tour", {
      maxRejects: 2,
      check() {
        throw new Error("判据坏了");
      },
    });
    assert.equal(recordSubmission(ctx, "submit_tour_days", PARTIAL), true, "一个 bug 不该把提交通道堵死");
  });
});

describe("工具端到端：原因原样回到模型手里", () => {
  const toolCtx = { sessionId: "s1", turnId: "t1", agent: "tour" } as never;

  it("残缺 → ToolError(invalid, code=incomplete)，消息带缺哪几天；交齐 → accepted=3", async () => {
    expectSubmission("s1", "t1", "tour", tourDaysExpectation(skeleton));
    await assert.rejects(
      () => invokeTool("submit_tour_days", PARTIAL, toolCtx),
      (err: unknown) => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.category, "invalid");
        assert.equal(err.code, "incomplete", "轨迹上归成 tool_invalid:incomplete，与形状校验（:arg）分得开");
        assert.equal(err.retryable, false, "包装层拿同一份入参自动重试只会白耗一次拒收额度");
        assert.match(err.message, /缺第 2、3 天/);
        return true;
      },
    );
    const ok = (await invokeTool("submit_tour_days", FULL, toolCtx)) as { data: { accepted: number } };
    assert.equal(ok.data.accepted, 3);
    assert.deepEqual((peekSubmission("s1", "t1", "tour")?.payload as { days: unknown[] }).days.length, 3);
  });
});

describe("fanout：拒收不能让结果比不拒收更差", () => {
  const opts = {
    submissionOf: () => waitSubmission("s1", "t1", "tour"),
    heldSubmissionOf: () => heldSubmission("s1", "t1", "tour"),
  };

  it("被退回后模型在会话里重交 → 分支拿到的是完整那一份", async () => {
    expectSubmission("s1", "t1", "tour", tourDaysExpectation(skeleton));
    const streamer: ChatStreamer = async function* (_m, hooks) {
      recordSubmission(ctx, "submit_tour_days", PARTIAL); // 第一次：被退回，流不该被掐
      yield "重交中";
      assert.equal(hooks?.signal?.aborted, false, "残缺提交不得触发『提交即收工』");
      recordSubmission(ctx, "submit_tour_days", FULL);
      await new Promise((res) => setTimeout(res, 200)); // 收尾轮：该被掐掉
    };
    const [r] = await runFanout(streamer, [{ agent: "tour-task", prompt: "p" }], { timeoutMs: 5_000, ...opts });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.submission, FULL);
  });

  it("被退回后模型直接收场（没再交）→ 用被退的那份，逐字等于没有这道闸的从前", async () => {
    expectSubmission("s1", "t1", "tour", tourDaysExpectation(skeleton));
    const streamer: ChatStreamer = async function* () {
      recordSubmission(ctx, "submit_tour_days", PARTIAL);
      yield "我已经提交了。";
    };
    const [r] = await runFanout(streamer, [{ agent: "tour-task", prompt: "p" }], { timeoutMs: 5_000, ...opts });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.submission, PARTIAL);
  });

  it("被退回后重交到一半超时 → 同样用被退的那份，不把整条腿弄丢", async () => {
    expectSubmission("s1", "t1", "tour", tourDaysExpectation(skeleton));
    const streamer: ChatStreamer = async function* (_m, hooks) {
      recordSubmission(ctx, "submit_tour_days", PARTIAL);
      await new Promise<void>((res) => hooks?.signal?.addEventListener("abort", () => res(), { once: true }));
      throw new Error("本轮已取消");
    };
    const [r] = await runFanout(streamer, [{ agent: "tour-task", prompt: "p" }], { timeoutMs: 60, ...opts });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.submission, PARTIAL);
  });

  it("没被退过：超时照旧是 timeout（兜底只在有被退的那份时生效）", async () => {
    const streamer: ChatStreamer = async function* (_m, hooks) {
      await new Promise<void>((res) => hooks?.signal?.addEventListener("abort", () => res(), { once: true }));
      throw new Error("本轮已取消");
    };
    const [r] = await runFanout(streamer, [{ agent: "tour-task", prompt: "p" }], { timeoutMs: 60, ...opts });
    assert.equal(r.status, "timeout");
    assert.equal(r.submission, undefined);
  });
});
