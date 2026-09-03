/**
 * 购车候选与成本只读端点（施工单 M15-05，F-15-14）。
 *
 * 盯三件事：
 *  1. **「还没比过车」是常态**——必须 200 `{plan:null}`，404 会让端上反复告警；
 *  2. **「读不到」与「没有」分开**——runtime 挂了要 502，不能返回空当成"你没比过"；
 *  3. **网关不加工**——runtime 返回什么就原样发什么，加工一半会让页面与编排层分家。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";

import type { ChatRepository } from "@carlife/db";

import { createBuyingRouter } from "../src/http/buying";

const PLAN = {
  candidates: [
    {
      model: "Model 3",
      specs: [
        {
          label: "续航",
          value: "CLTC 753 km",
          source: { document: "Model3_参数规格.md", snippet: "…CLTC 753 km…", score: 0.9 },
        },
      ],
      guidePrice: {
        amount: 235_500,
        trim: "Model 3 后轮驱动版",
        source: { document: "tesla_m3_选配.md", snippet: "…235,500…", score: 0.88 },
      },
    },
  ],
  eliminated: [],
  universe: [{ model: "Model 3", documents: ["Model3_参数规格.md"] }],
  constraints: {},
  unclassifiedDocs: 0,
  at: 1,
};

/** 配置比较（M21-06）。列 = 配置，且带对齐口径。 */
const TRIM = {
  models: ["Model 3"],
  rows: [{ model: "Model 3", trim: "后轮驱动版", priceCny: 235_500, rangeKm: 634, seats: 5 }],
  alignment: "same-model",
  alignmentNote: "同一款车的几个配置，按厂商指导价从低到高排",
  pairs: [],
  unpricedModels: [],
  missingModels: [],
  droppedRows: [],
  sources: [],
  at: 1,
};

/** 假 runtime：只实现 `/internal/buying/:id`。 */
let runtime: Server;
let runtimeMode: "ok" | "empty" | "down" = "ok";

before(async () => {
  runtime = createServer((req, res) => {
    if (runtimeMode === "down") {
      res.writeHead(500).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        runtimeMode === "empty"
          ? { plan: null, cost: null, trim: null, loan: null, insurance: null }
          : { plan: PLAN, cost: null, trim: TRIM, loan: null, insurance: null },
      ),
    );
  });
  await new Promise<void>((r) => runtime.listen(0, r));
  const addr = runtime.address();
  process.env.AGENT_RUNTIME_URL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => {
  runtime.close();
});

function memRepo(exists: boolean): ChatRepository {
  return {
    async sessionExists() {
      return exists;
    },
  } as unknown as ChatRepository;
}

function appWith(exists: boolean, userId: string | null) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createBuyingRouter(memRepo(exists)));
  return app;
}

async function get(app: express.Express) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/session/sess-1/buying`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("GET /v1/session/:id/buying", () => {
  it("**M21-06 新增的三段原样透传**——网关不加工、不补默认值", async () => {
    runtimeMode = "ok";
    const r = await get(appWith(true, "u1"));
    assert.equal(r.status, 200);
    // 有值的原样给，没值的保持 null——**不能悄悄补成 {}**，
    // 端上靠 null 区分"还没算过"与"算过但是空的"。
    assert.deepEqual(r.body.trim, TRIM);
    assert.equal(r.body.loan, null);
    assert.equal(r.body.insurance, null);
  });

  it("未鉴权 401", async () => {
    runtimeMode = "ok";
    const r = await get(appWith(true, null));
    assert.equal(r.status, 401);
  });

  it("会话不存在 404——与「会话里还没比过车」不是一回事", async () => {
    runtimeMode = "ok";
    const r = await get(appWith(false, "demo-user"));
    assert.equal(r.status, 404);
  });

  it("**还没比过车 → 200 {plan:null}**，不是 404", async () => {
    runtimeMode = "empty";
    const r = await get(appWith(true, "demo-user"));
    assert.equal(r.status, 200);
    assert.equal(r.body.plan, null);
  });

  it("有候选 → **原样返回**，网关不加工", async () => {
    runtimeMode = "ok";
    const r = await get(appWith(true, "demo-user"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plan, PLAN);
    // 出处必须带原文片段——没有它，AC-15-3 的"可点开查看来源"点开是空的。
    const plan = r.body.plan as typeof PLAN;
    assert.ok(plan.candidates[0].specs[0].source.snippet.length > 0);
  });

  it("**runtime 挂了要 502**，不能返回空当成「你没比过」", async () => {
    runtimeMode = "down";
    const r = await get(appWith(true, "demo-user"));
    assert.equal(r.status, 502);
    assert.equal(r.body.plan, undefined);
  });
});
