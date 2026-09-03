/**
 * 真实日历后端（施工单 M43-02）。stub 服务打真 HTTP；凭证/网络之外的
 * 行为（幂等 id、409 语义、发现两跳、半成态话术）全部可离线断言。
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { createGoogleCalendarBackend, googleEventId } from "../src/calendar-google";
import { createCaldavBackend, buildIcs, caldavUid } from "../src/calendar-caldav";
import { createCalendarTool, createFanoutCalendarBackend, createMockBackend } from "../src/calendar";
import { ToolError } from "../src/external";

const EV = { title: "保养预约 · 上海浦东前滩服务中心", start: "2026-09-01T09:00:00+08:00", end: "2026-09-01T10:00:00+08:00" };
const CTX = { sessionId: "sess-cal-test", mode: "real" as const };

describe("buildIcs / uid 纯函数", () => {
  it("UID 确定性：同键同 id；Google id 只含 base32hex 字符", () => {
    assert.equal(caldavUid("s1", EV), caldavUid("s1", EV));
    assert.notEqual(caldavUid("s1", EV), caldavUid("s2", EV));
    const gid = googleEventId("s1", EV);
    assert.equal(gid, googleEventId("s1", EV));
    assert.match(gid, /^[a-v0-9]+$/);
  });

  it(".ics 含时区块与转义；逗号分号换行转义", () => {
    const ics = buildIcs("uid1@carlife", { ...EV, note: "带,逗号;分号\n换行", location: "地下B2, 3号位" });
    assert.match(ics, /TZID:Asia\/Shanghai/);
    assert.match(ics, /DTSTART;TZID=Asia\/Shanghai:20260901T090000/);
    assert.match(ics, /DESCRIPTION:带\\,逗号\\;分号\\n换行/);
    assert.match(ics, /LOCATION:地下B2\\, 3号位/);
  });
});

// ── Google stub ─────────────────────────────────────────────

let tokenCalls = 0;
let putEvents: Array<Record<string, unknown>> = [];
let googleSrv: Server;
let googleBase = "";

function startGoogleStub(): Server {
  return createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/token") {
      tokenCalls += 1;
      return send(200, { access_token: `at-${tokenCalls}`, expires_in: 3600 });
    }
    if (url.pathname === "/badtoken") return send(401, { error: "invalid_grant" });
    if (/\/calendars\/.+\/events$/.test(url.pathname) && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (putEvents.some((e) => e.id === body.id)) return send(409, { error: "duplicate" });
        putEvents.push(body);
        send(200, body);
      });
      return;
    }
    if (/\/calendars\/.+\/events\/.+$/.test(url.pathname) && req.method === "GET") {
      const id = decodeURIComponent(url.pathname.split("/").pop()!);
      const hit = putEvents.find((e) => e.id === id);
      return hit ? send(200, hit) : send(404, { error: "not_found" });
    }
    if (url.pathname === "/freeBusy" && req.method === "POST") {
      return send(200, { calendars: { "me@example.com": { busy: [{ start: "2026-09-01T09:00:00+08:00", end: "2026-09-01T10:00:00+08:00" }] } } });
    }
    send(404, { error: "not_found" });
  });
}

describe("Google 后端（stub）", () => {
  before(async () => {
    googleSrv = startGoogleStub();
    await new Promise<void>((r) => googleSrv.listen(0, r));
    googleBase = `http://localhost:${(googleSrv.address() as AddressInfo).port}`;
  });
  after(() => googleSrv.close());

  const backend = () =>
    createGoogleCalendarBackend({
      clientId: "cid",
      clientSecret: "cs",
      refreshToken: "rt-secret",
      calendarId: "me@example.com",
      tokenUrl: `${googleBase}/token`,
      apiBase: googleBase,
    });

  it("token 缓存：两次写只换一次 token；写→读回自证", async () => {
    tokenCalls = 0;
    putEvents = [];
    const b = backend();
    const ids1 = await b.createEvents("s1", [EV]);
    const ids2 = await b.createEvents("s1", [{ ...EV, title: "另一条", start: "2026-09-02T09:00:00+08:00" }]);
    assert.equal(ids1.length, 1);
    assert.equal(ids2.length, 1);
    assert.equal(tokenCalls, 1, "token 应被缓存");
    assert.equal(putEvents.length, 2);
  });

  it("同键重放：Google 409 视为幂等成功，事件不翻倍", async () => {
    putEvents = [];
    const b = backend();
    const a = await b.createEvents("s1", [EV]);
    const c = await b.createEvents("s1", [EV]);
    assert.deepEqual(a, c);
    assert.equal(putEvents.length, 1);
  });

  it("凭证失效：话术引导重新授权且不含 token 原文", async () => {
    const b = createGoogleCalendarBackend({
      clientId: "cid",
      clientSecret: "cs",
      refreshToken: "rt-secret",
      calendarId: "me@example.com",
      tokenUrl: `${googleBase}/badtoken`,
      apiBase: googleBase,
    });
    await assert.rejects(
      () => b.createEvents("s1", [EV]),
      (err: unknown) => {
        assert.ok(err instanceof ToolError);
        assert.match(err.message, /重新授权/);
        assert.ok(!err.message.includes("rt-secret"), "错误信息不得含 refresh token");
        return true;
      },
    );
  });

  it("freeBusy 读回忙闲三元组", async () => {
    const slots = await backend().listBusy("s1", "2026-09-01", "2026-09-02");
    assert.equal(slots.length, 1);
    assert.equal(slots[0].status, "busy");
  });
});

// ── CalDAV stub ─────────────────────────────────────────────

let davPuts = new Map<string, string>();
let davSrv: Server;
let davBase = "";

function startDavStub(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "PROPFIND" && url.pathname === "/") {
      res.writeHead(207, { "content-type": "application/xml" });
      return res.end(`<multistatus xmlns="DAV:"><response><propstat><prop><current-user-principal><href>/principal/u1/</href></current-user-principal></prop></propstat></response></multistatus>`);
    }
    if (req.method === "PROPFIND" && url.pathname === "/principal/u1/") {
      res.writeHead(207, { "content-type": "application/xml" });
      return res.end(`<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><response><propstat><prop><c:calendar-home-set><href>/cal/u1/</href></c:calendar-home-set></prop></propstat></response></multistatus>`);
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const existed = davPuts.has(url.pathname);
        davPuts.set(url.pathname, Buffer.concat(chunks).toString());
        res.writeHead(existed ? 204 : 201).end();
      });
      return;
    }
    if (req.method === "GET" && davPuts.has(url.pathname)) {
      res.writeHead(200, { "content-type": "text/calendar" });
      return res.end(davPuts.get(url.pathname));
    }
    res.writeHead(404).end();
  });
}

describe("CalDAV 后端（stub）", () => {
  before(async () => {
    davSrv = startDavStub();
    await new Promise<void>((r) => davSrv.listen(0, r));
    davBase = `http://localhost:${(davSrv.address() as AddressInfo).port}`;
  });
  after(() => davSrv.close());

  it("发现两跳 → PUT → 读回；同 UID 重放只有一份（204 覆盖）", async () => {
    davPuts = new Map();
    const b = createCaldavBackend({ appleId: "a@icloud.com", appPassword: "app-pass", discoveryBase: davBase });
    const ids = await b.createEvents("s1", [EV]);
    assert.equal(ids.length, 1);
    assert.match(ids[0], /@carlife$/);
    assert.equal(davPuts.size, 1);
    const again = await b.createEvents("s1", [EV]);
    assert.deepEqual(ids, again);
    assert.equal(davPuts.size, 1, "同 UID 覆盖不是新增");
    const stored = [...davPuts.values()][0];
    assert.match(stored, /SUMMARY:保养预约/);
  });

  it("URL 直填短路发现", async () => {
    davPuts = new Map();
    const b = createCaldavBackend({ appleId: "a@icloud.com", appPassword: "p", calendarUrl: `${davBase}/direct/cal/` });
    await b.createEvents("s2", [EV]);
    assert.ok([...davPuts.keys()][0].startsWith("/direct/cal/"));
  });

  it("读侧未实现 → calendar 工具降级为 skipped + 如实 reason（不谎报无冲突）", async () => {
    const tool = createCalendarTool(createCaldavBackend({ appleId: "a@icloud.com", appPassword: "p", discoveryBase: davBase }));
    const r = await tool.call({ op: "read", from: "2026-09-01", to: "2026-09-02" }, CTX);
    assert.equal(r.data.op, "read");
    assert.equal((r.data as { skipped: boolean }).skipped, true);
    assert.match((r.data as { reason?: string }).reason ?? "", /未检查日程冲突/);
  });
});

describe("fanout（both 模式）", () => {
  it("双写各得其 id（带侧名前缀）", async () => {
    const a = createMockBackend();
    const b = createMockBackend();
    const fan = createFanoutCalendarBackend([
      { name: "google", backend: a },
      { name: "caldav", backend: b },
    ]);
    const ids = await fan.createEvents("s1", [EV]);
    assert.equal(ids.length, 2);
    assert.ok(ids.some((i) => i.startsWith("google:")));
    assert.ok(ids.some((i) => i.startsWith("caldav:")));
  });

  it("半成态如实：一侧成功一侧失败时话术点名哪边成功", async () => {
    const ok = createMockBackend();
    const bad = {
      ...createMockBackend(),
      createEvents: async () => {
        throw new Error("iCloud 401");
      },
    };
    const fan = createFanoutCalendarBackend([
      { name: "google", backend: ok },
      { name: "caldav", backend: bad },
    ]);
    await assert.rejects(
      () => fan.createEvents("s1", [EV]),
      (err: unknown) => err instanceof ToolError && /google 已写入.*caldav 写入失败/.test(err.message),
    );
  });
});
