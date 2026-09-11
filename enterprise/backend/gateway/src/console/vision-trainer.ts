/**
 * 检测器训练服务的代理 `/console/vision-trainer/*`（ACR-026 / 施工单 M76-02）。
 *
 * # 网关只做鉴权与透传
 *
 * 训练服务（`enterprise/backend/vision-trainer`，Python）只绑 localhost、自己没有鉴权；业务逻辑全在它那边。
 * 这里：读走 `CONSOLE_READERS`，写（发起 / 取消 / 删除）走 `admin` 并审计；JSON、字节、SSE 原样透传。
 *
 * # 「没配」和「没起」是两个错
 *
 * 页面要分得出「这个部署没启用这项功能」和「服务该起没起」——前者是配置，后者是运维动作。
 * 所以 URL 为空**仍然挂路由**，回 503 `vision_trainer_not_configured`；配了但连不上回 503 `vision_trainer_unreachable`。
 * 与 `evals` 那种"不注入就不挂"不同：不挂路由的 404 分不出这两件事。
 *
 * # 路径白名单
 *
 * 只转发列出的形状；`jobs/:id/files/*` 的尾巴不允许 `..`。URL 每次请求从 ConfigStore 读（后台可热改）。
 */

import { Readable } from "node:stream";

import { raw, Router, type Request, type Response } from "express";

import type { ConfigStore } from "@carlife/db";

