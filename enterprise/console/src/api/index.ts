/**
 * 后台接口客户端（施工单 M3-01）。
 *
 * 统一四件事，供后续所有页面复用：token 携带、错误形态、401 跳登录、403 明确提示。
 * **不做重试**——后台是人工操作场景，静默重试会让"到底成功没有"变得不可判断。
 */

const TOKEN_KEY = "carlife.console.token";

export type ConsoleRole = "admin" | "ops";

export interface ConsoleIdentity {
  subject: string;
  role: ConsoleRole;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }

  /** 403：身份有效但角色不够——界面上要说清"不是没登录，是没权限"。 */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 401 时广播，由 App 统一跳登录，避免每个调用点各写一遍。 */
const UNAUTHORIZED_EVENT = "carlife:unauthorized";

export function onUnauthorized(handler: () => void): () => void {
  const fn = (): void => handler();
  window.addEventListener(UNAUTHORIZED_EVENT, fn);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, fn);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(401, "unauthorized");
  }

  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) code = body.error;
    } catch {
      /* 非 JSON 错误体：保留 http_<status> */
    }
    throw new ApiError(res.status, code);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * 二进制取件（会话试听用，M60-02）。
 *
 * 与 `request` 分开而不是加个开关：错误形态、401 广播这些要一模一样，
 * 但 `<audio src>` 带不了 Authorization 头，所以只能先取回 Blob 再转 objectURL。
 * 调用方**必须自己 revokeObjectURL**，否则一页听下来会攒一堆音频在内存里。
 */
async function requestBlob(path: string): Promise<{ blob: Blob; origin: string | null; engine: string | null }> {
  const token = getToken();
  const res = await fetch(path, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      if (body.error) code = body.error;
      detail = body.detail;
    } catch {
      /* 非 JSON 错误体：保留 http_<status> */
    }
    throw new ApiError(res.status, code, detail);
  }
  return {
    blob: await res.blob(),
    // 是"当时录的"还是"事后补合成的"——界面要如实说，见网关侧注释。
    origin: res.headers.get("x-audio-origin"),
    engine: res.headers.get("x-audio-engine"),
  };
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  blob: requestBlob,
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),

  /** 用当前 token 换身份；登录页与启动恢复共用。 */
  whoami: (): Promise<ConsoleIdentity> => request<ConsoleIdentity>("/console/session", { method: "POST" }),
};
