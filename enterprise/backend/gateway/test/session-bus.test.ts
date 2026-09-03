/**
 * 补发窗口对瞬时事件的排除（施工单 M18-04，F-45-11 / AC-45-7）。
 *
 * 0812 的走查记录里有一条同源现象："语音播报的内容推送给客户端后……
 * 客户刷新或者重启会重复播放最后一条"。filler 若可补发，会把它放大成**重复寒暄**。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EventEnvelope, SessionEvent } from "@carlife/shared";

import { SessionBus, isEphemeral } from "../src/stream/session-bus";

const delta = (text: string): SessionEvent =>
  ({ type: "update", kind: "delta", turnId: "t1", text }) as SessionEvent;

const filler = (text: string): SessionEvent =>
  ({ type: "update", kind: "filler", turnId: "t1", text, source: "l0", interruptible: true }) as SessionEvent;

const turnEnd = (turnId: string): SessionEvent =>
  ({ type: "update", kind: "turn_end", turnId, messageId: `m-${turnId}` }) as SessionEvent;

/**
 * 首次订阅 vs 续传（施工单 M27-02）。
 *
 * 这两件事一度共用 `afterId = 0` 那条路径，代价是每新开一条流就把这个会话的
 * **每一轮回复重念一遍**——端上见到 turn_end 就播报，四轮历史就是四次播报，
 * 再与"流被开了几次"相乘。演示现场的表现是说一句话换来十几个重叠的声音。
 */
describe("首次订阅只补当前这一轮（M27-02）", () => {
  it("已经结束的轮次一条都不补", () => {
    const bus = new SessionBus();
    bus.append("s1", delta("第一轮"));
    bus.append("s1", turnEnd("t1"));
    bus.append("s1", delta("第二轮"));
    bus.append("s1", turnEnd("t2"));

    const got: string[] = [];
    bus.subscribe("s1", null, (e) => got.push(e.eventId));
    assert.deepEqual(got, [], "历史归 refresh_history，不该从流里再念一遍");
  });

  it("正在进行的那一轮照常补上", () => {
    const bus = new SessionBus();
    bus.append("s1", delta("上一轮")); // 1
    bus.append("s1", turnEnd("t1")); // 2
    bus.append("s1", delta("这一轮说到一半")); // 3

    const got: string[] = [];
    bus.subscribe("s1", null, (e) => got.push(e.eventId));
    assert.deepEqual(got, ["3"], "刚发完消息才连上流，不能丢掉整段流式回复");
  });

  it("续传语义不受影响：带 lastEventId 仍按游标补，跨轮次也补", () => {
    const bus = new SessionBus();
    bus.append("s1", delta("A")); // 1
    bus.append("s1", turnEnd("t1")); // 2
    bus.append("s1", delta("B")); // 3

    const got: string[] = [];
    bus.subscribe("s1", "1", (e) => got.push(e.eventId));
    assert.deepEqual(got, ["2", "3"], "续传方已经收过 1，缺的是它之后的全部");
  });
});

describe("isEphemeral", () => {
  it("只认 update/filler", () => {
    assert.equal(isEphemeral(filler("x")), true);
    assert.equal(isEphemeral(delta("x")), false);
    assert.equal(isEphemeral({ type: "session", status: "created" } as SessionEvent), false);
    assert.equal(
      isEphemeral({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m" } as SessionEvent),
      false,
    );
  });
});

describe("窗口排除（AC-45-7）", () => {
  it("filler 照常取号、照常广播，但不入窗口", () => {
    const bus = new SessionBus();
    const live: EventEnvelope[] = [];
    bus.subscribe("s1", null, (e) => live.push(e));

    const a = bus.append("s1", delta("A"));
    const f = bus.append("s1", filler("我在翻你这车的手册"));
    const b = bus.append("s1", delta("B"));

    // 取号连续：不递增会让后续事件的 id 与已下发的冲突
    assert.deepEqual([a.eventId, f.eventId, b.eventId], ["1", "2", "3"]);
    // 实时订阅者**收得到**——它就是要被播出去的
    assert.equal(live.length, 3);

    // 重连补发里没有它
    const replayed: EventEnvelope[] = [];
    bus.subscribe("s1", null, (e) => replayed.push(e));
    assert.deepEqual(
      replayed.map((e) => e.eventId),
      ["1", "3"],
      "重连补发一句垫场话，就是在早已结束的话题上重复寒暄",
    );
  });

  it("重放不丢任何真实事件", () => {
    const bus = new SessionBus();
    bus.append("s1", delta("A")); // 1
    bus.append("s1", filler("垫场")); // 2（不入窗）
    bus.append("s1", delta("B")); // 3
    bus.append("s1", delta("C")); // 4

    const got: string[] = [];
    // 端上最后收到的真实事件是 1；带着它重连
    bus.subscribe("s1", "1", (e) => got.push(e.eventId));
    assert.deepEqual(got, ["3", "4"], "真实事件一条不少");
  });

  it("非 filler 事件的入窗行为一字未改", () => {
    const bus = new SessionBus();
    for (let i = 0; i < 5; i += 1) bus.append("s1", delta(`d${i}`));
    const got: string[] = [];
    bus.subscribe("s1", "2", (e) => got.push(e.eventId));
    assert.deepEqual(got, ["3", "4", "5"]);
  });
});

describe("SSE 不给瞬时事件写 id 行（约束 4）", () => {
  /**
   * 只挡 buffer 不够：浏览器 `EventSource` 会把带 `id:` 的事件记成 `lastEventId`。
   * 下次带着一个**不在窗口里**的 id 回来，`Number(eventId) > afterId` 会把它之后的
   * 真实事件也算作已收——表现是**重连后丢事件**，比重复寒暄更难查。
   */
  it("用 filler 的 id 重连会丢掉它之后的真实事件——所以不能让端上记住它", () => {
    const bus = new SessionBus();
    bus.append("s1", delta("A")); // 1
    bus.append("s1", filler("垫场")); // 2
    bus.append("s1", delta("B")); // 3

    const got: string[] = [];
    bus.subscribe("s1", "2", (e) => got.push(e.eventId));
    assert.deepEqual(got, ["3"]);

    // 反证：若端上把 3 也当成已收（因为它记住了更大的 id），B 就丢了。
    const worse: string[] = [];
    bus.subscribe("s1", "3", (e) => worse.push(e.eventId));
    assert.deepEqual(worse, [], "这正是写 id 行会导致的形态——所以 stream/index.ts 里不写");
  });
});
