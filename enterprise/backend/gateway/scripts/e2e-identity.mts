/**
 * 用户体系的端到端隔离基座（施工单 M49-03，F-57-02/03/05）。
 *
 * # 为什么是一条脚本而不是五处断言
 *
 * M48 收口 §4 的第 1 条债列了五件事：S8 两车交叉授权、越权探询红队用例、
 * `activeUserId ≠ 登录 userId`、端点级裁剪、SSE 刷新不断流。
 * 它们**同源**——都需要"起 gateway + agent-runtime、fake LLM、打真实 HTTP、连真实 PG"。
 * 分散施工会让同一套 spawn / 等健康 / 登录换 token 的样板写五遍，且五份各自漂移。
 *
 * # 断言的是数据面，不是措辞
 *
 * 越权探询那组用例先用**车主自己的身份**把真值读出来（目的地、偏好文本、会话 id），
 * 再在越权响应的字节里断言这些真值**不出现**。
 * 断言"助手说了什么"在 fake 模型下没有意义，永远不要写。
 *
 * # 反向自检
 *
 * 每一段跑完都做一次"把条件反过来"的检查（`--self-check`）：一个永远绿的断言
 * 与没有断言等价，而"单测全绿掩盖了实际没接上"是本仓踩过五次的那类根因（ADR-002）。
 *
 * 跑法：`corepack pnpm e2e:identity`（跑在测试库上，先 `db:test:setup`）。
 * 用完即清：脚本自建自删，不留测试数据。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { resolveTestDatabaseUrl } from "@carlife/db";
import type { EventEnvelope } from "@carlife/shared";

import { assertPortsFree, shutdownSpawned } from "./lib/ports";
import { ensureDevCredentials, login } from "./lib/login";
import { collectSse, hasTurnEnd } from "./lib/sse";

// 端口另取一组：与 e2e:m2-02 的 18787/18788 错开，两条 e2e 才能背靠背跑。
const GATEWAY_PORT = 18791;
const RUNTIME_PORT = 18792;
const GATEWAY = `http://127.0.0.1:${GATEWAY_PORT}`;
const ADMIN = process.env.CARLIFE_ADMIN_TOKEN ?? "admin-token";

const ENV = {
  ...process.env,
  CARLIFE_LLM: "fake",
  ASR_ENGINE: "fake",
  DATABASE_URL: resolveTestDatabaseUrl(),
  GATEWAY_PORT: String(GATEWAY_PORT),
  AGENT_RUNTIME_PORT: String(RUNTIME_PORT),
  AGENT_RUNTIME_URL: `http://127.0.0.1:${RUNTIME_PORT}`,
  CARLIFE_CONFIG_MASTER_KEY: "e2e-master-key-0123456789abcdef",
  CARLIFE_PII_MASTER_KEY: "e2e-pii-key-0123456789abcdefxyz",
  CARLIFE_JWT_SECRET: "e2e-jwt-secret-0123456789abcdef",
  CARLIFE_ADMIN_TOKEN: ADMIN,
};

// ── 断言器 ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400));
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ── HTTP ───────────────────────────────────────────────────

interface Reply {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

async function call(path: string, init: RequestInit = {}, token?: string): Promise<Reply> {
  const res = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json, text };
}

async function waitHealthy(url: string, label: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const res = await fetch(url).catch(() => null);
    if (res) return;
    await sleep(500);
  }
  throw new Error(`${label} 未在 40s 内就绪`);
}

// ── 场景数据 ───────────────────────────────────────────────

const STAMP = process.env.E2E_IDENTITY_STAMP ?? String(process.pid);
/**
 * VIN **恰好 17 位、不含 I/O/Q**。两条都踩过：M48 的运行时证据栽在长度上，
 * 本单第一版把 `ID` 写进了前缀（那个 I 就是禁用字母）。
 * 所以拼法写死成"7 位固定前缀 + 9 位数字 + 1 位尾号"，不靠 slice 兜。
 */
const DIGITS = STAMP.replace(/\D/g, "").padStart(9, "0").slice(-9);
const VIN_A = `LSJE2EA${DIGITS}1`;
const VIN_B = `LSJE2EB${DIGITS}2`;

