/**
 * 车机端「车辆资料」页（施工单 M29-04，F-23-05 / F-23-11）。
 *
 * 只读区 + 占位车的 VIN 补录表单。真 VIN **只给掩码不给全文**——
 * 脱敏纪律（FL-26）不因"这是详情页"松动；要全文去行驶证上看。
 *
 * 补录只对 `PEND-` 占位车开放（与网关判据同一枚 `isPendingVin`）；
 * 真 VIN 车这里没有任何编辑入口——换 VIN 是过户流程，本页不受理。
 */
import { useState } from "react";
import type { CharacterTheme } from "@carlife/ui";

import { backfillVin } from "./api";
import { validateVinInput } from "./records-logic";
import { ENERGY_LABEL, isPendingVin, maskVin, type VehicleView } from "./types";
import "./ownership.css";

export interface VehicleInfoScreenProps {
  theme: CharacterTheme;
  vehicle: VehicleView;
  /** 补录成功；调用方负责 reload（VIN 变了，列表键也变了）。 */
  onSaved: () => void;
  onBack: () => void;
}

function fmtMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

export function VehicleInfoScreen({ theme, vehicle, onSaved, onBack }: VehicleInfoScreenProps) {
  const pending = isPendingVin(vehicle.vin);
  const [vin, setVin] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const clientError = validateVinInput(vin);

  const submit = async () => {
    setTouched(true);
    if (clientError) return;
    setSubmitting(true);
    setServerError(null);
    const r = await backfillVin(vehicle.vin, vin.trim().toUpperCase());
    setSubmitting(false);
    if (r.kind === "ok") {
      onSaved();
      return;
    }
    setServerError(r.reason);
  };

  return (
    <div className={`cown cown--${theme}`} aria-label="车辆资料">
      <div className="cown-sheet">
        <header className="cown-head">
          <h2 className="cown-title">车辆资料</h2>
          <span className="cown-chip">
            {vehicle.model} · {vehicle.modelYear} 款
          </span>
          <span className="cown-head-spacer" />
          <button type="button" className="cown-btn cown-btn--ghost" onClick={onBack}>
            返回车辆档案
          </button>
        </header>

        <div className="cown-grid2">
          <div className="cown-col">
            <section className="cown-card">
              <div className="cown-card-head">
                <b>基本信息</b>
              </div>
              <dl className="cown-facts">
                <div>
                  <dt>车型</dt>
                  <dd>{vehicle.model}</dd>
                </div>
                <div>
                  <dt>年款</dt>
                  <dd>{vehicle.modelYear} 款</dd>
                </div>
                <div>
                  <dt>动力形式</dt>
                  <dd>{vehicle.energyType ? ENERGY_LABEL[vehicle.energyType] : "未记录"}</dd>
                </div>
                <div>
                  <dt>购入</dt>
                  <dd>{fmtMonth(vehicle.purchasedAt)}</dd>
                </div>
                <div>
                  <dt>表显里程</dt>
                  <dd>{Math.round(vehicle.odometerKm).toLocaleString()} km</dd>
                </div>
                <div>
                  <dt>VIN</dt>
                  {/* 占位不渲染值（M14-05 纪律）；真 VIN 只给掩码（FL-26） */}
                  <dd>{pending ? <span className="cown-dim">还没补录</span> : maskVin(vehicle.vin)}</dd>
                </div>
              </dl>
            </section>
          </div>

          <div className="cown-col">
            {pending ? (
              <section className="cown-card">
                <div className="cown-card-head">
                  <b>补充 VIN</b>
                </div>
                <p className="cown-dim cown-tiny">
                  VIN 在行驶证「车辆识别代号」一栏，17 位。补上后可关联召回与保修信息。
                </p>
                <input
                  className="cown-input"
                  type="text"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={17}
                  placeholder="17 位，如 LSVAA49P4E2008921"
                  value={vin}
                  onChange={(e) => setVin(e.target.value.toUpperCase())}
                />
                {touched && clientError && <p className="cown-meta cown-error">{clientError}</p>}
                {serverError && <p className="cown-meta cown-error">{serverError}</p>}
                <div className="cown-actions">
                  <button
                    type="button"
                    className="cown-btn cown-btn--primary"
                    disabled={submitting}
                    onClick={submit}
                  >
                    {submitting ? "保存中…" : "保存 VIN"}
                  </button>
                </div>
                <p className="cown-dim cown-tiny">保存后不可在此修改——录错了联系客服走更正流程。</p>
              </section>
            ) : (
              <section className="cown-card">
                <div className="cown-card-head">
                  <b>VIN 已登记</b>
                </div>
                <p className="cown-dim">
                  这辆车的 VIN 已登记（{maskVin(vehicle.vin)}）。换 VIN 属于过户流程，本页不受理。
                </p>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
