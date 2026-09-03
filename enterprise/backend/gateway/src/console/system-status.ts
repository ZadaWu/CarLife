/**
 * 系统状态 —— 运维大屏的数据面（`GET /console/system/status`）。
 *
 * 服务清单的权威源是 infra 的两份文件，**这里只是它们的探活投影**：
 *   infra/scripts/dev.sh        本地进程目标（gateway/runtime/五个 mock/三个 vite/两个客户端窗口/worker）
 *   infra/docker-compose.yml    基础设施（postgres/redis/minio）
 * 那边增删服务，这里的 `SERVICE_PLAN` 要跟着动——两处都有注释互相指着。
 *
 * 三条判定纪律（跟探活页 probe.ts 同一价值观）：
 *  1. **探不到 ≠ 挂了**。客户端窗口没有 HTTP 通道、worker 也允许被显式停掉、
 *     redis/minio 可以不配——这三种"灰"各有各的说法，都不许染成红色。
 *     红色只留给"预期在跑却联不上"，否则大屏常年一片红，真红出现时没人看。
 *  2. **响应了也未必健康**。runtime 自己报 risks（M9-05 的判据：空数组才能上台），
 *     risks 非空这里标黄，不吞掉。
 *  3. **一个探针挂了不能带塌整页**。全部并发、各自吞异常、各自限时。
 *
 * # worker 用两种证据，不是一种
 *
 * `:8796/health` 回答"进程此刻在不在"（实时，答话的就是 worker 本身），
 * `job_runs` 留痕回答"任务最近跑过没有"（粒度是小时级 cron）。
 * 早先只有后者，于是"刚起来的 worker"和"根本没起的 worker"长得一模一样——
 * 2026-08-27 实测：进程在跑、4 个任务已挂上调度，这张卡却写「上次留痕已是 1 天前」。
 * 现在端口通了就以端口为准，端口不通才退回留痕（worker 可能跑在别的机器上）。
 */

import { Router } from "express";
import type { Response } from "express";

import { getPrisma, resolveTts, type ConfigStore } from "@carlife/db";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { readHostNetwork, type HostNetworkInfo } from "./host-network";

export type ServiceState = "ok" | "degraded" | "down" | "idle" | "unknown";

export interface ServiceReport {
  id: string;
  label: string;
  /** 分组给大屏排版用：core 核心链路 / mock 模拟外部系统 / frontend dev server / client 客户端窗口 / cron 定时任务 / infra 基础设施 */
  group: "core" | "mock" | "frontend" | "client" | "cron" | "infra";
  /** 实际探测的地址（全是本机/内网地址，不含任何凭据）。没有探测通道的服务不带。 */
  endpoint?: string;
  /**
   * 卡片上可点开的地址——**点开真能看到东西**的那个 URL，多数是 /health。
   * 只给 HTTP 服务：PG/Redis 不是 HTTP，客户端窗口没有通道，
   * 给一个点开必然失败的链接比不给链接更糟。
   */
  url?: string;
  state: ServiceState;
  latencyMs?: number;
  detail?: string;
  /** 异常时的处置指引——"检查配置"这种话等于没说（selfcheck 同款纪律）。 */
  hint?: string;
}

export interface SystemStatusSnapshot {
  generatedAt: string;
  summary: Record<ServiceState, number>;
  services: ServiceReport[];
  /**
   * 本机网络（局域网地址 / 默认网关）。它不是"某个服务的状态"，所以不进
   * services 数组也不进 summary——网关读不到不算故障，别把横幅染红。
   */
  network: HostNetworkInfo;
  /**
   * 今日云 vendor 用量与上界（ACR-016）。与 network 同理**不进 services 也不进
   * summary**：用量高不是故障，别把横幅染红；但它必须看得见——一个看不见的闸门
   * 等于没有闸门，超限那天只会表现为"声音怎么变了"。
   *
   * 闸门未装配时为 undefined（页面据此不渲染这一块）。
   */
  quota?: QuotaSnapshot;
}

