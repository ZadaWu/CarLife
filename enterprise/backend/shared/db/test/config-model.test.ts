import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEEPSEEK_MODEL } from "@carlife/shared";

import { createConfigStore } from "../src/config/store";
import { CONFIG_REGISTRY } from "../src/config/registry";

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
