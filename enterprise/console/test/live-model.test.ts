/**
 * 大屏实时视图的状态归并。
 *
 * 这里断言的每一条都对应一个真实观测到的现象——尤其第一条：
 * 兜底桶抢走"最近活动"导致整张图被反复卸载。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY,
  ingest,
  mergeSessionTitles,
  ORPHAN_SESSION,
  pickTurn,
  type LiveTraceEvent,
} from "../src/pages/demo/live-model";

const ev = (sessionId: string, turnId: string | undefined, kind = "span"): LiveTraceEvent => ({
  sessionId,
  turnId,
  kind,
  at: 1,
  data: {},
});

describe("实时视图的会话归并", () => {
  it("**`unknown` 兜底桶不能抢走「最近活动」**——它一抢，整张图就被卸载换成一行说明", () => {
    /*
     * 实测一轮出行对话：最近活动的会话在 unknown 与真实会话之间来回切了五次
     * （旁路垫场话的提示词没有 threadId，ACP 冷启动同理）。
     * 第一版按"最近有事件的那个会话"选，于是 420px 的图被反复卸载再挂回来。
     */
    let s = ingest(EMPTY, [ev("sess-1", "turn-1")], 100);
    s = ingest(s, [ev(ORPHAN_SESSION, undefined, "prompt")], 200);
    const turn = pickTurn(s);
    assert.equal(turn?.sessionId, "sess-1", "兜底桶来了一条，画的仍然是真实会话");
    assert.equal(turn?.turnId, "turn-1");
  });

  it("会话外事件不丢，单独计数——不吭声读者会以为「就这些」", () => {
    const s = ingest(EMPTY, [
      ev(ORPHAN_SESSION, undefined, "span"),
      ev("sess-1", undefined, "span"),
      ev("sess-1", "turn-1"),
    ], 100);
    assert.equal(s.orphanCount, 2, "没有 turnId 的一律算会话外，不管挂在谁名下");
    assert.equal(s.sessions.length, 1);
  });

  it("画的是最近活动会话的**最后一轮**，不是整个会话", () => {
    // 三轮铺在一张图上，第三轮的分支会和第一轮的混着亮，
    // 读出来是一条从没发生过的路径。
    let s = ingest(EMPTY, [ev("sess-1", "turn-1"), ev("sess-1", "turn-1")], 100);
    s = ingest(s, [ev("sess-1", "turn-2")], 200);
    const turn = pickTurn(s);
    assert.equal(turn?.turnId, "turn-2");
    assert.equal(turn?.events.length, 1, "只含这一轮的事件");
  });

  it("多个会话时画最近有轮次活动的那个", () => {
    let s = ingest(EMPTY, [ev("sess-1", "turn-1")], 100);
    s = ingest(s, [ev("sess-2", "turn-9")], 200);
    assert.equal(pickTurn(s)?.sessionId, "sess-2");
    s = ingest(s, [ev("sess-1", "turn-1")], 300);
    assert.equal(pickTurn(s)?.sessionId, "sess-1", "谁最近有轮次事件就画谁");
  });

  it("成批并入：一次 fan-out 几十条，逐条 setState 就是几十次重渲染", () => {
    const batch = Array.from({ length: 40 }, () => ev("sess-1", "turn-1"));
    const s = ingest(EMPTY, batch, 100);
    assert.equal(s.sessions[0].events.length, 40);
    assert.equal(s.sessions[0].lastTurnAt, 100, "一批只推进一次时间戳");
  });

  it("空批次原样返回同一个对象——否则每个心跳都会触发一次重渲染", () => {
    const s = ingest(EMPTY, [], 100);
    assert.equal(s, EMPTY);
  });

  it("每会话有上限，丢最早的；会话数也有上限，按最近活动淘汰", () => {
    const many = Array.from({ length: 320 }, (_, i) => ({ ...ev("sess-1", "turn-1"), at: i }));
    const s = ingest(EMPTY, many, 100);
    assert.equal(s.sessions[0].events.length, 300);
    assert.equal(s.sessions[0].events[299].at, 319, "留下的是最近那批");

    let multi = EMPTY;
    for (let i = 0; i < 12; i += 1) multi = ingest(multi, [ev(`sess-${i}`, "turn-1")], i);
    assert.equal(multi.sessions.length, 8);
    assert.equal(multi.sessions[0].sessionId, "sess-11");
  });

  it("指定会话时画它的最后一轮；不在跟踪列表就返回 undefined，**不悄悄退回最近活动**", () => {
    // 调用方要能分清"锁定的会话没有实时事件"（该走回放）与
    // "跟随模式没人说话"（该说等着呢）——退回去就把两种提示混成一种。
    let s = ingest(EMPTY, [ev("sess-1", "turn-1")], 100);
    s = ingest(s, [ev("sess-2", "turn-9")], 200);
    assert.equal(pickTurn(s, "sess-1")?.sessionId, "sess-1", "锁谁画谁，不管谁更活跃");
    assert.equal(pickTurn(s, "sess-1")?.turnId, "turn-1");
    assert.equal(pickTurn(s, "sess-gone"), undefined, "不在列表就明说没有");
  });

  it("一轮都还没有时不硬指一个位置", () => {
    const s = ingest(EMPTY, [ev(ORPHAN_SESSION, undefined)], 100);
    assert.equal(pickTurn(s), undefined);
    assert.equal(pickTurn(EMPTY), undefined);
  });
});

describe("会话标题表", () => {
  it("并入标题：id → 标题，没标题的不占位", () => {
    const t = mergeSessionTitles(
      {},
      [
        { sessionId: "sess-a", title: "去广州出差" },
        { sessionId: "sess-b", title: null },
      ],
    );
    assert.equal(t["sess-a"], "去广州出差");
    assert.equal("sess-b" in t, false);
  });

  it("**`null` 不覆盖已经显示出来的标题**——否则演示中标题会一闪一闪", () => {
    /*
     * 标题是首轮之后异步补写的：同一个会话前一次请求还没有、下一次才有。
     * 若让 null 覆盖，标题就会在两次复取之间被抹掉再写回。
     */
    const t = mergeSessionTitles({ "sess-a": "去广州出差" }, [{ sessionId: "sess-a", title: null }]);
    assert.equal(t["sess-a"], "去广州出差");
  });

  it("没有变化时原样返回——渲染层据此不重画整张图", () => {
    const prev = { "sess-a": "去广州出差" };
    assert.equal(mergeSessionTitles(prev, [{ sessionId: "sess-a", title: "去广州出差" }]), prev);
    assert.equal(mergeSessionTitles(prev, []), prev);
  });

  it("改名后跟着改，且不动别的会话", () => {
    const t = mergeSessionTitles(
      { "sess-a": "旧名", "sess-b": "别动我" },
      [{ sessionId: "sess-a", title: "新名" }],
    );
    assert.deepEqual(t, { "sess-a": "新名", "sess-b": "别动我" });
  });
});
