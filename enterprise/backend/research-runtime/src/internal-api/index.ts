/**
 * 内部 HTTP 面（施工单 M82-04）。
 *
 * # 只绑 127.0.0.1，没有鉴权
 *
 * 与 `vision-trainer` 同纪律（ACR-026）：鉴权由网关的 `/console/research/*`
 * 代理负责（M82-07）。这个进程自己不认识用户，也不该认识——
 * 它做的是跨用户聚合，一旦有了"当前用户"这个概念，
 * 就会有人想在这里加一个按用户过滤的分支。
 *
 * # 端点永不返回原文
 *
 * 证据接口只出 `text_redacted`。`api.test.ts` 有一条断言钉住响应体里没有
 * `content` 键——那是 `messages` 表的列名，出现即说明有人把原文接进来了。
 *
 * # 不引 express
 *
 * 与 worker 的 health 端点同一条取舍：`node:http` 够用，
 * 为几个只读端点给一个后台进程加 HTTP 框架不划算。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { LENSES } from "@carlife/research";
import type { ResearchRepository } from "@carlife/db";

import type { Codebook } from "../codebook/load";
import { handleResume, listReview, type ReviewDeps, type ResumeBody } from "../review/endpoints";
import { handleCapability, type CapabilityBody, type CapabilityDeps } from "./capabilities";
import { handleRunStream, type RunState, type RunStreamDeps } from "./run-stream";

export interface ApiDeps {
  repo: ResearchRepository;
  book: Codebook;
  /** 各队列注册上了没——`/health` 要如实说，不能因为进程活着就报 ok。 */
  queues: () => Record<string, boolean>;
  startedAt: number;
  /** codebook 在库里锁没锁。 */
  codebookLocked: () => boolean;
  /** 触发一次研究运行（M82-05 是顺序执行，M82-06 换成图）。缺省时端点回 503。 */
  startRun?: (input: { contractId: string; windowFrom: number; windowTo: number }) => Promise<{ inputsHash: string; reused: boolean }>;
  /** POC 缺省合同 id——不带 `contract=` 时用它。 */
  defaultContractId?: () => string | null;
  /** review 面（人工决定）。缺省时那几条端点回 503。 */
  review?: ReviewDeps;
  /** 一次运行的当前状态，`GET runs/:id` 与运行流都读它——**一个信息源**。 */
  runState?: (runId: string) => Promise<RunState | null>;
  /** 能力端点的取数。缺省时 `POST capabilities/:name` 里要读库的那条回 503。 */
  capabilities?: CapabilityDeps;
  /** 这次运行烧了多少 token（G7）。口径的窟窿写在 `RunStreamDeps.runUsage` 上。 */
  runUsage?: RunStreamDeps["runUsage"];
  /** 运行流的轮询间隔，只有测试会传。 */
  runStreamPollMs?: number;
  /**
   * 当前证据矩阵快照的 `inputs_hash`（G5，M85-06）。
   *
   * `GET insights?full=1` 拿它与每张卡上的那份比：不等 → 「口径已变」。
   * 缺省时回 null，界面把全部卡片显示成「口径未知」——
   * **不要在缺省时假装一致**，那正是 G5 要防的那种"看起来正常"。
   */
  currentInputsHash?: (contractId: string) => Promise<string | null>;
  /**
   * 研究工具的回调面（M88-04，ACR-038 步 4）：pi 扩展打回来的 describe / invoke。
   *
   * 挂成一个"先问它"的前置处理器而不是 `route()` 里的两个分支，是因为它要**自己读
   * 请求体**（与车主面 `handleToolsRequest` 同形），而 `route()` 收到的 body 已经被
   * 解析过一次。缺省不挂：这两条路径只对 pi 子进程有意义。
   */
  tools?: { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> };
  /**
   * ACP 面的健康（M88-04 先把字段接上，M88-05 才真的建池）。
   *
   * `configured` 说的是"池装配了没有"，不是"进程活着没有"——缺省 `false` 是如实说。
   * `describeCalls` 是**扩展确实被 pi 加载**的唯一证据：pi 在 `--mode rpc` 下对未信任
   * 项目会静默忽略 `.pi/extensions/`，不报错、不告警，只是工具一个都没有。
   * `invokeCalls` 是第二问的答案——**加载了不等于用了**：模型手里有工具却一次没调，
   * 产出的挑战记录与真查过的长得一模一样（M88-05 冒烟按它断言）。
   */
  acpHealth?: () => {
    configured: boolean;
    processes?: number;
    describeCalls: number;
    invokeCalls?: number;
  };
}