import { requireAnyRole, requireRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { auditAction } from "./audit";

export interface VisionTrainerDeps {
  config: Pick<ConfigStore, "get">;
  /** 测试注入；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
}

const PREFIX = "/console/vision-trainer";
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const FILE_NAME = /^(?:[A-Za-z0-9_-]+\.(?:png|jpg|csv|json|jsonl|log)|weights\/(?:best|last)\.(?:pt|onnx))$/;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

type Upstream = { ok: true; base: string } | { ok: false; error: "vision_trainer_not_configured" };

async function upstream(config: Pick<ConfigStore, "get">): Promise<Upstream> {
  const v = ((await config.get("VISION_TRAINER_URL").catch(() => undefined)) ?? "").trim();
  if (!v) return { ok: false, error: "vision_trainer_not_configured" };
  return { ok: true, base: v.replace(/\/+$/, "") };
}

function sendUnreachable(res: Response, detail: string): void {
  res.status(503).json({ error: "vision_trainer_unreachable", detail });
}

export function createVisionTrainerRouter(deps: VisionTrainerDeps): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? fetch;

  /** 普通请求：状态码、content-type、body 原样回；连接失败 → 503 unreachable。 */
  async function passthrough(req: ConsoleRequest, res: Response, path: string, init: RequestInit = {}): Promise<void> {
    const up = await upstream(deps.config);
    if (!up.ok) {
      res.status(503).json({ error: up.error });
      return;
    }
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    let r: globalThis.Response;
    try {
      r = await fetchImpl(`${up.base}${path}${qs}`, init);
    } catch (e) {
      sendUnreachable(res, e instanceof Error ? e.message : String(e));
      return;
    }
    res.status(r.status);
    const type = r.headers.get("content-type");
    if (type) res.setHeader("content-type", type);
    const len = r.headers.get("content-length");
    if (len) res.setHeader("content-length", len);
    res.send(Buffer.from(await r.arrayBuffer()));
  }

  const readers = requireAnyRole(CONSOLE_READERS);

  router.get(`${PREFIX}/health`, readers, (req: ConsoleRequest, res: Response) => void passthrough(req, res, "/health"));
  router.get(`${PREFIX}/models`, readers, (req: ConsoleRequest, res: Response) => void passthrough(req, res, "/models"));
  router.get(`${PREFIX}/datasets`, readers, (req: ConsoleRequest, res: Response) => void passthrough(req, res, "/datasets"));
  router.get(`${PREFIX}/photos`, readers, (req: ConsoleRequest, res: Response) => void passthrough(req, res, "/photos"));
  router.get(`${PREFIX}/photos/:id/image`, readers, (req: ConsoleRequest, res: Response) => {
    const id = String(req.params.id);
    if (!ID.test(id)) {
      res.status(400).json({ error: "bad_id" });
      return;
    }
    void passthrough(req, res, `/photos/${id}/image`);
  });
  router.get(`${PREFIX}/jobs`, readers, (req: ConsoleRequest, res: Response) => void passthrough(req, res, "/jobs"));
  router.get(`${PREFIX}/jobs/:id`, readers, (req: ConsoleRequest, res: Response) => {
    const id = String(req.params.id);
    if (!ID.test(id)) {
      res.status(400).json({ error: "bad_id" });
      return;
    }
    void passthrough(req, res, `/jobs/${id}`);
  });
  // Express 4 的通配是裸 `*`，值在 params[0]（已解码，`..%2F` 到这里就是 `../`，白名单正则拦得住）。
  router.get(`${PREFIX}/jobs/:id/files/*`, readers, (req: ConsoleRequest, res: Response) => {
    const id = String(req.params.id);
    const name = String((req.params as Record<string, string | undefined>)[0] ?? "");
    if (!ID.test(id) || !FILE_NAME.test(name)) {
      res.status(400).json({ error: "file_not_allowed" });
      return;
    }
    void passthrough(req, res, `/jobs/${id}/files/${name}`);
  });

  router.post(`${PREFIX}/jobs`, auditAction("vision-trainer.job"), requireRole("admin"), (req: ConsoleRequest, res: Response) => {
    void passthrough(req, res, "/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body ?? {}) });
  });
  router.delete(`${PREFIX}/jobs/:id`, auditAction("vision-trainer.job"), requireRole("admin"), (req: ConsoleRequest, res: Response) => {
    const id = String(req.params.id);
    if (!ID.test(id)) {
      res.status(400).json({ error: "bad_id" });
      return;
    }
    void passthrough(req, res, `/jobs/${id}`, { method: "DELETE" });
  });

  // 试推理：只读动作（不产生持久产物），读者角色即可。二进制 body 要在这里单独接——console router 挂的是 json()。
  router.post(`${PREFIX}/predict`, readers, raw({ type: IMAGE_TYPES, limit: "20mb" }), (req: ConsoleRequest, res: Response) => {
    const type = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const body = Buffer.isBuffer(req.body) ? (req.body as Buffer) : undefined;
    if (body && body.length > 0) {
      void passthrough(req, res, "/predict", { method: "POST", headers: { "content-type": type }, body: new Uint8Array(body) });
      return;
    }
    // 没有 body：只能是 photo=<评测集 id> 的形态；让服务自己校验
    void passthrough(req, res, "/predict", { method: "POST" });
  });

  // SSE：拿上游的流逐块写给客户端；客户端断开就 abort 上游。
  router.get(`${PREFIX}/jobs/:id/stream`, readers, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!ID.test(id)) {
      res.status(400).json({ error: "bad_id" });
      return;
    }
    const up = await upstream(deps.config);
    if (!up.ok) {
      res.status(503).json({ error: up.error });
      return;
    }
    const abort = new AbortController();
    // 用 res 的 close 而不是 req 的：Node 16 起 IncomingMessage 的 close 在请求体被读完时就发，那时连接还开着；
    // 只有 res 的 close 才对应"客户端真的断了"。
    res.on("close", () => abort.abort());
    let r: globalThis.Response;
    try {
      r = await fetchImpl(`${up.base}/jobs/${id}/stream`, { signal: abort.signal, headers: { accept: "text/event-stream" } });
    } catch (e) {
      sendUnreachable(res, e instanceof Error ? e.message : String(e));
      return;
    }
    if (!r.ok || !r.body) {
      res.status(r.status);
      res.setHeader("content-type", r.headers.get("content-type") ?? "application/json");
      res.send(Buffer.from(await r.arrayBuffer()));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const stream = Readable.fromWeb(r.body as import("node:stream/web").ReadableStream);
    stream.on("error", () => res.end());
    stream.pipe(res);
  });

  return router;
}
