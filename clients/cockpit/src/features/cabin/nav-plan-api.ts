/**
 * 出发导航规划的端上请求封装（施工单 M66-03）。
 *
 * 两条路与导览页同款（`App.tsx openGuide`）：Tauri 里 `invoke("plan_departure_nav")`（网络在 Rust，§2.2 C2）；
 * 浏览器走查形态走 vite 的 `/v1` 代理 + `devAuth` token。**任何异常都收敛成 `{status:"failed"}`**——
 * 出发卡据此走今天的直连，绝不把降级渲染成一次报错（旧版 Rust 二进制没有这个命令时 invoke 会 reject，同理）。
 *
 * 回包归一与起点取法在 `@carlife/ui/departure`（两端一字一样）；这里只剩"网络走哪条路"——
 * `devFetch` 是各端自己的，所以这一层不上提。
 */

import type { NavPlanRequest, NavPlanResponse } from "@carlife/shared";
import { normalizeNavPlanResponse } from "@carlife/ui/departure";

import { devFetch } from "../../devAuth";

/** 与 `bridge/locationPort.ts` 同款；不从 `voice/tauriVoicePort` 引——那个文件带着 `@carlife/ui` 的运行时（png 资源，node:test 里加载不了）。 */
function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function requestNavPlan(body: NavPlanRequest, opts: { signal?: AbortSignal } = {}): Promise<NavPlanResponse> {
  try {
    if (isTauriEnv()) {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke<string>("plan_departure_nav", { bodyJson: JSON.stringify(body) });
      return normalizeNavPlanResponse(JSON.parse(raw));
    }
    const r = await devFetch("/v1/trip-plan/nav-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!r.ok) return { status: "failed", reason: `http_${r.status}` };
    return normalizeNavPlanResponse(await r.json());
  } catch (err) {
    return { status: "failed", reason: err instanceof Error && err.name === "AbortError" ? "aborted" : "failed" };
  }
}

/** 起点取法上提到了共享层；旧调用方与 `nav-plan-api.test.ts` 仍从这里引。 */
export { currentOriginForNav } from "@carlife/ui/departure";
