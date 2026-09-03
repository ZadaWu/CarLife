/**
 * middleware —— 请求日志（施工单 M2-02）。
 *
 * 每条日志带 `session_id`（§3"贯穿全链路，关联短期记忆与日志"）——
 * 这是排障与审计的唯一线头（FL-07）。限流/熔断归 FL-10，本 Sprint 不做。
 */

import type { NextFunction, Request, Response } from "express";

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  res.on("finish", () => {
    // 中间件层 req.params 未填充（路由匹配前），从路径提取。
    const sessionId = /^\/v1\/session\/([^/]+)/.exec(req.path)?.[1] ?? "-";
    /*
     * `by=` 说出**这条请求是谁发的**（施工单 M54-04）。
     *
     * 2026-09-01 排障：车机与手机同时连着，日志里一片 401 夹着 200，
     * 而两台设备发的请求长得一模一样——"这个 401 是车机的还是手机的"
     * 这个问题当场无法回答，只能靠猜端点归属。一条线索都没有的日志，
     * 在多端场景下等于没有日志。
     *
     * 鉴权中间件跑在本中间件之后，所以这些字段在 finish 时才填好——
     * 放在 `res.on("finish")` 里读是必须的，不能在 next() 之前读。
     *
     * **不打 token、不打完整 VIN**：日志会被复制进工单和聊天记录。
     * 车机打 vin 末 4 位（够定位是哪辆车），人打 userId 前 8 位。
     */
    const a = req as AuthedLike;
    const by = a.tokenKind === "vehicle"
      ? `车机:${a.vehicleVin?.slice(-4) ?? "?"}`
      : a.userId
        ? `人:${a.userId.slice(0, 8)}`
        : "未鉴权";
    console.log(
      `[gateway] ${req.method} ${req.path} by=${by} session=${sessionId} status=${res.statusCode} ${Date.now() - startedAt}ms`,
    );
  });
  next();
}

/** 鉴权中间件往 req 上挂的那几个字段（`enterprise/backend/gateway/src/auth` 的 `AuthedRequest`）。 */
interface AuthedLike {
  userId?: string;
  vehicleVin?: string;
  tokenKind?: "user" | "vehicle";
}
