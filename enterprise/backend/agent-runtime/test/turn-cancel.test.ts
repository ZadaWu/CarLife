/**
 * 轮次取消登记表（施工单 M33-01，F-08-08 / F-14-04）。
 *
 * 这里验的是**取消这件事本身**：命中、幂等、跨会话不越权、
 * 以及"落在副作用窗口内要如实说动作已经发出去了"。
 * 图那一路能不能真停在 `graph-abort.test.ts`（那条是选型判据）。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  cancelCounters,
  cancelTurn,
  isTurnCancelled,
  registerTurnCancel,
  resetTurnCancelRegistry,
} from "../src/turn-cancel";
import { CancellationToken } from "../src/trace";

/** 建一条登记，返回它的把手，方便断言。 */
function register(sessionId: string, turnId: string, at = 1000) {
  const controller = new AbortController();
  const token = new CancellationToken();
  let aborts = 0;
  controller.signal.addEventListener("abort", () => {
    aborts += 1;
  });
  const off = registerTurnCancel(sessionId, turnId, controller, token, at);
  return { controller, token, off, aborted: () => aborts };
}

beforeEach(() => {
  resetTurnCancelRegistry();
});

describe("[M33-01][AC-14-4] 取消命中与注销", () => {
  it("按 turnId 取消：命中、token 置位、controller abort", () => {
    const h = register("s1", "t1");

    const r = cancelTurn("s1", "t1");

    assert.equal(r.cancelled, true);
    assert.equal(r.turnId, "t1");
    assert.equal(r.sideEffectInFlight, false);
    assert.equal(h.token.isCancelled(), true);
    assert.equal(h.controller.signal.aborted, true);
    assert.equal(h.aborted(), 1);
  });

  it("不给 turnId：取消这个会话当前在跑的那一轮（取最新登记的）", () => {
    const older = register("s1", "t1", 1000);
    const newer = register("s1", "t2", 2000);

    const r = cancelTurn("s1");

    assert.equal(r.turnId, "t2");
    assert.equal(newer.token.isCancelled(), true);
    assert.equal(older.token.isCancelled(), false, "旧那一轮不该被顺手掐掉");
  });

  it("注销之后取消落空——这正是 finally 里那行的意义", () => {
    const h = register("s1", "t1");
    h.off();

    const r = cancelTurn("s1", "t1");

    assert.equal(r.turnId, null);
    assert.equal(h.controller.signal.aborted, false);
  });

  it("注销只删自己那条：同一会话已经开始下一轮时，旧的注销不该把新的删掉", () => {
    const first = register("s1", "t1", 1000);
    register("s1", "t2", 2000);

    first.off();

    assert.equal(cancelTurn("s1").turnId, "t2");
  });
});

describe("[M33-01][AC-08-6] 幂等与未命中", () => {
  it("同一轮连取消两次都成功，abort 只真正生效一次", () => {
    const h = register("s1", "t1");

    const a = cancelTurn("s1", "t1");
    const b = cancelTurn("s1", "t1");

    assert.equal(a.turnId, "t1");
    assert.equal(b.turnId, "t1");
    assert.equal(h.aborted(), 1, "AbortController 自身保证只触发一次");
  });

  it("没有在跑的轮：返回成功 + turnId=null，**不是错误**", () => {
    const r = cancelTurn("s-none");
    assert.deepEqual(r, { cancelled: true, turnId: null, sideEffectInFlight: false });
    assert.equal(cancelCounters().missed, 1);
  });

  it("拿别人会话的 turnId 来取消：当作未命中，不越权", () => {
    const h = register("s1", "t1");

    const r = cancelTurn("s2", "t1");

    assert.equal(r.turnId, null);
    assert.equal(h.token.isCancelled(), false);
    assert.equal(h.controller.signal.aborted, false);
  });
});

describe("[M33-01][AC-14-4] 副作用边界（F-14-05）", () => {
  it("取消落在副作用窗口内 → sideEffectInFlight，**不谎称已取消**", async () => {
    const h = register("s1", "t1");
    let inside: ReturnType<typeof cancelTurn> | undefined;

    await h.token.withSideEffect(async () => {
      // 模拟"外部 API 已经发出、还没返回"的那一小段
      inside = cancelTurn("s1", "t1");
    });

    assert.equal(inside?.cancelled, true);
    assert.equal(inside?.sideEffectInFlight, true, "动作已经发出去了，收不回来");
    assert.equal(cancelCounters().sideEffectInFlight, 1);
  });

  it("窗口之外取消 → sideEffectInFlight 为假", async () => {
    const h = register("s1", "t1");
    await h.token.withSideEffect(async () => {
      /* 什么都不做，窗口已经关上 */
    });

    assert.equal(cancelTurn("s1", "t1").sideEffectInFlight, false);
  });
});

describe("[M33-01] isTurnCancelled", () => {
  it("取消前后与注销之后", () => {
    const h = register("s1", "t1");
    assert.equal(isTurnCancelled("t1"), false);

    cancelTurn("s1", "t1");
    assert.equal(isTurnCancelled("t1"), true);

    h.off();
    assert.equal(isTurnCancelled("t1"), false, "注销之后无从查起——那也是对的");
  });
});
