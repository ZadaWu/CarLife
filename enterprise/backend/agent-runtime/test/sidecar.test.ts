/**
 * 旁路观察者、生命周期与故障隔离（施工单 M18-02，F-45-01 / F-45-02 / F-45-14）。
 *
 * 本单**不发任何 filler**——这里验的全是"看得见、不泄漏、不拖累、坏了也安静"。
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import {
  PairSession,
  closePair,
  observeTrace,
  pairFor,
  registerPair,
  resetSidecarCounters,
  resetSidecarRegistry,
  sidecarCounters,
  sidecarRegistrySize,
} from "../src/sidecar/pair-session";

const ORIGINAL_ENABLED = process.env.SIDECAR_ENABLED;

beforeEach(() => {
  process.env.SIDECAR_ENABLED = "1";
  resetSidecarRegistry();
  resetSidecarCounters();
});

after(() => {
  if (ORIGINAL_ENABLED === undefined) delete process.env.SIDECAR_ENABLED;
  else process.env.SIDECAR_ENABLED = ORIGINAL_ENABLED;
});

describe("旁路生命周期（F-45-01）", () => {
  it("注册 → close → 注册表回到 0；重复 close 幂等", () => {
    registerPair("s1", "t1", 1000);
    assert.equal(sidecarRegistrySize(), 1);

    closePair("t1");
    assert.equal(sidecarRegistrySize(), 0);
    assert.equal(sidecarCounters().closed, 1);

    // 幂等：turn-runner 的 finally 可能在异常路径上被走两次
    closePair("t1");
    assert.equal(sidecarRegistrySize(), 0);
    assert.equal(sidecarCounters().closed, 1, "重复 close 不应重复计数");
  });

  it("20 轮（含异常轮与提前收口轮）之后不泄漏", () => {
    for (let i = 0; i < 20; i += 1) {
      const turnId = `t-${i}`;
      registerPair("s1", turnId, i * 100);
      try {
        if (i % 5 === 0) throw new Error("模拟本轮异常");
        if (i % 3 === 0) continue; // 模拟提前 return（turn_end）
      } catch {
        /* 主链路自己处理 */
      } finally {
        closePair(turnId);
      }
    }
    assert.equal(sidecarRegistrySize(), 0, "泄漏的表现是上一轮的垫场话在这一轮开头冒出来");
    assert.equal(sidecarCounters().registered, 20);
    assert.equal(sidecarCounters().closed, 20);
  });

  it("close 之后 observe 不再记录", () => {
    const pair = registerPair("s1", "t1", 0);
    pair.observe({ kind: "span", name: "tool.a", at: 1 });
    pair.close();
    pair.observe({ kind: "span", name: "tool.b", at: 2 });
    assert.equal(pair.snapshot().signals.length, 0);
  });
});

describe("只读观察（F-45-02）", () => {
  it("记录的是摘出来的快照，不是原对象的引用", () => {
    const pair = new PairSession("s1", "t1", 0);
    const mutable = { kind: "span", name: "tool.ragflow_retrieve", at: 10, agent: "service" };
    pair.observe(mutable);

    // 主链路之后改动了同一个对象——旁路记的东西不该跟着变
    mutable.name = "被改掉了";
    mutable.agent = "也被改掉了";

    const [snap] = pair.snapshot().signals;
    assert.equal(snap.name, "tool.ragflow_retrieve");
    assert.equal(snap.agent, "service");
  });

  it("observeTrace 从 span data 里摘 name/agent/status，认不出 turnId 就丢弃", () => {
    registerPair("s1", "t1", 0);

    // 没有 turnId：不该抛，也不该记到别人头上
    observeTrace({ kind: "span", at: 1, data: { name: "tool.x" } });
    // 认不出的 turnId：同上
    observeTrace({ turnId: "t-unknown", kind: "span", at: 2, data: { name: "tool.y" } });
    observeTrace({
      turnId: "t1",
      kind: "span",
      at: 3,
      data: { name: "tool.ragflow_retrieve", agent: "service", status: "ok", detail: "real · 8 chunks" },
    });

    const signals = pairFor("t1")!.snapshot().signals;
    assert.equal(signals.length, 1);
    assert.deepEqual(signals[0], {
      kind: "span",
      name: "tool.ragflow_retrieve",
      at: 3,
      agent: "service",
      status: "ok",
    });
    assert.equal(sidecarCounters().failures, 0);
  });

  it("signals 有上限，超出丢最旧并计数", () => {
    const pair = new PairSession("s1", "t1", 0);
    for (let i = 0; i < 200; i += 1) pair.observe({ kind: "span", name: `n-${i}`, at: i });

    const signals = pair.snapshot().signals;
    assert.equal(signals.length, 64, "无界数组等于把轨迹在内存里存第二份");
    assert.equal(signals[0].name, "n-136", "丢的应该是最旧的——L0 只关心最近在干什么");
    assert.equal(sidecarCounters().signalsDropped, 136);
  });
});

