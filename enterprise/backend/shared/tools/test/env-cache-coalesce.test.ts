/**
 * [F-58-02] 同键并发合并与短负缓存（M77 走查追修）。
 *
 * 缓存只挡得住**已经回来**的重复。一轮 fan-out 里几条腿几乎同时问同一个键时，
 * 它们全都 miss、全都真发一次——真跑里目的地亮点就这样在一轮内连查三次，每次 5 秒。
 * 另有一次是"模型没搜就答"，那种失败此前不缓存，同一轮会连着白花好几次。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  getEnvCacheStats,
  readNegative,
  setEnvCache,
  withEnvCache,
  writeNegative,
  type EnvCacheBackend,
} from "../src/env-cache";

function memoryBackend(): EnvCacheBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(k) {
      return store.get(k) ?? null;
    },
    async set(k, v) {
      store.set(k, v);
    },
  };
}

const defer = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

afterEach(() => setEnvCache(undefined));

describe("[F-58-02] 同键并发只发一次", () => {
  it("三个并发只调一次 fetch，三个都拿到同一个结果", async () => {
    setEnvCache(memoryBackend());
    let calls = 0;
    const gate = defer<string>();
    const run = () =>
      withEnvCache("k1", 60, async () => {
        calls += 1;
        return gate.promise;
      });
    const all = Promise.all([run(), run(), run()]);
    gate.resolve("同一份");
    const got = await all;
    assert.equal(calls, 1, "真跑里这里是三次，每次 5 秒");
    assert.deepEqual(got.map((x) => x.value), ["同一份", "同一份", "同一份"]);
  });

  it("合并单独计数，**不混进 hits**——混了会让命中率虚高，掩盖键设计的问题", async () => {
    setEnvCache(memoryBackend());
    const before = getEnvCacheStats();
    const gate = defer<string>();
    const all = Promise.all([
      withEnvCache("k2", 60, () => gate.promise),
      withEnvCache("k2", 60, () => gate.promise),
    ]);
    gate.resolve("x");
    await all;
    const after = getEnvCacheStats();
    assert.equal(after.coalesced - before.coalesced, 1);
    assert.equal(after.hits - before.hits, 0, "并发合并不是缓存命中");
  });

  it("失败也共享，且键要摘干净——不摘的话这个键从此永远复用一个已落定的 Promise", async () => {
    setEnvCache(memoryBackend());
    const gate = defer<string>();
    const both = Promise.allSettled([
      withEnvCache("k3", 60, () => gate.promise),
      withEnvCache("k3", 60, () => gate.promise),
    ]);
    gate.reject(new Error("上游挂了"));
    const r = await both;
    assert.deepEqual(r.map((x) => x.status), ["rejected", "rejected"]);
    // 摘干净了才能重来：下一次要真的再调一次
    let called = 0;
    const v = await withEnvCache("k3", 60, async () => {
      called += 1;
      return "第二次好了";
    });
    assert.equal(called, 1);
    assert.equal(v.value, "第二次好了");
  });

  it("先后（不重叠）的两次照旧走缓存，不受合并影响", async () => {
    setEnvCache(memoryBackend());
    let calls = 0;
    const f = async () => {
      calls += 1;
      return "v";
    };
    await withEnvCache("k4", 60, f);
    const second = await withEnvCache("k4", 60, f);
    assert.equal(calls, 1);
    assert.equal(second.cached, true, "这一次才是真正的缓存命中");
  });
});

describe("[F-58-02] 短负缓存", () => {
  it("写了就读得到；没写的键读不到", async () => {
    setEnvCache(memoryBackend());
    assert.equal(await readNegative("neg:1"), false);
    await writeNegative("neg:1");
    assert.equal(await readNegative("neg:1"), true);
  });

  it("后端没接时不报错，一律当没有——不缓存是部署选择，不是故障", async () => {
    setEnvCache(undefined);
    await writeNegative("neg:2");
    assert.equal(await readNegative("neg:2"), false);
  });

  it("后端抛错时读回 false，宁可多查一次也不要把异常抛给调用方", async () => {
    setEnvCache({
      async get() {
        throw new Error("redis 挂了");
      },
      async set() {
        throw new Error("redis 挂了");
      },
    });
    await writeNegative("neg:3");
    assert.equal(await readNegative("neg:3"), false);
  });
});
