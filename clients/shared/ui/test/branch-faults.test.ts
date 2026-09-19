/**
 * 分支失败的端上聚合（M37-01，F-13-03）。
 *
 * 真相源是 `update.branch` 的结构化 status——这些断言钉住的是
 * "什么进横幅、什么不进、什么时候清"，不是话术本身。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyBranchFault,
  EMPTY_FAULTS,
  faultsOfCurrentTurn,
  type BranchFaultEvent,
} from "../src/hooks/useBranchFaults";

const ev = (
  agent: string,
  status: BranchFaultEvent["status"],
  note: string | null = null,
  turnId = "turn-1",
): BranchFaultEvent => ({ turnId, agent, status, note });

describe("分支失败聚合", () => {
  it("failed/timeout 进清单，带服务端人话", () => {
    let s = applyBranchFault(EMPTY_FAULTS, ev("hotel-task", "timeout", "酒店安排超时未返回"));
    s = applyBranchFault(s, ev("guide-spots-task", "failed", "必玩点位失败了"));
    assert.deepEqual(
      s.map((x) => x.text),
      ["酒店安排超时未返回", "必玩点位失败了"],
    );
  });

  it("started/ok **不进**——进展不是缺失，混进去横幅会常驻", () => {
    let s = applyBranchFault(EMPTY_FAULTS, ev("hotel-task", "started"));
    s = applyBranchFault(s, ev("hotel-task", "ok", "酒店安排已完成"));
    assert.equal(s.length, 0);
    assert.equal(s, EMPTY_FAULTS, "无变化时保持原引用，少一次重渲染");
  });

  it("同一分支的重复终态不叠加（服务端重试补发）", () => {
    let s = applyBranchFault(EMPTY_FAULTS, ev("tour-task", "failed", "景点安排失败了"));
    const again = applyBranchFault(s, ev("tour-task", "failed", "景点安排失败了"));
    assert.equal(again.length, 1);
    assert.equal(again, s, "重复事件返回原引用");
  });

  it("note 缺席时退化为 agent 名——不编话术", () => {
    const s = applyBranchFault(EMPTY_FAULTS, ev("drive-task", "timeout"));
    assert.equal(s[0].text, "drive-task");
  });
});

/*
 * [F-13-03][F-13-07] M94-02：归属于哪一轮由 turnId 决定。
 *
 * 复现 sess-67477977-b21（2026-09-16）：turn-dfb2fd8e 五条分支全 ok、零失败，
 * 而屏幕顶部的横幅列着三条——那三条属于下一轮 turn-dfce15e7。
 */
describe("分支失败按轮归属", () => {
  it("**跨轮不串**：横幅只说最新一轮，上一轮的缺失不挂到这一轮头上", () => {
    let s = applyBranchFault(EMPTY_FAULTS, ev("hotel-task", "failed", "酒店安排失败了", "turn-a"));
    s = applyBranchFault(s, ev("tour-task", "failed", "景点安排失败了", "turn-a"));
    s = applyBranchFault(s, ev("drive-task", "timeout", "自驾路线超时未返回", "turn-b"));
    assert.equal(s.length, 3, "全部留在 state 里，排障要看得到");
    assert.deepEqual(
      faultsOfCurrentTurn(s).map((x) => x.text),
      ["自驾路线超时未返回"],
      "渲染只取最新一轮那组",
    );
  });

  it("同一轮多条按到达顺序排——与服务端发出的顺序一致", () => {
    let s = applyBranchFault(EMPTY_FAULTS, ev("hotel-task", "failed", "酒店安排失败了", "turn-x"));
    s = applyBranchFault(s, ev("tour-task", "failed", "景点安排失败了", "turn-x"));
    s = applyBranchFault(s, ev("drive-task", "timeout", "自驾路线超时未返回", "turn-x"));
    assert.deepEqual(
      faultsOfCurrentTurn(s).map((x) => x.text),
      ["酒店安排失败了", "景点安排失败了", "自驾路线超时未返回"],
    );
  });

  it("跨轮同名分支各留一条——只按 agent 去重会把后一轮那条整条丢掉", () => {
    let s = applyBranchFault(EMPTY_FAULTS, ev("tour-task", "failed", "景点安排失败了", "turn-a"));
    s = applyBranchFault(s, ev("tour-task", "failed", "景点安排失败了", "turn-b"));
    assert.equal(s.length, 2);
    assert.deepEqual(faultsOfCurrentTurn(s).map((x) => x.turnId), ["turn-b"]);
  });

  it("同一轮同一分支的重复终态仍去重（体检修复轮会重发）", () => {
    const s = applyBranchFault(EMPTY_FAULTS, ev("drive-task", "timeout", "自驾路线超时未返回", "turn-a"));
    const again = applyBranchFault(s, ev("drive-task", "timeout", "自驾路线超时未返回", "turn-a"));
    assert.equal(again, s, "重复事件返回原引用");
  });

  it("全是同一轮时返回原引用，不白白触发一次重渲染", () => {
    const s = applyBranchFault(EMPTY_FAULTS, ev("hotel-task", "failed", "酒店安排失败了", "turn-a"));
    assert.equal(faultsOfCurrentTurn(s), s);
    assert.equal(faultsOfCurrentTurn(EMPTY_FAULTS), EMPTY_FAULTS);
  });
});