/** 单个计费口的今日用量。`limit: 0` = 不限。 */
export interface QuotaUsage {
  used: number;
  limit: number;
  /** 计数当前不可靠（Redis 异常，已 fail-open 放行）——页面要如实标出来。 */
  degraded?: boolean;
}

export interface QuotaSnapshot {
  asr: QuotaUsage;
  tts: QuotaUsage;
}

type FetchLike = typeof fetch;

/** 单个探针的限时。整页并发，最慢也就等这么久。 */
const PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_LOCAL_ASR_URL = "http://127.0.0.1:8795/v1/audio/transcriptions";
const DEFAULT_HOST_SERVICES_HOST = "localhost";
const WORKER_START_HINT =
  "Worker 未运行：corepack pnpm dev:start worker；合并代码后用 corepack pnpm dev:upgrade";

/**
 * 状态页由谁发起探活，地址就必须按谁的网络命名空间解析。
 *
 * 宿主机 Gateway 用 localhost；完整 Compose 栈里的 Gateway 要访问宿主机
 * 的 TTS/Vite，则由 Compose 注入 `host.docker.internal`。业务请求地址不走
 * 这条转换，避免把容器内服务名误传给宿主端客户端。
 */
function hostServicesHost(raw: string | undefined = process.env.CARLIFE_HOST_SERVICES_HOST): string {
  const value = raw?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return value || DEFAULT_HOST_SERVICES_HOST;
}

/** 仅替换 loopback，外部或真实服务 URL 保持原样。 */
function probeOriginForHost(origin: string, host: string): string {
  try {
    const parsed = new URL(origin);
    if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      parsed.hostname = host;
    }
    return parsed.origin;
  } catch {
    return origin;
  }
}

/** worker 留痕多久以内算"还活着"。最密的任务也是小时级 cron，给到一天出头。 */
const WORKER_FRESH_MS = 26 * 60 * 60 * 1000;

// ── worker：实时端口 + PG 里的租约与留痕双证据 ─────────────────

export interface WorkerEvidence {
  /** 未过期的任务租约（有 = 此刻正有实例在执行）。 */
  lease: { job: string; holder: string } | null;
  /** 最近一次成功窗口的留痕。 */
  lastRun: { job: string; createdAt: number } | null;
}

/**
 * 人话的时长。`ago` 说的是"多久以前"，`duration` 说的是"持续了多久"——
 * 拿 `ago` 去讲运行时长会得到"运行 刚刚"这种话。
 */
export function duration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))} 秒`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时`;
  return `${Math.floor(ms / 86_400_000)} 天`;
}

