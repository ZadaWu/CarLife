/**
 * 拍照问诊报告的获取（施工单 M104-02）。
 *
 * 网络在 Rust 侧（§2.2 C2）：Tauri 环境经 `fetch_diagnosis` 命令走网关；浏览器预览没有网络通道——
 * 如实返回 offline，**不 mock 一份假报告**：假数据会让"接没接上"在评审时不可分辨（版式截图走 `?diagnosis=demo`）。
 */
import { invoke } from "@tauri-apps/api/core";

import type { DiagnosisReport, DiagnosisState } from "./types";

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadDiagnosis(sessionId: string | null): Promise<DiagnosisState> {
  if (!sessionId) return { kind: "offline", reason: "会话尚未就绪" };
  if (!isTauriEnv()) return { kind: "offline", reason: "浏览器预览没有网关通道（真实数据经 Tauri 命令获取）" };
  try {
    const raw = await invoke<string>("fetch_diagnosis", { sessionId });
    const parsed = JSON.parse(raw) as { report?: DiagnosisReport | null };
    // `report` 为 null ＝ 这个会话还没问过诊。常态。
    if (!parsed.report) return { kind: "empty" };
    return { kind: "ready", report: parsed.report };
  } catch (err) {
    return { kind: "offline", reason: `网关不可达：${String(err)}` };
  }
}
