/**
 * 实时轨迹总线（大屏"现在流到哪了"）。零依赖、不起网络。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { liveTrace, noteNodeStart, type LiveEvent } from "../src/trace/live";

const evt = (kind: string, name?: string): LiveEvent => ({
  sessionId: "s1",
  turnId: "t1",
  kind,
  at: 1,
  data: name ? { name } : {},
});

describe("实时轨迹总线", () => {
  beforeEach(() => liveTrace.reset());

  it("新订阅者先看到回溯，再接实时——否则打开大屏得先等一轮对话", () => {
    liveTrace.publish(evt("turn_start"));
    liveTrace.publish(evt("node_start", "node.understand"));

    const seen: string[] = [];
    const off = liveTrace.subscribe((e) => seen.push(e.kind));
    assert.deepEqual(seen, ["turn_start", "node_start"], "订阅那一刻就该有回溯");

    liveTrace.publish(evt("route"));
    assert.deepEqual(seen, ["turn_start", "node_start", "route"]);

    off();
    liveTrace.publish(evt("turn_end"));
    assert.equal(seen.length, 3, "退订之后不该再收到");
  });

  it("**一个订阅者炸了不拖垮别人，更不拖垮主链路**", () => {
    const good: string[] = [];
    liveTrace.subscribe(() => {
      throw new Error("大屏那边的 res.write 挂了");
    });
    liveTrace.subscribe((e) => good.push(e.kind));

    assert.doesNotThrow(() => liveTrace.publish(evt("route")));
    assert.deepEqual(good, ["route"], "坏订阅者不该让好的那个漏事件");
  });

  it("没有订阅者时也照常入回溯——大屏是偶尔才有人看的页面", () => {
    liveTrace.publish(evt("turn_start"));
    const seen: LiveEvent[] = [];
    liveTrace.subscribe((e) => seen.push(e));
    assert.equal(seen.length, 1);
  });

  it("回溯有上限，丢最早的而不是拒绝新的", () => {
    for (let i = 0; i < 260; i += 1) liveTrace.publish({ ...evt("route"), at: i });
    const seen: LiveEvent[] = [];
    liveTrace.subscribe((e) => seen.push(e));
    assert.equal(seen.length, 200);
    // 留下的必须是**最近**那 200 条：排障与演示看的总是刚刚发生的事。
    assert.equal(seen[seen.length - 1].at, 259);
  });

  it("`node_start` 是实时专有的一种，形状与 span 对齐（`node.<名>`）", () => {
    const seen: LiveEvent[] = [];
    liveTrace.subscribe((e) => seen.push(e));
    // threadId 换算不到时仍然发（`resolveTraceKey` 会给 unknown）——
    // 丢掉的话"为什么这一步没亮"就再也查不出来。
    noteNodeStart(undefined, "answer");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, "node_start");
    assert.equal(seen[0].data.name, "node.answer");
  });
});
