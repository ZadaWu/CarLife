/**
 * M3 后台端到端验收脚本（测试框架就位前的脚本化用例，沿用 M2 既定形态）。
 *
 * 运行（根目录）：`corepack pnpm e2e:m3`
 * 前置：PG 容器已启动、migration 已应用。全程 Fake LLM / Fake ASR（确定性断言）。
 *
 * 覆盖随工单增长；当前包含：
 *  M3-01 身份与角色、越权 403 落审计、审计追加式、两条鉴权路径互不影响
 *  M3-02 配置读写、掩码、来源标注、热生效（不重启改模型行为）
 *  M3-04 会话检索、默认脱敏、提权 reveal 与二次审计、admin/ops 双角色
 *  M3-05 ①Working 只读查询、会话隔离、六类分区元信息
 *  M68   用户体系后台：建号 → 登录注册设备 → 车主授权 → 绑车机 → 六条只读接口 → ops 写被拒
 *        → admin 撤设备 / 解绑车机 / 撤授权 → 被撤设备 refresh 401、被撤成员读车 404 → 审计齐全（含 reason）
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { assertPortsFree, shutdownSpawned } from "./lib/ports";
import { ensureDevCredentials, login } from "./lib/login";
import { PrismaClient, resolveTestDatabaseUrl } from "@carlife/db";
import type { EventEnvelope } from "@carlife/shared";

const GATEWAY = "http://localhost:18787";
const ADMIN = "e2e-admin-token";
const OPS = "e2e-ops-token";
// M48-02：demo-token 万能钥匙已删除，改为跑前登录换 token（见 lib/login.ts）。
let DEMO = "";
const SECRET_CONFIG_KEY = "DEEPSEEK_API_KEY";
const DATABASE_URL = resolveTestDatabaseUrl();

const ENV = {
  ...process.env,
  CARLIFE_LLM: "fake",
  ASR_ENGINE: "fake",
  CARLIFE_ASR_FAKE_TEXT: "我的手机号是 13800001111",
  DATABASE_URL,
  GATEWAY_PORT: "18787",
  AGENT_RUNTIME_PORT: "18788",
  AGENT_RUNTIME_URL: "http://localhost:18788",
  CARLIFE_ADMIN_TOKEN: ADMIN,
  CARLIFE_OPS_TOKEN: OPS,
  CARLIFE_CONFIG_MASTER_KEY: "e2e-master-key-0123456789abcdef",
  // M48-02：JWT 签名密钥没有默认值（默认密钥等于没有鉴权），端到端也必须显式给。
  CARLIFE_JWT_SECRET: "e2e-jwt-secret-0123456789abcdef",
  // 短 TTL：热生效的机制是 TTL 缓存失效，默认 30s 不适合 e2e 节奏
  CARLIFE_CONFIG_TTL_MS: "200",
};

/** 仓库根（gateway/scripts → gateway → backend → enterprise → 根）：M67 评测台段落清理任务目录用。 */
const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.error(`✗ ${name}`, detail ?? "");
  }
}

const as = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    authorization: `Bearer ${token}`,
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(init.headers ?? {}),
  },
});

async function captureConfigSnapshot(prisma: PrismaClient) {
  return {
    item: await prisma.configItem.findUnique({
      where: { key: SECRET_CONFIG_KEY },
    }),
    revisions: await prisma.configItemRevision.findMany({
      where: { key: SECRET_CONFIG_KEY },
    }),
  };
}

type ConfigSnapshot = Awaited<ReturnType<typeof captureConfigSnapshot>>;

/**
 * e2e 会验证密钥历史，但不应把测试密文留在共享开发库。
 *
 * 只删除本次快照之后新增的 revision；原有配置则恢复原密文，不读取也不打印
 * 明文。这样测试可以使用自己的主密钥，同时不会改变开发者的配置状态。
 */
async function restoreConfigSnapshot(
  prisma: PrismaClient,
  snapshot: ConfigSnapshot,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const baselineRevisionIds = new Set(
      snapshot.revisions.map((row) => row.id),
    );
    const currentRevisions = await tx.configItemRevision.findMany({
      where: { key: SECRET_CONFIG_KEY },
      select: { id: true },
    });
    const addedRevisionIds = currentRevisions
      .map((row) => row.id)
      .filter((id) => !baselineRevisionIds.has(id));
    if (addedRevisionIds.length > 0) {
      await tx.configItemRevision.deleteMany({
        where: { id: { in: addedRevisionIds } },
      });
    }

    if (snapshot.item) {
      const data = {
        value: snapshot.item.value,
        isSecret: snapshot.item.isSecret,
        updatedBy: snapshot.item.updatedBy,
        verifiedAt: snapshot.item.verifiedAt,
      };
      await tx.configItem.upsert({
        where: { key: SECRET_CONFIG_KEY },
        create: { key: SECRET_CONFIG_KEY, ...data },
        update: data,
      });
    } else {
      await tx.configItem.deleteMany({ where: { key: SECRET_CONFIG_KEY } });
    }
  });
}

async function waitHealthy(url: string, label: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(url).catch(() => null);
    if (res) return;
    await sleep(500);
  }
  throw new Error(`${label} 未在 30s 内就绪`);
}

async function collectSse(
  sessionId: string,
  until: (all: EventEnvelope[]) => boolean,
  timeoutMs = 15_000,
): Promise<EventEnvelope[]> {
  const controller = new AbortController();
  const res = await fetch(
    `${GATEWAY}/v1/session/${sessionId}/stream`,
    as(DEMO, { signal: controller.signal }),
  );
  if (!res.ok || !res.body) throw new Error(`stream status=${res.status}`);

  const envelopes: EventEnvelope[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) envelopes.push(JSON.parse(line.slice(6)) as EventEnvelope);
      }
      if (until(envelopes) || Date.now() > deadline) {
        controller.abort();
        break;
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  }
  return envelopes;
}

const hasTurnEnd = (all: EventEnvelope[]): boolean =>
  all.some((e) => e.event.type === "update" && e.event.kind === "turn_end");