/** 人话的相对时长。大屏是扫一眼的界面，"3 小时前"比 ISO 时间戳有用。 */
export function ago(ms: number): string {
  if (ms < 60_000) return "刚刚";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

/**
 * worker 状态推导（纯函数，供单测）。
 *
 * 完整升级与默认开发集合会启动它，但调试在线链路时仍可显式停掉；因此"没在跑"
 * 仍是 idle 不是 down——把可选的 cron 标红，等于教人忽略真正的红色。
 */
export function deriveWorkerState(
  evidence: WorkerEvidence,
  now: number,
): Pick<ServiceReport, "state" | "detail" | "hint"> {
  if (evidence.lease) {
    return {
      state: "ok",
      detail: `正在执行 ${evidence.lease.job}（持有者 ${evidence.lease.holder}）`,
    };
  }
  if (evidence.lastRun) {
    const elapsed = now - evidence.lastRun.createdAt;
    if (elapsed < WORKER_FRESH_MS) {
      return { state: "ok", detail: `最近留痕：${evidence.lastRun.job} · ${ago(elapsed)}` };
    }
    return {
      state: "idle",
      detail: `上次留痕已是 ${ago(elapsed)}（${evidence.lastRun.job}）`,
      hint: WORKER_START_HINT,
    };
  }
  return {
    state: "idle",
    detail: "从未留痕（job_runs 表为空）",
    hint: WORKER_START_HINT,
  };
}

/** worker 探活端点的响应形状（`enterprise/backend/worker/src/health.ts` 是它的真相源）。 */
export interface WorkerHealth {
  holder?: string;
  uptimeSec?: number;
  jobs?: Array<{
    job: string;
    cron: string;
    consecutiveFailures?: number;
    lastTick?: { at: number; outcome: string; error?: string };
  }>;
  skipped?: string[];
  risks?: string[];
}

/**
 * 端口通时的状态推导（纯函数，供单测）。
 *
 * 与 runtime 同一判据：**能应答只说明进程在，`risks` 非空要染黄**。
 * 留痕在这里只作补充说明——进程活着这件事已经由应答本身证明了，
 * 再让一份小时级的旧留痕把它拉回 idle 就是拿旧证据推翻新证据。
 */
export function deriveWorkerHealthState(
  health: WorkerHealth,
  evidence: WorkerEvidence | null,
  now: number,
): Pick<ServiceReport, "state" | "detail" | "hint"> {
  const jobs = health.jobs ?? [];
  const uptime = health.uptimeSec !== undefined ? `已运行 ${duration(health.uptimeSec * 1000)}` : "";
  const lastRun = evidence?.lastRun;
  const parts = [
    `${jobs.length} 个任务在调度`,
    uptime,
    lastRun ? `最近留痕：${lastRun.job} · ${ago(now - lastRun.createdAt)}` : "本进程尚未到点执行",
  ].filter(Boolean);

  const risks = health.risks ?? [];
  if (risks.length > 0) {
    return {
      state: "degraded",
      detail: `${parts.join(" · ")} · ${risks.length} 条风险：${risks[0]}`,
      hint: "corepack pnpm dev:logs worker",
    };
  }
  return { state: "ok", detail: parts.join(" · ") };
}

export function summarize(services: readonly ServiceReport[]): Record<ServiceState, number> {
  const summary: Record<ServiceState, number> = { ok: 0, degraded: 0, down: 0, idle: 0, unknown: 0 };
  for (const s of services) summary[s.state] += 1;
  return summary;
}

// ── 通用 HTTP 探针 ─────────────────────────────────────────────

interface HttpProbeResult {
  reachable: boolean;
  status?: number;
  latencyMs: number;
  body?: string;
  error?: string;
}

async function httpProbe(fetchImpl: FetchLike, url: string): Promise<HttpProbeResult> {
  const started = Date.now();
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await r.text().catch(() => "");
    return { reachable: true, status: r.status, latencyMs: Date.now() - started, body };
  } catch (err) {
    return {
      reachable: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 预期在跑的 HTTP 服务：通 = ok，不通 = down。 */
function expectUp(
  base: Omit<ServiceReport, "state" | "latencyMs">,
  r: HttpProbeResult,
  downHint: string,
): ServiceReport {
  if (r.reachable && r.status !== undefined && r.status < 500) {
    return { ...base, state: "ok", latencyMs: r.latencyMs };
  }
  return {
    ...base,
    state: "down",
    latencyMs: r.latencyMs,
    detail: r.reachable ? `HTTP ${r.status}` : `联不上：${r.error}`,
    hint: downHint,
  };
}

function localAsrEndpoint(inferenceUrl: string):
  | { healthUrl: string; displayUrl: string }
  | { error: string } {
  try {
    const parsed = new URL(inferenceUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: `LOCAL_ASR_URL 必须使用 http/https：${inferenceUrl}` };
    }
    return {
      healthUrl: `${parsed.origin}/health`,
      displayUrl: `${parsed.origin}${parsed.pathname}`,
    };
  } catch {
    return { error: `LOCAL_ASR_URL 不是有效 URL：${inferenceUrl}` };
  }
}

function parsedBody(body: string): { status?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as { status?: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}

async function localAsrStatus(
  fetchImpl: FetchLike,
  inferenceUrl: string,
  restartHint: string,
): Promise<ServiceReport> {
  const endpoint = localAsrEndpoint(inferenceUrl);
  const base = {
    id: "local-asr",
    label: "local-asr llama.cpp",
    group: "infra",
    endpoint: "error" in endpoint ? "LOCAL_ASR_URL" : endpoint.displayUrl,
  } as const;
  if ("error" in endpoint) {
    return { ...base, state: "down", detail: endpoint.error, hint: restartHint };
  }

  const r = await httpProbe(fetchImpl, endpoint.healthUrl);
  if (!r.reachable) {
    return {
      ...base,
      state: "down",
      latencyMs: r.latencyMs,
      detail: `服务不可达：${r.error}`,
      hint: restartHint,
    };
  }
  const body = r.body ?? "";
  const parsed = parsedBody(body);
  if (r.status === 200 && parsed?.status === "ok") {
    return {
      ...base,
      state: "ok",
      latencyMs: r.latencyMs,
      detail: "模型已 ready（health status=ok）",
    };
  }
  if (r.status === 503) {
    return {
      ...base,
      state: "degraded",
      latencyMs: r.latencyMs,
      detail: `容器已启动但模型尚未 ready：${body.slice(0, 160)}`,
      hint: restartHint,
    };
  }
  return {
    ...base,
    state: r.status === 404 ? "down" : "degraded",
    latencyMs: r.latencyMs,
    detail: `health 契约失败：HTTP ${r.status} ${body.slice(0, 160)}`,
    hint: restartHint,
  };
}

// ── 依赖注入（测试脱网用；生产走默认实现）────────────────────────

export interface SystemStatusDeps {
  config: ConfigStore;
  runtimeUrl: string;
  /** worker 探活端点。默认 `WORKER_HEALTH_URL` 或 `http://localhost:8796`。 */
  workerHealthUrl?: string;
  fetchImpl?: FetchLike;
  /** worker 证据与 PG ping。默认实现走 getPrisma()；测试注入假的。 */
  db?: {
    workerEvidence(now: number): Promise<WorkerEvidence>;
    /** 返回 SELECT 1 的耗时（ms）；失败抛异常。 */
    ping(): Promise<number>;
  };
  /** redis PING 耗时（ms）；失败抛异常。默认实现临时建连、打完即断。 */
  redisPing?: (url: string) => Promise<number>;
  /** 本机网络快照。默认读 os.networkInterfaces() + 路由表；测试注入假的。 */
  hostNetwork?: () => Promise<HostNetworkInfo>;
  /** 今日用量快照（ACR-016）。不注入即页面不显示这一块。 */
  quota?: () => Promise<QuotaSnapshot>;
}

function defaultDb(): NonNullable<SystemStatusDeps["db"]> {
  return {
    async workerEvidence(now) {
      const prisma = getPrisma();
      const [lease, lastRun] = await Promise.all([
        prisma.jobLease.findFirst({
          where: { expiresAt: { gt: new Date(now) } },
          select: { job: true, holder: true },
        }),
        prisma.jobRun.findFirst({
          orderBy: { createdAt: "desc" },
          select: { job: true, createdAt: true },
        }),
      ]);
      return {
        lease,
        lastRun: lastRun ? { job: lastRun.job, createdAt: lastRun.createdAt.getTime() } : null,
      };
    },
    async ping() {
      const started = Date.now();
      await getPrisma().$queryRaw`SELECT 1`;
      return Date.now() - started;
    },
  };
}

/**
 * redis 探针临时建连、PING、即断——不复用业务连接：
 * 业务侧（④档案缓存）连不上会自己降级直连 PG，探针要报的恰恰是那个降级的原因。
 */
async function defaultRedisPing(url: string): Promise<number> {
  const { createClient } = await import("redis");
  const client = createClient({ url, socket: { connectTimeout: PROBE_TIMEOUT_MS } });
  // 不挂 error 监听的话，连接失败会以 unhandled error 事件炸掉进程而不是走 catch
  client.on("error", () => {});
  const started = Date.now();
  try {
    await client.connect();
    await client.ping();
    return Date.now() - started;
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ── 装配 ──────────────────────────────────────────────────────

export function createSystemStatusRouter(deps: SystemStatusDeps): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const db = deps.db ?? defaultDb();
  const redisPing = deps.redisPing ?? defaultRedisPing;
  const hostNetwork = deps.hostNetwork ?? (() => readHostNetwork());
  const workerHealthUrl = (
    deps.workerHealthUrl ??
    process.env.WORKER_HEALTH_URL ??
    `http://${hostServicesHost()}:8796`
  ).replace(/\/$/, "");

  router.get(
    "/console/system/status",
    requireAnyRole(CONSOLE_READERS),
    async (_req: ConsoleRequest, res: Response) => {
      const now = Date.now();
      const env = process.env;
      const host = hostServicesHost(env.CARLIFE_HOST_SERVICES_HOST);
      const values = await deps.config.runtimeValues().catch(() => new Map<string, string>());
      const tts = resolveTts(values);
      // 选档判定统一走配置层（env-override 已在 store 解析，ACR-017）。
      const asrEngine = values.get("ASR_ENGINE")?.trim() || "ark";

      // 端口/地址的默认值与 .env.example、infra/scripts/dev.sh 保持一致
      const dealerUrl = env.MOCK_DEALER_URL ?? "http://localhost:8792";
      const cabinUrl = env.MOCK_CABIN_URL ?? "http://localhost:8793";
      const repairUrl = env.MOCK_REPAIR_URL ?? "http://localhost:8797";
      const insuranceUrl = env.MOCK_INSURANCE_URL ?? "http://localhost:8798";
      // 取 `upstreamUrl`：ACR-018 之后 `tts.url` 恒是网关自己的相对路径，
      // 拿它 `new URL()` 会直接抛（相对路径没有 origin）。
      const mockTtsOrigin =
        tts.engine === "mock" && tts.upstreamUrl
          ? probeOriginForHost(new URL(tts.upstreamUrl).origin, host)
          : `http://${host}:8794`;

      const restartHint = (target: string): string => `corepack pnpm dev:restart ${target}`;
      const localAsrUrl =
        values.get("LOCAL_ASR_URL") ?? env.LOCAL_ASR_URL ?? DEFAULT_LOCAL_ASR_URL;

      const probes: Array<Promise<ServiceReport>> = [
        // 网关自己：这份 JSON 就是它返回的，能收到即活着——不自打 HTTP，那是循环论证的形状
        Promise.resolve({
          id: "gateway",
          label: "gateway 网关",
          group: "core",
          endpoint: `http://localhost:${env.PORT ?? 8790}`,
          state: "ok",
          detail: "本页数据由它聚合返回",
        } satisfies ServiceReport),

        // mock 档才把 ASR 当作预期在线的核心依赖；Ark/aliyun/Fake 档没有这个容器，显示灰色。
        asrEngine === "mock"
          ? localAsrStatus(fetchImpl, localAsrUrl, "corepack pnpm dev:restart local-asr")
          : Promise.resolve({
              id: "local-asr",
              label: "local-asr llama.cpp",
              group: "infra",
              endpoint: localAsrUrl,
              state: "idle",
              detail: `未启用（ASR_ENGINE=${asrEngine}）`,
              hint: "后台或 .env 置 ASR_ENGINE=mock 后运行 corepack pnpm dev:bootstrap",
            } satisfies ServiceReport),

        // runtime：不止探"通不通"，还转述它自报的风险（M9-05：risks 空数组才是可以上台的状态）
        (async (): Promise<ServiceReport> => {
          const base = {
            id: "runtime",
            label: "agent-runtime 编排",
            group: "core",
            endpoint: `${deps.runtimeUrl}/internal/health/runtime`,
          } as const;
          const r = await httpProbe(fetchImpl, `${deps.runtimeUrl}/internal/health/runtime`);
          if (!r.reachable || r.status !== 200) {
            return {
              ...base,
              state: "down",
              latencyMs: r.latencyMs,
              detail: r.reachable ? `HTTP ${r.status}` : `联不上：${r.error}`,
              hint: restartHint("runtime"),
            };
          }
          try {
            const parsed = JSON.parse(r.body ?? "{}") as {
              health?: { agentRuntime?: string; llm?: string; tools?: { mode?: string } };
              risks?: string[];
            };
            const h = parsed.health ?? {};
            const shape = `形态 ${h.agentRuntime ?? "?"} · LLM ${h.llm ?? "?"} · 工具 ${h.tools?.mode ?? "?"}`;
            const risks = parsed.risks ?? [];
            if (risks.length > 0) {
              return {
                ...base,
                state: "degraded",
                latencyMs: r.latencyMs,
                detail: `${shape} · ${risks.length} 条风险：${risks[0]}`,
                hint: "细看 runtime 健康视图（演示大屏的 fake 横幅同源）",
              };
            }
            return { ...base, state: "ok", latencyMs: r.latencyMs, detail: shape };
          } catch {
            return { ...base, state: "ok", latencyMs: r.latencyMs, detail: "响应非 JSON（旧版本？）" };
          }
        })(),

        // 五个 mock。dealer/cabin/repair/insurance 在默认启动集合里，URL 也默认生效——不通就是红
        // （2026-08-14 两次事故：进程没起和缺配置是同一副"门店系统没连上"的面孔）
        httpProbe(fetchImpl, `${dealerUrl}/health`).then((r) =>
          expectUp(
            { id: "mock-dealer", label: "mock-dealer 门店系统", group: "mock", endpoint: dealerUrl },
            r,
            restartHint("mock-dealer"),
          ),
        ),
        httpProbe(fetchImpl, `${cabinUrl}/health`).then((r) =>
          expectUp(
            { id: "mock-cabin", label: "mock-cabin 舒适域", group: "mock", endpoint: cabinUrl },
            r,
            restartHint("mock-cabin"),
          ),
        ),
        // M41 的两个假第三方与 dealer/cabin 同规则：默认集合里、URL 默认生效，不通就是红
        httpProbe(fetchImpl, `${repairUrl}/health`).then((r) =>
          expectUp(
            { id: "mock-repair", label: "mock-repair 维修系统", group: "mock", endpoint: repairUrl },
            r,
            restartHint("mock-repair"),
          ),
        ),
        httpProbe(fetchImpl, `${insuranceUrl}/health`).then((r) =>
          expectUp(
            { id: "mock-insurance", label: "mock-insurance 保险系统", group: "mock", endpoint: insuranceUrl },
            r,
            restartHint("mock-insurance"),
          ),
        ),
        // mock-tts 只有在当前 TTS 引擎确实是 mock 时才算链路一环；doubao 档它不跑是常态
        httpProbe(fetchImpl, `${mockTtsOrigin}/health`).then((r): ServiceReport => {
          const base = {
            id: "mock-tts",
            label: "mock-tts 语音合成",
            group: "mock",
            endpoint: mockTtsOrigin,
          } as const;
          if (tts.engine === "mock") return expectUp(base, r, "corepack pnpm dev:start mock-tts");
          if (r.reachable) return { ...base, state: "ok", latencyMs: r.latencyMs, detail: "在跑（当前引擎是 doubao，未被使用）" };
          return {
            ...base,
            state: "idle",
            detail: `未运行——当前 TTS 引擎是 ${tts.engine}，不影响播报`,
          };
        }),

        // 三个 vite dev server（车机端与客户端窗口的界面都从这里来：debug 二进制走 devUrl 不内嵌 dist）
        ...([
          ["cockpit", "cockpit 车机前端", 1430],
          ["mobile", "mobile 手机前端", 1420],
          ["web", "web 运营控制台", 5173],
        ] as const).map(([id, label, port]) =>
          httpProbe(fetchImpl, `http://${host}:${port}/`).then((r) =>
            expectUp(
              { id, label, group: "frontend", endpoint: `http://localhost:${port}` },
              r,
              `${restartHint(id)}${id !== "web" ? `（vite 不在，${id}-app 就是白屏）` : ""}`,
            ),
          ),
        ),

        // 两个客户端窗口：Tauri 桌面进程，没有 HTTP 通道，网关无从探测——如实标灰，不猜
        ...(["cockpit-app", "mobile-app"] as const).map((id) =>
          Promise.resolve({
            id,
            label: `${id} 客户端窗口`,
            group: "client",
            state: "unknown",
            detail: "桌面窗口进程，无 HTTP 探测通道",
            hint: "corepack pnpm dev:status（按进程 cwd 判定，含监护层死活）",
          } satisfies ServiceReport),
        ),

        // worker：先问端口（进程此刻在不在），端口不通再退回留痕（任务最近跑过没有）
        (async (): Promise<ServiceReport> => {
          const base = {
            id: "worker",
            label: "worker 定时任务",
            group: "cron",
            endpoint: workerHealthUrl,
          } as const;

          // 两份证据并发取。留痕失败不影响端口判定——它只是 detail 里的一句补充。
          const [probe, evidence] = await Promise.all([
            httpProbe(fetchImpl, `${workerHealthUrl}/health`),
            db.workerEvidence(now).catch((err: unknown) => err as Error),
          ]);
          const ev = evidence instanceof Error ? null : evidence;

          if (probe.reachable && probe.status === 200) {
            try {
              const health = JSON.parse(probe.body ?? "{}") as WorkerHealth;
              return { ...base, latencyMs: probe.latencyMs, ...deriveWorkerHealthState(health, ev, now) };
            } catch {
              // 应答了但不是我们认识的 JSON：进程在，只是版本对不上。不猜、也不染红。
              return { ...base, state: "ok", latencyMs: probe.latencyMs, detail: "探活端点响应非 JSON（旧版本？）" };
            }
          }

          // 端口不通。**不染红**：worker 允许被显式停掉，理由同文件头纪律 1。
          if (evidence instanceof Error) {
            // 端口与 PG 双双不可达时无从判定——PG 那张卡会自己红，这里不重复染
            return {
              ...base,
              state: "unknown",
              detail: `探活端点联不上（${probe.error ?? `HTTP ${probe.status}`}），留痕也查不到：${evidence.message}`,
            };
          }
          const fallback = deriveWorkerState(ev as WorkerEvidence, now);
          return {
            ...base,
            ...fallback,
            // 端口不通时状态一律不高于 idle：留痕再新鲜也只能证明"跑过"，不能证明"还在"
            state: fallback.state === "ok" ? "idle" : fallback.state,
            detail: `探活端点未应答（${probe.error ?? `HTTP ${probe.status}`}）。${fallback.detail ?? ""}`,
            hint: WORKER_START_HINT,
          };
        })(),

        // ── 基础设施（infra/docker-compose.yml：postgres / redis / minio）
        (async (): Promise<ServiceReport> => {
          const base = {
            id: "postgres",
            label: "PostgreSQL（含 pgvector）",
            group: "infra",
            endpoint: "postgres://localhost:55433",
          } as const;
          try {
            const latencyMs = await db.ping();
            return { ...base, state: "ok", latencyMs, detail: "SELECT 1 通过" };
          } catch (err) {
            return {
              ...base,
              state: "down",
              detail: err instanceof Error ? err.message : String(err),
              hint: "docker compose -f infra/docker-compose.yml up -d",
            };
          }
        })(),
        (async (): Promise<ServiceReport> => {
          const url = env.REDIS_URL;
          const base = { id: "redis", label: "Redis（⑤环境缓存/④档案缓存）", group: "infra" } as const;
          if (!url) {
            return { ...base, state: "idle", detail: "未配置 REDIS_URL——④档案读直连 PG，属降级不属故障" };
          }
          try {
            const latencyMs = await Promise.race([
              redisPing(url),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`PING 超时（${PROBE_TIMEOUT_MS}ms）`)), PROBE_TIMEOUT_MS),
              ),
            ]);
            return { ...base, state: "ok", latencyMs, detail: "PING 通过" };
          } catch (err) {
            return {
              ...base,
              state: "down",
              detail: err instanceof Error ? err.message : String(err),
              hint: "docker compose -f infra/docker-compose.yml up -d",
            };
          }
        })(),
        (async (): Promise<ServiceReport> => {
          const endpoint = env.S3_ENDPOINT;
          const base = { id: "minio", label: "MinIO 对象存储（证据留档）", group: "infra" } as const;
          if (!endpoint) {
            return { ...base, state: "idle", detail: "未配置 S3_ENDPOINT——附件留档未接线" };
          }
          const r = await httpProbe(fetchImpl, `${endpoint.replace(/\/$/, "")}/minio/health/live`);
          return expectUp(
            { ...base, endpoint },
            r,
            "docker compose -f infra/docker-compose.yml up -d",
          );
        })(),
      ];

      /**
       * 每张卡片点开去哪。给的是**点开真能看到东西**的地址，不是服务根地址——
       * mock 的根是 404、网关的根是 401，把根地址做成链接等于给一堆坏门。
       * 主机名一律写 localhost：浏览器可能在局域网另一台机器上，由前端换成它自己的主机名。
       * 没进这张表的（PG/Redis/两个客户端窗口）就是没有可点开的地址，不硬造。
       */
      const browsable: Record<string, string> = {
        gateway: `http://localhost:${env.PORT ?? 8790}/healthz`,
        runtime: `${deps.runtimeUrl}/internal/health/runtime`,
        "mock-dealer": `${dealerUrl}/health`,
        "mock-cabin": `${cabinUrl}/health`,
        "mock-repair": `${repairUrl}/health`,
        "mock-insurance": `${insuranceUrl}/health`,
        "mock-tts": `${mockTtsOrigin}/health`,
        cockpit: "http://localhost:1430/",
        mobile: "http://localhost:1420/",
        web: "http://localhost:5173/",
        worker: `${workerHealthUrl}/health`,
      };
      if (asrEngine === "mock") {
        // 探的是转写接口（POST），浏览器打开它只会 404——链接给同源的 /health
        try {
          browsable["local-asr"] = `${new URL(localAsrUrl).origin}/health`;
        } catch {
          /* URL 不合法就不给链接，不猜 */
        }
      }
      if (env.S3_ENDPOINT) {
        browsable.minio = `${env.S3_ENDPOINT.replace(/\/$/, "")}/minio/health/live`;
      }

      // 网络与探活并发；读路由表失败不影响整页（readHostNetwork 自己把错误装进 error 字段）
      const [services, network, quota] = await Promise.all([
        Promise.all(probes),
        hostNetwork().catch(
          (err: unknown): HostNetworkInfo => ({
            scope: "host",
            lan: [],
            tunnels: [],
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
        // 读用量失败就不显示这一块——它是观测面，不该让整页 500。
        deps.quota?.().catch((err: unknown) => {
          console.warn("[system-status] 读今日用量失败", err);
          return undefined;
        }) ?? Promise.resolve(undefined),
      ]);
      res.json({
        generatedAt: new Date(now).toISOString(),
        summary: summarize(services),
        services: services.map((s) => (browsable[s.id] ? { ...s, url: browsable[s.id] } : s)),
        network,
        ...(quota ? { quota } : {}),
      } satisfies SystemStatusSnapshot);
    },
  );

  return router;
}
