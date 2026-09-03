/**
 * 购车数据获取（施工单 M15-05）。
 *
 * 网络在 Rust 侧（§2.2 C2）：Tauri 环境经 `fetch_buying` 命令走网关；
 * 浏览器预览（vite dev，无 Tauri）没有网络通道——如实返回 offline，
 * **不 mock 一份假候选**：假的车型与价格会与真实资料混同，
 * 而这个页面的全部价值就是"每个数字都能溯源"（与档案页同一条红线）。
 */

import { invoke } from "@tauri-apps/api/core";

import type { BuyingPlan, BuyingState, CostPlan, InsurancePlan, LoanPlan, TrimPlan } from "./types";

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadBuying(sessionId: string | null): Promise<BuyingState> {
  if (!sessionId) return { kind: "offline", reason: "会话尚未就绪" };
  if (!isTauriEnv()) {
    return { kind: "offline", reason: "浏览器预览没有网关通道（真实数据经 Tauri 命令获取）" };
  }
  try {
    const raw = await invoke<string>("fetch_buying", { sessionId });
    const parsed = JSON.parse(raw) as {
      plan?: BuyingPlan | null;
      cost?: CostPlan | null;
      trim?: TrimPlan | null;
      loan?: LoanPlan | null;
      insurance?: InsurancePlan | null;
    };
    // `plan` 为 null ＝ 这个会话还没比过车。这是常态，不是错误。
    if (!parsed.plan || parsed.plan.candidates.length === 0) return { kind: "empty" };
    return {
      kind: "ready",
      plan: parsed.plan,
      cost: parsed.cost ?? null,
      // 三段各自独立：只比过配置没算过钱时，金融分区自己显示"还没算"。
      trim: parsed.trim ?? null,
      loan: parsed.loan ?? null,
      insurance: parsed.insurance ?? null,
    };
  } catch (err) {
    return { kind: "offline", reason: `网关不可达：${String(err)}` };
  }
}