describe("静默基准只被面向用户的内容重置（F-45-03 的前提）", () => {
  it("markUserFacing 推进基准", () => {
    const pair = new PairSession("s1", "t1", 1000);
    assert.equal(pair.snapshot().lastUserFacingAt, 1000);
    pair.markUserFacing(9000);
    assert.equal(pair.snapshot().lastUserFacingAt, 9000);
  });

  it("observe 本身不推进基准", () => {
    const pair = new PairSession("s1", "t1", 1000);
    // 实测那一轮：9.2 秒里轨迹侧有 8 条 span，SSE 上一个字都没有。
    // 若 observe 也重置基准，这类链路永远触发不了静默判定。
    for (const name of ["acp.session_new", "llm.supervisor-intent", "route", "tool.ragflow_retrieve"]) {
      pair.observe({ kind: "span", name, at: 5000 });
    }
    assert.equal(pair.snapshot().lastUserFacingAt, 1000);
  });
});

describe("故障隔离与 fail-silent（F-45-14）", () => {
  it("observe 内部抛错不外抛，只计数", () => {
    const pair = new PairSession("s1", "t1", 0);
    // 构造一个取值就抛的对象：模拟主链路传进来的异常载荷
    const hostile = {
      kind: "span",
      at: 1,
      get name(): string {
        throw new Error("boom");
      },
    };
    assert.doesNotThrow(() => pair.observe(hostile as never));
    assert.equal(sidecarCounters().failures, 1, "fail-silent 不等于 fail-invisible");
    assert.equal(pair.snapshot().signals.length, 0);
  });

  it("observeTrace 遇到异常 data 不外抛", () => {
    registerPair("s1", "t1", 0);
    const hostile = {
      turnId: "t1",
      kind: "span",
      at: 1,
      get data(): Record<string, unknown> {
        throw new Error("boom");
      },
    };
    assert.doesNotThrow(() => observeTrace(hostile as never));
    assert.equal(sidecarCounters().failures, 1);
  });
});

describe("开关（F-45-08 的服务端侧）", () => {
  it("SIDECAR_ENABLED=0 时根本不建对象", () => {
    process.env.SIDECAR_ENABLED = "0";
    const pair = registerPair("s1", "t1", 0);
    assert.equal(pair.enabled, false);
    assert.equal(sidecarRegistrySize(), 0, "不是建了再判断——后者仍在记录、仍在占内存");
    assert.equal(sidecarCounters().registered, 0);

    // 空对象的所有方法都是 no-op，且不抛
    assert.doesNotThrow(() => {
      pair.observe({ kind: "span", name: "x", at: 1 });
      pair.markUserFacing(1);
      pair.close();
    });
  });

  it("请求级 fillerEnabled=false 同样不建对象", () => {
    const pair = registerPair("s1", "t1", 0, false);
    assert.equal(pair.enabled, false);
    assert.equal(sidecarRegistrySize(), 0);
  });
});
