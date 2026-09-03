/**
 * 会话详情页的轮次排序与逐轮轨迹切分（施工单 TD-08 追加）。
 *
 * 两条都属于"用眼睛在页面上看不出错"的那类：
 * 序号跟着显示顺序倒过来时，页面自己看着完全正常，
 * 只有在两个人对着屏幕说"第 3 轮"时才发现指的不是同一件事。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { eventsOfTurn, turnsNewestFirst } from "../src/pages/sessions/turns";
import type { TraceEvent } from "../src/pages/trace/timeline";

const msg = (turnId: string, ts: number, role: "user" | "assistant") => ({
  messageId: `msg-${turnId}-${role}`,
  turnId,
  role,
  source: "text" as const,
  content: "…",
  ts,
});

// 接口返回的是**正序**（ts 升序），页面负责倒过来显示。
const MESSAGES = [
  msg("t1", 1_000, "user"),
  msg("t1", 1_100, "assistant"),
  msg("t2", 2_000, "user"),
  msg("t2", 2_100, "assistant"),
  msg("t3", 3_000, "user"),
];

describe("轮次逆序展示", () => {
  const turns = turnsNewestFirst(MESSAGES);

  it("最近一轮排最上面", () => {
    assert.deepEqual(turns.map((t) => t.turnId), ["t3", "t2", "t1"]);
  });

  it("**序号仍是真实时间序**——不随显示顺序倒过来", () => {
    // 倒过来编号的话，最新那轮会叫"第 1 轮"，而它在轨迹与日志里是最后一条。
    // 两个人对着屏幕说"第 3 轮"时指的不是同一件事。
    assert.equal(turns.find((t) => t.turnId === "t1")!.index, 1, "最早那轮永远是第 1 轮");
    assert.equal(turns.find((t) => t.turnId === "t3")!.index, 3);
    assert.deepEqual(turns.map((t) => t.index), [3, 2, 1]);
  });

  it("轮内消息保持正序——一轮里车主在前、助手在后", () => {
    const t1 = turns.find((t) => t.turnId === "t1")!;
    assert.deepEqual(t1.messages.map((m) => m.role), ["user", "assistant"]);
  });

  it("只有车主消息的轮次（助手没回）照样成一轮，不被吞掉", () => {
    const t3 = turns.find((t) => t.turnId === "t3")!;
    assert.equal(t3.messages.length, 1);
  });

  it("空会话返回空数组，不抛错", () => {
    assert.deepEqual(turnsNewestFirst([]), []);
  });
});

describe("逐轮轨迹切分", () => {
  const timeline: TraceEvent[] = [
    { kind: "span", at: 10, turnId: "t1", data: { name: "node.answer" } },
    { kind: "route", at: 12, turnId: "t1", data: { agent: "trip" } },
    { kind: "span", at: 20, turnId: "t2", data: { name: "node.answer" } },
    // 轮次外：ACP 冷启动 / 确认超时后才落的裁决，都没有 turnId
    { kind: "span", at: 5, data: { name: "acp.connect", keyFallback: true } },
    { kind: "guard", at: 999, data: { decision: "deny", keyFallback: true } },
  ];

  it("按 turnId 精确切分", () => {
    assert.equal(eventsOfTurn(timeline, "t1").events.length, 2);
    assert.equal(eventsOfTurn(timeline, "t2").events.length, 1);
  });

  it("**轮次外的事件被数出来**，不静默消失", () => {
    // 不吭声的话读者会以为"这一轮就是这些"，而 acp.connect 恰恰可能是最慢的一跳。
    assert.equal(eventsOfTurn(timeline, "t1").orphan, 2);
  });

  it("没有轨迹的轮次返回空，且 orphan 计数仍然给出", () => {
    const r = eventsOfTurn(timeline, "t-不存在");
    assert.deepEqual(r.events, []);
    assert.equal(r.orphan, 2, "查不到这一轮，不等于会话里什么都没有");
  });
});
