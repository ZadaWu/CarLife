/**
 * 档案页「车机」区（施工单 M24-05，F-49-11）。
 *
 * 三态可区分是硬要求：**未绑定（引导按钮）/ 车机离线（如实提示，按钮置灰）/
 * 已绑定（能力摘要）**。离线显示成"未绑定"会诱导用户重绑。
 * 端上只展示与触发——绑定的幂等与重建语义都在服务侧。
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface CabinCapsSummary {
  model: string;
  source: "seed" | "synthesized";
  climateZones: number;
  tempRangeC: [number, number];
  seatVentilation: boolean;
  fragrance: boolean;
  rearMedia: boolean;
}

export type CabinState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "unconfigured"; reason: string }
  | { kind: "unbound" }
  | { kind: "cabin-offline"; reason: string }
  | { kind: "bound"; cabinVehicleId: string; caps: CabinCapsSummary; fetchedAt: string };

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function loadCabin(vin: string): Promise<CabinState> {
  if (!isTauriEnv()) return { kind: "offline", reason: "浏览器预览没有网关通道" };
  try {
    const raw = JSON.parse(await invoke<string>("fetch_cabin", { vin })) as Record<string, unknown>;
    if (raw.state === "bound") {
      return {
        kind: "bound",
        cabinVehicleId: String(raw.cabinVehicleId),
        caps: raw.capabilities as unknown as CabinCapsSummary,
        fetchedAt: String(raw.fetchedAt ?? ""),
      };
    }
    if (raw.state === "unbound") return { kind: "unbound" };
    if (raw.state === "offline") return { kind: "cabin-offline", reason: String(raw.reason ?? "车机离线") };
    return { kind: "unconfigured", reason: String(raw.reason ?? "车机能力未接入") };
  } catch (err) {
    return { kind: "offline", reason: `网关不可达：${String(err)}` };
  }
}

export function CabinSection({ vin }: { vin: string }) {
  const [state, setState] = useState<CabinState>({ kind: "loading" });
  const [binding, setBinding] = useState(false);

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    void loadCabin(vin).then(setState);
  }, [vin]);
  useEffect(reload, [reload]);

  const bind = async () => {
    setBinding(true);
    try {
      await invoke<string>("bind_cabin", { vin });
    } catch {
      // 失败的具体状态由 reload 后的三态呈现，这里不弹第二套文案
    } finally {
      setBinding(false);
      reload();
    }
  };

  return (
    <section className="own-card" aria-label="车机">
      <header className="own-card-head">
        <b>车机</b>
        {/* 模拟来源标注：与门店系统同一条 provenance 纪律 */}
        {state.kind === "bound" && <small className="own-meta">模拟车机 · {state.fetchedAt.slice(11, 19)}</small>}
      </header>

      {state.kind === "loading" && <p className="own-meta">正在读取车机状态…</p>}

      {state.kind === "offline" && <p className="own-offline">{state.reason}</p>}

      {state.kind === "unconfigured" && <p className="own-meta">{state.reason}</p>}

      {state.kind === "unbound" && (
        <>
          <p className="own-meta">这辆车还没绑定车机。绑定后可以用语音调空调、座椅、氛围灯，家人偏好也能自动应用。</p>
          <button type="button" className="own-cta" disabled={binding} onClick={() => void bind()}>
            {binding ? "绑定中…" : "绑定车机"}
          </button>
        </>
      )}

      {state.kind === "cabin-offline" && (
        <>
          {/* 离线 ≠ 未绑定：绑定还在，只是这会儿够不着 */}
          <p className="own-offline">{state.reason}</p>
          <button type="button" className="own-secondary" disabled onClick={undefined}>
            车机离线，暂不可操作
          </button>
          <button type="button" className="own-secondary" onClick={reload}>
            重试
          </button>
        </>
      )}

      {state.kind === "bound" && (
        <ul className="own-kv">
          <li>
            <span>车机车辆</span>
            <b>{state.cabinVehicleId}</b>
          </li>
          <li>
            <span>空调分区</span>
            <b>{state.caps.climateZones} 温区（{state.caps.tempRangeC[0]}~{state.caps.tempRangeC[1]}℃）</b>
          </li>
          <li>
            <span>座椅通风</span>
            <b>{state.caps.seatVentilation ? "有" : "无"}</b>
          </li>
          <li>
            <span>香氛</span>
            <b>{state.caps.fragrance ? "有" : "无"}</b>
          </li>
        </ul>
      )}
    </section>
  );
}
