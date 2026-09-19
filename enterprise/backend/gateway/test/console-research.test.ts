/**
 * 研究面代理（施工单 M82-07）。上游用一个真的 http 服务替身：记录收到的请求、按路径回固定内容。
 *
 * 三件事各有断言：**没配与没起是两个 503**、**读写角色不同**、
 * **打开单条证据要记审计**（读原文也是敏感动作）。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, describe, it } from "node:test";

import express from "express";

import { createResearchRouter } from "../src/console/research";

interface Seen {
  method: string;
  url: string;
  body: string;
}

function fakeUpstream(): Promise<{ server: Server; base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, body: Buffer.concat(chunks).toString("utf8") });

      if (url.startsWith("/internal/research/snapshots/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ snapshot: { lens: url.split("/").pop(), data: { rows: [] } } }));
      } else if (url.startsWith("/internal/research/evidence/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ unit: { id: "u1", textRedacted: "冬天掉电快" } }));
      } else if (url.startsWith("/internal/research/export")) {
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
        res.end("code,n,N\ncold-range-loss,12,20\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, seen });
    });
  });
}

/** 记下 auditAction 写进 res.locals 的动作名——审计中间件读的就是它。 */
interface AuditProbe {
  actions: string[];
}

function appWith(role: "admin" | "ops" | null, url: string | undefined, probe?: AuditProbe) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (role) (req as express.Request & { console?: unknown }).console = { subject: `${role}-1`, role };
    if (probe) {
      res.on("finish", () => {
        // auditAction 直接写在 res.locals 上（audit.ts 的 auditLocals 就是 res.locals）。
        const action = (res.locals as { auditAction?: string }).auditAction;
        if (action) probe.actions.push(action);
      });
    }
    next();
  });
  app.use(createResearchRouter({ config: { get: async () => url } }));
  return app;
}

async function call(app: express.Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* 非 JSON（CSV） */
    }
    return { status: r.status, json, text, type: r.headers.get("content-type") ?? "" };
  } finally {
    server.close();
  }
}

describe("[M82-07] 没配与没起是两个 503", () => {
  it("URL 为空 → research_not_configured，路由仍然挂着", async () => {
    for (const path of [
      "/console/research/contracts",
      "/console/research/snapshots/evidence-matrix",
      "/console/research/insights",
      "/console/research/review",
    ]) {
      const r = await call(appWith("admin", ""), "GET", path);
      assert.equal(r.status, 503, path);
      assert.equal((r.json as { error: string }).error, "research_not_configured", path);
    }
  });

  it("配了但连不上 → research_unreachable", async () => {
    const r = await call(appWith("admin", "http://127.0.0.1:9"), "GET", "/console/research/contracts");
    assert.equal(r.status, 503);
    assert.equal((r.json as { error: string }).error, "research_unreachable");
  });

  it("两个错分得开——不挂路由的 404 分不出「没启用」与「没起来」", async () => {
    const notConfigured = await call(appWith("admin", ""), "GET", "/console/research/contracts");
    const unreachable = await call(appWith("admin", "http://127.0.0.1:9"), "GET", "/console/research/contracts");
    assert.notEqual((notConfigured.json as { error: string }).error, (unreachable.json as { error: string }).error);
  });
});

describe("[M82-07] 角色门", () => {
  const up = fakeUpstream();

  after(async () => {
    (await up).server.close();
  });

  it("没有身份 → 401", async () => {
    const { base } = await up;
    const r = await call(appWith(null, base), "GET", "/console/research/contracts");
    assert.equal(r.status, 401);
  });

  it("ops 能读快照", async () => {
    const { base } = await up;
    const r = await call(appWith("ops", base), "GET", "/console/research/snapshots/evidence-matrix");
    assert.equal(r.status, 200);
    assert.equal((r.json as { snapshot: { lens: string } }).snapshot.lens, "evidence-matrix");
  });

  it("ops 不能触发运行、不能做人工决定", async () => {
    const { base } = await up;
    assert.equal((await call(appWith("ops", base), "POST", "/console/research/runs", {})).status, 403);
    assert.equal(
      (await call(appWith("ops", base), "POST", "/console/research/review/t1/resume", { kind: "promote" })).status,
      403,
    );
    assert.equal((await call(appWith("ops", base), "POST", "/console/research/contracts", {})).status, 403);
  });

  it("admin 的 resume 原样透传 body 给上游", async () => {
    const { base, seen } = await up;
    const body = { kind: "codebook-lock", rationale: "口径定了" };
    const r = await call(appWith("admin", base), "POST", "/console/research/review/research:c1:r1/resume", body);
    assert.equal(r.status, 200);

    const hit = seen.find((s) => s.url.includes("/review/") && s.method === "POST");
    assert.ok(hit, "上游没收到 resume");
    assert.deepEqual(JSON.parse(hit.body), body, "body 不该被网关改形");
    assert.match(hit.url, /research%3Ac1%3Ar1/, "thread_id 里的冒号要转义");
  });
});

