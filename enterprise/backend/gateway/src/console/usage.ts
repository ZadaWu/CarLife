/**
 * 用量与成本视图接口（施工单 M3-06，F-36-07 / F-10-09 子集）。
 *
 * 明确一条职责边界（AC-44-13）：**指标可采样可丢失，审计逐条不可丢失**。
 * 这里返回的是聚合值，出事时的逐条事实以 `/console/audit` 为准。
 */

import { Router } from "express";
import type { Response } from "express";

import type { UsageRepository } from "@carlife/db";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";

export function createUsageRouter(usage: UsageRepository): Router {
  const router = Router();

  router.get(
    "/console/usage",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const dim = req.query.dimension;
      const dimension =
        dim === "agent" || dim === "provider" || dim === "day" ? dim : "model";

      const parseDate = (v: unknown): Date | undefined => {
        if (typeof v !== "string") return undefined;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? undefined : d;
      };

      res.json({
        dimension,
        ...(await usage.summary({
          dimension,
          since: parseDate(req.query.since),
          until: parseDate(req.query.until),
        })),
        note: "聚合值，可能采样；逐条事实以操作审计为准（AC-44-13）",
      });
    },
  );

  return router;
}
