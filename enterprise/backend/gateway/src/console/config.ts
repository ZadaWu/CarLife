/**
 * 配置读写路由（施工单 M3-02）—— **admin 独有**。
 *
 * `GET  /console/config`  掩码 + 来源 + 验证状态（AC-35-5）
 * `POST /console/config`  逐项写入，逐项返回拒绝原因
 *
 * ops 在这里一律 403：让运营持有"把审核/模型指向任意端点"的能力，
 * 等于给内容安全开后门（§8.2 配置的字段级分权）。
 */

import { Router } from "express";
import type { Response } from "express";

import type { AuditRepository, ConfigStore, ConfigWrite } from "@carlife/db";

import { requireRole, type ConsoleRequest } from "../auth/console";
import { auditAction, auditLocals } from "./audit";

interface WriteBody {
  items?: Array<{ key?: unknown; value?: unknown }>;
  /** 探活未通过时由界面显式置 true —— 该项将被标记为"未验证"（AC-35-6） */
  forced?: boolean;
}

export function createConfigRouter(store: ConfigStore, _audit: AuditRepository): Router {
  const router = Router();

  router.get("/console/config", requireRole("admin"), async (_req: ConsoleRequest, res: Response) => {
    res.json({ items: await store.displayItems() });
  });

  router.post(
    "/console/config",
    auditAction("config.update"),
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      const body = (req.body ?? {}) as WriteBody;
      if (!Array.isArray(body.items)) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }

      const writes: ConfigWrite[] = [];
      for (const item of body.items) {
        if (typeof item?.key !== "string" || typeof item?.value !== "string") {
          res.status(400).json({ error: "invalid_item" });
          return;
        }
        writes.push({ key: item.key, value: item.value });
      }

      const actor = req.console?.subject ?? "unknown";
      const result = await store.write(writes, actor, { verified: body.forced !== true });

      // 审计只记项名与结果——**A 类的值永远不进审计**（AC-35-8）。
      auditLocals(res).auditTarget = result.accepted.join(",") || "(none)";
      auditLocals(res).auditDetail = {
        accepted: result.accepted,
        rejected: result.rejected.map((r) => r.key),
        forced: body.forced === true,
      };

      res.json(result);
    },
  );

  // ── 变更历史与回滚（M3-06 F-35-07）
  router.get(
    "/console/config/:key/revisions",
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      res.json({ revisions: await store.revisions(String(req.params.key)) });
    },
  );

  router.post(
    "/console/config/:key/rollback",
    auditAction("config.rollback"),
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      const key = String(req.params.key);
      const result = await store.rollback(key, req.console?.subject ?? "unknown");
      auditLocals(res).auditTarget = key;
      // 回滚值本身不进审计 detail：B 类是端点/模型名，也没必要留在审计里
      auditLocals(res).auditDetail = { ok: result.ok, reason: result.reason };
      res.status(result.ok ? 200 : 409).json(result);
    },
  );

  return router;
}