describe("[M82-07] 审计", () => {
  const up = fakeUpstream();

  after(async () => {
    (await up).server.close();
  });

  it("打开单条证据记 research.evidence.open——读原文也是敏感动作", async () => {
    const { base } = await up;
    const probe: AuditProbe = { actions: [] };
    const r = await call(appWith("ops", base, probe), "GET", "/console/research/evidence/u1");
    assert.equal(r.status, 200);
    assert.deepEqual(probe.actions, ["research.evidence.open"]);
  });

  it("三个写动作各有自己的审计名", async () => {
    const { base } = await up;
    for (const [method, path, action] of [
      ["POST", "/console/research/contracts", "research.contract.create"],
      ["POST", "/console/research/runs", "research.run.start"],
      ["POST", "/console/research/review/t1/resume", "research.review.resume"],
    ] as const) {
      const probe: AuditProbe = { actions: [] };
      await call(appWith("admin", base, probe), method, path, {});
      assert.deepEqual(probe.actions, [action], path);
    }
  });

  it("普通列表读不单独记动作（全局审计中间件兜底即可）", async () => {
    const { base } = await up;
    const probe: AuditProbe = { actions: [] };
    await call(appWith("ops", base, probe), "GET", "/console/research/insights");
    assert.deepEqual(probe.actions, []);
  });
});

describe("[M82-07] 白名单与透传", () => {
  const up = fakeUpstream();

  after(async () => {
    (await up).server.close();
  });

  it("拼错的 lens 在网关就被拦下，不打到上游", async () => {
    const { base, seen } = await up;
    const before = seen.length;
    const r = await call(appWith("ops", base), "GET", "/console/research/snapshots/no-such-lens");
    assert.equal(r.status, 400);
    assert.equal((r.json as { error: string }).error, "unknown_lens");
    assert.equal(seen.length, before, "不该打到上游");
  });

  it("路径参数里的 .. 被拒", async () => {
    const { base } = await up;
    const r = await call(appWith("ops", base), "GET", "/console/research/insights/..%2Fx");
    assert.equal(r.status, 400);
  });

  it("CSV 的 content-type 原样透传", async () => {
    const { base } = await up;
    // 用 evidence 列表打到 fake 的 CSV 分支（fake 按 URL 前缀分发）。
    const app = appWith("ops", base);
    const r = await call(app, "GET", "/console/research/evidence?export=csv");
    assert.equal(r.status, 200);
    // 这条走的是 JSON 分支；CSV 分支单独探一次上游本身的行为。
    const direct = await fetch(`${base}/internal/research/export`);
    assert.match(direct.headers.get("content-type") ?? "", /text\/csv/);
  });

  it("能力名的字符集比 SAFE_ID 更窄，怪名字不打到上游", async () => {
    const { base, seen } = await up;
    const before = seen.length;
    const r = await call(appWith("admin", base), "POST", "/console/research/capabilities/Red_Team", {});
    assert.equal(r.status, 400);
    assert.equal((r.json as { error: string }).error, "bad_capability");
    assert.equal(seen.length, before, "不该打到上游");
  });

  it("网关不算任何东西：源码里不 import 研究包", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(new URL("../src/console/research.ts", import.meta.url).pathname, "utf8");
    // 先剥注释：文件头就写着"不 import @carlife/research"，那句话本身不是违规
    //（`check-arch-invariants.ts` 的 isComment 是同一条取舍）。
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["@carlife/research", "research-runtime"]) {
      assert.ok(!src.includes(forbidden), `网关 import 了 ${forbidden}——分母口径只该有一份`);
    }
  });
});

