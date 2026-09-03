/**
 * 车机端「记一笔」保养手动录入（施工单 M29-03，F-23-03 / F-23-11）。
 *
 * 表单形态遵守 M14-05 向导先例（驻车短表单），不是 M17-04 的"车机不填表"——
 * 三个字段一屏放完，不做多步。校验与网关同一套规则（records-logic 的
 * `validateMaintenanceEntry`，M14-04"校验规则与端上一致"同款要求）。
 *
 * 失败保留已填内容（向导同款纪律：重填一遍是最伤的失败形态）；
 * 网关 400 的 detail 原文上屏——"未来时间不能是保养时间"比"保存失败"有用。
 */
import { useState } from "react";
import type { CharacterTheme } from "@carlife/ui";

import { appendMaintenance } from "./api";
import { validateMaintenanceEntry } from "./records-logic";
import type { VehicleView } from "./types";
import "./ownership.css";

export interface MaintenanceEntryScreenProps {
  theme: CharacterTheme;
  vehicle: VehicleView;
  /** 保存成功；调用方负责 reload 档案并把用户带到详情页看见新记录。 */
  onSaved: () => void;
  onCancel: () => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function MaintenanceEntryScreen({ theme, vehicle, onSaved, onCancel }: MaintenanceEntryScreenProps) {
  const [date, setDate] = useState(todayIso());
  // 预填当前表显：多数人是"刚做完保养回来记一笔"，改数字比从零敲快。
  const [km, setKm] = useState<number | undefined>(Math.round(vehicle.odometerKm));
  const [items, setItems] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const entry = {
    at: date ? Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)),
    ) : Number.NaN,
    odometerKm: km ?? Number.NaN,
    items,
  };
  const clientError = validateMaintenanceEntry(entry);

  const submit = async () => {
    setTouched(true);
    if (clientError) return;
    setSubmitting(true);
    setServerError(null);
    const r = await appendMaintenance(vehicle.vin, entry);
    setSubmitting(false);
    if (r.kind === "ok") {
      onSaved();
      return;
    }
    // 失败如实说并保留已填内容。
    setServerError(r.reason);
  };

  return (
    <div className={`cown cown--${theme}`} aria-label="记一笔保养">
      <div className="cown-sheet">
        <header className="cown-head">
          <h2 className="cown-title">记一笔保养</h2>
          <span className="cown-chip">
            {vehicle.model} · {vehicle.modelYear} 款
          </span>
          <span className="cown-head-spacer" />
        </header>

        <section className="cown-card">
          <p className="cown-meta" style={{ marginTop: 0 }}>保养日期：</p>
          <input
            className="cown-input"
            type="date"
            max={todayIso()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />

          <p className="cown-meta">保养时的表显里程：</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              className="cown-input"
              type="number"
              inputMode="numeric"
              min={0}
              value={km ?? ""}
              onChange={(e) => setKm(e.target.value === "" ? undefined : Number(e.target.value))}
            />
            <span>km</span>
          </div>
          {/* 补录旧保养单是合法场景：里程小于当前表显不报错，档案里程也不会被改小。 */}
          {km !== undefined && km < vehicle.odometerKm && (
            <p className="cown-dim cown-tiny">比当前表显（{Math.round(vehicle.odometerKm).toLocaleString()} km）小——按补录旧记录处理，当前里程不变。</p>
          )}

          <p className="cown-meta">做了什么保养：</p>
          <input
            className="cown-input"
            type="text"
            placeholder="如：机油机滤、轮胎换位"
            value={items}
            onChange={(e) => setItems(e.target.value)}
          />

          {touched && clientError && <p className="cown-meta cown-error">{clientError}</p>}
          {serverError && <p className="cown-meta cown-error">{serverError}</p>}
        </section>

        <div className="cown-actions">
          <button type="button" className="cown-btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="cown-btn cown-btn--primary" disabled={submitting} onClick={submit}>
            {submitting ? "保存中…" : "保存"}
          </button>
        </div>
        <p className="cown-dim cown-tiny">这条记录会标注为「您手动记录的」——它与门店记录分开展示来源。</p>
      </div>
    </div>
  );
}