/*
 * [F-13-03][F-13-07] M98-04：真跑事件原样回放。
 *
 * 上面几条用的是手写事件，钉的是"规则对不对"；这一条用的是 2026-09-16 那次真跑
 * （sess-6c9b92c3-8f3，成都→西藏 7 天自驾 + 一次"第 3 天太赶了"的改动）从网关 SSE
 * 上原样收到的 28 条 branch 事件，钉的是"真实数据流上归因对不对"。
 *
 * 这组数据正好是 M94-02 那个 bug 的镜像形态：第一轮五条分支全 ok，第二轮 drive 连超时两次。
 * 归因错的话，横幅会在第一轮就挂上第二轮的超时，或者第二轮把第一轮的 ok 一起算进来。
 *
 * 只留 turnId / agent / status 三个字段与服务端那句话，用户原文与地名一律不进仓。
 */
const LIVE_TURN_1 = "turn-72c30c4e";
const LIVE_TURN_2 = "turn-fcef68a6";

/** 真跑第 1 轮：主 fan-out 五条 + 两轮修复里 tour / drive 各重跑两次，全部 ok。 */
const LIVE_ROUND_1: Array<[string, BranchFaultEvent["status"]]> = [
  ["tour-plan-task", "started"], ["tour-plan-task", "ok"],
  ["drive-task", "started"], ["hotel-task", "started"], ["tour-task", "started"],
  ["transit-task", "started"], ["ownership-task", "started"],
  ["ownership-task", "ok"], ["tour-task", "ok"], ["transit-task", "ok"],
  ["drive-task", "ok"], ["hotel-task", "ok"],
  ["tour-task", "started"], ["tour-task", "ok"],
  ["drive-task", "started"], ["drive-task", "ok"],
  ["tour-task", "started"], ["tour-task", "ok"],
  ["drive-task", "started"], ["drive-task", "ok"],
];

/** 真跑第 2 轮：tour 重跑两次都 ok，drive 连超时两次（25 s 硬顶各一次）。 */
const LIVE_ROUND_2: Array<[string, BranchFaultEvent["status"]]> = [
  ["tour-task", "started"], ["tour-task", "ok"],
  ["tour-task", "started"], ["tour-task", "ok"],
  ["drive-task", "started"], ["drive-task", "timeout"],
  ["drive-task", "started"], ["drive-task", "timeout"],
];

describe("分支失败按轮归属 · 真跑事件", () => {
  it("**真实数据**：第一轮全 ok、第二轮 drive 两次超时——横幅只出第二轮那一条", () => {
    let s = EMPTY_FAULTS;
    for (const [agent, status] of LIVE_ROUND_1) {
      s = applyBranchFault(s, ev(agent, status, status === "ok" ? `${agent}已完成` : null, LIVE_TURN_1));
    }
    assert.equal(s.length, 0, "第一轮零失败：二十条事件一条都不该进横幅");

    for (const [agent, status] of LIVE_ROUND_2) {
      s = applyBranchFault(
        s,
        ev(agent, status, status === "timeout" ? "自驾路线超时未返回" : null, LIVE_TURN_2),
      );
    }
    assert.deepEqual(
      faultsOfCurrentTurn(s).map((x) => [x.turnId, x.text]),
      [[LIVE_TURN_2, "自驾路线超时未返回"]],
      "同一轮同一分支超时两次去重成一条，且挂在第二轮",
    );
  });
});
