/**
 * 分支结论提交通道的地基（施工单 M30-01，F-13-02 通道地基段）。
 *
 * 三条主线：
 *  1. ACL：submit_hotels 只有 hotel 拿得到——"悄悄多给"是接线点 #10 盯的事故形态。
 *  2. 暂存区语义：覆盖、隔离、轮级清理、顺序不变量（先写后通知）。
 *  3. 工具端到端：经 invokeTool 走一遍，落的就是原样 payload；归不了轮时如实拒收。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { listForAgent, setBranchSubmissionSink, submitHotelsTool } from "@carlife/tools";

import {
  __resetSubmissions,
  peekSubmission,
  recordSubmission,
  sweepTurn,
  waitSubmission,
} from "../src/branch-submissions";

beforeEach(() => {
  __resetSubmissions();
  setBranchSubmissionSink({ record: (ctx, tool, payload) => recordSubmission(ctx, tool, payload) });
});

describe("ACL：提交通道按分支一对一", () => {
  it("hotel 拿得到 submit_hotels", () => {
    const names = listForAgent("hotel").map((t) => t.name);
    assert.ok(names.includes("submit_hotels"));
  });

  it("四个 submit 工具各归各家——悄悄多给没人会报错，只能靠这里（M30-04 扩成矩阵）", () => {
    const owner: Record<string, string> = {
      submit_hotels: "hotel",
      submit_tour_days: "tour",
      submit_transit: "transit",
      submit_drive_draft: "drive",
    };
    for (const agent of ["hotel", "drive", "tour", "transit", "trip", "supervisor", "cabin"] as const) {
      const names = new Set(listForAgent(agent).map((t) => t.name));
      for (const [tool, own] of Object.entries(owner)) {
        assert.equal(names.has(tool), agent === own, `${agent} 与 ${tool} 的可见性错了`);
      }
    }
  });
});

describe("暂存区：①Working 层的按轮槽位", () => {
  const ctx = { sessionId: "s1", turnId: "t1", agent: "hotel" };

  it("record 后 peek 取到原样 payload；不同 (session,turn,agent) 互不可见", () => {
    assert.equal(recordSubmission(ctx, "submit_hotels", { hotels: [{ name: "A" }] }), true);
    assert.deepEqual(peekSubmission("s1", "t1", "hotel")?.payload, { hotels: [{ name: "A" }] });
    assert.equal(peekSubmission("s1", "t1", "drive"), undefined);
    assert.equal(peekSubmission("s1", "t2", "hotel"), undefined);
    assert.equal(peekSubmission("s2", "t1", "hotel"), undefined);
  });

  it("同轮后写覆盖前写——模型重试正是靠覆盖生效", () => {
    recordSubmission(ctx, "submit_hotels", { hotels: [] });
    recordSubmission(ctx, "submit_hotels", { hotels: [{ name: "重试成功的那次" }] });
    const got = peekSubmission("s1", "t1", "hotel")?.payload as { hotels: Array<{ name: string }> };
    assert.equal(got.hotels[0]?.name, "重试成功的那次");
  });

  it("turnId 或 agent 缺失时拒收——归不了轮的提交谁也读不到", () => {
    assert.equal(recordSubmission({ sessionId: "s1", agent: "hotel" }, "t", {}), false);
    assert.equal(recordSubmission({ sessionId: "s1", turnId: "t1" }, "t", {}), false);
  });

  it("sweepTurn 只清这一轮，别的轮不动", () => {
    recordSubmission(ctx, "submit_hotels", { hotels: [] });
    recordSubmission({ sessionId: "s1", turnId: "t2", agent: "hotel" }, "submit_hotels", { hotels: [] });
    sweepTurn("s1", "t1");
    assert.equal(peekSubmission("s1", "t1", "hotel"), undefined);
    assert.ok(peekSubmission("s1", "t2", "hotel"));
  });

  it("**顺序不变量**：完成信号兑现时暂存区必已有数据（M30-02 的 abort 靠它不丢数据）", async () => {
    const p = waitSubmission("s1", "t1", "hotel").then((sub) => {
      // 信号到手的这一刻就去读——这正是 fanout 拿到信号立刻 abort 后 merge 会做的事。
      assert.ok(peekSubmission("s1", "t1", "hotel"), "通知先于写入的话，这里读到空，数据丢且零报错");
      return sub;
    });
    recordSubmission(ctx, "submit_hotels", { hotels: [{ name: "A" }] });
    const sub = await p;
    assert.deepEqual((sub.payload as { hotels: unknown[] }).hotels, [{ name: "A" }]);
  });

  it("提交先于订阅：信号立即兑现，不因起跑顺序丢失", async () => {
    recordSubmission(ctx, "submit_hotels", { hotels: [] });
    const sub = await waitSubmission("s1", "t1", "hotel");
    assert.equal(sub.tool, "submit_hotels");
  });
});

describe("submit_hotels 工具端到端", () => {
  it("经 call 走一遍：落原样 payload，findings 缺省补空数组", async () => {
    const res = await submitHotelsTool.call(
      { hotels: [{ name: "如家", area: "荔湾" }] },
      { sessionId: "s1", turnId: "t1", agent: "hotel" },
    );
    assert.equal((res.data as { accepted: number }).accepted, 1);
    assert.deepEqual(peekSubmission("s1", "t1", "hotel")?.payload, {
      hotels: [{ name: "如家", area: "荔湾" }],
      findings: [],
    });
  });

  it("turnId 反解失败时如实报错，不静默吞下", async () => {
    await assert.rejects(
      submitHotelsTool.call({ hotels: [] }, { sessionId: "s1", agent: "hotel" }),
      /归属到当前轮次/,
    );
  });

  it("schema 拒收坏参数——这是「当场重试」的物理基础（invokeTool 层）", async () => {
    const { invokeTool } = await import("@carlife/tools");
    // 缺 hotels
    await assert.rejects(
      invokeTool("submit_hotels", {}, { sessionId: "s1", turnId: "t1", agent: "hotel" }),
      /入参不合法/,
    );
    // hotels[].name 缺失——事故原型里坏掉的正是条目级字段
    await assert.rejects(
      invokeTool(
        "submit_hotels",
        { hotels: [{ address: "没有名字的店" }] },
        { sessionId: "s1", turnId: "t1", agent: "hotel" },
      ),
      /入参不合法/,
    );
    // 拒收之后暂存区必须还是空的——坏提交不留半截状态
    assert.equal(peekSubmission("s1", "t1", "hotel"), undefined);
  });

  it("sink 未注入时报 unconfigured——提交进不存在的地方不算成功", async () => {
    setBranchSubmissionSink(undefined);
    await assert.rejects(
      submitHotelsTool.call({ hotels: [] }, { sessionId: "s1", turnId: "t1", agent: "hotel" }),
      /未接入/,
    );
  });
});