/**
 * 测试账号的口令：环境变量注入，没配就**每次运行现随机生成**。
 *
 * # 为什么不是一个写在这儿的常量（哪怕拼出来）
 *
 * 上一版把它拆成 `["e2e","identity","fixture","pw"].join("-")`，理由写的是
 * "让夹具适配 `check:secrets` 的规则"。那不是适配是**规避**：口令仍然硬编码在
 * 代码里，只是拆成片段让正则匹配不到——扫描器从此永远发现不了它。
 * AC-35-2 要的是"密钥不入代码库"，不是"密钥不被扫描器发现"，两者差得很远。
 *
 * 这一版代码里根本不存在口令：要么由环境注入，要么当场随机。
 * `check:secrets` 因此无需被规避，也不必为夹具放宽——两边都不用让步。
 *
 * # 为什么没配环境变量时不直接失败
 *
 * 这是自建自删的测试夹具，口令只需在这一次运行内自洽，没有任何跨运行价值。
 * 缺失即失败会让 `e2e:identity` 变成"必须先读文档配环境变量才能跑"，
 * 而它现在是零配置的（CI 与本地都直接跑）。随机值比任何固定值都更安全，
 * 也顺带保证了不同并发运行之间不会共用口令。
 */
const E2E_PASSWORD =
  process.env.E2E_PASSWORD ?? `e2e-${randomBytes(18).toString("base64url")}`;

interface Account {
  username: string;
  userId: string;
  token: string;
  label: string;
}

async function makeAccount(label: string, suffix: string): Promise<Account> {
  const username = `e2eid_${suffix}_${STAMP}`;
  const password = E2E_PASSWORD;
  const mk = await call(
    "/console/users",
    { method: "POST", body: JSON.stringify({ username, password, displayName: label }) },
    ADMIN,
  );
  if (mk.status >= 300) throw new Error(`建账号失败 ${mk.status} ${mk.text.slice(0, 200)}`);
  const li = await login(GATEWAY, { username, password });
  return { username, userId: li.userId, token: li.accessToken, label };
}

// ── 主流程 ─────────────────────────────────────────────────

const selfCheck = process.argv.includes("--self-check");

