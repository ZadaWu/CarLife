/**
 * 车型 ↔ 知识库关联关系端点（施工单 M14-08）。
 *
 * 盯的是**三态不能塌成两态**：读不到知识库时必须是 `unavailable`，
 * 而不是"所有车型都没有资料"。后者是在替知识库断言一件我们此刻不知道的事，
 * 而端上两句话的含义完全不同。
 *
 * 另外盯缓存：算一次要向 RAGFlow 打三次 listDocuments，
 * 建档页一进来可能并发几次，没有去重就是三倍到九倍的外部调用。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { DatasetKey, DocumentStatus, RagClient } from "@carlife/rag";

import { createCoverageProvider, createVehicleCatalogRouter, knowledgeFor } from "../src/http/vehicle-catalog";

const DOCS: Partial<Record<DatasetKey, string[]>> = {
  "vehicle-manuals": ["ModelY_车主手册.md", "Model3_车主手册.md"],
  "repair-kb": ["ModelY_保养.md"],
  "car-catalog": [],
};

/** 只实现 listDocuments——provider 用不到别的方法。 */
function fakeRag(opts: { fail?: DatasetKey[]; failAll?: boolean; onCall?: () => void } = {}): RagClient {
  return {
    async listDocuments(dataset: DatasetKey): Promise<DocumentStatus[]> {
      opts.onCall?.();
      if (opts.failAll || opts.fail?.includes(dataset)) throw new Error(`${dataset} 读不到`);
      return (DOCS[dataset] ?? []).map((name, i) => ({
        documentId: `d${i}`,
        name,
        status: "succeeded" as const,
        chunkCount: 1,
      }));
    },
  } as unknown as RagClient;
}

function appWith(client: RagClient | undefined) {
  const app = express();
  const provider = createCoverageProvider(() => client);
  app.use(createVehicleCatalogRouter(provider));
  return { app, provider };
}

async function get(app: express.Express, path: string) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: (await r.json()) as Record<string, never> };
  } finally {
    server.close();
  }
}

describe("GET /v1/vehicle-catalog", () => {
  it("关联关系由文件名算出，落到对应数据集", async () => {
    const { app } = appWith(fakeRag());
    const { status, body } = await get(app, "/v1/vehicle-catalog");
    assert.equal(status, 200);
    const entries = body.entries as unknown as Array<{
      model: string;
      links: Array<{ dataset: string; documents: string[] }>;
    }>;
    const my = entries.find((e) => e.model === "Model Y")!;
    assert.deepEqual(my.links.map((l) => l.dataset).sort(), ["repair-kb", "vehicle-manuals"]);
    // car-catalog 读到了但里面没有 Model Y 的文档 → 不生成空链接。
    assert.equal(my.links.some((l) => l.dataset === "car-catalog"), false);
    assert.deepEqual(entries.find((e) => e.model === "海豚")!.links, []);
    assert.equal((body.coverage as unknown as { state: string }).state, "live");
  });

  it("知识库全读不到 → unavailable，**不是「所有车型都没有资料」**", async () => {
    const { app } = appWith(fakeRag({ failAll: true }));
    const { body } = await get(app, "/v1/vehicle-catalog");
    const cov = body.coverage as unknown as { state: string; reason?: string };
    assert.equal(cov.state, "unavailable");
    assert.match(String(cov.reason), /知识库不可达/);
    // 车型清单照常给——建档不依赖知识库。
    assert.ok((body.entries as unknown as unknown[]).length > 0);
  });

  it("知识库未接入（无 client）同样是 unavailable 且说明原因", async () => {
    const { app } = appWith(undefined);
    const cov = (await get(app, "/v1/vehicle-catalog")).body.coverage as unknown as {
      state: string;
      reason?: string;
    };
    assert.equal(cov.state, "unavailable");
    assert.match(String(cov.reason), /未接入/);
  });

  it("部分数据集读不到：仍出结果，但如实报告失败的那个", async () => {
    const { app } = appWith(fakeRag({ fail: ["repair-kb"] }));
    const { body } = await get(app, "/v1/vehicle-catalog");
    const cov = body.coverage as unknown as {
      state: string;
      partialFailures: Array<{ dataset: string }>;
    };
    assert.equal(cov.state, "live");
    assert.deepEqual(cov.partialFailures.map((f) => f.dataset), ["repair-kb"]);
    const my = (body.entries as unknown as Array<{ model: string; links: Array<{ dataset: string }> }>)
      .find((e) => e.model === "Model Y")!;
    // repair-kb 没读到 → 不出现在链接里，**也没被记成"没有保养资料"**。
    assert.deepEqual(my.links.map((l) => l.dataset), ["vehicle-manuals"]);
  });

  it("TTL 内命中缓存；并发请求只打一次知识库", async () => {
    let calls = 0;
    const { app, provider } = appWith(fakeRag({ onCall: () => void calls++ }));
    await Promise.all([get(app, "/v1/vehicle-catalog"), get(app, "/v1/vehicle-catalog")]);
    // 三个数据集 × 一轮 = 3；并发去重没生效的话会是 6。
    assert.equal(calls, 3);
    await provider.get();
    assert.equal(calls, 3);
  });
});

describe("knowledgeFor（GET /v1/vehicles 附带的那一份）", () => {
  it("有资料时带出关联，没资料时 links 为空但 state 仍是 live", async () => {
    const { provider } = appWith(fakeRag());
    assert.equal((await knowledgeFor(provider, "Model Y")).links.length, 2);
    const none = await knowledgeFor(provider, "海豚");
    assert.equal(none.state, "live");
    assert.deepEqual(none.links, []);
  });

  it("读不到时 state=unavailable —— 端上据此说「读不到」而不是「没有」", async () => {
    const { provider } = appWith(fakeRag({ failAll: true }));
    const k = await knowledgeFor(provider, "Model Y");
    assert.equal(k.state, "unavailable");
    assert.deepEqual(k.links, []);
    assert.ok(k.reason);
  });
});