const deltaText = (all: EventEnvelope[]): string =>
  all
    .filter((e) => e.event.type === "update" && e.event.kind === "delta")
    .map((e) => (e.event as { text: string }).text)
    .join("");

/**
 * 跑一轮对话（文本），返回**本轮**的回复文本。
 *
 * SSE 重连会重放会话内已缓冲的事件，所以不能简单地"看到一个 turn_end 就停"——
 * 那样第 N 轮会拿到第 1 轮的内容。这里按会话记轮次，等到第 N 个 turn_end，
 * 再取第 N-1 个 turn_end 之后的 delta。
 */
const turnCounters = new Map<string, number>();
const isTurnEnd = (e: EventEnvelope): boolean =>
  e.event.type === "update" && e.event.kind === "turn_end";

async function runTurn(sessionId: string, content: string): Promise<string> {
  const n = (turnCounters.get(sessionId) ?? 0) + 1;
  turnCounters.set(sessionId, n);

  const sse = collectSse(sessionId, (all) => all.filter(isTurnEnd).length >= n);
  await fetch(
    `${GATEWAY}/v1/session/${sessionId}/messages`,
    as(DEMO, { method: "POST", body: JSON.stringify({ content }) }),
  );
  const all = await sse;

  let seen = 0;
  let start = 0;
  all.forEach((e, i) => {
    if (isTurnEnd(e)) {
      seen += 1;
      if (seen === n - 1) start = i + 1;
    }
  });
  await sleep(200); // 助手消息在轮次结束时落库，给写入一点余量
  return deltaText(all.slice(start));
}

interface AuditPage {
  entries: Array<{
    id: string;
    at: string;
    actor: string;
    actorRole: string;
    action: string;
    result: string;
    target: string | null;
    detail: Record<string, unknown> | null;
  }>;
}

async function auditSince(
  sinceIso: string,
  action?: string,
): Promise<AuditPage["entries"]> {
  const url = new URL(`${GATEWAY}/console/audit`);
  url.searchParams.set("limit", "200");
  url.searchParams.set("since", sinceIso);
  if (action) url.searchParams.set("action", action);
  const res = await fetch(url, as(ADMIN));
  const page = (await res.json()) as AuditPage;
  return page.entries;
}

