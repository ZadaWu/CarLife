/**
 * [F-20-15][AC-20-1] 拍照问诊报告只读端点（施工单 M104-02）。照 buying.test.ts：三态 + 鉴权 + 会话存在性。
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";

import type { ChatRepository } from "@carlife/db";

import { createDiagnosisRouter } from "../src/http/diagnosis";

const REPORT = {
  threadId: "t1",
  at: "2026-09-18T06:41:00.000Z",
  agent: "ownership",
  risk: { level: "medium", action: "建议尽快检查", basis: ["伴随仪表警告灯"] },
  observation: { items: [], unreadable: false, retakeHints: ["右侧没拍到，请补一张"], alerts: [] },
  questions: [{ id: "parked", text: "车现在是停着的吗？", options: ["停着", "在开", "刚停下"] }],
  askedRounds: 1,
  askedIds: ["parked"],
  selfChecks: ["a"],
  stopNowSigns: ["b"],
  questionsForShop: ["c"],
  answer: "正文",
  disclaimer: "以上是按可能性排序的判断，不是维修结论；是否需要维修请由专业人员检查确认。",
};

let runtime: Server;
let runtimeMode: "ok" | "empty" | "down" = "ok";

before(async () => {
  runtime = createServer((req, res) => {
    if (runtimeMode === "down") {
      res.writeHead(500).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(runtimeMode === "empty" ? { report: null } : { report: REPORT }));
  });
  await new Promise<void>((r) => runtime.listen(0, r));
  const addr = runtime.address();
  process.env.AGENT_RUNTIME_URL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => runtime.close());

function memRepo(exists: boolean): ChatRepository {
  return { async sessionExists() { return exists; } } as unknown as ChatRepository;
}
function appWith(exists: boolean, userId: string | null) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createDiagnosisRouter(memRepo(exists)));
  return app;
}
async function get(app: express.Express) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/session/sess-1/diagnosis`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("GET /v1/session/:id/diagnosis", () => {
  it("原样透传：报告逐字段不动", async () => {
    runtimeMode = "ok";
    const r = await get(appWith(true, "u1"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.report, REPORT);
  });
  it("未鉴权 401", async () => {
    runtimeMode = "ok";
    assert.equal((await get(appWith(true, null))).status, 401);
  });
  it("会话不存在 404——与「还没问过诊」不是一回事", async () => {
    runtimeMode = "ok";
    assert.equal((await get(appWith(false, "u1"))).status, 404);
  });
  it("还没问过诊 → 200 {report:null}", async () => {
    runtimeMode = "empty";
    const r = await get(appWith(true, "u1"));
    assert.equal(r.status, 200);
    assert.equal(r.body.report, null);
  });
  it("runtime 挂 → 502，不能把「读不到」说成「没有」", async () => {
    runtimeMode = "down";
    const r = await get(appWith(true, "u1"));
    assert.equal(r.status, 502);
  });
});
