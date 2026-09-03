/**
 * HITL 中转单测（施工单 M5-03）。零依赖：不起服务、不连库。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HitlRelay, type InterruptNotice } from "../src/hitl";
import type { SessionEvent } from "@carlife/shared";

function makeRelay(forwardOk = true) {
  const emitted: Array<{ sessionId: string; event: SessionEvent }> = [];
  const forwarded: Array<{ interruptId: string; approved: boolean }> = [];
  const relay = new HitlRelay({
    emit: (sessionId, event) => emitted.push({ sessionId, event }),
    forwardResume: async ({ interruptId, approved }) => {
      forwarded.push({ interruptId, approved });
      return forwardOk;
    },
  });
  return { relay, emitted, forwarded };
}

const notice = (over: Partial<InterruptNotice> = {}): InterruptNotice => ({
  sessionId: "sess-1",
  interruptId: "itr-1",
  action: "calendar_write",
  title: "确认写入日历",
  details: [
    { label: "出发", value: "8 月 15 日 07:00 深圳" },
    { label: "沿途停靠", value: "赣州服务区 充电 40 分钟" },
  ],
  scope: "Google 日历（zada@example.com）",
  ...over,
});

describe("中断投影为 permission 事件（§3）", () => {
  it("下发的是 permission 事件且带中断点 id", () => {
    const { relay, emitted } = makeRelay();
    relay.onInterrupt(notice());
    assert.equal(emitted.length, 1);
    const ev = emitted[0].event as SessionEvent & { interruptId: string };
    assert.equal(ev.type, "permission");
    assert.equal(ev.interruptId, "itr-1");
  });

  it("**明细是具体内容，不是动作名**（F-04-02 的硬要求）", () => {
    const { relay, emitted } = makeRelay();
    relay.onInterrupt(notice());
    const ev = emitted[0].event as SessionEvent & { details: Array<{ label: string; value: string }>; title: string };
    assert.ok(ev.details.length >= 2, "至少要有具体明细项");
    assert.ok(
      ev.details.every((d) => d.value.trim().length > 0),
      "每项都要有实际内容，不能只有标签",
    );
    // 反面：只有一个"写入日历"的标题是不够的
    assert.notEqual(ev.details.length, 0);
  });

  it("影响范围随事件下发（写到哪个账号，F-26-09 知情）", () => {
    const { relay, emitted } = makeRelay();
    relay.onInterrupt(notice());
    const ev = emitted[0].event as SessionEvent & { scope: string | null };
    assert.match(ev.scope ?? "", /Google/);
  });
});

describe("resume 回灌", () => {
  it("确认 → 转发 approved=true", async () => {
    const { relay, forwarded } = makeRelay();
    relay.onInterrupt(notice());
    const r = await relay.resume({ sessionId: "sess-1", interruptId: "itr-1", approved: true });
    assert.equal(r.ok, true);
    assert.deepEqual(forwarded, [{ interruptId: "itr-1", approved: true }]);
  });

  it("拒绝 → 转发 approved=false", async () => {
    const { relay, forwarded } = makeRelay();
    relay.onInterrupt(notice());
    await relay.resume({ sessionId: "sess-1", interruptId: "itr-1", approved: false });
    assert.equal(forwarded[0].approved, false);
  });

  it("**重复 resume 幂等**：只转发一次，第二次返回 duplicate 而不是报错", async () => {
    const { relay, forwarded } = makeRelay();
    relay.onInterrupt(notice());
    const first = await relay.resume({ sessionId: "sess-1", interruptId: "itr-1", approved: true });
    const second = await relay.resume({ sessionId: "sess-1", interruptId: "itr-1", approved: true });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true, "重发不该报错——报错会让端上重试，越试越乱");
    assert.equal(second.duplicate, true);
    assert.equal(forwarded.length, 1, "动作只能被执行一次");
  });

  it("未知中断点明确拒绝，不静默成功", async () => {
    const { relay, forwarded } = makeRelay();
    const r = await relay.resume({ sessionId: "sess-1", interruptId: "不存在", approved: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unknown_interrupt");
    assert.equal(forwarded.length, 0);
  });

  it("**跨会话 resume 是越权，不是笔误**——拒绝", async () => {
    const { relay, forwarded } = makeRelay();
    relay.onInterrupt(notice({ sessionId: "sess-A" }));
    const r = await relay.resume({ sessionId: "sess-B", interruptId: "itr-1", approved: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "session_mismatch");
    assert.equal(forwarded.length, 0);
  });

  it("runtime 侧已超时收敛时，端上得到明确答复而不是悬着", async () => {
    const { relay } = makeRelay(false);
    relay.onInterrupt(notice());
    const r = await relay.resume({ sessionId: "sess-1", interruptId: "itr-1", approved: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "interrupt_expired");
  });
});

describe("可观测性", () => {
  it("挂起中的中断可列出（F-14-09）", () => {
    const { relay } = makeRelay();
    relay.onInterrupt(notice({ interruptId: "a" }));
    relay.onInterrupt(notice({ interruptId: "b" }));
    assert.equal(relay.listOpen().length, 2);
  });

  it("回答后从挂起列表移除", async () => {
    const { relay } = makeRelay();
    relay.onInterrupt(notice());
    await relay.resume({ sessionId: "sess-1", interruptId: "itr-1", approved: true });
    assert.equal(relay.listOpen().length, 0);
  });
});

/**
 * 外发个人信息的下发（施工单 M15-04，F-26-09 / AC-15-7）。
 *
 * 网关这一层的职责只有一个：**原样透传**。
 * 在这里做任何加工，都会让"弹窗上显示的"与"实际发出去的"分家，
 * 而那正是这条验收要防的。
 */
describe("外发个人信息独立成段下发（M15-04）", () => {
  it("有外发项时逐条带到 permission 事件里，且值保持掩码", () => {
    const { relay, emitted } = makeRelay();
    relay.onInterrupt(
      notice({
        action: "appointment",
        title: "需要你确认：appointment",
        details: [{ label: "动作", value: "预约试驾 · 某某门店 · 2026-09-01T10:00:00+08:00" }],
        disclosure: [
          { label: "称呼", value: "林先生" },
          { label: "手机号", value: "138****8000" },
        ],
      }),
    );
    const ev = emitted[0].event as SessionEvent & {
      disclosure: Array<{ label: string; value: string }>;
      details: Array<{ label: string; value: string }>;
    };
    assert.deepEqual(ev.disclosure, [
      { label: "称呼", value: "林先生" },
      { label: "手机号", value: "138****8000" },
    ]);
    // **不能混进动作明细**：混排的话用户不会意识到这几行的性质完全不同。
    assert.equal(ev.details.length, 1);
    assert.equal(JSON.stringify(ev.details).includes("手机号"), false);
  });

  it("**没有外发项时是空数组**，不是缺字段——端上少一个分支判断", () => {
    const { relay, emitted } = makeRelay();
    relay.onInterrupt(notice()); // 写日历，不外发个人信息给第三方
    const ev = emitted[0].event as SessionEvent & { disclosure: unknown };
    assert.deepEqual(ev.disclosure, []);
  });

  it("网关不加工内容——传进去什么就发出去什么", () => {
    const { relay, emitted } = makeRelay();
    const disclosure = [{ label: "备注", value: "希望周六上午" }];
    relay.onInterrupt(notice({ disclosure }));
    const ev = emitted[0].event as SessionEvent & { disclosure: typeof disclosure };
    assert.deepEqual(ev.disclosure, disclosure);
  });
});
