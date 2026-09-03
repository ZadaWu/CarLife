/**
 * 导览后台任务通道（ACR-008）。
 *
 * `GET  /v1/guide/jobs`        —— 当前行程逐景点的采集进度/状态（前端进度条轮询它）。
 * `POST /v1/guide/jobs/trigger`—— 手动「获取」：未处理/失败的景点点按钮走这里。
 *
 * 网关红线不变：鉴权 → 查仓储（当前行程归属只认鉴权身份）→ 转发 runtime → 原样返回。
 * 状态查询是轮询面：任何失败一律 200 + `jobs: null`（前端收起进度区），
 * 5xx 会把"队列没开"渲染成一片报错（trip-plan/guide.ts 同款取舍）。
 */

import { Router, json } from "express";
import type { Response } from "express";

import type { GuideJobsResponse } from "@carlife/shared";
import type { TripPlanRepository } from "@carlife/db";

import type { AuthedRequest } from "../auth";
import { planContextFor } from "./guide";

/** 状态查询走快路径（runtime 只读 pg-boss + 缓存在场），10s 足够。 */
const STATUS_TIMEOUT_MS = 10_000;

export function createGuideJobsRouter(
  plans: TripPlanRepository,
  /** runtime 内部地址；不传 = 无采集面，一律 jobs:null / failed。 */
  runtimeUrl?: string,
): Router {
  const router = Router();

  async function postRuntime<T>(path: string, body: unknown, timeoutMs: number): Promise<T | null> {
    if (!runtimeUrl) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(`${runtimeUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!r.ok) return null; // 503（队列关）与 5xx 对前端是同一件事：没有任务面
      return (await r.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  router.get("/v1/guide/jobs", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const current = await plans.currentForUser(req.userId).catch(() => null);
    if (!current) {
      // 没有已确认行程不是错误——前端据此不渲染进度区。
      res.json({ jobs: null } satisfies GuideJobsResponse);
      return;
    }
    const reply = await postRuntime<{ jobs: GuideJobsResponse["jobs"] }>(
      "/internal/guide/jobs-status",
      { plan: current.plan },
      STATUS_TIMEOUT_MS,
    );
    res.json({ planId: current.planId, jobs: reply?.jobs ?? null } satisfies GuideJobsResponse);
  });

  router.post("/v1/guide/jobs/trigger", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = (req.body ?? {}) as { spotName?: unknown };
    const spotName = typeof body.spotName === "string" ? body.spotName.trim() : "";
    if (!spotName) {
      res.status(400).json({ error: "missing_spot_name" });
      return;
    }
    // 行程上下文（城市/出发日）由网关从当前行程补——按钮只需要说"哪个景点"。
    const current = await plans.currentForUser(req.userId).catch(() => null);
    const reply = await postRuntime<{ spot: unknown }>(
      "/internal/guide/enqueue",
      {
        spotName,
        ...(current?.plan.destination ? { city: current.plan.destination } : {}),
        ...(current?.plan.startDate ? { date: current.plan.startDate } : {}),
        selfDrive: true,
        ...planContextFor(current?.plan, spotName),
      },
      STATUS_TIMEOUT_MS,
    );
    res.json({
      spot: reply?.spot ?? { spotName, state: "failed", note: "后台采集暂不可用" },
    });
  });

  return router;
}
