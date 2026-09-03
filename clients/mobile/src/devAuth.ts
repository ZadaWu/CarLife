// 手机端 · 浏览器走查鉴权（与 clients/cockpit/src/devAuth.ts 逐字一致，改一处必须同步改另一处）
/**
 * 浏览器走查形态的鉴权。**Tauri 下永远不走这里**——客户端的网络在 Rust 侧
 * （§2.2 C2），token 由 `carlife_core::auth` 持有，JS 只发 `invoke`。
 * 本模块只服务于「vite 直开 1430/1420、没有 Rust 桥」的那条走查路径。
 *
 * # 为什么不能再写 `Bearer demo-token`
 *
 * 那是 M48-02 之前的万能钥匙。网关删掉 demo 鉴权之后，这几处 fetch 恒 401——
 * 而失败在界面上只表现为「导览采集失败」，**与"这个景点确实采不到"一模一样**，
 * 所以坏了很久没人发现。更糟的是那个字面量会进 release 产物：
 * 一个早已不存在的凭证被打包分发到每一台设备上。
 *
 * # 现在的形态：走查者自己贴一枚真 token
 *
 *   localStorage.setItem("carlife.dev.token", "<登录拿到的 access token>")
 *
 * 没贴就**不发请求**，抛 `DevTokenMissing`。「走查环境没配好」与「服务端拒绝」
 * 从此是两种可区分的失败，而不是同一句"失败"。
 *
 * # 产物里不再有凭证
 *
 * 本文件没有任何 token 字面量，只有一个 localStorage 键名。
 * 架构不变量 `client-isolation` 会守住这一点（scripts/dev/check/check-arch-invariants.ts）。
 */

/** 走查 token 的 localStorage 键。改它要同步改另一端与 runbook。 */
export const DEV_TOKEN_KEY = "carlife.dev.token";

/** 未配置走查 token。调用方据此把"环境没配好"与"服务端拒绝"分开呈现。 */
export class DevTokenMissing extends Error {
  constructor() {
    super(
      `浏览器走查未配置访问令牌：先 localStorage.setItem("${DEV_TOKEN_KEY}", "<access token>") 再刷新`,
    );
    this.name = "DevTokenMissing";
  }
}

/**
 * 只吼一次。轮询面每 10 秒一发，每发都 warn 会把控制台刷满，
 * 而"没配 token"这件事说一遍就够——刷屏的告警等于没有告警。
 */
let warned = false;

/** 走查 token；没配 / 存储不可用都回 null（隐私模式下读 localStorage 会抛）。 */
export function devToken(): string | null {
  try {
    const raw = window.localStorage.getItem(DEV_TOKEN_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 带鉴权的同源 fetch（经 vite 的 `/v1` 代理打本机网关）。
 * 没有 token 时**不发请求**——发一个必然 401 的请求只会在网关审计里留噪音。
 */
export async function devFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = devToken();
  if (!token) {
    const err = new DevTokenMissing();
    if (!warned) {
      warned = true;
      console.warn("[devAuth]", err.message);
    }
    throw err;
  }
  return fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
  });
}
