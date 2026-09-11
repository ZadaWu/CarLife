/**
 * 训练服务代理（施工单 M76-02）。上游用一个真的 http 服务替身：记录收到的请求、按路径回固定内容、SSE 每 30 ms 一帧。
 * 没有角色注入时 401；ops 读 200、写 403；admin 全通；未配 / 不可达各自 503。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, it } from "node:test";

import express from "express";

import { createVisionTrainerRouter } from "../src/console/vision-trainer";

interface Seen {
  method: string;
  url: string;
  type?: string;
  body: Buffer;
}

function fakeUpstream(): Promise<{ server: Server; base: string; seen: Seen[]; closed: { count: number } }> {
  const seen: Seen[] = [];
  const closed = { count: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? "", url: req.url ?? "", type: req.headers["content-type"], body });
      const url = req.url ?? "";
      if (url.startsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: "train-a", mAP50: 0.9 }]));
      } else if (url.startsWith("/jobs/j1/files/results.png")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } else if (url.startsWith("/jobs/j1/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": connected\n\n");
        const t = setInterval(() => res.write('event: progress\ndata: {"epoch":1}\n\n'), 30);
        // req 的 close 在请求体读完就发（连接还开着）；要的是连接断开，所以听 res 的 close
        res.on("close", () => {
          clearInterval(t);
          closed.count += 1;
        });
      } else if (url.startsWith("/jobs/nope")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "job_not_found" }));
      } else if (url.startsWith("/jobs") && req.method === "POST") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "train-new", status: "queued" }));
      } else if (url.startsWith("/predict")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, detections: [], got: body.length }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, seen, closed });
    });
  });
}

function appWith(role: "admin" | "ops" | null, url: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role) (req as express.Request & { console?: unknown }).console = { subject: `${role}-1`, role };
    next();
  });
  app.use(createVisionTrainerRouter({ config: { get: async () => url } }));
  return app;
}

async function call(app: express.Express, method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, ...init });
    const buf = Buffer.from(await r.arrayBuffer());
    let json: Record<string, unknown> | unknown[] = {};
    try {
      json = JSON.parse(buf.toString("utf-8")) as Record<string, unknown>;
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, json, buf, type: r.headers.get("content-type") ?? "" };
  } finally {
    server.close();
  }
}

describe("[M76-02] 未配置 / 不可达", () => {
  it("URL 为空 → 503 not_configured；连不上 → 503 unreachable", async () => {
    const a = await call(appWith("admin", ""), "GET", "/console/vision-trainer/models");
    assert.equal(a.status, 503);
    assert.equal((a.json as { error: string }).error, "vision_trainer_not_configured");
    const b = await call(appWith("admin", "http://127.0.0.1:9"), "GET", "/console/vision-trainer/models");
    assert.equal(b.status, 503);
    assert.equal((b.json as { error: string }).error, "vision_trainer_unreachable");
    const c = await call(appWith("admin", ""), "GET", "/console/vision-trainer/jobs/j1/stream");
    assert.equal(c.status, 503);
  });
});

describe("[M76-02] 角色门与透传", () => {
  it("无身份 401；ops 读 200 写 403；admin 写 201 且上游收到 JSON 体", async () => {
    const up = await fakeUpstream();
    try {
      assert.equal((await call(appWith(null, up.base), "GET", "/console/vision-trainer/models")).status, 401);
      const r = await call(appWith("ops", up.base), "GET", "/console/vision-trainer/models");
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, [{ id: "train-a", mAP50: 0.9 }]);
      const w = await call(appWith("ops", up.base), "POST", "/console/vision-trainer/jobs", { body: JSON.stringify({ kind: "train" }), headers: { "content-type": "application/json" } });
      assert.equal(w.status, 403);
      const ok = await call(appWith("admin", up.base), "POST", "/console/vision-trainer/jobs", { body: JSON.stringify({ kind: "train", params: { dataset: "d" } }), headers: { "content-type": "application/json" } });
      assert.equal(ok.status, 201);
      const posted = up.seen.find((s) => s.method === "POST" && s.url === "/jobs");
      assert.ok(posted);
      assert.deepEqual(JSON.parse(posted.body.toString()), { kind: "train", params: { dataset: "d" } });
    } finally {
      up.server.close();
    }
  });

  it("字节与状态码原样：png 透传、上游 404 原样、文件名白名单 400", async () => {
    const up = await fakeUpstream();
    try {
      const png = await call(appWith("ops", up.base), "GET", "/console/vision-trainer/jobs/j1/files/results.png");
      assert.equal(png.status, 200);
      assert.equal(png.type, "image/png");
      assert.deepEqual([...png.buf], [0x89, 0x50, 0x4e, 0x47]);
      const nf = await call(appWith("ops", up.base), "GET", "/console/vision-trainer/jobs/nope");
      assert.equal(nf.status, 404);
      assert.equal((nf.json as { error: string }).error, "job_not_found");
      const bad = await call(appWith("ops", up.base), "GET", "/console/vision-trainer/jobs/j1/files/..%2Fjob.json");
      assert.equal(bad.status, 400);
      const evil = await call(appWith("ops", up.base), "GET", "/console/vision-trainer/jobs/j1/files/weights/evil.pt");
      assert.equal(evil.status, 400);
      const weights = await call(appWith("ops", up.base), "GET", "/console/vision-trainer/jobs/j1/files/weights/best.pt");
      assert.equal(up.seen.at(-1)?.url, "/jobs/j1/files/weights/best.pt");
      assert.equal(weights.status, 200);
    } finally {
      up.server.close();
    }
  });

  it("试推理：图片字节、content-type 与 query 原样到上游；无 body 的 photo= 形态也能过", async () => {
    const up = await fakeUpstream();
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      const r = await call(appWith("ops", up.base), "POST", "/console/vision-trainer/predict?model=m1&conf=0.3", { body: bytes, headers: { "content-type": "image/png" } });
      assert.equal(r.status, 200);
      const seen = up.seen.find((s) => s.url.startsWith("/predict"));
      assert.ok(seen);
      assert.equal(seen.url, "/predict?model=m1&conf=0.3");
      assert.equal(seen.type, "image/png");
      assert.deepEqual([...seen.body], [1, 2, 3]);
      const p = await call(appWith("ops", up.base), "POST", "/console/vision-trainer/predict?model=m1&photo=tesla-01");
      assert.equal(p.status, 200);
      assert.equal(up.seen.at(-1)?.body.length, 0);
    } finally {
      up.server.close();
    }
  });

  it("SSE：帧原样到达；客户端断开后上游的连接被关掉", async () => {
    const up = await fakeUpstream();
    const app = appWith("ops", up.base);
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const abort = new AbortController();
      const r = await fetch(`http://127.0.0.1:${port}/console/vision-trainer/jobs/j1/stream`, { signal: abort.signal });
      assert.equal(r.status, 200);
      assert.ok(r.headers.get("content-type")?.startsWith("text/event-stream"));
      const reader = r.body!.getReader();
      let text = "";
      while (!text.includes("event: progress")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString();
      }
      assert.ok(text.startsWith(": connected"));
      assert.ok(text.includes('data: {"epoch":1}'));
      abort.abort();
      for (let i = 0; i < 50 && up.closed.count === 0; i++) await new Promise((res) => setTimeout(res, 20));
      assert.equal(up.closed.count, 1, "客户端断开后上游连接应被关闭");
    } finally {
      server.close();
      up.server.close();
    }
  });
});
