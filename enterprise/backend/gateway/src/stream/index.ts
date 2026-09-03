/**
 * stream —— SSE 下行通道（施工单 M2-02）。
 *
 * `GET /v1/session/:id/stream`：`text/event-stream`，单向下行（§3，不用 WS）。
 * 事件格式：`id: <eventId>` + `data: <EventEnvelope JSON>`；
 * 续传：`Last-Event-ID` 头或 `lastEventId` query（会话内窗口，SessionBus）；
 * 心跳：15s 一条注释行，防中间设备断连（FL-08 F-08-11）。
 */

import { Router } from "express";
import type { Response } from "express";

import type { EventEnvelope } from "@carlife/shared";
import type { ChatRepository } from "@carlife/db";
import type { AuthedRequest } from "../auth";
import { isEphemeral, type SessionBus } from "./session-bus";

const HEARTBEAT_MS = 15_000;

export function createStreamRouter(repo: ChatRepository, bus: SessionBus): Router {
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

  return router;
}
