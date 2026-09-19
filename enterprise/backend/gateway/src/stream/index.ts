/**
 * stream —— SSE 下行通道（施工单 M2-02）。
 *
 * 两条流，别混：
 *
 *  - `GET /v1/session/:id/stream`：**按会话**，讲这一段对话里发生了什么，带续传窗口。
 *  - `GET /v1/events`（ACR-031）：**按账号**，只说"你的会话列表变了，重拉一次"，无续传。
 *
 * `GET /v1/session/:id/stream`：`text/event-stream`，单向下行（§3，不用 WS）。
 * 事件格式：`id: <eventId>` + `data: <EventEnvelope JSON>`；
 * 续传：`Last-Event-ID` 头或 `lastEventId` query（会话内窗口，SessionBus）；
 * 心跳：15s 一条注释行，防中间设备断连（FL-08 F-08-11）。
 */

import { Router } from "express";
import type { Response } from "express";

import type { EventEnvelope, UserEventEnvelope } from "@carlife/shared";
import type { ChatRepository } from "@carlife/db";
import type { AuthedRequest } from "../auth";
import { isEphemeral, type SessionBus } from "./session-bus";
import type { UserBus } from "./user-bus";

const HEARTBEAT_MS = 15_000;

/**
 * 账号级通道的总开关（ACR-031 的回滚手段之一）。
 *
 * **默认开**：没有客户端连它时，`publish` 只是一次无订阅者的 Map 查询，开着不花钱；
 * 而默认关会让端侧接入（ACR-032/033）联调时先踩一次"忘了开"，那种坑的现象是
 * "什么都没发生"，最难查。置 `false` 时路由回 503、发射点短路，等于这条通道不存在。
 */
export function accountEventsEnabled(): boolean {
  return (process.env.ACCOUNT_EVENTS_ENABLED ?? "true").toLowerCase() !== "false";
}

export function createStreamRouter(repo: ChatRepository, bus: SessionBus, userBus?: UserBus): Router {
  const router = Router();

  router.get("/v1/session/:id/stream", async (req: AuthedRequest, res: Response) => {
    const sessionId = String(req.params.id);
    if (!(await repo.sessionExists(sessionId))) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    const lastEventId =
      req.header("last-event-id") ??
      (typeof req.query.lastEventId === "string" ? req.query.lastEventId : null);

    /*
     * 瞬时事件**不写 `id:` 行**（M18-04 约束 4，F-45-11）。
     *
     * 只把 filler 挡在 `log.buffer` 外还不够：浏览器 `EventSource` 会把每条
     * 带 `id:` 的事件记成 `lastEventId`。下次重连带着一个**不在窗口里**的 id 回来，
     * `subscribe` 的 `Number(envelope.eventId) > afterId` 会把它之后的**真实事件**
     * 也算作已收——表现是重连后丢事件，比重复寒暄更难查。
     */
    const send = (envelope: EventEnvelope) => {
      const idLine = isEphemeral(envelope.event) ? "" : `id: ${envelope.eventId}\n`;
      res.write(`${idLine}data: ${JSON.stringify(envelope)}\n\n`);
    };

    const unsubscribe = bus.subscribe(sessionId, lastEventId, send);
    const heartbeat = setInterval(() => res.write(": hb\n\n"), HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /**
   * 账号级事件流（ACR-031）：`GET /v1/events`。
   *
   * 它回答的是会话流回答不了的那个问题——"我的**另一个端**刚做了什么"。
   * 在此之前协议里没有这一层，于是手机端聊完的那段对话不会出现在车机端的
   * 会话列表里，直到车机自己因为别的原因重拉一次（2026-09-12 车主实际撞到）。
   *
   * 与上面那条流的三处刻意不同，都是同一个理由——**本通道的事件不携带内容**：
   *
   *  1. **不写 `id:` 行、不认 `Last-Event-ID`**。晚到的刷新信号与刚到的做的事一样，
   *     补发没有意义；端上重连时本来就要整拉一次。
   *  2. **连上先发一条 `connected`**。把"重连即对齐"做成通道自带的语义，
   *     而不是让每个端各写一遍"连上先拉一次"——写漏的那个端就是下一个 bug。
   *  3. **不校验会话存在**。这里没有会话，订阅的键是人。
   */
  router.get("/v1/events", (req: AuthedRequest, res: Response) => {
    if (!userBus || !accountEventsEnabled()) {
      res.status(503).json({ error: "account_events_disabled" });
      return;
    }
    /*
     * 车辆级 token 未声明上车时没有"我的"可言，与 `/v1/sessions`、`/v1/attachments`
     * 同一口径。**这里不能回空流**：那样端上会一直连着一条永远不来事件的流，
     * 看起来像"同步坏了"，而真实原因是没人声明在用车。
     */
    const userId = req.userId;
    if (!userId) {
      res.status(400).json({ error: "active_user_required" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    const send = (envelope: UserEventEnvelope) => {
      res.write(`data: ${JSON.stringify(envelope)}\n\n`);
    };

    const unsubscribe = userBus.subscribe(userId, send);
    // 先订阅再对齐：反过来的话，这两步之间发生的变动会漏掉。
    send({ ts: Date.now(), event: { kind: "sessions_changed", reason: "connected" } });

    const heartbeat = setInterval(() => res.write(": hb\n\n"), HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
