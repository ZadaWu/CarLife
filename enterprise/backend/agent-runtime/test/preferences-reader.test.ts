/**
 * 偏好读取器（`context/preferences-reader.ts`）的两条不变量：
 * 走列举不走检索；后端不可用是「读不到」，不是「没有」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { assembleUserContext } from "../src/context/assemble";
import { PREFERENCE_LIMIT, readPreferences, type PreferenceSource } from "../src/context/preferences-reader";

interface Call {
  userId: string;
  filters: Record<string, unknown> | undefined;
  limit: number | undefined;
}

function fakeSource(result: Awaited<ReturnType<PreferenceSource["getAll"]>>): { calls: Call[]; source: PreferenceSource } {
  const calls: Call[] = [];
  return {
    calls,
    source: {
      async getAll(userId, filters, limit) {
        calls.push({ userId, filters, limit });
        return result;
      },
    },
  };
}

test("偏好读取按类别列举，带用户维度与投影上限，不带查询词", async () => {
  const f = fakeSource({
    results: [
      { id: "m1", memory: "喜欢安静的路线" },
      { id: "m2", memory: "" },
      { id: "m3", memory: "不走高速" },
    ],
  });
  assert.deepEqual(await readPreferences(f.source, "u1"), ["喜欢安静的路线", "不走高速"]);
  assert.deepEqual(f.calls, [{ userId: "u1", filters: { category: "preference" }, limit: PREFERENCE_LIMIT }]);
});

test("后端 degraded 时抛出，不当成空表", async () => {
  const f = fakeSource({ results: [], degraded: true, error: "fetch failed" });
  await assert.rejects(readPreferences(f.source, "u1"), /记忆后端不可用：fetch failed/);
});

test("经投影层后是「读不到」并带原因，而不是「没有」", async () => {
  const f = fakeSource({ results: [], degraded: true, error: "fetch failed" });
  const ctx = await assembleUserContext({ preferences: (uid) => readPreferences(f.source, uid) }, "u1");
  assert.deepEqual(ctx.preferences, { unavailable: true, reason: "记忆后端不可用：fetch failed" });
});

test("后端正常但一条偏好都没有时是空表——缺席与读不到分得开", async () => {
  const f = fakeSource({ results: [] });
  const ctx = await assembleUserContext({ preferences: (uid) => readPreferences(f.source, uid) }, "u1");
  assert.deepEqual(ctx.preferences, []);
});