interface Json {
  status: number;
  body: unknown;
}

const json = (status: number, body: unknown): Json => ({ status, body });

/** 分页游标：`<occurredAt>|<id>`。单列游标在同毫秒下会静默丢行（M68-01 踩过）。 */
function parseCursor(raw: string | null): { at: number; id: string } | null {
  if (!raw) return null;
  const [at, id] = raw.split("|");
  const n = Number(at);
  return Number.isFinite(n) && id ? { at: n, id } : null;
}

async function route(url: URL, method: string, deps: ApiDeps, bodyJson?: unknown): Promise<Json> {
  const path = url.pathname;

  if (method === "GET" && path === "/health") {
    return json(200, {
      ok: true,
      uptime: Math.round((Date.now() - deps.startedAt) / 1000),
      queue: deps.queues(),
      codebook: { version: deps.book.version, locked: deps.codebookLocked() },
      acp: deps.acpHealth?.() ?? { configured: false, describeCalls: 0 },
    });
  }

  if (path === "/internal/research/contracts") {
    if (method === "GET") return json(200, { contracts: await deps.repo.contracts.list() });
    return json(405, { error: "method_not_allowed", hint: "创建合同在 M82-06 接线" });
  }

  if (method === "GET" && path === "/internal/research/evidence") {
    const q = url.searchParams;
    const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50)));
    const page = await listEvidence(deps, {
      kind: q.get("kind"),
      counter: q.get("counter") === "true",
      cursor: parseCursor(q.get("cursor")),
      limit,
    });
    return json(200, page);
  }

  const unitMatch = /^\/internal\/research\/evidence\/([\w-]+)$/.exec(path);
  if (method === "GET" && unitMatch) {
    const unit = (await deps.repo.units.byId(unitMatch[1])) as Record<string, unknown> | null;
    if (!unit) return json(404, { error: "unit_not_found" });
    const codings = await deps.repo.codings.forUnits([unitMatch[1]], deps.book.version);
    return json(200, { unit: publicUnit(unit), codings });
  }

  const lensMatch = /^\/internal\/research\/snapshots\/([\w-]+)$/.exec(path);
  if (method === "GET" && lensMatch) {
    const lens = lensMatch[1];
    if (!(LENSES as readonly string[]).includes(lens)) {
      return json(404, { error: "unknown_lens", hint: `lens ∈ ${LENSES.join(" / ")}` });
    }
    const contractId = url.searchParams.get("contract") ?? deps.defaultContractId?.() ?? null;
    if (!contractId) return json(400, { error: "contract_required", hint: "带 ?contract=，或先建一个合同" });

    const snap = (await deps.repo.snapshots.latest(contractId, lens)) as Record<string, unknown> | null;
    if (snap) return json(200, { snapshot: publicSnapshot(snap) });

    /*
     * 没有快照时回 **202 并触发一次运行**，不是 404：
     * 「还没算」与「这个镜头不存在」是两件事，前端要能分开——
     * 前者该显示"正在算，稍后刷新"，后者是它自己拼错了 URL。
     */
    if (deps.startRun && contractId) {
      const contract = (await deps.repo.contracts.byId(contractId)) as
        | { windowFrom?: bigint; windowTo?: bigint }
        | null;
      if (contract?.windowFrom !== undefined && contract.windowTo !== undefined) {
        void deps.startRun({
          contractId,
          windowFrom: Number(contract.windowFrom),
          windowTo: Number(contract.windowTo),
        });
      }
    }
    return json(202, { status: "computing", lens, contractId });
  }

  if (method === "GET" && path === "/internal/research/system-events") {
    const from = Number(url.searchParams.get("from") ?? 0);
    const to = Number(url.searchParams.get("to") ?? Date.now());
    return json(200, { events: await deps.repo.systemEvents.inWindow({ from, to }) });
  }

  if (method === "POST" && path === "/internal/research/runs") {
    if (!deps.startRun) return json(503, { error: "runs_not_available", hint: "缺 DEEPSEEK_API_KEY 或队列未起" });
    const contractId = url.searchParams.get("contract") ?? deps.defaultContractId?.() ?? null;
    if (!contractId) return json(400, { error: "contract_required" });
    const contract = (await deps.repo.contracts.byId(contractId)) as
      | { windowFrom?: bigint; windowTo?: bigint }
      | null;
    if (!contract) return json(404, { error: "contract_not_found" });
    const out = await deps.startRun({
      contractId,
      windowFrom: Number(contract.windowFrom ?? 0),
      windowTo: Number(contract.windowTo ?? Date.now()),
    });
    return json(200, { runId: out.inputsHash, reused: out.reused });
  }

  if (method === "GET" && path === "/internal/research/review") {
    if (!deps.review) return json(503, { error: "review_not_available" });
    return listReview(deps.review);
  }

  const resumeMatch = /^\/internal\/research\/review\/([^/]+)\/resume$/.exec(path);
  if (method === "POST" && resumeMatch) {
    if (!deps.review) return json(503, { error: "review_not_available" });
    const body = (bodyJson ?? {}) as ResumeBody;
    // actor 由网关注入（M82-07 走 admin + auditAction）；本进程不认识用户。
    const actor = url.searchParams.get("actor") ?? "unknown";
    return handleResume(decodeURIComponent(resumeMatch[1]), body, actor, deps.review);
  }

  if (method === "GET" && path === "/internal/research/insights") {
    const contractId = url.searchParams.get("contract") ?? deps.defaultContractId?.() ?? null;
    if (!contractId) return json(400, { error: "contract_required" });
    /*
     * `?full=1` 才回六栏正文（M85-06）。缺省仍是三列的老形状——
     * review 面与既有调用方只要 id 和等级，给它们灌上几十张卡的正文
     * 是一次谁都没要的放大。
     *
     * **`currentInputsHash` 与卡片一起回**：G5 的比对是"这张卡的口径 vs 此刻的口径"，
     * 分两跳查的话两个值来自两个时刻，而它们不一致时看起来就像卡片过期了。
     */
    if (url.searchParams.get("full") === "1") {
      return json(200, {
        insights: await deps.repo.insights.forContract(contractId),
        currentInputsHash: (await deps.currentInputsHash?.(contractId)) ?? null,
      });
    }
    return json(200, { insights: await deps.repo.insights.list(contractId) });
  }

  const insightMatch = /^\/internal\/research\/insights\/([\w-]+)$/.exec(path);
  if (method === "GET" && insightMatch) {
    const row = await deps.repo.insights.byId(insightMatch[1]);
    if (!row) return json(404, { error: "insight_not_found" });
    return json(200, { insight: row });
  }

  if (method === "GET" && path === "/internal/research/opportunities") {
    const outlet = url.searchParams.get("outlet") ?? undefined;
    const rows = (await deps.repo.opportunities.list(outlet)) as Array<{ ods?: { score?: number } }>;
    // 按 ODS 降序——分数只用来排这个序，不写回任何计划文件。
    rows.sort((a, b) => (b.ods?.score ?? 0) - (a.ods?.score ?? 0));
    return json(200, { opportunities: rows });
  }

  const capabilityMatch = /^\/internal\/research\/capabilities\/([\w-]+)$/.exec(path);
  if (method === "POST" && capabilityMatch) {
    return handleCapability(
      capabilityMatch[1],
      {
        ...((bodyJson ?? {}) as CapabilityBody),
        /*
         * 决定人**由这一跳从 `?actor=` 覆盖进来**（C8 要它，M85-08）。
         * 展开顺序不能反：放在前面的话，请求体里带一个 `actor` 就能顶掉网关注入的那个，
         * 而那等于客户端自证身份。网关在 `withActor` 那条上已经把查询串上的值覆盖过了。
         */
        actor: url.searchParams.get("actor") ?? "unknown:unknown",
      },
      deps.capabilities,
      deps.defaultContractId?.() ?? null,
    );
  }

  const runMatch = /^\/internal\/research\/runs\/([\w:%-]+)$/.exec(path);
  if (method === "GET" && runMatch) {
    if (!deps.runState) return json(503, { error: "runs_not_available" });
    const st = await deps.runState(decodeURIComponent(runMatch[1]));
    if (!st) return json(404, { error: "run_not_found" });
    return json(200, st);
  }

  return json(404, { error: "not_found" });
}

