/**
 * 拍照问诊报告只读端点（施工单 M104-02，F-20-15）。
 *
 * `GET /v1/session/:id/diagnosis` —— 手机端引导卡 / 报告页 / 追问钉顶条的唯一入口。
 * 与 `buying.ts` 同形：报告在编排层已经是结构化的（图状态 `diagnosis` 通道），这里只代理
 * runtime 的 `/internal/diagnosis/:id`，**不加工**——加工一半会让页面与编排层分家。
 *
 * 三件事盯死：「还没问过诊」是常态 → 200 `{report:null}`；runtime 挂 → 502（读不到 ≠ 没有）；
 * 会话不存在 → 404。
 */

import { Router } from "express";
import type { Response } from "express";

import type { ChatRepository } from "@carlife/db";

import type { AuthedRequest } from "../auth";

function runtimeUrl(): string {
  return process.env.AGENT_RUNTIME_URL ?? "http://localhost:8788";
}

export function createDiagnosisRouter(repo: ChatRepository): Router {
  const router = Router();

  router.get("/v1/session/:id/diagnosis", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const sessionId = String(req.params.id);
    if (!(await repo.sessionExists(sessionId))) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    try {
      const r = await fetch(`${runtimeUrl()}/internal/diagnosis/${encodeURIComponent(sessionId)}`);
      if (!r.ok) {
        res.status(502).json({ error: "runtime_unavailable" });
        return;
      }
      res.json(await r.json());
    } catch {
      res.status(502).json({ error: "runtime_unreachable" });
    }
  });

  return router;
}
