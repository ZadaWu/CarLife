/**
 * ⑥用车流水上报入口（施工单 M11-01，§7⑥ 两段式的第一段）。
 *
 * # 这一段此前完全不存在
 *
 * 两段式的第二段（`trips` 表、`usage_profile` 工具、聚合任务、双路消费端）M7 全部交付且实测有效，
 * 但**端上没有任何办法把行程送进来**：全仓搜 `ingestTrip` 只有 `enterprise/backend/shared/memory` 自身与其单测。
 * 于是 `trips` 里那 66 条全部来自 `demo:seed`，而已实现的 `usage-aggregation`
 * 在真实部署里只会在一张空表上跑，产出永远是"样本不足"。
 *
 * # 网关只做协议转换与鉴权（§3）
 *
 * 校验用 `@carlife/memory` 的 `validateTrip`，落库用 `@carlife/db` 的 `TripRepository`。
 * 这里一行业务规则都不写——规则写在这里就等于有了第二份，两份迟早不一致。
 */

import { Router, json } from "express";
import type { Response } from "express";

import {
  ingestTrip,
  TripValidationError,
  type MemberStore,
  type TripInput,
  type TripStore,
} from "@carlife/memory";

import type { AuthedRequest } from "../auth";

/**
 * 单批上限。
 *
 * 端上会攒一批再传（弱网下尤其如此），但一次几千条既拖垮请求也让部分成功的结果难读。
 * 100 条足够覆盖"离线一整天再上线"的场景（一天几十段行程已经很多了）。
 */
export const MAX_BATCH = 100;

/** 上报项：`TripInput` 去掉 userId（服务端注入），加上端上生成的稳定 id。 */
type ReportedTrip = Omit<TripInput, "userId"> & { id?: unknown };

export interface TripReportResult {
  accepted: number;
  rejected: Array<{ id: string; reason: string }>;
}

/**
 * `members` 可选（施工单 M17-02）：传了就校验人员归属属于同一辆车，
 * 不传则跳过那层校验。**⑥的写入不该因为人员表不可用而失败**——
 * 归属是增强信息，行程本身才是要保住的那份数据。
 */
export function createTelemetryRouter(trips: TripStore, members?: MemberStore): Router {
  const router = Router();

  /**
   * `POST /v1/telemetry/trips`
   *
   * 三条硬约束，每条都对应一种"看起来正常但数据是错的"结局：
   *
   * 1. **userId 取自鉴权上下文，不接受请求体里的**。否则任何客户端都能往别人账下写流水，
   *    而跨用户混算是严重事故（F-21-12）。
   * 2. **id 必须由端上给且稳定**。`append` 是 upsert 语义，重发同一条行程才会幂等覆盖；
   *    服务端随机生成 id 会让一次弱网重试变成两条重复流水，日均里程直接翻倍。
   * 3. **一条非法不让整批失败**。端上攒的批次里混进一条脏数据是常态，
   *    整批拒绝会让端上无限重试同一批，越积越多。
   */
  router.post("/v1/telemetry/trips", json({ limit: "1mb" }), async (req: AuthedRequest, res: Response) => {
    const userId = req.userId;
    if (!userId) {
      // 理论上到不了这里（demoAuth 在前），但缺用户维度绝不能落库。
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const body = req.body as { trips?: unknown };
    if (!Array.isArray(body?.trips)) {
      res.status(400).json({ error: "invalid_body", detail: "需要 { trips: [...] }" });
      return;
    }
    if (body.trips.length === 0) {
      res.status(400).json({ error: "empty_batch" });
      return;
    }
    if (body.trips.length > MAX_BATCH) {
      res.status(413).json({ error: "batch_too_large", max: MAX_BATCH, got: body.trips.length });
      return;
    }

    const result: TripReportResult = { accepted: 0, rejected: [] };

    for (const raw of body.trips as ReportedTrip[]) {
      const id = typeof raw?.id === "string" ? raw.id.trim() : "";
      if (!id) {
        result.rejected.push({
          id: "(缺失)",
          reason: "缺少 id。id 必须由端上生成且重试时保持不变，否则重复上报会变成两条行程",
        });
        continue;
      }

      // **丢掉请求体里的 userId**（如果有）：归属只认鉴权上下文。
      const { id: _ignored, userId: _spoofed, ...rest } = raw as ReportedTrip & { userId?: unknown };
      const trip = { ...rest, userId } as TripInput;

      try {
        await ingestTrip(trips, id, trip, { members });
        result.accepted += 1;
      } catch (err) {
        // 校验失败要说清是哪一条规则——"数据非法"这种话让端上无从修起。
        const reason =
          err instanceof TripValidationError
            ? err.message
            : `落库失败：${err instanceof Error ? err.message : String(err)}`;
        result.rejected.push({ id, reason });
      }
    }

    console.log(
      `[telemetry] trips user=${userId} accepted=${result.accepted} rejected=${result.rejected.length}`,
    );
    // 部分成功仍是 200：端上据 `rejected` 决定丢弃哪几条，而不是整批重试。
    res.status(200).json(result);
  });

  return router;
}