/** 快照的对外形状：BigInt 转数字，其余原样（快照里本来就没有原文）。 */
export function publicSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  const num = (v: unknown): unknown => (typeof v === "bigint" ? Number(v) : v);
  return {
    id: row.id,
    contractId: row.contractId,
    lens: row.lens,
    window: { from: num(row.windowFrom), to: num(row.windowTo) },
    codebookVersion: row.codebookVersion,
    inputsHash: row.inputsHash,
    population: row.population,
    gates: row.gates,
    data: row.data,
    computedAt: row.computedAt,
  };
}

/**
 * 单元的**对外形状**。这里是"原文不出研究面"这条红线的实现处：
 * 逐字段挑出来，而不是 `delete unit.content`——
 * 后者在新增一列时会静默漏出去，前者会因为字段不在白名单里而不出现。
 */
export function publicUnit(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    sourceId: row.sourceId,
    vin: row.vin,
    occurredAt: typeof row.occurredAt === "bigint" ? Number(row.occurredAt) : row.occurredAt,
    textRedacted: row.textRedacted,
    features: row.features,
    context: row.context,
    displayLevel: row.displayLevel,
    role: row.role,
    withdrawnAt: row.withdrawnAt,
  };
}

interface EvidenceQuery {
  kind: string | null;
  counter: boolean;
  cursor: { at: number; id: string } | null;
  limit: number;
}

