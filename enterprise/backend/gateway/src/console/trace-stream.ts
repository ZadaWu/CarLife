/**
 * 实时轨迹转发 `GET /console/trace/stream`（大屏的"现在流到哪了"）。
 *
 * # 网关在这里只做协议转换与治理，不加业务
 *
 * 轨迹产生在 agent-runtime（`/internal/trace/stream`），那一侧不做鉴权——
 * 对外的 token、角色、脱敏全在这一层，与 `/console/replay/:id` 同一道口径。
 *
 * # 脱敏与回放页**共用同一个函数**
 *
 * 轨迹里带用户原文的地方不少（意图四要素、工具入参、guard 的命中理由），
 * 提示词事件更是约等于整段对话原文。两条读取通道各写一套的话，
 * 迟早有一条更宽——而更宽的那条就是绕过"提权 + 审计"的后门。
 * 所以这里直接用 `presentTraceData`。
 *
 * # 为什么不用 EventSource 那套 `?token=`
 *
 * 浏览器的 `EventSource` 设不了请求头，于是很自然会想把 token 塞进 query。
 * **不行**：URL 会进日志、进浏览器历史、进 Referer。前端改用 fetch 读流
 * （`api/stream.ts`），token 照常走 `Authorization`。
 *
 * # 断开与重连
 *
 * 这条流**不做续传**。它回答的是"此刻"，补发一段十分钟前的轨迹没有意义，
 * 也不该让大屏在重连后追着播一段旧动画。运行时那侧的回溯缓冲
 * （最近 200 条）已经够让刚打开的大屏立刻有东西看。
 */

import { Router, type Response } from "express";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { presentTraceData } from "./replay";

/** 与端上下行、运行时上游同一个值。三处不同的话最短的那个说了算，而那不明显。 */
const HEARTBEAT_MS = 15_000;

interface UpstreamEvent {
  sessionId: string;
  turnId?: string;
  kind: string;
  at: number;
  data: Record<string, unknown>;
}

export function createTraceStreamRouter(runtimeUrl: string): Router {
  const router = Router();

  router.get(
    "/console/trace/stream",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const upstream = new AbortController();

      let source: Awaited<ReturnType<typeof fetch>>;
      try {
        source = await fetch(`${runtimeUrl}/internal/trace/stream`, {
          signal: upstream.signal,
          headers: { accept: "text/event-stream" },
        });
      } catch {
        // **取不到就明说**，不要开一条永远安静的流：一条安静的实时流
        // 与"系统很闲"在页面上一模一样，而这里是"根本没连上"。
        res.status(503).json({ error: "runtime_unavailable" });
        return;
      }
      if (!source.ok || !source.body) {
        res.status(503).json({ error: "runtime_unavailable" });
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");

      const heartbeat = setInterval(() => res.write(": hb\n\n"), HEARTBEAT_MS);
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        upstream.abort();
      };
      req.on("close", close);

      const reader = source.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || closed) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE 的帧边界是空行。**按帧切而不是按行**：一条载荷较长的
          // 事件会被 TCP 切成好几段，按行处理会解析到半条 JSON。
          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            sep = buffer.indexOf("\n\n");
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue; // 注释行（心跳）不转发，本层自己有心跳
            try {
              const e = JSON.parse(line.slice(5).trim()) as UpstreamEvent;
              const presented = presentTraceData(e.kind, e.data);
              res.write(
                `data: ${JSON.stringify({
                  sessionId: e.sessionId,
                  turnId: e.turnId,
                  kind: e.kind,
                  at: e.at,
                  data: presented.data,
                  redacted: presented.redacted,
                })}\n\n`,
              );
            } catch {
              // 单条解析失败就丢这一条，不要断整条流：
              // 大屏因为一条坏事件而整个黑掉，比少显示一步糟得多。
            }
          }
        }
      } catch {
        /* 上游断开：走 finally 收摊 */
      } finally {
        close();
        res.end();
      }
    },
  );

  return router;
}
