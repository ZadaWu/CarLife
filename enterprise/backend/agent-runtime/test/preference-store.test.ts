/**
 * 座舱偏好 store（施工单 M95-02）：无查询词走列举、有查询词走检索、`degraded` 不丢。
 * 假客户端只实现 `getAll` 与 `searchPreference`——类型上就排除了 `search("")` 这条路。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MemoryReadResult } from "@carlife/memory";

import { createPreferenceStore, type PreferenceStoreClient } from "../src/memory-preference-store";

const ROWS: MemoryReadResult = {
  degraded: false,
  results: [
    { id: "m1", memory: "开车喜欢安静，车内不放音乐", metadata: { domain: "cabin", confidence: 0.8 } },
    { id: "m2", memory: "习惯夜间充电", score: 0.42, metadata: { domain: "charging", confidence: 0.6 } },
  ],
};

function fake(getAllResult: MemoryReadResult | Error = ROWS, searchResult: MemoryReadResult = ROWS) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const client: PreferenceStoreClient = {
    async getAll(...args) {
      calls.push({ op: "getAll", args });
      if (getAllResult instanceof Error) throw getAllResult;
      return getAllResult;
    },
    async searchPreference(...args) {
      calls.push({ op: "searchPreference", args });
      return searchResult;
    },
  };
  return { client, calls };
}

describe("createPreferenceStore（M95-02）", () => {
  it("无查询词 → getAll(userId, {category:'preference'}, limit)，不调 searchPreference；映射 content / domain / confidence", async () => {
    const { client, calls } = fake();
    const r = await createPreferenceStore(client).recall("u1", undefined, 5);
    assert.deepEqual(calls, [{ op: "getAll", args: ["u1", { category: "preference" }, 5] }]);
    assert.deepEqual(r, {
      degraded: false,
      preferences: [
        { content: "开车喜欢安静，车内不放音乐", score: undefined, domain: "cabin", confidence: 0.8 },
        { content: "习惯夜间充电", score: 0.42, domain: "charging", confidence: 0.6 },
      ],
    });
  });

  it("空串不是查询词：recall(u, '', n) 与 undefined 同路", async () => {
    const { client, calls } = fake();
    await createPreferenceStore(client).recall("u1", "", 3);
    assert.deepEqual(calls.map((c) => c.op), ["getAll"]);
    assert.equal(calls[0].args[2], 3, "limit 原样传给 getAll，不再截一次");
  });

  it("有查询词 → searchPreference(userId, query, limit)，不调 getAll，score 透传", async () => {
    const { client, calls } = fake();
    const r = await createPreferenceStore(client).recall("u1", "座椅加热", 3);
    assert.deepEqual(calls, [{ op: "searchPreference", args: ["u1", "座椅加热", 3] }]);
    assert.equal(r.preferences[1].score, 0.42);
  });

  it("degraded 透传；getAll 抛错也是 degraded:true，不是空列表", async () => {
    const dead = fake({ results: [], degraded: true, error: "401 Unauthorized" });
    assert.deepEqual(await createPreferenceStore(dead.client).recall("u1", undefined, 5), {
      preferences: [],
      degraded: true,
    });
    const throwing = fake(new Error("boom"));
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(await createPreferenceStore(throwing.client).recall("u1", undefined, 5), {
        preferences: [],
        degraded: true,
      });
    } finally {
      console.warn = origWarn;
    }
  });
});