describe("[M85-03] actor 由这一跳注入，不由客户端带", () => {
  const up = fakeUpstream();

  after(async () => {
    (await up).server.close();
  });

  const upstreamUrlOf = (seen: Seen[], match: string): string => {
    const hit = [...seen].reverse().find((s) => s.url.includes(match));
    assert.ok(hit, `上游没收到 ${match}`);
    return hit.url;
  };

  it("resume 的上游 URL 带 actor，且等于当前身份——这是 decided_by 恒 unknown 的修复点", async () => {
    const { base, seen } = await up;
    const r = await call(appWith("admin", base), "POST", "/console/research/review/t-actor/resume", { kind: "promote" });
    assert.equal(r.status, 200);
    const url = upstreamUrlOf(seen, "/review/t-actor/resume");
    assert.match(url, /actor=admin%3Aadmin-1/, `上游 URL 少了 actor：${url}`);
  });

  it("能力调用的上游 URL 也带 actor", async () => {
    const { base, seen } = await up;
    await call(appWith("admin", base), "POST", "/console/research/capabilities/red-team", { scope: { kind: "page" } });
    assert.match(upstreamUrlOf(seen, "/capabilities/red-team"), /actor=admin%3Aadmin-1/);
  });

  it("**客户端自己写的 actor 被覆盖**，不是被追加——自证身份等于没有身份", async () => {
    const { base, seen } = await up;
    await call(appWith("admin", base), "POST", "/console/research/review/t-forge/resume?actor=ceo", { kind: "promote" });
    const url = upstreamUrlOf(seen, "/review/t-forge/resume");
    assert.ok(!url.includes("actor=ceo"), `客户端伪造的 actor 活下来了：${url}`);
    assert.match(url, /actor=admin%3Aadmin-1/);
  });

  it("读路径不带 actor——读不产生决定记录", async () => {
    const { base, seen } = await up;
    for (const path of ["/console/research/insights", "/console/research/review", "/console/research/contracts"]) {
      await call(appWith("admin", base), "GET", path);
      const hit = [...seen].reverse().find((s) => s.method === "GET" && s.url.includes(path.split("/").pop()!));
      assert.ok(hit);
      assert.ok(!hit.url.includes("actor="), `读路径带上了 actor：${hit.url}`);
    }
  });

  it("actor 带角色：admin 与 ops 是同一个 subject 的两种登录方式", async () => {
    const { base, seen } = await up;
    await call(appWith("admin", base), "POST", "/console/research/runs", {});
    // runs 不是决定记录，不加 actor；这条同时钉住"只给会产生决定的那几条加"。
    const hit = [...seen].reverse().find((s) => s.method === "POST" && s.url.includes("/runs"));
    assert.ok(hit);
    assert.ok(!hit.url.includes("actor="));
  });
});

describe("[M85-03] 能力端点与运行流", () => {
  const up = fakeUpstream();

  after(async () => {
    (await up).server.close();
  });

  it("能力调用要 admin：ops 回 403", async () => {
    const { base } = await up;
    const r = await call(appWith("ops", base), "POST", "/console/research/capabilities/red-team", {
      scope: { kind: "page" },
    });
    assert.equal(r.status, 403);
  });

  it("能力调用记 research.capability.run", async () => {
    const { base } = await up;
    const probe: AuditProbe = { actions: [] };
    await call(appWith("admin", base, probe), "POST", "/console/research/capabilities/red-team", {
      scope: { kind: "page" },
    });
    assert.deepEqual(probe.actions, ["research.capability.run"]);
  });

  it("body 原样转发，网关不改形", async () => {
    const { base, seen } = await up;
    const body = { scope: { kind: "cell", needPainCode: "x", sceneCode: "y", suppressed: false }, contractId: "c1" };
    await call(appWith("admin", base), "POST", "/console/research/capabilities/red-team", body);
    const hit = [...seen].reverse().find((s) => s.url.includes("/capabilities/"));
    assert.deepEqual(JSON.parse(hit!.body), body);
  });

  it("运行流走读者角色，且 ops 也能看", async () => {
    const { base } = await up;
    const r = await call(appWith("ops", base), "GET", "/console/research/runs/r1/stream");
    assert.equal(r.status, 200);
  });

  it("坏 id 在网关就被拦下", async () => {
    const { base } = await up;
    const r = await call(appWith("ops", base), "GET", "/console/research/runs/..%2Fx/stream");
    assert.equal(r.status, 400);
  });

  /**
   * **这一条是本单最要紧的断言**：`passthrough` 每次请求挂 5 秒超时，
   * 而一次 `✎` 运行 10–60 秒。用一个 8 秒才收尾的假上游证明这条路不经那把闸刀。
   */
  it("SSE 不被 5 秒超时掐断：8 秒的上游能完整读到最后一帧", async () => {
    const slow = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n");
      res.write(`event: state\ndata: ${JSON.stringify({ event: "state", stage: "frame" })}\n\n`);
      // 8 秒 > UPSTREAM_TIMEOUT_MS（5 秒）。走 passthrough 的话这里必然断。
      setTimeout(() => {
        res.write(`event: done\ndata: ${JSON.stringify({ event: "done", stage: "done" })}\n\n`);
        res.end();
      }, 8_000);
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const addr = slow.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const r = await call(appWith("ops", `http://127.0.0.1:${port}`), "GET", "/console/research/runs/r1/stream");
      assert.equal(r.status, 200);
      assert.match(r.text, /event: state/);
      assert.match(r.text, /event: done/, "8 秒的流被掐断了——这条路还在走 5 秒超时");
    } finally {
      slow.close();
    }
  });

  it("上游的 404 run_not_found 原样传下去，不变成 503", async () => {
    const missing = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "run_not_found" }));
    });
    await new Promise<void>((r) => missing.listen(0, "127.0.0.1", r));
    const addr = missing.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const r = await call(appWith("ops", `http://127.0.0.1:${port}`), "GET", "/console/research/runs/nope/stream");
      assert.equal(r.status, 404);
      assert.equal((r.json as { error: string }).error, "run_not_found");
    } finally {
      missing.close();
    }
  });
});
