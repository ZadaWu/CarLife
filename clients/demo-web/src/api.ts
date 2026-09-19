/**
 * 网关客户端。
 *
 * 所有请求都是**同源相对路径**（`/v1/...`）——线上由容器里的 nginx 反代到 ECS 网关，
 * 开发期由 vite 的 proxy 打本机 8790。这一条是整个方案的地基：
 * 浏览器全程只跟当前站点说话，所以既不会撞 HTTPS 页面调明文接口的混合内容阻断，
 * 也不需要网关支持 CORS（网关因此一行没改）。
 */

import type { EventEnvelope } from "@carlife/shared";
import { splitFrames, parseFrame } from "./sse.ts";

/**
 * 带 token 的请求用这个头，**不用 `Authorization`**。
 *
 * 魔搭创空间的边缘把 `Authorization`、`X-modelscope-*`、`X-studio-*` 三类头
 * 保留给平台自己（官方文档明写）。带 `Authorization` 的请求根本到不了我们的容器，
 * 平台直接回 403——而症状很误导：不带头的登录一切正常，带头的建会话 403，
 * 看起来像"后端拒绝了这个账号"，其实请求压根没出平台。
 *
 * 容器里的 nginx 负责把它翻回 `Authorization` 再发给网关（见
 * infra/modelscope/nginx.conf.template），开发期由 vite 的 proxy 做同一件事。
 * 所以**网关一行没改**，它收到的还是标准的 Authorization。
 */
export const AUTH_HEADER = "x-carlife-auth";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { [AUTH_HEADER]: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new GatewayError(path + " → " + res.status, res.status);
  return (await res.json()) as T;
}

export async function login(username: string, password: string): Promise<string> {
  const r = await post<{ accessToken: string }>("/v1/auth/login", { username, password });
  /*
   * token 同时走两条路：自定义请求头，以及一个同源 cookie。
   *
   * 起因是魔搭那条边缘——`Authorization` 被平台占用（403），换成自定义头之后
   * 变成了 401，也就是请求到了网关但**没带上有效 token**：头在中途没了。
   * 到底是哪一层丢的、丢的是不是所有自定义头，光看现象判断不了，
   * 所以两条路一起发，nginx 优先用头、没有就用 cookie（见 nginx.conf.template）。
   * `/__whoami` 会告诉我们哪一条活着，之后再把多余的那条删掉。
   *
   * cookie 不设 Secure：创空间是 https，但本机开发是 http，设了开发期就存不上。
   * 它装的是公开演示账号的短时 token（15 分钟），不是密钥。
   */
  try {
    // 只存**裸 token**，不带 "Bearer " 前缀、不做 URL 编码：
    // 前缀里的空格在 cookie 值里非法，而编码后 nginx 取到的是编码串，
    // 拼出来的 Authorization 是坏的（实测 401）。"Bearer " 由 nginx 补。
    // JWT 的字符集（A-Za-z0-9-_.）在 cookie 值里本来就合法。
    document.cookie = "carlife_auth=" + r.accessToken + "; path=/; SameSite=Lax; max-age=900";
  } catch {
    // 浏览器禁用 cookie 时静默跳过——头那条路还在
  }
  return r.accessToken;
}

export async function openSession(token: string): Promise<string> {
  const r = await post<{ sessionId: string }>("/v1/session", {}, token);
  return r.sessionId;
}

export async function sendMessage(sessionId: string, content: string, token: string): Promise<void> {
  await post("/v1/session/" + encodeURIComponent(sessionId) + "/messages", { content }, token);
}

/**
 * 演示账号重新登录，换一把新 token。
 *
 * access token 只有 15 分钟，而访客很可能是**打开页面、看一会儿介绍、再动手**——
 * 实测过期后发消息直接 401，且页面自己恢复不了，看起来像"这东西坏了"。
 * 演示环境的账号是固定的，重登一次的代价只有一次请求，所以遇到 401 就换一把再试。
 */
export async function relogin(): Promise<string> {
  const { config } = await import("./config.ts");
  return login(config.demoUser, config.demoPassword);
}

export async function resume(
  sessionId: string,
  interruptId: string,
  approved: boolean,
  token: string,
): Promise<void> {
  await post("/v1/session/" + encodeURIComponent(sessionId) + "/resume", { interruptId, approved }, token);
}

/**
 * 订阅一个会话的下行事件。
 *
 * 不用 `EventSource`：它发不了 `Authorization` 头，而网关的流是要鉴权的。
 * 所以走 `fetch` + 手动读流。浏览器里 `ReadableStream` 的异步迭代支持还不齐，
 * 用 `getReader()` 是标准做法（Node 侧那条"别用 getReader"的经验是 undici 的毛病，
 * 不适用于浏览器）。
 *
 * 返回一个中止函数。
 */
export function openStream(
  sessionId: string,
  token: string,
  onEvent: (env: EventEnvelope) => void,
  onError: (err: Error) => void,
): () => void {
  const ctrl = new AbortController();

  void (async () => {
    try {
      const res = await fetch("/v1/session/" + encodeURIComponent(sessionId) + "/stream", {
        headers: { [AUTH_HEADER]: "Bearer " + token, accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new GatewayError("stream " + res.status, res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = splitFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          const env = parseFrame(frame);
          if (env) onEvent(env);
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      onError(err as Error);
    }
  })();

  return () => ctrl.abort();
}
