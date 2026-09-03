/**
 * 车机端档案页「车机」卡（施工单 M24-05，F-49-11，横版）。
 *
 * 与手机端 `cabin-section.tsx` 同一套三态语义：未绑定 / 车机离线 / 已绑定。
 * 离线不显示成未绑定；能力摘要带模拟来源标注。
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface CapsSummary {
  climateZones: number;
  tempRangeC: [number, number];
  seatVentilation: boolean;
  fragrance: boolean;
}

type CabinState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "unbound" }
  | { kind: "cabin-offline"; reason: string }
  | { kind: "bound"; cabinVehicleId: string; caps: CapsSummary };

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function CabinCard({ vin }: { vin: string }) {
  const [state, setState] = useState<CabinState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    void (async (): Promise<CabinState> => {
      if (!isTauriEnv()) return { kind: "offline", reason: "浏览器预览没有网关通道" };
      try {
        const raw = JSON.parse(await invoke<string>("fetch_cabin", { vin })) as Record<string, unknown>;
        if (raw.state === "bound") {
          return { kind: "bound", cabinVehicleId: String(raw.cabinVehicleId), caps: raw.capabilities as unknown as CapsSummary };
        }
        if (raw.state === "unbound") return { kind: "unbound" };
        if (raw.state === "offline") return { kind: "cabin-offline", reason: String(raw.reason ?? "车机离线") };
        return { kind: "offline", reason: String(raw.reason ?? "车机能力未接入") };
      } catch (err) {
        return { kind: "offline", reason: `网关不可达：${String(err)}` };
      }
    })().then(setState);
  }, [vin]);
  useEffect(reload, [reload]);

  const bind = async () => {
    setBusy(true);
    try {
      await invoke<string>("bind_cabin", { vin });
    } catch {
      /* 状态由 reload 呈现 */
    } finally {
      setBusy(false);
      reload();
    }
  };

  return (
    <section className="cown-card" aria-label="车机">
      <b>车机{state.kind === "bound" ? "（模拟）" : ""}</b>
      {state.kind === "loading" && <p className="cown-dim">正在读取…</p>}
      {state.kind === "offline" && <p className="cown-dim">{state.reason}</p>}
      {state.kind === "unbound" && (
        <>
          <p className="cown-dim">绑定后语音可调空调、座椅、氛围灯，家人偏好自动应用。</p>
          <button type="button" className="cown-btn cown-btn--primary" disabled={busy} onClick={() => void bind()}>
            {busy ? "绑定中…" : "绑定车机"}
          </button>
        </>
      )}
      {state.kind === "cabin-offline" && (
        <>
          <p className="cown-dim">{state.reason}（绑定还在，恢复后自动可用）</p>
          <button type="button" className="cown-btn" onClick={reload}>
            重试
          </button>
        </>
      )}
      {state.kind === "bound" && (
        <p className="cown-dim">
          {state.cabinVehicleId} · {state.caps.climateZones} 温区（{state.caps.tempRangeC[0]}~{state.caps.tempRangeC[1]}℃）
          · 通风{state.caps.seatVentilation ? "有" : "无"} · 香氛{state.caps.fragrance ? "有" : "无"}
        </p>
      )}
    </section>
  );
}
