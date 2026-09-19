import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEEPSEEK_MODEL } from "@carlife/shared";

import { createConfigStore } from "../src/config/store";
import { AMAP_SERVER_KEY_MAX, CONFIG_REGISTRY } from "../src/config/registry";

describe("配置注册表中的 DeepSeek 模型", () => {
  it("默认值与共享模型基线一致", () => {
    const model = CONFIG_REGISTRY.find((item) => item.key === "DEEPSEEK_MODEL");
    assert.ok(model);
    assert.equal(model.default, DEFAULT_DEEPSEEK_MODEL);
  });

  it("数据库中的旧值在 runtime 与展示出口都归一化", async () => {
    const prisma = {
      configItem: {
        findMany: async () => [
          {
            key: "DEEPSEEK_MODEL",
            value: "deepseek-chat",
            isSecret: false,
            updatedBy: "test",
            updatedAt: new Date("2026-08-28T00:00:00.000Z"),
            verifiedAt: null,
          },
        ],
      },
    } as never;
    const store = createConfigStore(prisma, { env: {}, ttlMs: 60_000 });

    assert.equal(await store.get("DEEPSEEK_MODEL"), DEFAULT_DEEPSEEK_MODEL);
    const item = (await store.displayItems()).find(
      (entry) => entry.key === "DEEPSEEK_MODEL",
    );
    assert.equal(item?.value, DEFAULT_DEEPSEEK_MODEL);
    assert.equal(item?.source, "db");
  });

  it("后台写入旧值时直接持久化当前模型名", async () => {
    const upserts: Array<{ create: { value: string }; update: { value: string } }> = [];
    const prisma = {
      configItem: {
        findMany: async () => [],
        findUnique: async () => null,
        upsert: async (args: (typeof upserts)[number]) => {
          upserts.push(args);
        },
      },
      configItemRevision: { create: async () => undefined },
    } as never;
    const store = createConfigStore(prisma, { env: {}, ttlMs: 60_000 });

    const result = await store.write(
      [{ key: "DEEPSEEK_MODEL", value: "deepseek-chat" }],
      "test",
      { verified: false },
    );

    assert.deepEqual(result, { accepted: ["DEEPSEEK_MODEL"], rejected: [] });
    assert.equal(upserts[0]?.create.value, DEFAULT_DEEPSEEK_MODEL);
    assert.equal(upserts[0]?.update.value, DEFAULT_DEEPSEEK_MODEL);
  });

  it("回滚历史旧值时写入并返回当前模型名", async () => {
    const upserts: Array<{ create: { value: string }; update: { value: string } }> = [];
    const prisma = {
      configItem: {
        findMany: async () => [],
        findUnique: async () => null,
        upsert: async (args: (typeof upserts)[number]) => {
          upserts.push(args);
        },
      },
      configItemRevision: {
        findFirst: async () => ({
          prevValue: "deepseek-chat",
          prevVerifiedAt: null,
        }),
        create: async () => undefined,
      },
    } as never;
    const store = createConfigStore(prisma, { env: {}, ttlMs: 60_000 });

    const result = await store.rollback("DEEPSEEK_MODEL", "test");

    assert.deepEqual(result, { ok: true, restoredValue: DEFAULT_DEEPSEEK_MODEL });
    assert.equal(upserts[0]?.create.value, DEFAULT_DEEPSEEK_MODEL);
    assert.equal(upserts[0]?.update.value, DEFAULT_DEEPSEEK_MODEL);
  });
});

/*
 * 高德 key 池的注册表条目由 `amapServerKeyDefs` 生成（M100-01）。
 * 从前 `_2` / `_3` 手写两条，与 `@carlife/tools` 的清单、`.env.example` 三处互抄；现在这里从注册表对象上数一遍，
 * tools 侧的 `amap-rate-gate.test.ts` 再钉两边的上限相等——改一个数会当场红。
 */
describe("配置注册表中的高德 key 池", () => {
  it("AMAP_SERVER_KEY 加 _2 … _10 共 AMAP_SERVER_KEY_MAX 条，全是 map 域的密钥", () => {
    const keys = CONFIG_REGISTRY.filter((d) => /^AMAP_SERVER_KEY(_\d+)?$/.test(d.key));
    assert.equal(keys.length, AMAP_SERVER_KEY_MAX);
    assert.equal(keys[0]!.key, "AMAP_SERVER_KEY", "第一条是手写的那条，顺序即车道顺序");
    for (let n = 2; n <= AMAP_SERVER_KEY_MAX; n += 1) {
      const d = keys.find((k) => k.key === `AMAP_SERVER_KEY_${n}`);
      assert.ok(d, `缺 AMAP_SERVER_KEY_${n}`);
      assert.equal(d.envFallback, d.key);
      assert.equal(d.class, "secret");
      assert.equal(d.scope, "map");
    }
    assert.equal(new Set(CONFIG_REGISTRY.map((d) => d.key)).size, CONFIG_REGISTRY.length, "注册表里有重复的 key");
  });

  it("AMAP_DAILY_BUDGET 缺省 place=450，校验挡住非法片段", () => {
    const d = CONFIG_REGISTRY.find((x) => x.key === "AMAP_DAILY_BUDGET");
    assert.ok(d);
    assert.equal(d.default, "place=450");
    assert.equal(d.validate?.("place=450,direction=0"), null);
    assert.match(d.validate?.("place=450,bogus") ?? "", /bogus/);
  });
});
