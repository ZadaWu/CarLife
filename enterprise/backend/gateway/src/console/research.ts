/**
 * 研究面的代理 `/console/research/*`（ACR-034 / 施工单 M82-07）。
 *
 * # 网关只做鉴权与透传，不算任何东西
 *
 * `research-runtime`（8800）只绑 127.0.0.1、自己没有鉴权。分母口径、比率、方向、
 * 抑制**只在研究服务一份**——网关裁一刀或补一个字段，就会出现"控制台上的数
 * 和 API 里的数对不上"，而两边各自都能自圆其说。所以这里 JSON 原样回，
 * 唯一的例外是错误体统一成 `{ error: code }`。
 *
 * 本文件因此**不 import `@carlife/research`**，也不 import 研究服务的任何东西。
 *
 * # 「没配」和「没起」是两个错
 *
 * 与 `vision-trainer.ts` 同一条纪律：URL 为空**仍然挂路由**，回 503
 * `research_not_configured`（这个部署没启用研究面）；配了但连不上回 503
 * `research_unreachable`（服务该起没起）。不挂路由的 404 分不出这两件事。
 *
 * # 读原文也是敏感动作
 *
 * `GET evidence/:unitId` 走读者角色，但**记审计** `research.evidence.open`。
 * 证据单元里是车主说过的话（已脱敏），谁在什么时候翻过哪一条要留痕——
 * analysis.md §1 把它与原声回放并列。
 */

import { Router, type Response } from "express";

import type { ConfigStore } from "@carlife/db";

