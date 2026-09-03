/**
 * 多模态上传（施工单 M8-04，§3 / FL-09）。
 *
 * 高鹏拍一张故障灯照片、说一句"咔哒咔哒，凉车明显"，两者要一起到达 Agent。
 * 本模块做的是这条通路。
 *
 * # 三条硬性质
 *
 * 1. **网关只接收与转存，不解析内容**（AC-09-8）。见 `storage.ts` 的说明。
 * 2. **句柄不可枚举**（F-09-02），且**句柄不是授权凭证**——取件仍比对归属。
 *    两道一起：猜不到，猜到了也拿不到别人的。
 * 3. **绝不静默丢弃用户拍的照片**（F-09-05）。幂等键让弱网重传不产生重复记录，
 *    重传同一个幂等键直接返回原句柄——端上因此可以放心重试。
 *
 * # 大文件不进 LLM 上下文（§3）
 *
 * 上传返回的是**句柄**，Agent 拿到的也是句柄。需要看内容时它自己去取。
 * 把图片 base64 塞进上下文会同时炸掉成本与上下文窗口。
 */

import { Router, type Response } from "express";

import type { AttachmentRepository } from "@carlife/db";

import type { AuthedRequest } from "../auth";
import { checkUpload, newHandle, objectKeyFor, type AttachmentKind } from "./policy";
import type { ObjectStore } from "./storage";

export { createObjectStore, type ObjectStore, type StorageConfig } from "./storage";
export { checkUpload, newHandle, objectKeyFor, LIMITS, type AttachmentKind, type PolicyVerdict } from "./policy";

/** 单次请求体上限：比最大的白名单项再宽一点，防止在读完之前就被截断。 */
const BODY_LIMIT = 40 * 1024 * 1024;

async function readBody(req: AuthedRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    total += chunk.length;
    // 提前掐断，不把 40MB 之外的东西读进内存——
    // 这一条与白名单无关，它防的是恶意的超大 body。
    if (total > BODY_LIMIT) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createUploadRouter(store: ObjectStore, repo: AttachmentRepository): Router {
  const router = Router();

  /**
   * 上传。用原始 body + 头部元数据，不用 multipart：
   * 一次请求只传一个文件，multipart 的解析依赖会把"不解析内容"这条红线弄模糊。
   *
   *   POST /v1/session/:id/attachments
   *   headers: content-type, x-filename?, x-turn-id?, x-idempotency-key?
   */
  router.post("/v1/session/:id/attachments", async (req: AuthedRequest, res: Response) => {
    const sessionId = String(req.params.id);
    // M48-02：兜底已删。车辆级 token 无归属，附件必须挂在具体的人名下。
    const userId = req.userId;
    if (!userId) {
      res.status(400).json({ error: "active_user_required" });
      return;
    }
    const contentType = String(req.headers["content-type"] ?? "");
    const idempotencyKey = header(req, "x-idempotency-key");

    // 幂等先于一切：弱网重传必须**直接返回原句柄**，
    // 而不是再传一遍再产生第二条记录（F-09-05）。
    if (idempotencyKey) {
      const existing = await repo.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        res.status(200).json({ handle: existing.id, kind: existing.kind, bytes: existing.bytes, deduped: true });
        return;
      }
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.status(413).json({ error: "too_large", reason: "文件太大，传输被中断了。" });
      return;
    }

    const verdict = checkUpload(contentType, body.length);
    if (!verdict.ok) {
      // 视频单独给 415 + 引导文案（约束 4）：用户会本能地拍视频，
      // 回一句"格式不支持"他只会觉得 App 坏了。
      res.status(verdict.code === "too_large" ? 413 : 415).json({
        error: verdict.code,
        reason: verdict.reason,
      });
      return;
    }

    const kind = verdict.kind as AttachmentKind;
    const handle = newHandle();
    const objectKey = objectKeyFor(kind, handle);

    // 先落对象存储再写元数据：反过来的话，元数据存在而文件不在，
    // 用户会看到一个点开就 404 的附件——比"上传失败"更难排查。
    await store.put(objectKey, body, contentType);
    await repo.create({
      id: handle,
      sessionId,
      turnId: header(req, "x-turn-id"),
      userId,
      kind,
      contentType: contentType.split(";")[0].trim(),
      bytes: body.length,
      filename: decodeFilename(header(req, "x-filename")),
      objectKey,
      idempotencyKey,
    });

    res.status(201).json({ handle, kind, bytes: body.length });
  });

  /**
   * 取件。**句柄不是授权凭证**——这里比对归属。
   *
   * 回看以句柄向对象存储取原件，**不依赖端上缓存**（F-09-09）：
   * 端上缓存会被 LRU 淘汰，而高鹏两周后才想起来要看那张照片。
   */
  router.get("/v1/attachments/:handle", async (req: AuthedRequest, res: Response) => {
    const handle = String(req.params.handle);
    // M48-02：兜底已删。车辆级 token 无归属，附件必须挂在具体的人名下。
    const userId = req.userId;
    if (!userId) {
      res.status(400).json({ error: "active_user_required" });
      return;
    }

    const meta = await repo.get(handle);
    // **归属不符与不存在返回同一个 404**：区分二者等于确认"这个句柄存在"，
    // 那正好给了枚举者他想要的信号。
    if (!meta || meta.userId !== userId) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const obj = await store.get(meta.objectKey);
    if (!obj) {
      res.status(410).json({ error: "gone", reason: "文件已不在存储中。" });
      return;
    }

    res.setHeader("content-type", meta.contentType);
    res.setHeader("content-length", String(obj.body.length));
    // 一律作为附件下载，不内联渲染：用户上传的 HTML/SVG 内联渲染会变成 XSS。
    res.setHeader("content-disposition", "attachment");
    res.status(200).end(Buffer.from(obj.body));
  });

  /** 某轮 / 某会话的附件列表——历史回看的入口。 */
  router.get("/v1/session/:id/attachments", async (req: AuthedRequest, res: Response) => {
    const sessionId = String(req.params.id);
    // M48-02：兜底已删。车辆级 token 无归属，附件必须挂在具体的人名下。
    const userId = req.userId;
    if (!userId) {
      res.status(400).json({ error: "active_user_required" });
      return;
    }
    const turnId = typeof req.query.turnId === "string" ? req.query.turnId : undefined;
    res.json({ attachments: await repo.list(sessionId, userId, turnId) });
  });

  return router;
}

function header(req: AuthedRequest, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim().length > 0 ? s.trim() : undefined;
}

/**
 * 文件名走 **percent-encoding**。
 *
 * HTTP 头是 ByteString（每字符 ≤ 255），而"故障灯.png"这种名字对我们的用户是常态——
 * 直接塞进头里连请求都发不出去（fetch 在客户端就抛）。
 * 所以约定 `x-filename` 是 `encodeURIComponent` 后的值。
 *
 * 解码失败不报错、退回原值：文件名只用于展示，
 * **不该因为一个名字没编码好就把用户拍的照片拒掉**（F-09-05 边界）。
 */
function decodeFilename(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
