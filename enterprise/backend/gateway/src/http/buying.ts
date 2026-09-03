/**
 * 购车候选与成本的只读端点（施工单 M15-05，F-15-14）。
 *
 * `GET /v1/session/:id/buying` —— 手机端购车页的唯一入口。
 *
 * # 为什么是端点而不是让页面解析回答文本
 *
 * 解析自然语言是漂移之源：模型换个措辞，页面就少一列。
 * 候选与成本在编排层已经是结构化的（`buyingPlan` / `costPlan` 在图状态里），
 * 页面读结构，不读文字。
 *
 * # 为什么不是查库
 *
 * M13-03 的行程端点查的是 PG——因为行程**确认后会落库**。
 * 购车候选没有落库（本 Sprint 无 schema 变更），它只活在检查点里，
 * 所以这里是**代理到 runtime 的只读接口**，而不是查仓储。
 *
 * # 网关红线
 *
 * 只做 鉴权 → 转发 → 原样返回。**不做任何加工**——
 * 加工一半的结果是"页面显示的"和"编排层算的"分家。
 *
 * 没有结果返回 `200 {plan: null, cost: null}` 而不是 404：
 * "还没比过车"是常态不是异常，端上把 404 当异常会反复告警（同 M13-03 的取向）。
 */

import { Router } from "express";
import type { Response } from "express";

import type { ChatRepository } from "@carlife/db";

import type { AuthedRequest } from "../auth";

function runtimeUrl(): string {
  return process.env.AGENT_RUNTIME_URL ?? "http://localhost:8788";
}

export function createBuyingRouter(repo: ChatRepository): Router {
  const router = Router();

  router.get("/v1/session/:id/buying", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const sessionId = String(req.params.id);
    // 会话不存在与"会话里还没比过车"是两件事：前者是调用方搞错了 id，
    // 后者是常态。混成一个响应，端上就没法区分"我该重新建会话"和"我该先问一句"。
    if (!(await repo.sessionExists(sessionId))) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }

    try {
      const r = await fetch(`${runtimeUrl()}/internal/buying/${encodeURIComponent(sessionId)}`);
      if (!r.ok) {
        res.status(502).json({ error: "runtime_unavailable" });
        return;
      }
      // 原样返回。**不在这里补默认值、不做单位换算、不排序**。
      res.json(await r.json());
    } catch {
      // runtime 挂了要说清楚是"读不到"而不是"没有"——
      // 后者会让用户以为自己刚才比的车没了（同 ③偏好那条纪律）。
      res.status(502).json({ error: "runtime_unreachable" });
    }
  });

  return router;
}