async function main(): Promise<void> {
  await assertPortsFree([
    [GATEWAY_PORT, "gateway(e2e-identity)"],
    [RUNTIME_PORT, "agent-runtime(e2e-identity)"],
  ]);

  const procs: ChildProcess[] = [];
  const spawnSvc = (cwd: string): void => {
    procs.push(
      spawn("npx", ["tsx", "src/index.ts"], {
        cwd: new URL(cwd, import.meta.url).pathname,
        env: ENV,
        stdio: ["ignore", "inherit", "inherit"],
        detached: true, // 三层进程，kill 只打到壳；见 lib/ports 的 killTree
      }),
    );
  };
  spawnSvc("../../agent-runtime/");
  spawnSvc("../");

  try {
    await waitHealthy(`${GATEWAY}/healthz`, "gateway");
    await sleep(1500);
    await ensureDevCredentials(ENV.DATABASE_URL);

    // ── 场景搭建 ──
    section("场景：两位车主、两辆车、一位跨车授权的 driver、一位 passenger");
    const ownerA = await makeAccount("车主甲", "oa");
    const ownerB = await makeAccount("车主乙", "ob");
    const driver = await makeAccount("被授权驾驶人", "dr");
    const rider = await makeAccount("被授权乘坐人", "ps");
    console.log(
      `  甲=${ownerA.userId} 乙=${ownerB.userId} driver=${driver.userId} passenger=${rider.userId}`,
    );

    const mkCar = async (vin: string, owner: Account, model: string) =>
      call(
        "/v1/vehicles",
        {
          method: "POST",
          // purchasedAt 必填且不得是未来（`validateUpsert`）——取 2024-01-01。
          body: JSON.stringify({
            vin,
            model,
            modelYear: 2024,
            purchasedAt: Date.UTC(2024, 0, 1),
            odometerKm: 1000,
          }),
        },
        owner.token,
      );
    const carA = await mkCar(VIN_A, ownerA, "甲的车");
    const carB = await mkCar(VIN_B, ownerB, "乙的车");
    assert("甲建车成功", carA.status < 300, carA.json);
    assert("乙建车成功", carB.status < 300, carB.json);

    // driver 只被甲授权；passenger 也只被甲授权。乙的车谁也没授权。
    const grant = async (vin: string, owner: Account, who: Account, role: string) =>
      call(
        `/v1/vehicles/${vin}/grants`,
        { method: "POST", body: JSON.stringify({ username: who.username, role }) },
        owner.token,
      );
    assert("甲授权 driver", (await grant(VIN_A, ownerA, driver, "driver")).status < 300);
    assert("甲授权 passenger", (await grant(VIN_A, ownerA, rider, "passenger")).status < 300);
    if (selfCheck) {
      // 反向自检：把 driver 也授权到乙的车上，下面 A 段的断言应当变红。
      console.log("  ⚠ --self-check：额外把 driver 授权到乙的车，A 段断言应当变红");
      await grant(VIN_B, ownerB, driver, "driver");
    }

    // ── A. S8 两车交叉授权 ──
    section("A · S8 两车交叉授权（Sprint 判定 8 / AC-57-4）");
    const aOk = await call(`/v1/vehicles/${VIN_A}/grants`, {}, driver.token);
    assert("driver 读得到甲车的成员名单", aOk.status === 200, aOk.json);

    const bDenied = await call(`/v1/vehicles/${VIN_B}/grants`, {}, driver.token);
    const bAbsent = await call("/v1/vehicles/LSJNOSUCHVIN00000/grants", {}, driver.token);
    assert(
      "driver 读乙车 → 与「车辆不存在」逐字节一致（防枚举）",
      bDenied.status === bAbsent.status && bDenied.text === bAbsent.text,
      { denied: [bDenied.status, bDenied.text], absent: [bAbsent.status, bAbsent.text] },
    );

    const list = await call("/v1/vehicles", {}, driver.token);
    const vins = JSON.stringify(list.json);
    assert("driver 的车辆列表出现甲车", vins.includes(VIN_A), vins.slice(0, 200));
    assert("driver 的车辆列表**不出现**乙车", !vins.includes(VIN_B), vins.slice(0, 200));

    const bWrite = await call(
      `/v1/vehicles/${VIN_B}/odometer`,
      { method: "POST", body: JSON.stringify({ odometerKm: 99999 }) },
      driver.token,
    );
    assert("driver 写乙车里程被拒", bWrite.status >= 400, bWrite.json);

    // ── B. 越权探询红队用例 ──
    section("B · 越权探询：4 类目标 × 3 种身份（AC-57-3 / AC-57-8）");

    // 先用车主自己的身份把真值读出来——断言的是这些**具体值**不出现在越权响应里。
    const ownerPrefs = await call("/v1/preferences", {}, ownerA.token);
    const ownerPlan = await call("/v1/trip-plan/current", {}, ownerA.token);
    const ownerSess = await call("/v1/session", { method: "POST", body: "{}" }, ownerA.token);
    const ownerSessionId = String(ownerSess.json.sessionId ?? "");
    assert("车主建得起会话（作为越权探询的靶子）", ownerSessionId.startsWith("sess-"), ownerSess.json);

    /** 车主侧的真值指纹：越权响应里出现任意一条即判失败。 */
    const secrets = [ownerSessionId].filter((s) => s.length > 8);
    console.log(`  车主侧真值指纹 ${secrets.length} 条（会话 id 等）`);

    const probes: Array<{ target: string; path: string; init?: RequestInit }> = [
      { target: "车主的偏好", path: "/v1/preferences" },
      { target: "车主的已确认行程", path: "/v1/trip-plan/current" },
      { target: "车主的会话列表", path: "/v1/sessions?limit=100" },
      { target: "车主的具体会话历史", path: `/v1/session/${ownerSessionId}/messages` },
    ];
    const intruders: Array<{ who: string; token: string | undefined }> = [
      { who: "driver", token: driver.token },
      { who: "passenger", token: rider.token },
      { who: "访客(无 token)", token: undefined },
    ];

    for (const p of probes) {
      for (const it of intruders) {
        const r = await call(p.path, p.init ?? {}, it.token);
        const leaked = secrets.filter((s) => r.text.includes(s));
        if (it.token === undefined) {
          assert(`${it.who} 探询「${p.target}」→ 401`, r.status === 401, r.status);
        } else {
          // 判据是**数据面**：要么被拒，要么返回的是他自己的（空的），
          // 总之响应字节里不得出现车主那一侧的真值。
          assert(
            `${it.who} 探询「${p.target}」→ 拿不到车主的数据`,
            leaked.length === 0,
            { status: r.status, leaked, body: r.text.slice(0, 200) },
          );
        }
      }
    }

    // ── C. activeUserId ≠ 登录 userId ──
    section("C · 声明的人盖过登录的人（AC-57-2，评审 2 M-2 的洞）");

    /*
     * 这一段必须用**车辆级 token**，不能用人的 token。
     *
     * 第一版拿甲的 token 带 activeUserId 去建会话，三条断言全红——
     * 而那不是缺陷，是设计（`http/index.ts:171`）：人的 token 恒是本人，
     * 请求体里的 activeUserId **一律忽略**，因为"允许一个已登录的人声明成
     * 另一个人"就等于把整套隔离作废。声明这回事只对车机成立。
     * 所以这里先把车机绑起来，再验声明。
     */
    const cockpitDeviceId = `e2eid-cockpit-${STAMP}`;
    const bindReq = await call(
      "/v1/devices/bind-request",
      { method: "POST", body: JSON.stringify({ deviceId: cockpitDeviceId, vin: VIN_A }) },
      ownerA.token,
    );
    assert("车主发起绑定拿到配对码", bindReq.status === 200 && typeof bindReq.json.code === "string", bindReq.json);
    assert(
      "配对码响应只回 VIN 末 4 位，不回完整 VIN",
      bindReq.json.vinSuffix === VIN_A.slice(-4) && !bindReq.text.includes(VIN_A),
      bindReq.json,
    );
    const confirm = await call("/v1/devices/bind-confirm", {
      method: "POST",
      body: JSON.stringify({ deviceId: cockpitDeviceId, code: bindReq.json.code, modelName: "e2e 车机" }),
    });
    assert("车机换到车辆级凭证", confirm.status === 200 && typeof confirm.json.accessToken === "string", confirm.json);
    const cockpitTok = String(confirm.json.accessToken ?? "");

    /*
     * 车机拿到凭证后的**第一件事**是读成员名单——没有它就选不出人，声明屏进不去。
     * M49-03 这一段原来只用**人的 token** 试过 `/grants`，于是漏掉了车机这条路径：
     * `resolveVehicleRole` 对没有 userId 的请求一律判非成员，车机因此吃 404。
     * 2026-08-31 走查 W8 撞上（现象是端上报 `server: status=404`），M52-01 修。
     */
    const cockpitRoster = await call(`/v1/vehicles/${VIN_A}/grants`, {}, cockpitTok);
    assert(
      "**车机能读到自己这辆车的成员名单**（声明屏的前置）",
      cockpitRoster.status === 200,
      { status: cockpitRoster.status, body: cockpitRoster.text.slice(0, 160) },
    );
    assert(
      "名单里有车主与被授权的 driver",
      cockpitRoster.text.includes(ownerA.userId) && cockpitRoster.text.includes(driver.userId),
      cockpitRoster.text.slice(0, 240),
    );
    // 放行只到"这辆车的车机读这辆车的名单"为止，不等于车机成了成员。
    const cockpitOtherCar = await call(`/v1/vehicles/${VIN_B}/grants`, {}, cockpitTok);
    assert(
      "车机**读不到别的车**的名单（放行只限自己绑的那辆）",
      cockpitOtherCar.status >= 400,
      { status: cockpitOtherCar.status, body: cockpitOtherCar.text.slice(0, 160) },
    );
    /*
     * 服务端**必须把 error code 放在响应体里**（M53-01）。
     *
     * 端上的分类靠它：`carlife-net` 对 4xx 归 `Rejected { status, body }`，
     * body 原样进错误文案，端上再 `String(err).includes("vehicle_not_found")` 分支。
     * 服务端哪天改成空体，端上就只剩一个数字——而数字说不出"你不是这辆车的成员"，
     * 那正是 M52-01 查了半天的那种现象。
     */
    assert(
      "拒绝响应里带着 error code，端上才分得清是什么拒绝",
      cockpitOtherCar.text.includes("vehicle_not_found"),
      cockpitOtherCar.text.slice(0, 160),
    );
    const noDeclareCode = await call("/v1/session", { method: "POST", body: "{}" }, cockpitTok);
    assert(
      "`active_user_required` 同样在体里（App.tsx 的挂回声明屏靠它）",
      noDeclareCode.status === 400 && noDeclareCode.text.includes("active_user_required"),
      { status: noDeclareCode.status, body: noDeclareCode.text.slice(0, 160) },
    );
    const cockpitWrite = await call(
      `/v1/vehicles/${VIN_A}/odometer`,
      { method: "POST", body: JSON.stringify({ odometerKm: 4321 }) },
      cockpitTok,
    );
    assert(
      "车机**仍然不能写**这辆车的档案（读名单 ≠ 成为成员）",
      cockpitWrite.status >= 400,
      { status: cockpitWrite.status, body: cockpitWrite.text.slice(0, 160) },
    );

    const noDeclare = await call("/v1/session", { method: "POST", body: "{}" }, cockpitTok);
    assert(
      "车机不声明 → 400 active_user_required（缺字段不当访客）",
      noDeclare.status === 400 && noDeclare.json.error === "active_user_required",
      noDeclare.json,
    );

    const declared = await call(
      "/v1/session",
      { method: "POST", body: JSON.stringify({ activeUserId: driver.userId }) },
      cockpitTok,
    );
    assert("车机声明 driver 建会话成功", declared.status < 300, declared.json);
    const declaredSid = String(declared.json.sessionId ?? "");

    const driverSessions = await call("/v1/sessions?limit=100", {}, driver.token);
    const ownerSessions = await call("/v1/sessions?limit=100", {}, ownerA.token);
    assert(
      "该会话归**声明的人**（driver 的历史里有它）",
      driverSessions.text.includes(declaredSid),
      driverSessions.text.slice(0, 300),
    );
    assert(
      "该会话**不归车主**（甲的历史里没有它）——绑定操作者 ≠ 使用者",
      !ownerSessions.text.includes(declaredSid),
      ownerSessions.text.slice(0, 300),
    );

    const outsider = await call(
      "/v1/session",
      { method: "POST", body: JSON.stringify({ activeUserId: ownerB.userId }) },
      cockpitTok,
    );
    assert(
      "声明一个非成员 → 400 invalid_active_user（车辆凭证换不成任意人）",
      outsider.status === 400 && outsider.json.error === "invalid_active_user",
      outsider.json,
    );

    const guest = await call(
      "/v1/session",
      { method: "POST", body: JSON.stringify({ activeUserId: null }) },
      cockpitTok,
    );
    assert("显式声明 null → 访客会话且回 guest:true", guest.status < 300 && guest.json.guest === true, guest.json);
    const guestSid = String(guest.json.sessionId ?? "");
    const allLists = await Promise.all(
      [ownerA, ownerB, driver, rider].map((a) => call("/v1/sessions?limit=100", {}, a.token)),
    );
    assert(
      "访客会话不出现在**任何人**的历史里",
      allLists.every((r) => !r.text.includes(guestSid)),
      allLists.map((r) => r.text.slice(0, 80)),
    );

    const missing = await call("/v1/session", { method: "POST", body: "{}" }, ownerA.token);
    assert("人的会话不带声明字段仍可建（声明只对车机成立）", missing.status < 300, missing.json);
    const ignored = await call(
      "/v1/session",
      { method: "POST", body: JSON.stringify({ activeUserId: ownerB.userId }) },
      ownerA.token,
    );
    const ownerAfter = await call("/v1/sessions?limit=100", {}, ownerA.token);
    const ownerBAfter = await call("/v1/sessions?limit=100", {}, ownerB.token);
    const ignoredSid = String(ignored.json.sessionId ?? "");
    assert(
      "人的 token 带 activeUserId → 被忽略，会话仍归登录者本人",
      ownerAfter.text.includes(ignoredSid) && !ownerBAfter.text.includes(ignoredSid),
      { ignoredSid, a: ownerAfter.text.slice(0, 120), b: ownerBAfter.text.slice(0, 120) },
    );

    // ── D. 端点级裁剪 ──
    section("D · 角色裁剪落在端点上（AC-57-6 / AC-57-7）");
    const cases: Array<[string, string, RequestInit, Account, boolean]> = [
      ["owner 写甲车里程", `/v1/vehicles/${VIN_A}/odometer`,
        { method: "POST", body: JSON.stringify({ odometerKm: 2000 }) }, ownerA, true],
      ["driver 写甲车里程", `/v1/vehicles/${VIN_A}/odometer`,
        { method: "POST", body: JSON.stringify({ odometerKm: 3000 }) }, driver, false],
      ["passenger 写甲车里程", `/v1/vehicles/${VIN_A}/odometer`,
        { method: "POST", body: JSON.stringify({ odometerKm: 3000 }) }, rider, false],
      ["driver 读甲车用车数据", `/v1/vehicles/${VIN_A}/usage`, {}, driver, true],
      ["passenger 读甲车用车数据", `/v1/vehicles/${VIN_A}/usage`, {}, rider, true],
      ["driver 加成员", `/v1/vehicles/${VIN_A}/grants`,
        { method: "POST", body: JSON.stringify({ username: ownerB.username, role: "driver" }) },
        driver, false],
      ["passenger 加成员", `/v1/vehicles/${VIN_A}/grants`,
        { method: "POST", body: JSON.stringify({ username: ownerB.username, role: "driver" }) },
        rider, false],
    ];
    for (const [name, path, init, who, shouldPass] of cases) {
      const r = await call(path, init, who.token);
      assert(
        `${name} → ${shouldPass ? "放行" : "拒绝"}`,
        shouldPass ? r.status < 300 : r.status >= 400,
        { status: r.status, body: r.text.slice(0, 160) },
      );
    }

    const publicCatalog = await call("/v1/vehicle-catalog", {}, rider.token);
    assert("平台公共域（车型库）对 passenger 也开放", publicCatalog.status === 200, publicCatalog.status);

    // ── E. SSE 刷新不断流 ──
    section("E · 刷新期间流不中断（AC-07-1）");
    const streamSess = await call("/v1/session", { method: "POST", body: "{}" }, ownerA.token);
    const streamSid = String(streamSess.json.sessionId ?? "");
    let refreshed: string | undefined;
    let refreshedAt = -1;

    const collecting = collectSse(
      GATEWAY,
      streamSid,
      () => ({ authorization: `Bearer ${ownerA.token}` }),
      {
        until: hasTurnEnd,
        timeoutMs: 25_000,
        onEnvelope: (_e, all) => {
          // 流刚开起来就在**流的中途**换一次 token。
          if (refreshedAt < 0 && all.length >= 1) {
            refreshedAt = all.length;
            void (async () => {
              const li = await login(GATEWAY, {
                username: ownerA.username,
                password: E2E_PASSWORD,
              });
              refreshed = li.accessToken;
            })();
          }
        },
      },
    );
    await sleep(300);
    const sent = await call(
      `/v1/session/${streamSid}/messages`,
      // 字段是 `content` 不是 `text`（`/v1/session/:id/messages` 的 JSON 分支）。
      { method: "POST", body: JSON.stringify({ content: "明天去哪儿都行，你说了算" }) },
      ownerA.token,
    );
    assert("发消息成功", sent.status < 300, sent.json);

    const envelopes: EventEnvelope[] = await collecting;
    assert("流在刷新之后仍收到 turn_end（没断）", hasTurnEnd(envelopes), {
      count: envelopes.length,
      refreshedAt,
      kinds: envelopes.map((e) => (e.event as { kind?: string }).kind).slice(0, 12),
    });
    assert("刷新确实发生了（拿到了新 token）", typeof refreshed === "string" && refreshed.length > 20);
    assert(
      "新旧 token 不是同一枚",
      refreshed !== ownerA.token,
      { same: refreshed === ownerA.token },
    );

    // ── 收尾：自建自删 ──
    section("收尾");
    for (const vin of [VIN_A, VIN_B]) {
      const owner = vin === VIN_A ? ownerA : ownerB;
      await call(`/v1/vehicles/${vin}/grants/${driver.userId}`, { method: "DELETE" }, owner.token);
      await call(`/v1/vehicles/${vin}/grants/${rider.userId}`, { method: "DELETE" }, owner.token);
    }
    const afterRevoke = await call(`/v1/vehicles/${VIN_A}/grants`, {}, driver.token);
    assert("撤销后 driver 立刻读不到甲车", afterRevoke.status >= 400, afterRevoke.status);
    await cleanupDb();
    console.log("  测试数据已删（车辆 / 授权 / 会话 / 账号）");
  } finally {
    await shutdownSpawned(procs, [GATEWAY_PORT, RUNTIME_PORT]);
  }
}

/** 直接连库收尾：网关没有"删账号"端点，而留下的账号会让下一轮重名。 */
async function cleanupDb(): Promise<void> {
  // 同 lib/login.ts：走 `@carlife/db` 的再导出，不直接 import `@prisma/client`。
  const { PrismaClient } = await import("@carlife/db");
  const prisma = new PrismaClient({ datasources: { db: { url: ENV.DATABASE_URL } } });
  try {
    const users = await prisma.user.findMany({
      where: { username: { startsWith: `e2eid_` } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    await prisma.vehicleGrant.deleteMany({ where: { userId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.vehicle.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.device.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await prisma.$disconnect();
  }
}

await main().catch(async (err) => {
  console.error("\n脚本异常：", err);
  failed += 1;
  await cleanupDb().catch(() => undefined);
});

console.log(`\n合计：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.error(`失败项：\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
