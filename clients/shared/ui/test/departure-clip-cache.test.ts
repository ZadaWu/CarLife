/**
 * 片子进程内缓存的不变量（`vehicle/departure-clip-cache.ts`）。
 *
 * 守的是"每段一次进程只取一次"这句话本身，以及它的反面：
 * 缓存失败时 `<video>` 拿到的必须是原 URL——缓存绝不能成为动画放不出来的原因。
 * 全部走注入的假 `fetch` / `createObjectURL`，不碰 DOM。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createClipCache, type ClipCacheIo } from "../src/vehicle/departure-clip-cache";

interface FakeIo extends ClipCacheIo {
  calls: string[];
  /** 按 URL 定失败方式：`throw` 抛异常，数字是 HTTP 状态。 */
  fail: Map<string, "throw" | number>;
}

function fakeIo(): FakeIo {
  const io: FakeIo = {
    calls: [],
    fail: new Map(),
    async fetch(url) {
      io.calls.push(url);
      const f = io.fail.get(url);
      if (f === "throw") throw new Error(`network down: ${url}`);
      return {
        ok: f === undefined,
        status: f ?? 200,
        blob: async () => new Blob([url]),
      };
    },
    createObjectURL: (blob) => `blob:fake/${blob.size}`,
  };
  return io;
}

const A = "/assets/departure-1-arrive.mp4";
const B = "/assets/departure-2-wake.mp4";

describe("片子进程内缓存", () => {
  it("预热前 resolve 原样返回；预热后返回 blob: URL", async () => {
    const io = fakeIo();
    const cache = createClipCache(io);
    assert.equal(cache.resolve(A), A);
    await cache.warm([A, B]);
    assert.match(cache.resolve(A), /^blob:/);
    assert.match(cache.resolve(B), /^blob:/);
    assert.equal(cache.size, 2);
  });

  it("每段只取一次：第二次 warm 一个请求都不发", async () => {
    const io = fakeIo();
    const cache = createClipCache(io);
    await cache.warm([A, B]);
    await cache.warm([A, B]);
    await cache.warm([A]);
    assert.deepEqual(io.calls, [A, B]);
  });

  it("并发 warm 按 URL 去重，不取两遍", async () => {
    const io = fakeIo();
    const cache = createClipCache(io);
    await Promise.all([cache.warm([A, B]), cache.warm([A, B]), cache.warm([B])]);
    assert.deepEqual(io.calls, [A, B]);
    assert.equal(cache.size, 2);
  });

  it("没缓存的 URL 原样透传——<video> 自己去取，与没有这一层时一样", async () => {
    const cache = createClipCache(fakeIo());
    await cache.warm([A]);
    assert.equal(cache.resolve(B), B);
  });

  it("取失败（抛异常 / 非 2xx）时 warm 不 reject、resolve 回退原 URL，下次 warm 会再试", async () => {
    const io = fakeIo();
    const cache = createClipCache(io);
    io.fail.set(A, "throw");
    io.fail.set(B, 404);
    await cache.warm([A, B]);
    assert.equal(cache.resolve(A), A, "抛异常那条必须回退原 URL");
    assert.equal(cache.resolve(B), B, "404 那条必须回退原 URL");
    assert.equal(cache.size, 0);

    io.fail.clear();
    await cache.warm([A, B]);
    assert.deepEqual(io.calls, [A, B, A, B], "失败的条目下次要再试");
    assert.match(cache.resolve(A), /^blob:/);
    assert.match(cache.resolve(B), /^blob:/);
  });

  it("缺省 io 在模块顶层不碰全局对象：没有 DOM 也能 import 与构造", () => {
    // 能走到这里就说明 import 时没有解引用 URL.createObjectURL / fetch。
    const cache = createClipCache();
    assert.equal(cache.resolve(A), A);
  });
});