import { requireAnyRole, requireRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { auditAction } from "./audit";

export interface ResearchProxyDeps {
  config: Pick<ConfigStore, "get">;
  /** 测试注入；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
}

const PREFIX = "/console/research";

/** 上游超时。研究服务的快照是预算好的读，5 秒还没回多半是它挂了。 */
export const UPSTREAM_TIMEOUT_MS = 5_000;

/** 路径参数的字符集。`:` 是给 `thread_id`（`research:<contract>:<run>`）留的。 */
const SAFE_ID = /^[A-Za-z0-9:_-]{1,120}$/;

/** 五个镜头，白名单。拼错的 lens 在网关就该被拦下，不该打到上游。 */
const LENSES = [
  "evidence-matrix",
  "importance-performance",
  "emotion-job-map",
  "segment-atlas",
  "trend-signal",
];

/** 能力名的字符集。九条能力的 `key` 都是 kebab-case，比 `SAFE_ID` 更窄。 */
const SAFE_CAPABILITY = /^[a-z][a-z0-9-]{0,39}$/;

/** SSE 心跳。与 `trace-stream.ts` 同一个值。 */
const HEARTBEAT_MS = 15_000;

/**
 * 决定人。身份由 `requireRole` / `requireAnyRole` 填在 `req.console` 上
 * （`ConsoleIdentity = {subject, role}`），到这一步一定有值。
 *
 * **带上角色**：`admin` 与 `ops` 都可能是同一个 subject 的两种登录方式，
 * 而"半年后回看是谁决定的"这个问题，答案里少了角色就要再 join 一次审计表。
 * 取不到身份时写 `unknown:unknown` 而不是静默放行成 `unknown`——
 * 前者一眼看得出是这一跳没填上，后者会被当成上游的缺省值。
 */
function actorOf(req: ConsoleRequest): string {
  const id = req.console;
  return id ? `${id.role}:${id.subject}` : "unknown:unknown";
}

type Upstream = { ok: true; base: string } | { ok: false; error: "research_not_configured" };

async function upstream(config: Pick<ConfigStore, "get">): Promise<Upstream> {
  const v = ((await config.get("RESEARCH_RUNTIME_URL").catch(() => undefined)) ?? "").trim();
  if (!v) return { ok: false, error: "research_not_configured" };
  return { ok: true, base: v.replace(/\/+$/, "") };
}

export function createResearchRouter(deps: ResearchProxyDeps): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? fetch;

  /**
   * 状态码、content-type、body 原样回（JSON 与 CSV 都走这条）。
   *
   * `withActor` 只给**写**路径开：上游从 `?actor=` 取决定人，而客户端自己
   * 在 URL 里写 `?actor=admin` 等于自证身份——随手改一个字就换了人。
   * 所以这一跳（已经做过鉴权的这一跳）把它**覆盖**掉，不是"没有就补"。
   */
  async function passthrough(
    req: ConsoleRequest,
    res: Response,
    path: string,
    init: RequestInit = {},
    withActor = false,
  ): Promise<void> {
    const up = await upstream(deps.config);
    if (!up.ok) {
      res.status(503).json({ error: up.error });
      return;
    }
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const url = new URL(`${up.base}${path}${qs}`);
    if (withActor) url.searchParams.set("actor", actorOf(req));
    let r: globalThis.Response;
    try {
      r = await fetchImpl(url.toString(), {
        ...init,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (e) {
      // 超时与连不上是同一类：服务该起没起（或起了不应答）。
      res.status(503).json({ error: "research_unreachable", detail: e instanceof Error ? e.message : String(e) });
      return;
    }
    res.status(r.status);
    const type = r.headers.get("content-type");
    if (type) res.setHeader("content-type", type);
    res.send(Buffer.from(await r.arrayBuffer()));
  }

  const readers = requireAnyRole(CONSOLE_READERS);
  const jsonPost = (req: ConsoleRequest): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req.body ?? {}),
  });

  // ── 读：admin / ops ─────────────────────────────────
  router.get(`${PREFIX}/contracts`, readers, (req, res) => void passthrough(req, res, "/internal/research/contracts"));
  router.get(`${PREFIX}/insights`, readers, (req, res) => void passthrough(req, res, "/internal/research/insights"));
  router.get(`${PREFIX}/opportunities`, readers, (req, res) => void passthrough(req, res, "/internal/research/opportunities"));
  router.get(`${PREFIX}/review`, readers, (req, res) => void passthrough(req, res, "/internal/research/review"));
  router.get(`${PREFIX}/system-events`, readers, (req, res) => void passthrough(req, res, "/internal/research/system-events"));
  router.get(`${PREFIX}/evidence`, readers, (req, res) => void passthrough(req, res, "/internal/research/evidence"));

  router.get(`${PREFIX}/snapshots/:lens`, readers, (req: ConsoleRequest, res: Response) => {
    const lens = String(req.params.lens);
    if (!LENSES.includes(lens)) {
      res.status(400).json({ error: "unknown_lens" });
      return;
    }
    void passthrough(req, res, `/internal/research/snapshots/${lens}`);
  });

  router.get(`${PREFIX}/insights/:id`, readers, (req: ConsoleRequest, res: Response) => {
    const id = String(req.params.id);
    if (!SAFE_ID.test(id)) {
      res.status(400).json({ error: "bad_id" });
      return;
    }
    void passthrough(req, res, `/internal/research/insights/${id}`);
  });

  router.get(`${PREFIX}/runs/:id`, readers, (req: ConsoleRequest, res: Response) => {
    const id = String(req.params.id);
    if (!SAFE_ID.test(id)) {
      res.status(400).json({ error: "bad_id" });
      return;
    }
    void passthrough(req, res, `/internal/research/runs/${encodeURIComponent(id)}`);
  });

  /*
   * 打开单条证据：读者角色够，但**记审计**。
   * 里面是车主说过的话（已脱敏），谁翻过哪一条要留痕。
   */
  router.get(
    `${PREFIX}/evidence/:unitId`,
    auditAction("research.evidence.open"),
    readers,
    (req: ConsoleRequest, res: Response) => {
      const id = String(req.params.unitId);
      if (!SAFE_ID.test(id)) {
        res.status(400).json({ error: "bad_id" });
        return;
      }
      void passthrough(req, res, `/internal/research/evidence/${id}`);
    },
  );

  // ── 写：admin + 审计 ────────────────────────────────
  router.post(
    `${PREFIX}/contracts`,
    auditAction("research.contract.create"),
    requireRole("admin"),
    (req: ConsoleRequest, res: Response) => void passthrough(req, res, "/internal/research/contracts", jsonPost(req)),
  );

  router.post(
    `${PREFIX}/runs`,
    auditAction("research.run.start"),
    requireRole("admin"),
    (req: ConsoleRequest, res: Response) => void passthrough(req, res, "/internal/research/runs", jsonPost(req)),
  );

  router.post(
    `${PREFIX}/review/:threadId/resume`,
    auditAction("research.review.resume"),
    requireRole("admin"),
    (req: ConsoleRequest, res: Response) => {
      const id = String(req.params.threadId);
      if (!SAFE_ID.test(id)) {
        res.status(400).json({ error: "bad_id" });
        return;
      }
      // 第五个参数就是那条债的修复点：决定人由这一跳注入，不由客户端带。
      void passthrough(req, res, `/internal/research/review/${encodeURIComponent(id)}/resume`, jsonPost(req), true);
    },
  );

  /*
   * 能力调用。**按写操作对待**：它烧 token、可能落库、且 `✎` 层的产物会
   * 带上决定人。读者角色能看数，但不能让系统替他做事。
   */
  router.post(
    `${PREFIX}/capabilities/:capability`,
    auditAction("research.capability.run"),
    requireRole("admin"),
    (req: ConsoleRequest, res: Response) => {
      const name = String(req.params.capability);
      if (!SAFE_CAPABILITY.test(name)) {
        res.status(400).json({ error: "bad_capability" });
        return;
      }
      void passthrough(req, res, `/internal/research/capabilities/${name}`, jsonPost(req), true);
    },
  );

  /*
   * 运行流**不走 `passthrough`**，两个原因叠加，缺一条都还能凑合：
   *  ① `passthrough` 每次请求挂 `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)`，
   *     而一次 `✎` 运行 10–60 秒，必然在第 5 秒被掐断；掐断后回的是
   *     503 `research_unreachable`——那句话的意思是"服务该起没起"，
   *     和"跑得比较久"是两回事，照抄会得到一个说谎的错误码。
   *  ② 它用 `Buffer.from(await r.arrayBuffer())` 把整个响应体读完再发，
   *     流式响应会被缓冲到结束，进度事件一条都不会提前到达。
   *
   * **没有动 `UPSTREAM_TIMEOUT_MS` 的值**：调大它会让所有读端点在服务挂掉时
   * 慢 60 秒才报错，那是拿全局换局部。这里单开一条，形状照 `trace-stream.ts`。
   */
  router.get(`${PREFIX}/runs/:id/stream`, readers, async (req: ConsoleRequest, res: Response) => {
    const id = String(req.params.id);
    if (!SAFE_ID.test(id)) {
      res.status(400).json({ error: "bad_id" });
      return;
    }
    const up = await upstream(deps.config);
    if (!up.ok) {
      res.status(503).json({ error: up.error });
      return;
    }

    const abort = new AbortController();
    let source: globalThis.Response;
    try {
      source = await fetchImpl(`${up.base}/internal/research/runs/${encodeURIComponent(id)}/stream`, {
        signal: abort.signal,
        headers: { accept: "text/event-stream" },
      });
    } catch (e) {
      res.status(503).json({ error: "research_unreachable", detail: e instanceof Error ? e.message : String(e) });
      return;
    }
    // 上游的 404 `run_not_found` 要原样传下去：它和"服务没起"是两件事。
    if (!source.ok || !source.body) {
      res.status(source.status === 404 ? 404 : 503);
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.send(Buffer.from(await source.arrayBuffer()));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    let closed = false;
    const heartbeat = setInterval(() => res.write(": hb\n\n"), HEARTBEAT_MS);
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      abort.abort();
    };
    req.on("close", close);

    const reader = source.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        // **按字节透传**，不解析帧：网关在这条流上不加业务，
        // 解析一遍就意味着上游加一种事件、这里要跟着改一次。
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* 上游断开：走 finally 收摊 */
    } finally {
      close();
      res.end();
    }
  });

  return router;
}
