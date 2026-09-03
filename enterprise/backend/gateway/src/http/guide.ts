/**
 * 景区导览触发通道（施工单 M36-02）。
 *
 * `POST /v1/guide/brief` —— 点击景点的唯一入口。网关红线不变：
 * 鉴权 → 参数校验 → 转发 runtime → **原样返回 brief**。不拼时间轴、不调工具——
 * 投影是 shared 的纯函数（端上调用），采集是 runtime 的事。
 *
 * # 为什么同步挂等而不是两段式
 *
 * 冷启真跑实测 ~50s（三分支并行取最慢，runtime 分支预算 90s）、缓存命中 11ms。
 * 100s 的挂等预算盖得住冷启；端上的"采集中"占位态兜观感。回包契约里留了
 * `collecting` 位（`GuideBriefStatus`），日后改两段式端上不用二次适配。
 *
 * # 失败一律 200 + status:"failed"
 *
 * runtime 没起 / 超时 / skipped，对端上是同一件事：这次没有导览页。
 * 5xx 会让端上把"景区太冷门没查到"渲染成一次报错（trip-plan.ts 同款取舍）。
 */

import { Router, json } from "express";
import type { Response } from "express";

import type { GuideBriefResponse } from "@carlife/shared";
import type { TripPlanRepository } from "@carlife/db";

import type { AuthedRequest } from "../auth";

/** 网关侧挂等预算：runtime 分支硬超时 90s + 汇聚与网络余量。 */
const GUIDE_TIMEOUT_MS = 100_000;

/**
 * 行程骨架 → 景点名单（跨天去重保序）。给 runtime 传"同行程的其他景点"用——
 * 小景点不拆 + 跨页去重（2026-08-29 走查，规则本体在 runtime 的 subgraphs/guide.ts）。
 * 与 runtime guide-queue 的 planSpots 同构；网关不 import runtime，故各留一份。
 */
export function planSpotNames(plan: {
  skeleton?: Array<{ spots?: Array<{ name?: string }> }>;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const day of plan.skeleton ?? []) {
    for (const s of day.spots ?? []) {
      const name = s.name?.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

/**
 * 行程上下文（兄弟景点 + 上一站 + 是否末站），给 runtime 的采集提示词用
 * （2026-08-29 走查：到达动作跨页重复、中途站出现返程建议）。
 * 景点不在当前行程里（演示入口 `?guide=`）时给空——没有行程就没有"上一站"。
 */
export function planContextFor(
  plan: { skeleton?: Array<{ spots?: Array<{ name?: string }> }> } | undefined,
  spotName: string,
): { siblingSpots?: string[]; prevSpot?: string; isLastStop?: boolean } {
  if (!plan) return {};
  const names = planSpotNames(plan);
  const idx = names.indexOf(spotName);
  const sibs = names.filter((n) => n !== spotName);
  return {
    ...(sibs.length > 0 ? { siblingSpots: sibs } : {}),
    ...(idx > 0 ? { prevSpot: names[idx - 1] } : {}),
    ...(idx >= 0 && idx === names.length - 1 ? { isLastStop: true } : {}),
  };
}

export function createGuideRouter(
  /** runtime 内部地址；不传 = 不提供采集能力（单挂测试与降级形态回 failed）。 */
  runtimeUrl?: string,
  timeoutMs = GUIDE_TIMEOUT_MS,
  /**
   * 当前行程仓储（M40-02 走查追修）：body 没带 city/date 时从当前行程补齐——
   * ⑤缓存键按（城市+景区）构成，点击路径与队列采集路径的键必须同源，
   * 否则同一个景点两条路各查一遍（真实病例：面板 ready、点开却重新采集）。
   * 与 guide-jobs 的 trigger 同一规则；不传仓储 = 维持原样透传（测试兼容）。
   */
  plans?: TripPlanRepository,
): Router {
  const router = Router();

  router.post("/v1/guide/brief", json(), async (req: AuthedRequest, res: Response) => {
    // demoAuth 之后 userId 恒在；防御性判空是为了单独挂载测试时不静默放行。
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = (req.body ?? {}) as {
      spotName?: unknown;
      city?: unknown;
      date?: unknown;
      selfDrive?: unknown;
      /** 「重新采集」（2026-08-29）：跳过持久层与缓存，强制重采。 */
      force?: unknown;
    };
    const spotName = typeof body.spotName === "string" ? body.spotName.trim() : "";
    if (!spotName) {
      res.status(400).json({ error: "missing_spot_name" });
      return;
    }
    if (!runtimeUrl) {
      res.json({ status: "failed" } satisfies GuideBriefResponse);
      return;
    }

    // body 缺 city/date 时从当前行程补齐（缓存键同源，见 plans 参数注释）。
    const current = plans ? await plans.currentForUser(req.userId).catch(() => null) : null;
    const city =
      typeof body.city === "string" && body.city.trim()
        ? body.city.trim()
        : current?.plan.destination;
    const date =
      typeof body.date === "string" && body.date.trim()
        ? body.date.trim()
        : current?.plan.startDate;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(`${runtimeUrl}/internal/guide/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spotName,
          ...(city ? { city } : {}),
          ...(date ? { date } : {}),
          ...(typeof body.selfDrive === "boolean" ? { selfDrive: body.selfDrive } : {}),
          ...(body.force === true ? { force: true } : {}),
          ...(planContextFor(current?.plan, spotName)),
        }),
        signal: ac.signal,
      });
      if (!r.ok) {
        res.json({ status: "failed" } satisfies GuideBriefResponse);
        return;
      }
      const upstream = (await r.json()) as {
        brief?: unknown;
        cached?: boolean;
        computedAt?: string;
        skipped?: string;
      };
      if (!upstream.brief) {
        // `skipped`（采集失败）不是错误，只是这次没有导览页。
        res.json({ status: "failed" } satisfies GuideBriefResponse);
        return;
      }
      // brief **原样透传**（网关红线）：字段增减由 shared 契约管，这里不挑不拣。
      res.json({
        status: "ready",
        brief: upstream.brief,
        ...(upstream.cached !== undefined ? { cached: upstream.cached } : {}),
        ...(upstream.computedAt ? { computedAt: upstream.computedAt } : {}),
      } as GuideBriefResponse);
    } catch {
      // 超时、runtime 没起、网络抖动——一律"这次没查成"，绝不把导览页变成一次报错。
      res.json({ status: "failed" } satisfies GuideBriefResponse);
    } finally {
      clearTimeout(timer);
    }
  });

  return router;
}
