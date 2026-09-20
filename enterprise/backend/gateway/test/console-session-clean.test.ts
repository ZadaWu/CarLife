/**
 * [F-03-11][AC-03-7] 控制台的会话清理与恢复端点（施工单 M108-03）。假仓储。
 *
 * 守四件事：**只有 admin 能清**（ops 一律 403 且仓储零调用）、不存在回 404、
 * 「清理全部」缺确认回 400 且会分批累加、列表的 `deleted` 参数翻译。
 * SQL 那一侧（一行不删、`updated_at` 不动）在 `@carlife/db` 的 `session-soft-delete.test.ts`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";

import { createSessionsRouter, parseDeletedMode } from "../src/console/sessions";

type Role = "admin" | "ops";

interface Calls {
  softDeleteSession: string[];
  restoreSession: string[];
  softDeleteSessions: Array<{ limit?: number }>;
  countSessions: number;
  page: Array<Record<string, unknown>>;
}

function appWith(role: Role | null, opts: { batches?: Array<{ scanned: number; deleted: number; remaining: number }> } = {}) {
  const calls: Calls = { softDeleteSession: [], restoreSession: [], softDeleteSessions: [], countSessions: 0, page: [] };
  const batches = [...(opts.batches ?? [{ scanned: 0, deleted: 0, remaining: 0 }])];
  const chat = {
    async softDeleteSession(id: string, at: Date) {
      calls.softDeleteSession.push(id);
      return id === "sess-missing" ? null : { deletedAt: at, changed: true };
    },
    async restoreSession(id: string) {
      calls.restoreSession.push(id);
      return id === "sess-missing" ? null : { changed: true };
    },
    async softDeleteSessions(o: { limit?: number }) {
      calls.softDeleteSessions.push(o);
      return batches.shift() ?? { scanned: 0, deleted: 0, remaining: 0 };
    },
    async countSessions() {
      calls.countSessions += 1;
      return 5765;
    },
    async consoleSessionPage(q: Record<string, unknown>) {
      calls.page.push(q);
      return { sessions: [], hasMore: false, nextCursor: null };
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role) (req as express.Request & { console?: unknown }).console = { subject: `${role}-1`, role };
    next();
  });
  app.use(createSessionsRouter(chat as never, {} as never));
  return { app, calls };
}

async function call(app: express.Express, method: "GET" | "POST", path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("[F-03-11][AC-03-7] 控制台会话清理与恢复", () => {
  it("admin 清理一条：200、回 deletedAt、仓储以该 id 调一次", async () => {
    const { app, calls } = appWith("admin");
    const r = await call(app, "POST", "/console/sessions/sess-1/clean");
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionId, "sess-1");
    assert.ok(!Number.isNaN(Date.parse(String(r.body.deletedAt))));
    assert.deepEqual(calls.softDeleteSession, ["sess-1"]);
  });

  it("admin 恢复一条：200、deletedAt 回 null", async () => {
    const { app, calls } = appWith("admin");
    const r = await call(app, "POST", "/console/sessions/sess-1/restore");
    assert.equal(r.status, 200);
    assert.equal(r.body.deletedAt, null);
    assert.deepEqual(calls.restoreSession, ["sess-1"]);
  });

  it("会话不存在：清理与恢复都回 404 session_not_found", async () => {
    const { app } = appWith("admin");
    for (const verb of ["clean", "restore"]) {
      const r = await call(app, "POST", `/console/sessions/sess-missing/${verb}`);
      assert.equal(r.status, 404, verb);
      assert.equal(r.body.error, "session_not_found");
    }
  });

  it("ops 调三个写端点：一律 403，仓储零调用；没带身份是 401", async () => {
    const { app, calls } = appWith("ops");
    for (const [path, body] of [
      ["/console/sessions/sess-1/clean", undefined],
      ["/console/sessions/sess-1/restore", undefined],
      ["/console/sessions/clean-all", { confirm: "all" }],
      ["/console/sessions/clean-all", { dryRun: true }],
    ] as const) {
      assert.equal((await call(app, "POST", path, body)).status, 403, path);
    }
    assert.deepEqual(
      [calls.softDeleteSession.length, calls.restoreSession.length, calls.softDeleteSessions.length, calls.countSessions],
      [0, 0, 0, 0],
    );
    const anon = appWith(null);
    assert.equal((await call(anon.app, "POST", "/console/sessions/sess-1/clean")).status, 401);
  });

  it("清理全部不带 confirm: \"all\"：400，仓储零调用", async () => {
    const { app, calls } = appWith("admin");
    for (const body of [undefined, {}, { confirm: "yes" }, { confirm: true }]) {
      const r = await call(app, "POST", "/console/sessions/clean-all", body);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "confirm_required");
    }
    assert.equal(calls.softDeleteSessions.length, 0);
  });

  it("清理全部会分批：前两批还有剩、第三批清完 → 调三次，cleaned 是三次之和", async () => {
    const { app, calls } = appWith("admin", {
      batches: [
        { scanned: 500, deleted: 500, remaining: 765 },
        { scanned: 500, deleted: 500, remaining: 265 },
        { scanned: 265, deleted: 265, remaining: 0 },
      ],
    });
    const r = await call(app, "POST", "/console/sessions/clean-all", { confirm: "all" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { cleaned: 1265, remaining: 0 });
    assert.equal(calls.softDeleteSessions.length, 3);
    assert.ok(calls.softDeleteSessions.every((o) => o.limit === 500));
  });

  it("清理全部有总上限：一直清不完时 20 批后停下并如实回 remaining", async () => {
    const { app, calls } = appWith("admin", {
      batches: Array.from({ length: 30 }, () => ({ scanned: 500, deleted: 500, remaining: 99_999 })),
    });
    const r = await call(app, "POST", "/console/sessions/clean-all", { confirm: "all" });
    assert.equal(calls.softDeleteSessions.length, 20);
    assert.deepEqual(r.body, { cleaned: 10_000, remaining: 99_999 });
  });

  it("dryRun 只报数：不调清理、回 total", async () => {
    const { app, calls } = appWith("admin");
    const r = await call(app, "POST", "/console/sessions/clean-all", { dryRun: true });
    assert.deepEqual(r.body, { total: 5765 });
    assert.equal(calls.softDeleteSessions.length, 0);
  });

  it("列表的 deleted 参数：include / only 透传，缺省与拼错都不传", async () => {
    assert.equal(parseDeletedMode("include"), "include");
    assert.equal(parseDeletedMode("only"), "only");
    for (const v of [undefined, "", "exclude", "all", "1", ["only"]]) assert.equal(parseDeletedMode(v), undefined);

    const { app, calls } = appWith("ops");
    await call(app, "GET", "/console/sessions?deleted=only");
    await call(app, "GET", "/console/sessions");
    await call(app, "GET", "/console/sessions?deleted=bogus");
    assert.deepEqual(calls.page.map((q) => q.deleted), ["only", undefined, undefined]);
  });
});
