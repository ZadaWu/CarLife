/**
 * SSE 读取 —— 用 `fetch` 而不是 `EventSource`。
 *
 * # 为什么不用 EventSource
 *
 * 它设不了请求头，于是唯一的带 token 方式是塞进 query。**不行**：
 * URL 会进服务端访问日志、进浏览器历史、进 Referer。
 * 后台的 token 是一个能读全部会话的凭据，不该躺在这些地方。
 *
 * 代价是自动重连要自己写（下面那层），换来的是 token 照常走 `Authorization`。
 *
 * # 重连要有退避，而且要能说出来
 *
 * 固定 1s 重连会在网关重启时打出一串请求。退避到 15s 封顶；
 * 状态经 `onState` 交给页面——**一条安静的实时流与"系统很闲"长得一模一样**，
 * 页面必须能显示"连着呢"还是"断了"。
 */

import { getToken } from "./index";

export type StreamState = "connecting" | "open" | "closed";

export interface StreamHandle {
  close(): void;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

export function openEventStream<T>(
  path: string,
  handlers: {
    onEvent: (e: T) => void;
    onState?: (s: StreamState, detail?: string) => void;
  },
): StreamHandle {
  let stopped = false;
  let abort: AbortController | undefined;
  let backoff = BACKOFF_START_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    handlers.onState?.("connecting");
    abort = new AbortController();
    try {
      const token = getToken();
      const res = await fetch(path, {
        signal: abort.signal,
        headers: {
          accept: "text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok || !res.body) {
        // 401/403/503 都不该无限重试同一个错。**如实报出来**，
        // 而不是让页面看起来像"还在连"。
        let code = `http_${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          /* 非 JSON 错误体 */
        }
        throw new Error(code);
      }
      handlers.onState?.("open");
      backoff = BACKOFF_START_MS;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        buffer += decoder.decode(value, { stream: true });
        // 按**帧**（空行）切，不是按行：一条长事件会被切成好几段到达，
        // 按行处理会解析到半条 JSON。
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf("\n\n");
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue; // 注释行：心跳
          try {
            handlers.onEvent(JSON.parse(line.slice(5).trim()) as T);
          } catch {
            /* 坏事件丢一条，不断流 */
          }
        }
      }
      if (!stopped) throw new Error("stream_ended");
    } catch (err) {
      if (stopped) return;
      handlers.onState?.("closed", err instanceof Error ? err.message : String(err));
      timer = setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  };

  void connect();

  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      abort?.abort();
      handlers.onState?.("closed");
    },
  };
}
