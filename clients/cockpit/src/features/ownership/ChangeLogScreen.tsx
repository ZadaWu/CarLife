/**
 * 车机端「档案变更记录」页（施工单 M29-05，F-23-11 / AC-23-9 的"留痕可见"一跳）。
 *
 * 服务端给的是受控视图（时间 / 角色 / 一句话 summary），detail 不透传；
 * 角色 → 用户措辞的翻译在端上（`actorRoleLabel`）。
 * 四态齐全：offline（读不到）≠ empty（"档案建立以来还没有变更记录"）。
 */
import { useCallback, useEffect, useState } from "react";
import type { CharacterTheme } from "@carlife/ui";

import { DEMO_CHANGES, isProfileDemo } from "../../data/demoVehicleProfile";
import { loadVehicleChanges } from "./api";
import { actorRoleLabel, type ChangeListState, type VehicleView } from "./types";
import "./ownership.css";

export interface ChangeLogScreenProps {
  theme: CharacterTheme;
  vehicle: VehicleView;
  onBack: () => void;
}

function fmtAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ChangeLogScreen({ theme, vehicle, onBack }: ChangeLogScreenProps) {
  const [state, setState] = useState<ChangeListState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);

  const reload = useCallback(() => {
    // 版式走查夹具（M14-14 同款）。Tauri 窗口不带 query，真实记录照常拉。
    if (isProfileDemo()) {
      setState(DEMO_CHANGES);
      return;
    }
    setState({ kind: "loading" });
    void loadVehicleChanges(vehicle.vin).then(setState);
  }, [vehicle.vin]);

  useEffect(reload, [reload]);

  const loadMore = async () => {
    if (state.kind !== "ready" || !state.nextCursor) return;
    setLoadingMore(true);
    const next = await loadVehicleChanges(vehicle.vin, state.nextCursor, state.changes);
    setLoadingMore(false);
    // 追加失败不清掉已有列表——把 offline 原因垫在底部比整页翻车诚实。
    if (next.kind === "ready") setState(next);
  };

  return (
    <div className={`cown cown--${theme}`} aria-label="档案变更记录">
      <div className="cown-sheet">
        <header className="cown-head">
          <h2 className="cown-title">档案变更记录</h2>
          <span className="cown-chip">
            {vehicle.model} · {vehicle.modelYear} 款
          </span>
          <span className="cown-chip cown-chip--quiet">谁在什么时候改了这份档案</span>
          <span className="cown-head-spacer" />
          <button type="button" className="cown-btn cown-btn--ghost" onClick={onBack}>
            返回车辆档案
          </button>
        </header>

        {state.kind === "loading" && <p className="cown-note">正在读取…</p>}

        {state.kind === "offline" && (
          <div className="cown-card cown-note">
            <p>暂时读不到变更记录。</p>
            <p className="cown-dim">{state.reason}</p>
            <button type="button" className="cown-btn" onClick={reload}>
              重试
            </button>
          </div>
        )}

        {state.kind === "empty" && (
          <div className="cown-card cown-note">
            <p>档案建立以来还没有变更记录。</p>
            <p className="cown-dim">设默认车、记保养、补 VIN 这些操作都会留在这里。</p>
          </div>
        )}

        {state.kind === "ready" && (
          <section className="cown-card">
            <ul className="cown-records">
              {state.changes.map((c) => (
                <li key={c.id} className="cown-record">
                  <span className="cown-dot" aria-hidden />
                  <span className="cown-record-main">
                    <b>{c.summary}</b>
                    <small>
                      {fmtAt(c.at)} · {actorRoleLabel(c.actorRole)}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
            {state.nextCursor && (
              <div className="cown-timeline-foot">
                <button type="button" className="cown-btn cown-btn--sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? "加载中…" : "加载更早"}
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