async function main(): Promise<void> {
  // spawn 之前先探端口（M46-01）：不检查的话，端口被占时本轮进程起不来，
  // 请求却会落到上一轮残留的进程上，报出看起来像业务故障的假错误。
  await assertPortsFree([
    [Number(ENV.GATEWAY_PORT), "gateway"],
    [Number(ENV.AGENT_RUNTIME_PORT), "agent-runtime"],
  ]);

  const prisma = new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
  });
  const procs: ChildProcess[] = [];
  let configSnapshot: ConfigSnapshot | undefined;
  let secretTouched = false;
  const startedAt = new Date().toISOString();
  const spawnSvc = (cwd: string): void => {
    procs.push(
      spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: new URL(cwd, import.meta.url).pathname,
        env: ENV,
        stdio: ["ignore", "inherit", "inherit"],
        detached: true, // 杀得掉整组（M46-02）：npx 壳→tsx→node 三层，kill 只打到壳
      }),
    );
  };
  spawnSvc("../../agent-runtime/");
  spawnSvc("../");

  try {
    configSnapshot = await captureConfigSnapshot(prisma);
    await waitHealthy(`${GATEWAY}/healthz`, "gateway");

    // M48-02：先把测试库的开发账号解锁，再登录换 token（demo-token 已删除）。
    await ensureDevCredentials(ENV.DATABASE_URL);
    DEMO = (await login(GATEWAY)).accessToken;
    await sleep(1500);

    // ══════════ M3-01 骨架、角色鉴权与审计 ══════════

    const whoAdmin = await fetch(
      `${GATEWAY}/console/session`,
      as(ADMIN, { method: "POST" }),
    );
    const adminIdentity = (await whoAdmin.json()) as {
      subject: string;
      role: string;
    };
    assert(
      "M3-01 admin token → role=admin",
      adminIdentity.role === "admin",
      adminIdentity,
    );

    const whoOps = await fetch(
      `${GATEWAY}/console/session`,
      as(OPS, { method: "POST" }),
    );
    const opsIdentity = (await whoOps.json()) as { role: string };
    assert(
      "M3-01 ops token → role=ops",
      opsIdentity.role === "ops",
      opsIdentity,
    );

    const whoBad = await fetch(
      `${GATEWAY}/console/session`,
      as("nope", { method: "POST" }),
    );
    assert("M3-01 错误 token → 401", whoBad.status === 401, whoBad.status);

    // 端上 demo token 不是后台身份（两条路径互不影响）
    const whoDemo = await fetch(
      `${GATEWAY}/console/session`,
      as(DEMO, { method: "POST" }),
    );
    assert(
      "M3-01 端上 demo token 不能登录后台 → 401",
      whoDemo.status === 401,
      whoDemo.status,
    );

    // 越权：ops 打 admin 独有的配置写接口
    const denied = await fetch(
      `${GATEWAY}/console/config`,
      as(OPS, { method: "POST", body: JSON.stringify({ items: [] }) }),
    );
    assert("M3-01 ops 越权写配置 → 403", denied.status === 403, denied.status);

    await sleep(400); // 审计异步写入余量
    const deniedAudit = (await auditSince(startedAt)).filter(
      (e) => e.result === "denied" && e.actorRole === "ops",
    );
    assert(
      "M3-01 越权尝试落审计（result=denied）",
      deniedAudit.length >= 1,
      deniedAudit,
    );

    // 审计接口无删除路径
    const del = await fetch(
      `${GATEWAY}/console/audit`,
      as(ADMIN, { method: "DELETE" }),
    );
    assert(
      "M3-01 审计无删除接口（404/405）",
      del.status === 404 || del.status === 405,
      del.status,
    );

    // ══════════ M3-02 配置内核 ══════════

    const cfgAsOps = await fetch(`${GATEWAY}/console/config`, as(OPS));
    assert(
      "M3-02 ops 读配置 → 403（接入面对运营不可见）",
      cfgAsOps.status === 403,
      cfgAsOps.status,
    );

    const cfgRes = await fetch(`${GATEWAY}/console/config`, as(ADMIN));
    const cfg = (await cfgRes.json()) as {
      items: Array<{
        key: string;
        scope: string;
        isSecret: boolean;
        value: string | null;
        source: string;
        verifiedAt: string | null;
      }>;
    };
    assert(
      "M3-02 admin 可读配置清单",
      cfgRes.ok && cfg.items.length > 0,
      cfgRes.status,
    );

    const secretItems = cfg.items.filter((i) => i.isSecret);
    assert("M3-02 注册表含密钥类项", secretItems.length > 0);

    // 写一个密钥，读回必须是掩码
    const setRes = await fetch(
      `${GATEWAY}/console/config`,
      as(ADMIN, {
        method: "POST",
        body: JSON.stringify({
          items: [{ key: "DEEPSEEK_API_KEY", value: "sk-e2e-secret-abcd" }],
        }),
      }),
    );
    assert("M3-02 写入密钥成功", setRes.ok, setRes.status);
    secretTouched = setRes.ok;

    // 变更历史记录的是“已有配置项被再次变更”，首次创建没有 prev row。
    // 在这里显式写第二次，保证 e2e 在空库和已有库两种状态下都能验证历史。
    const setResAgain = await fetch(
      `${GATEWAY}/console/config`,
      as(ADMIN, {
        method: "POST",
        body: JSON.stringify({
          items: [{ key: "DEEPSEEK_API_KEY", value: "sk-e2e-secret-efgh" }],
        }),
      }),
    );
    assert(
      "M3-06 再次写入密钥形成 revision",
      setResAgain.ok,
      setResAgain.status,
    );

    const cfg2 = (await (
      await fetch(`${GATEWAY}/console/config`, as(ADMIN))
    ).json()) as {
      items: Array<{ key: string; value: string | null; source: string }>;
    };
    const dsKey = cfg2.items.find((i) => i.key === "DEEPSEEK_API_KEY");
    assert(
      "M3-02 密钥读回为掩码（不含明文）",
      dsKey?.value !== null &&
        dsKey?.value !== "sk-e2e-secret-abcd" &&
        (dsKey?.value ?? "").includes("***"),
      dsKey,
    );
    assert("M3-02 来源标注为 db", dsKey?.source === "db", dsKey?.source);

    const raw = JSON.stringify(cfg2);
    assert(
      "M3-02 配置响应全文不含密钥明文",
      !raw.includes("sk-e2e-secret-abcd"),
    );

    const cfgAudit = (await auditSince(startedAt, "config.update")).filter(
      (e) => e.result === "ok",
    );
    assert("M3-02 配置写入落审计", cfgAudit.length >= 1, cfgAudit.length);
    assert(
      "M3-02 审计中不含密钥值（A 类只记项名）",
      !JSON.stringify(cfgAudit).includes("sk-e2e-secret-abcd"),
    );

    // 热生效：改 Fake 回复前缀，不重启服务。
    // **写两次**：配置项会跨 e2e 运行留在库里，只比较"改之后有没有"会被上一轮的
    // 残留值蒙混过关（第一次跑这段时就是这么骗过去的）。所以先落一个基线值、
    // 验证它生效，再换成本次运行唯一的值、验证它也生效——两次都不重启。
    const baselineTag = "baseline";
    const uniqueTag = `hot-${Date.now().toString(36)}`;

    const writeTag = async (value: string): Promise<void> => {
      const res = await fetch(
        `${GATEWAY}/console/config`,
        as(ADMIN, {
          method: "POST",
          body: JSON.stringify({
            items: [{ key: "CARLIFE_LLM_FAKE_TAG", value }],
          }),
        }),
      );
      const result = (await res.json()) as {
        accepted: string[];
        rejected: Array<{ key: string; reason: string }>;
      };
      if (!result.accepted.includes("CARLIFE_LLM_FAKE_TAG")) {
        throw new Error(`配置写入被拒：${JSON.stringify(result.rejected)}`);
      }
      await sleep(600); // 等过配置 TTL —— 热生效的机制是缓存失效，不是即时推送
    };

    const replyOnFreshSession = async (): Promise<string> => {
      const created = (await (
        await fetch(`${GATEWAY}/v1/session`, as(DEMO, { method: "POST" }))
      ).json()) as { sessionId: string };
      return runTurn(created.sessionId, "你好");
    };

    await writeTag(baselineTag);
    const beforeReply = await replyOnFreshSession();
    assert(
      "M3-02 接入面项可写入并生效（基线）",
      beforeReply.includes(baselineTag),
      beforeReply,
    );

    await writeTag(uniqueTag);
    const afterReply = await replyOnFreshSession();
    assert(
      "M3-02 热生效：不重启服务，改配置后下一轮对话使用新值",
      afterReply.includes(uniqueTag) && !afterReply.includes(baselineTag),
      { beforeReply, afterReply },
    );

    // ══════════ M3-06 版本化回滚 / 用量埋点 ══════════

    // B 类可回滚：把 tag 回滚到基线值
    const rbRes = await fetch(
      `${GATEWAY}/console/config/CARLIFE_LLM_FAKE_TAG/rollback`,
      as(ADMIN, { method: "POST" }),
    );
    const rb = (await rbRes.json()) as {
      ok: boolean;
      restoredValue?: string;
      reason?: string;
    };
    assert(
      "M3-06 B 类配置可回滚到上一版本",
      rbRes.ok && rb.ok && rb.restoredValue === baselineTag,
      rb,
    );

    // A 类不可回滚：旧值从未保存，只能重填——这是设计不是缺陷
    const rbSecret = await fetch(
      `${GATEWAY}/console/config/DEEPSEEK_API_KEY/rollback`,
      as(ADMIN, { method: "POST" }),
    );
    const rbSecretBody = (await rbSecret.json()) as {
      ok: boolean;
      reason?: string;
    };
    assert(
      "M3-06 A 类（密钥）拒绝回滚且说明原因",
      rbSecret.status === 409 &&
        !rbSecretBody.ok &&
        (rbSecretBody.reason ?? "").includes("重新填写"),
      rbSecretBody,
    );

    const revRes = await fetch(
      `${GATEWAY}/console/config/DEEPSEEK_API_KEY/revisions`,
      as(ADMIN),
    );
    const revs = (await revRes.json()) as {
      revisions: Array<{ isSecret: boolean; restorable: boolean }>;
    };
    assert(
      "M3-06 密钥变更历史只记事实、不可还原",
      revs.revisions.length > 0 &&
        revs.revisions.every((r) => r.isSecret && !r.restorable),
      revs.revisions.slice(0, 2),
    );
    assert(
      "M3-06 变更历史响应不含密钥明文",
      !JSON.stringify(revs).includes("sk-e2e-secret-abcd"),
    );

    // 用量埋点：前面已跑过多轮对话，应有记录且带 agent/session 维度
    await sleep(500);
    const usageRes = await fetch(
      `${GATEWAY}/console/usage?dimension=agent`,
      as(OPS),
    );
    const usage = (await usageRes.json()) as {
      buckets: Array<{ key: string; calls: number }>;
      total: { calls: number };
    };
    assert(
      "M3-06 用量按 Agent 维度可拆解（埋点贯穿 session/turn/agent）",
      usageRes.ok &&
        usage.total.calls > 0 &&
        usage.buckets.some((b) => b.key === "supervisor"),
      usage.buckets,
    );

    // ══════════ M3-04 会话与对话浏览 ══════════

    const created = (await (
      await fetch(`${GATEWAY}/v1/session`, as(DEMO, { method: "POST" }))
    ).json()) as { sessionId: string };
    const sid = created.sessionId;
    await runTurn(sid, "我的手机号是 13800001111，帮我记一下");
    await runTurn(sid, "那我出发前要注意什么？");

    const listRes = await fetch(
      `${GATEWAY}/console/sessions?limit=20`,
      as(OPS),
    );
    const list = (await listRes.json()) as {
      sessions: Array<{
        sessionId: string;
        messageCount: number;
        turnCount: number;
      }>;
    };
    assert(
      "M3-04 ops 可检索会话列表且含刚才的会话",
      listRes.ok && list.sessions.some((s) => s.sessionId === sid),
      listRes.status,
    );

    const listAsAdmin = await fetch(
      `${GATEWAY}/console/sessions?limit=5`,
      as(ADMIN),
    );
    assert(
      "M3-04 admin 同样可检索会话（角色矩阵已定案）",
      listAsAdmin.ok,
      listAsAdmin.status,
    );

    const msgsRes = await fetch(
      `${GATEWAY}/console/sessions/${sid}/messages`,
      as(OPS),
    );
    const msgs = (await msgsRes.json()) as {
      messages: Array<{
        messageId: string;
        content: string;
        redacted: boolean;
        source: string;
      }>;
    };
    assert(
      "M3-04 会话详情返回 4 条（两轮）",
      msgs.messages.length === 4,
      msgs.messages.length,
    );
    const withPhone = msgs.messages.find((m) => m.redacted);
    assert(
      "M3-04 默认脱敏：手机号不出现在响应中",
      !JSON.stringify(msgs).includes("13800001111") && withPhone !== undefined,
      msgs.messages.map((m) => m.content),
    );

    // 详情页元信息：按 sessionId 精确定位（URL 直达详情页时的数据源）
    const oneRes = await fetch(
      `${GATEWAY}/console/sessions?limit=1&sessionId=${encodeURIComponent(sid)}`,
      as(OPS),
    );
    const one = (await oneRes.json()) as {
      sessions: Array<{
        sessionId: string;
        turnCount: number;
        messageCount: number;
        firstMessageAt: number | null;
      }>;
    };
    assert(
      "M3-04 按 sessionId 精确定位返回该会话的概况",
      one.sessions.length === 1 &&
        one.sessions[0].sessionId === sid &&
        one.sessions[0].turnCount === 2 &&
        one.sessions[0].messageCount === 4 &&
        one.sessions[0].firstMessageAt !== null,
      one.sessions,
    );

    assert(
      "M3-04 脱敏命中类型可见（供界面标注「已脱敏：手机号」）",
      msgs.messages.some((m) =>
        (m as { redactedKinds?: string[] }).redactedKinds?.includes("phone_cn"),
      ),
      msgs.messages,
    );

    const revealRes = await fetch(
      `${GATEWAY}/console/sessions/${sid}/reveal`,
      as(OPS, { method: "POST", body: JSON.stringify({}) }),
    );
    const revealed = (await revealRes.json()) as {
      messages: Array<{ content: string }>;
    };
    assert(
      "M3-04 提权后可见原文",
      revealRes.ok && JSON.stringify(revealed).includes("13800001111"),
      revealRes.status,
    );

    await fetch(
      `${GATEWAY}/console/sessions/${sid}/reveal`,
      as(ADMIN, { method: "POST", body: JSON.stringify({}) }),
    );
    await sleep(400);
    const reveals = await auditSince(startedAt, "message.reveal");
    const roles = new Set(reveals.map((e) => e.actorRole));
    assert(
      "M3-04 两种角色的提权都落审计且 actorRole 可区分",
      roles.has("ops") && roles.has("admin"),
      [...roles],
    );
    assert(
      "M3-04 审计中不含被查看的原文",
      !JSON.stringify(reveals).includes("13800001111"),
    );

    // ══════════ M3-05 记忆浏览 ══════════

    const memRes = await fetch(
      `${GATEWAY}/console/memory/working/${sid}`,
      as(OPS),
    );
    const mem = (await memRes.json()) as {
      status: string;
      turnCount: number;
      messages: Array<{ role: string; content: string }>;
    };
    assert(
      "M3-05 ①Working 查询返回 active",
      memRes.ok && mem.status === "active",
      mem.status,
    );
    assert("M3-05 ①Working 含两轮上下文", mem.turnCount === 2, mem.turnCount);
    assert(
      "M3-05 ①Working 默认脱敏",
      !JSON.stringify(mem).includes("13800001111"),
      mem.messages?.map((m) => m.content),
    );

    const freshSession = (await (
      await fetch(`${GATEWAY}/v1/session`, as(DEMO, { method: "POST" }))
    ).json()) as { sessionId: string };
    const memFresh = (await (
      await fetch(
        `${GATEWAY}/console/memory/working/${freshSession.sessionId}`,
        as(OPS),
      )
    ).json()) as { status: string };
    assert(
      "M3-05 新会话 ①Working 为 empty（不污染新会话）",
      memFresh.status === "empty",
      memFresh.status,
    );

    const taxRes = await fetch(`${GATEWAY}/console/memory/taxonomy`, as(OPS));
    const tax = (await taxRes.json()) as {
      categories: Array<{ id: number; owner: string; [key: string]: unknown }>;
    };
    assert(
      "M3-05 六类分区元信息完整",
      taxRes.ok && tax.categories.length === 6,
      tax.categories.length,
    );
    assert(
      "M3-05 taxonomy 只返回稳定元数据，不复制接线状态",
      tax.categories.every((c) => !("connected" in c) && c.owner.length > 0),
      tax.categories,
    );

    const overviewRes = await fetch(
      `${GATEWAY}/console/memory/overview`,
      as(OPS),
    );
    const overview = (await overviewRes.json()) as {
      runtimeReachable: boolean;
      wiring: Array<{ id: number; read: boolean; write: boolean }>;
    };
    assert(
      "M3-05 接线状态来自 runtime overview",
      overviewRes.ok &&
        overview.runtimeReachable &&
        overview.wiring.length === 6 &&
        overview.wiring.every(
          (item) =>
            typeof item.read === "boolean" && typeof item.write === "boolean",
        ),
      overview,
    );

    // ══════════ 只读性：查询不干扰在线链路 ══════════
    const replyAfterProbe = await runTurn(sid, "再说一次刚才的话题");
    assert(
      "M3-05 只读查询后对话仍正常（图状态未被破坏）",
      replyAfterProbe.includes("第3轮"),
      replyAfterProbe,
    );

    // ══════════ M68 用户体系后台：读写全流程（M68-05）══════════
    // 放在 M67 段之前：它不起 runner、不等 LLM，十几秒跑完，先跑先挂。
    // 临时数据全带 e2e-m68- / LSJE2EM68 前缀，开头与 finally 各清一次（幂等）；
    // 删除顺序 grants → devices → sessions → vehicles → users（Vehicle.ownerId onDelete: Restrict）。
    {
      const t0 = Date.now();
      const M68_USER = "e2e-m68-driver";
      const M68_PASS = "e2e-m68-pass-2026";
      const M68_VIN = "LSJE2EM6800000001"; // 17 位，不含 I/O/Q
      const PHONE = "e2e-m68-phone";
      const PAD = "e2e-m68-pad";
      const COCKPIT = "e2e-m68-cockpit";
      const cleanupM68 = async (): Promise<void> => {
        const users = await prisma.user.findMany({ where: { username: { startsWith: "e2e-m68-" } }, select: { id: true } });
        const ids = users.map((u) => u.id);
        await prisma.vehicleGrant.deleteMany({ where: { OR: [{ vin: { startsWith: "LSJE2EM68" } }, { userId: { in: ids } }] } });
        await prisma.device.deleteMany({
          where: { OR: [{ id: { startsWith: "e2e-m68-" } }, { userId: { in: ids } }, { vehicleVin: { startsWith: "LSJE2EM68" } }] },
        });
        await prisma.session.deleteMany({ where: { userId: { in: ids } } });
        await prisma.vehicle.deleteMany({ where: { vin: { startsWith: "LSJE2EM68" } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      };
      await cleanupM68();
      try {
        const beforeM68 = new Date().toISOString();
        const jsonPost = (token: string, body: unknown): RequestInit => as(token, { method: "POST", body: JSON.stringify(body) });

        // 1. 建号：ops 403、admin 201（M48-02 的端点，本 Sprint 第一次有界面调它）
        const denied = await fetch(`${GATEWAY}/console/users`, jsonPost(OPS, { username: M68_USER, password: M68_PASS }));
        assert("M68 ops 建号 → 403", denied.status === 403, denied.status);
        const createdRes = await fetch(
          `${GATEWAY}/console/users`,
          jsonPost(ADMIN, { username: M68_USER, password: M68_PASS, displayName: "M68 e2e 驾驶人" }),
        );
        const createdUser = (await createdRes.json()) as { id?: string };
        assert("M68 admin 建号 → 201", createdRes.status === 201 && Boolean(createdUser.id), createdUser);
        const uid = createdUser.id ?? "";

        // 2. 该用户注册两台私人设备，再各自以设备身份登录。
        //    顺序不能反：token 里签了 deviceId 的话，jwtAuth 会去查这台设备（`resolveIdentity`），
        //    还没注册就是 401——所以先用不带 deviceId 的登录态注册，再带 deviceId 登录拿设备绑定的 refresh。
        const plainLogin = await login(GATEWAY, { username: M68_USER, password: M68_PASS });
        const register = async (id: string, deviceType: string): Promise<number> =>
          (await fetch(`${GATEWAY}/v1/devices/register`, jsonPost(plainLogin.accessToken, { deviceId: id, deviceType, modelName: `e2e ${deviceType}` }))).status;
        const regPhone = await register(PHONE, "mobile");
        const regPad = await register(PAD, "pad");
        assert("M68 注册两台私人设备 → 200", regPhone === 200 && regPad === 200, [regPhone, regPad]);
        const phoneLogin = await login(GATEWAY, { username: M68_USER, password: M68_PASS, deviceId: PHONE });
        const padLogin = await login(GATEWAY, { username: M68_USER, password: M68_PASS, deviceId: PAD });

        // 3. 车主（demo）建车并授权 driver
        const vehRes = await fetch(
          `${GATEWAY}/v1/vehicles`,
          jsonPost(DEMO, { vin: M68_VIN, model: "M68 e2e 车型", modelYear: 2025, purchasedAt: Date.UTC(2025, 0, 1), odometerKm: 100 }),
        );
        assert("M68 车主建车", vehRes.ok, vehRes.status);
        const grantRes = await fetch(`${GATEWAY}/v1/vehicles/${M68_VIN}/grants`, jsonPost(DEMO, { username: M68_USER, role: "driver" }));
        assert("M68 车主授权 driver → 201", grantRes.status === 201, grantRes.status);
        const driverReadBefore = await fetch(`${GATEWAY}/v1/vehicles/${M68_VIN}/grants`, as(padLogin.accessToken));
        assert("M68 授权后 driver 读车 → 200（撤销断言的对照）", driverReadBefore.status === 200, driverReadBefore.status);

        // 4. 绑一台车机：扫码（bind-request）→ 配对码 → 车机确认（bind-confirm，无鉴权）→ 车辆级 refresh
        const bindReq = await fetch(`${GATEWAY}/v1/devices/bind-request`, jsonPost(DEMO, { deviceId: COCKPIT, vin: M68_VIN }));
        const bindReqBody = (await bindReq.json()) as { code?: string; vinSuffix?: string };
        assert(
          "M68 bind-request 发配对码且回尾号",
          bindReq.ok && Boolean(bindReqBody.code) && bindReqBody.vinSuffix === M68_VIN.slice(-4),
          { status: bindReq.status, ...bindReqBody },
        );
        const confirmRes = await fetch(`${GATEWAY}/v1/devices/bind-confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId: COCKPIT, code: bindReqBody.code, modelName: "e2e 车机" }),
        });
        const cockpitTokens = (await confirmRes.json()) as { refreshToken?: string; vin?: string };
        assert(
          "M68 bind-confirm 发车辆级 refresh",
          confirmRes.ok && Boolean(cockpitTokens.refreshToken) && cockpitTokens.vin === M68_VIN,
          confirmRes.status,
        );

        // 5. 六条只读接口（ops 视角）
        const ov = (await (await fetch(`${GATEWAY}/console/identity/overview`, as(OPS))).json()) as Record<string, unknown>;
        const grantsCount = ov.activeGrants as { driver?: unknown } | undefined;
        const devCount = ov.devices as { cockpit?: unknown } | undefined;
        assert(
          "M68 overview 六计数为数",
          ["users", "vehicles", "revokedDevices", "vehiclesWithCockpit"].every((k) => typeof ov[k] === "number") &&
            typeof grantsCount?.driver === "number" &&
            typeof devCount?.cockpit === "number",
          ov,
        );
        const ulist = (await (await fetch(`${GATEWAY}/console/identity/users?q=e2e-m68`, as(OPS))).json()) as {
          rows: Array<{ id: string; activeDevices: number; activeGrants: number }>;
        };
        assert(
          "M68 users?q 命中 1 行：2 私人设备、1 授权",
          ulist.rows.length === 1 && ulist.rows[0]?.id === uid && ulist.rows[0]?.activeDevices === 2 && ulist.rows[0]?.activeGrants === 1,
          ulist.rows,
        );
        const detailRes = await fetch(`${GATEWAY}/console/identity/users/${uid}`, as(OPS));
        const detailText = await detailRes.text();
        const detail = JSON.parse(detailText) as {
          grants: Array<{ vin: string; role: string }>;
          devices: unknown[];
          ownedVehicles: unknown[];
          recentSessions: unknown[];
        };
        assert(
          "M68 users/:id 四块与造的数据一致，且 JSON 无 passwordHash",
          detailRes.ok &&
            detail.grants.length === 1 &&
            detail.grants[0]?.vin === M68_VIN &&
            detail.devices.length === 2 &&
            detail.ownedVehicles.length === 0 &&
            Array.isArray(detail.recentSessions) &&
            !detailText.includes("passwordHash"),
          { grants: detail.grants, devices: detail.devices.length },
        );
        const vlist = (await (await fetch(`${GATEWAY}/console/identity/vehicles?q=LSJE2EM68`, as(OPS))).json()) as {
          rows: Array<{ vin: string; cockpits: number; activeGrants: number }>;
        };
        assert(
          "M68 vehicles?q 命中且 cockpits=1、activeGrants=1",
          vlist.rows.length === 1 && vlist.rows[0]?.cockpits === 1 && vlist.rows[0]?.activeGrants === 1,
          vlist.rows,
        );
        const vdetail = (await (await fetch(`${GATEWAY}/console/identity/vehicles/${M68_VIN}`, as(OPS))).json()) as {
          grants: Array<{ userId: string; role: string }>;
          cockpits: Array<{ id: string }>;
          shadowMemberCount: number;
        };
        assert(
          "M68 vehicles/:vin 授权 1 条 driver、车机 1 台、影子档案 0",
          vdetail.grants.length === 1 && vdetail.grants[0]?.role === "driver" && vdetail.cockpits.length === 1 && vdetail.cockpits[0]?.id === COCKPIT && vdetail.shadowMemberCount === 0,
          vdetail,
        );
        const countOf = async (qs: string): Promise<number> =>
          ((await (await fetch(`${GATEWAY}/console/identity/devices?${qs}`, as(OPS))).json()) as { rows: unknown[] }).rows.length;
        const nByUser = await countOf(`userId=${uid}`);
        const nByVin = await countOf(`vin=${M68_VIN}`);
        const nCockpit = await countOf(`type=cockpit&vin=${M68_VIN}`);
        assert("M68 devices 按 userId 2 / vin 1 / type+vin 1", nByUser === 2 && nByVin === 1 && nCockpit === 1, [nByUser, nByVin, nCockpit]);

        // 6. 写：ops 两条都 403；admin 撤手机 → 该设备 refresh 401、另一台 200；解绑车机 → 车辆级 refresh 401；撤授权 → driver 读车 404；撤车主 → 409
        const revokeDevUrl = (id: string): string => `${GATEWAY}/console/identity/devices/${id}/revoke`;
        const revokeGrantUrl = (userId: string): string => `${GATEWAY}/console/identity/vehicles/${M68_VIN}/grants/${userId}/revoke`;
        const opsDev = await fetch(revokeDevUrl(PHONE), jsonPost(OPS, {}));
        const opsGrant = await fetch(revokeGrantUrl(uid), jsonPost(OPS, {}));
        assert("M68 ops 两条写 → 403", opsDev.status === 403 && opsGrant.status === 403, [opsDev.status, opsGrant.status]);

        const rev1 = await fetch(revokeDevUrl(PHONE), jsonPost(ADMIN, { reason: "e2e 丢失" }));
        const rev1Body = (await rev1.json()) as { kind?: string; alreadyRevoked?: boolean };
        assert("M68 admin 撤销手机 → 200 personal", rev1.status === 200 && rev1Body.kind === "personal" && rev1Body.alreadyRevoked === false, rev1Body);
        const rev1Again = (await (await fetch(revokeDevUrl(PHONE), jsonPost(ADMIN, {}))).json()) as { alreadyRevoked?: boolean };
        assert("M68 再撤一次 → 200 alreadyRevoked", rev1Again.alreadyRevoked === true, rev1Again);
        const refresh = async (refreshToken: string | undefined): Promise<number> =>
          (
            await fetch(`${GATEWAY}/v1/auth/refresh`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ refreshToken }),
            })
          ).status;
        const phoneRefresh = await refresh(phoneLogin.refreshToken);
        const padRefresh = await refresh(padLogin.refreshToken);
        assert("M68 [F-07-11] 被撤设备 refresh → 401，同账号另一台 → 200（撤的是设备不是账号）", phoneRefresh === 401 && padRefresh === 200, [phoneRefresh, padRefresh]);

        const rev2Body = (await (await fetch(revokeDevUrl(COCKPIT), jsonPost(ADMIN, { reason: "e2e 解绑" }))).json()) as { kind?: string; vehicleVin?: string };
        assert("M68 admin 解绑车机 → kind cockpit 带 vin", rev2Body.kind === "cockpit" && rev2Body.vehicleVin === M68_VIN, rev2Body);
        const cockpitRefresh = await refresh(cockpitTokens.refreshToken);
        assert("M68 [F-07-11] 解绑后车辆级 refresh → 401", cockpitRefresh === 401, cockpitRefresh);

        const rev3 = await fetch(revokeGrantUrl(uid), jsonPost(ADMIN, { reason: "e2e 车主来电" }));
        const rev3Body = (await rev3.json()) as { role?: string };
        assert("M68 admin 撤授权 → 200 role=driver", rev3.status === 200 && rev3Body.role === "driver", rev3Body);
        const driverReadAfter = await fetch(`${GATEWAY}/v1/vehicles/${M68_VIN}/grants`, as(padLogin.accessToken));
        assert("M68 撤销后 driver 读车 → 404（与不存在同句，R11 下一请求生效）", driverReadAfter.status === 404, driverReadAfter.status);
        const ownerRev = await fetch(revokeGrantUrl("demo-user"), jsonPost(ADMIN, {}));
        assert("M68 撤车主 → 409 owner_cannot_be_revoked", ownerRev.status === 409, ownerRev.status);

        // 7. 审计：动作名、denied、reason
        const devAudit = await auditSince(beforeM68, "device.revoke");
        const grantAudit = await auditSince(beforeM68, "grant.revoke");
        const userAudit = await auditSince(beforeM68, "user.create");
        const results = (list: Array<{ result: string }>): string[] => list.map((e) => e.result);
        assert("M68 审计 device.revoke：≥3 ok + 1 denied", devAudit.filter((e) => e.result === "ok").length >= 3 && devAudit.some((e) => e.result === "denied"), results(devAudit));
        assert(
          "M68 审计 grant.revoke：ok + denied + error(409 也留痕)",
          grantAudit.some((e) => e.result === "ok") && grantAudit.some((e) => e.result === "denied") && grantAudit.some((e) => e.result === "error"),
          results(grantAudit),
        );
        assert("M68 审计 user.create：ok + denied", userAudit.some((e) => e.result === "ok") && userAudit.some((e) => e.result === "denied"), results(userAudit));
        assert(
          "M68 审计 detail.reason 原样入库",
          devAudit.some((e) => (e.detail as Record<string, unknown> | null)?.reason === "e2e 丢失"),
          devAudit.map((e) => e.detail),
        );
        console.log(`  M68 段耗时 ${Date.now() - t0} ms`);
      } finally {
        await cleanupM68();
      }
    }

    // ══════════ M67 评测台：fake 档 5 题全流程（零成本）══════════
    // 网关 spawn 的编排器起的是 18797/18798 的隔离栈，与本 e2e 的 18787/18788 不撞；
    // 评测会话写进网关进程的 DATABASE_URL（= 本 e2e 的测试库），所以轨迹能在这里查到。
    {
      const evalIds = ["o-01", "s-01", "b-02", "o-20", "s-41"];
      const beforeEval = new Date().toISOString();
      const denied = await fetch(
        `${GATEWAY}/console/evals/jobs`,
        as(OPS, { method: "POST", body: JSON.stringify({ tiers: ["scenario-fake"], ids: evalIds }) }),
      );
      assert("M67 ops 起评测任务 → 403", denied.status === 403, denied.status);
      const createRes = await fetch(
        `${GATEWAY}/console/evals/jobs`,
        as(ADMIN, { method: "POST", body: JSON.stringify({ tiers: ["scenario-fake"], ids: evalIds }) }),
      );
      const created = (await createRes.json()) as { id?: string; error?: string };
      assert("M67 admin 起 fake 档任务 → 201", createRes.status === 201 && Boolean(created.id), created);
      const jobId = created.id ?? "";
      const evalAudit = await auditSince(beforeEval, "evals.create");
      assert(
        "M67 起任务落审计（含 ops 被拒的那次）",
        evalAudit.length >= 2 && evalAudit.some((e) => e.result === "denied") && evalAudit.some((e) => e.result === "ok"),
        evalAudit.map((e) => [e.actor, e.result]),
      );

      // 轮询到 done（上限 150s），途中至少看到一次 done < selected（进度真在动）
      let job: { status: string; tierRuns: Record<string, { done: number; selected: number | null }> } | null = null;
      let sawPartial = false;
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline) {
        const r = await fetch(`${GATEWAY}/console/evals/jobs/${jobId}`, as(OPS));
        if (!r.ok) {
          await sleep(1_000); // 任务目录刚建、编排器还没落 job.json 的窗口
          continue;
        }
        job = (await r.json()) as typeof job;
        const run = job?.tierRuns["scenario-fake"];
        if (run && run.selected !== null && run.done < run.selected) sawPartial = true;
        if (job && !["queued", "running"].includes(job.status)) break;
        await sleep(1_500);
      }
      assert("M67 任务在 150s 内结束且状态 done", job?.status === "done", job);
      assert("M67 进度真在动（途中读到 done < selected）", sawPartial, job?.tierRuns);
      assert("M67 该档 5/5", job?.tierRuns["scenario-fake"]?.done === 5 && job?.tierRuns["scenario-fake"]?.selected === 5, job?.tierRuns);

      const casesRes = await fetch(`${GATEWAY}/console/evals/jobs/${jobId}/tiers/scenario-fake/cases`, as(OPS));
      const casesBody = (await casesRes.json()) as { cases: Array<{ id: string; sessionId?: string; reply?: string; expect: { route?: string }; status: string }> };
      assert("M67 逐题 5 条且都有 sessionId 与 reply", casesRes.ok && casesBody.cases.length === 5 && casesBody.cases.every((c) => c.sessionId && typeof c.reply === "string"), casesBody.cases?.map((c) => [c.id, c.sessionId, c.status]));
      const o20 = casesBody.cases.find((c) => c.id === "o-20");
      assert("M67 逐题带题库期望（o-20 route=ownership）", o20?.expect.route === "ownership", o20?.expect);

      const evalSid = casesBody.cases[0]?.sessionId ?? "";
      const replayRes = await fetch(`${GATEWAY}/console/replay/${encodeURIComponent(evalSid)}`, as(OPS));
      const replay = (await replayRes.json()) as { timeline: Array<{ kind: string }> };
      assert("M67 评测会话的轨迹可回放（timeline 含 route）", replayRes.ok && replay.timeline.length > 0 && replay.timeline.some((e) => e.kind === "route"), { status: replayRes.status, n: replay.timeline?.length });

      const reportRes = await fetch(`${GATEWAY}/console/evals/jobs/${jobId}/tiers/scenario-fake/report`, as(OPS));
      const reportMd = await reportRes.text();
      assert("M67 报告可取且含 M-P1", reportRes.ok && reportMd.includes("M-P1"), reportRes.status);

      // 单任务锁：起一个全量 fake 任务后立刻再起一个 → 409；取消后 cancelled 且隔离栈端口空
      const secondRes = await fetch(`${GATEWAY}/console/evals/jobs`, as(ADMIN, { method: "POST", body: JSON.stringify({ tiers: ["scenario-fake"] }) }));
      const second = (await secondRes.json()) as { id?: string };
      assert("M67 第二个任务 201（前一个已结束）", secondRes.status === 201, secondRes.status);
      await sleep(3_000);
      const thirdRes = await fetch(`${GATEWAY}/console/evals/jobs`, as(ADMIN, { method: "POST", body: JSON.stringify({ tiers: ["scenario-fake"] }) }));
      const third = (await thirdRes.json()) as { error?: string };
      assert("M67 有任务在跑时再起 → 409 job_running", thirdRes.status === 409 && third.error === "job_running", third);
      const cancelRes = await fetch(`${GATEWAY}/console/evals/jobs/${second.id}/cancel`, as(ADMIN, { method: "POST" }));
      assert("M67 取消 → 200", cancelRes.status === 200, cancelRes.status);
      let cancelled: { status: string } | null = null;
      for (let i = 0; i < 20; i += 1) {
        await sleep(1_000);
        cancelled = (await (await fetch(`${GATEWAY}/console/evals/jobs/${second.id}`, as(OPS))).json()) as { status: string };
        if (cancelled.status === "cancelled") break;
      }
      assert("M67 取消后状态 cancelled", cancelled?.status === "cancelled", cancelled);
      let evalPortFree = false;
      try {
        await fetch("http://localhost:18797/healthz", { signal: AbortSignal.timeout(800) });
      } catch {
        evalPortFree = true;
      }
      assert("M67 取消后隔离栈端口 18797 空", evalPortFree);
      // 清理：任务目录是测试产物，不留在仓库里
      const { rmSync } = await import("node:fs");
      for (const id of [jobId, second.id ?? ""]) if (id) rmSync(`${REPO_ROOT}/evals/runs/jobs/${id}`, { recursive: true, force: true });
    }
  } finally {
    await shutdownSpawned(procs, [
      Number(ENV.GATEWAY_PORT),
      Number(ENV.AGENT_RUNTIME_PORT),
    ]);
    if (configSnapshot && secretTouched) {
      try {
        await restoreConfigSnapshot(prisma, configSnapshot);
        console.log("✓ e2e 配置快照已恢复（未保留测试密文）");
      } catch (err) {
        failed += 1;
        console.error("✗ e2e 配置快照恢复失败：", err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\nM3 console e2e：${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e 执行异常：", err);
  process.exit(1);
});
