/**
 * [F-07-05][AC-7-3] 建会话的在飞闸（施工单 M50-01）。
 *
 * 断言的是**并发语义**，因为这次的病就出在那里：StrictMode 把引导跑了两遍，
 * 两遍之间没有互斥，于是每次启动都多出一个零消息、永不关闭的会话。
 * 库里的形状是决定性的——按「相隔 <100ms」聚类，每一簇恰好 2 个。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInflight } from "../src/data/inflight";

/** 造一个可控时机的异步函数，并记下它被调了几次。 */
function tracked<T>(value: T) {
  let calls = 0;
  let release!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const fn = (): Promise<T> => {
    calls += 1;
    return new Promise<T>((res, rej) => {
      release = res;
      fail = rej;
    });
  };
  return {
    fn,
    get calls() {
      return calls;
    },
    resolve: (v: T = value) => release(v),
    reject: (e: unknown) => fail(e),
  };
}

describe("在飞闸", () => {
  it("**并发两次只做一次**——这一条就是每次启动多一个空会话的病根", async () => {
    const g = createInflight();
    const t = tracked("sess-1");
    const a = g.run("k", t.fn);
    const b = g.run("k", t.fn);
    assert.equal(t.calls, 1);
    t.resolve();
    assert.equal(await a, "sess-1");
    assert.equal(await b, "sess-1");
  });

  it("两个调用方拿到的是**同一个引用**——各自 setState 也不会变成两份", async () => {
    const g = createInflight();
    const t = tracked({ sessionId: "sess-1" });
    const a = g.run("k", t.fn);
    const b = g.run("k", t.fn);
    t.resolve();
    assert.equal(await a, await b);
  });

  it("**不是缓存**：前一次 settle 之后，串行的第二次照常再做一次", async () => {
    const g = createInflight();
    const t = tracked("sess-1");
    const a = g.run("k", t.fn);
    t.resolve();
    await a;
    g.run("k", t.fn);
    assert.equal(t.calls, 2);
  });

  it("**失败也要释放**——否则网关没起来那一次会变成永远建不出会话", async () => {
    const g = createInflight();
    const t = tracked("sess-1");
    const first = g.run("k", t.fn);
    t.reject(new Error("ECONNREFUSED"));
    await assert.rejects(first);
    assert.equal(g.busy("k"), false);
    g.run("k", t.fn);
    assert.equal(t.calls, 2);
  });

  it("同步抛错也释放（`fn` 自己就炸了的情况）", async () => {
    const g = createInflight();
    let calls = 0;
    const boom = () => {
      calls += 1;
      throw new Error("boom");
    };
    await assert.rejects(g.run("k", boom as unknown as () => Promise<void>));
    assert.equal(g.busy("k"), false);
    await assert.rejects(g.run("k", boom as unknown as () => Promise<void>));
    assert.equal(calls, 2);
  });

  it("**按 key 隔离**：引导与「新建对话」是两件事，不合并", async () => {
    const g = createInflight();
    const boot = tracked("sess-boot");
    const fresh = tracked("sess-new");
    g.run("session:bootstrap", boot.fn);
    g.run("session:new", fresh.fn);
    assert.equal(boot.calls, 1);
    assert.equal(fresh.calls, 1);
    assert.equal(g.busy("session:bootstrap"), true);
    assert.equal(g.busy("session:new"), true);
    boot.resolve();
    fresh.resolve();
  });

  it("慢的那次收尾时不误删已经在飞的新一次", async () => {
    /*
     * 时序：第一次在飞 → reject（释放）→ 第二次开始在飞 →
     * 第一次的 finally 若无条件 delete，会把第二次的记录抹掉，
     * 于是第三次并发调用又会真的再建一个会话。
     */
    const g = createInflight();
    const t = tracked("sess-1");
    const first = g.run("k", t.fn);
    t.reject(new Error("x"));
    await assert.rejects(first);
    g.run("k", t.fn); // 第二次
    g.run("k", t.fn); // 与第二次并发，应合并
    assert.equal(t.calls, 2);
  });
});
