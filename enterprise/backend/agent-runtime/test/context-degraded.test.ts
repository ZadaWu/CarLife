/**
 * [F-11-03][AC-11-2] 装载失败不阻塞，但必须说出来（M84-03，ACR-036 §4.9）。
 *
 * 这一条与 `recallEpisodesFor` 是同一课：**"读不到"与"没有"是两件事**。
 * 返回空会被下游当成"他没有车 / 没有行程"然后据此说话，而那比慢一点糟得多。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isContextUnavailable, type ContextVehicle } from "@carlife/shared";

import { assembleUserContext } from "../src/context/assemble";
import { createContextCache, NO_CONTEXT_CACHE } from "../src/context/cache";

const VEHICLE: ContextVehicle = { model: "Model Y", energyType: "bev", odometerKm: 100 };

describe("[F-11-03][AC-11-2] 装载：一段坏了不拖垮整轮", () => {
  it("超预算的那一段标「读不到」，其余照常返回", async () => {
    const ctx = await assembleUserContext(
      {
        vehicle: async () => VEHICLE,
        trips: () => new Promise(() => {}), // 永远不 resolve
      },
      "u-1",
      30,
    );
    assert.deepStrictEqual(ctx.vehicle, VEHICLE, "好的那一段必须照常");
    assert.ok(isContextUnavailable(ctx.trips), "坏的那一段要标读不到，不能是空数组");
    assert.ok((ctx.trips as { reason: string }).reason.includes("预算"));
  });

  it("抛错的那一段也标「读不到」，原因进提示词但不带栈", async () => {
    const ctx = await assembleUserContext(
      { home: async () => Promise.reject(new Error("PG 连接被拒绝")) },
      "u-1",
    );
    assert.ok(isContextUnavailable(ctx.home));
    assert.equal((ctx.home as { reason: string }).reason, "PG 连接被拒绝");
  });

  it("没给读取器的那一段整段缺席——与「读不到」不是一回事", async () => {
    const ctx = await assembleUserContext({ vehicle: async () => VEHICLE }, "u-1");
    assert.equal(ctx.trips, undefined, "缺席 = 这个部署没接这一段，不该渲染成「读不到」");
    assert.equal(ctx.preferences, undefined);
  });

  it("八段并行而不是串行：两段各等 40ms，整体远小于 80ms", async () => {
    const slow = <T>(v: T) => () => new Promise<T>((r) => setTimeout(() => r(v), 40));
    const t0 = Date.now();
    await assembleUserContext(
      { vehicle: slow(VEHICLE), home: slow({ city: "杭州", lat: 0, lon: 0 }) },
      "u-1",
      300,
    );
    assert.ok(Date.now() - t0 < 80, `并行的话该在 40ms 出头，实际 ${Date.now() - t0}ms`);
  });

  it("排序在装载层做完：同行人与行程的顺序不随仓储返回顺序变", async () => {
    const mk = (labels: string[]) =>
      assembleUserContext(
        { companions: async () => labels.map((label) => ({ label, needs: [] })) },
        "u-1",
      );
    const a = await mk(["囡囡", "妈", "爸"]);
    const b = await mk(["爸", "囡囡", "妈"]);
    assert.deepStrictEqual(a.companions, b.companions, "顺序不稳 = 锚定块每轮换前缀");
  });
});

describe("[F-11-03][AC-11-2] 快照缓存：坏了只是慢，不是故障", () => {
  it("后端缺席时是空实现，读永远 miss、写不抛错", async () => {
    assert.equal(await NO_CONTEXT_CACHE.get("u-1"), undefined);
    await NO_CONTEXT_CACHE.set("u-1", { userId: "u-1" });
    await NO_CONTEXT_CACHE.invalidate("u-1");
  });

  it("后端读抛错时当成 miss，不把异常抛给对话", async () => {
    const cache = createContextCache({
      get: async () => {
        throw new Error("redis 断了");
      },
      set: async () => {},
      del: async () => {},
    });
    assert.equal(await cache.get("u-1"), undefined);
  });

  it("后端写抛错时吞掉——快照写不进去不该让这一轮失败", async () => {
    const cache = createContextCache({
      get: async () => null,
      set: async () => {
        throw new Error("redis 满了");
      },
      del: async () => {},
    });
    await cache.set("u-1", { userId: "u-1" });
  });

  it("存进去能原样读回来", async () => {
    const store = new Map<string, string>();
    const cache = createContextCache({
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => void store.set(k, v),
      del: async (ks) => void ks.forEach((k) => store.delete(k)),
    });
    const ctx = { userId: "u-1", vehicle: VEHICLE };
    await cache.set("u-1", ctx);
    assert.deepStrictEqual(await cache.get("u-1"), ctx);
    await cache.invalidate("u-1");
    assert.equal(await cache.get("u-1"), undefined);
  });
});