async function listEvidence(deps: ApiDeps, q: EvidenceQuery): Promise<{ units: unknown[]; nextCursor: string | null }> {
  const rows = (await deps.repo.units.listForApi({
    kind: q.kind,
    // `counter=true` 只回被编码成 counter-example 的那些——反例栏用它。
    polarity: q.counter ? "counter-example" : null,
    codebookVersion: deps.book.version,
    cursorAt: q.cursor?.at ?? null,
    cursorId: q.cursor?.id ?? null,
    limit: q.limit + 1,
  })) as Array<Record<string, unknown>>;

  const hasMore = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    units: page.map(publicUnit),
    nextCursor: hasMore && last ? `${Number(last.occurredAt)}|${String(last.id)}` : null,
  };
}

/**
 * 运行流的路径。放在 `route()` 之外——它不产 JSON，走的是 `text/event-stream`。
 *
 * ⚠️ 字符集里有 `%`：`thread_id` 形如 `research:<contract>:<窗口>`，调用方按
 * `encodeURIComponent` 编过之后冒号变成 `%3A`，而 `url.pathname` 保留百分号编码。
 * 少了 `%` 的表现是**带线程 id 的请求一律 404**，看起来像那条 run 不存在——
 * 2026-09-14 真跑撞到（`GET runs/:id` 那条也有同一个洞，一并补了：
 * 它此前只被十六进制的 `inputsHash` 试过，从没试过线程 id）。
 */
const RUN_STREAM_PATH = /^\/internal\/research\/runs\/([\w:%-]+)\/stream$/;

export function createInternalApi(deps: ApiDeps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    /*
     * SSE 在读 body 之前分流：`route()` 的出口把一切都包成一次 `res.end(JSON…)`，
     * 流式响应套不进那个形状。GET 也没有 body 要等。
     */
    const streamMatch = RUN_STREAM_PATH.exec(url.pathname);
    if (req.method === "GET" && streamMatch) {
      if (!deps.runState) {
        res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "runs_not_available" }));
        return;
      }
      const runState = deps.runState;
      void handleRunStream(
        res,
        decodeURIComponent(streamMatch[1]),
        { runState, runUsage: deps.runUsage, pollMs: deps.runStreamPollMs },
        (fn) => req.on("close", fn),
      ).catch(() => {
        // 流已经写过头了就只能收摊——此时再写状态码会抛 ERR_HTTP_HEADERS_SENT。
        if (!res.writableEnded) res.end();
      });
      return;
    }

    /*
     * 工具回调面**先问一次**（M88-04）：它自己读请求体，而下面那段读完 body 才分发。
     * 顺序不能反——body 被下面读走之后，`handle` 里的 `for await (const c of req)`
     * 拿到的是一个已经流干的流，表现是每次 invoke 都 `invalid_json`。
     *
     * 没匹配上时它同步回 `false`（此时流还没被 resume，一个 chunk 都没丢），
     * 再走原来的分发。
     */
    if (deps.tools) {
      void deps.tools
        .handle(req, res)
        .then((handled) => {
          if (!handled) dispatch(req, res, url, deps);
        })
        .catch((err: unknown) => {
          if (res.writableEnded) return;
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "tools_endpoint_failed", detail: errText(err) }));
        });
      return;
    }
    dispatch(req, res, url, deps);
  });
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 读完 body 再走 `route()`。从 `createInternalApi` 里提出来，好让工具面先插一脚。 */
function dispatch(req: IncomingMessage, res: ServerResponse, url: URL, deps: ApiDeps): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    let bodyJson: unknown;
    if (chunks.length > 0) {
      try {
        bodyJson = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // 非 JSON 的 body 直接忽略——这些端点只吃 JSON。
      }
    }
    void route(url, req.method ?? "GET", deps, bodyJson)
      .then(({ status, body }) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
      })
      .catch((err: unknown) => {
        // 500 要带一句原因：这个端点只有我们自己看，藏起来只会让排查多一跳。
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "internal_error", detail: errText(err) }));
      });
  });
}
