/**
 * 车机端「保养与维修记录」详情页（施工单 M29-02，F-23-06 表现层 / F-23-11 查看段）。
 *
 * # 不发独立请求
 *
 * 数据取自 `vehicle.maintenance/repairs`——`GET /v1/vehicles` 一直随档案带出全量两数组
 * （仓储侧按 at desc 排好）。一辆车几十条记录的量级，分页是伪需求。
 * 好处是 offline 语义天然与主页面一致：读不到档案就进不来这一页。
 *
 * # 维修的 `resolution` 缺席 ≠ 没修
 *
 * 维修记录可能只有症状没有处置（问诊未闭环）。缺席时如实写"未记录处置"，
 * 不省略那一行——省略会让"记了处置"与"没记"在版式上不可分辨。
 * `sessionId` 只做"来自问诊"标注不做跳转：车机端没有会话回放页，死链接不如不做。
 *
 * # 来源必须可分辨（FL-53-08 的 UI 面）
 *
 * 车主自述/手录与门店记录可信度不同（schema 注释原文），source 原样展示不归并。
 */
import type { CharacterTheme } from "@carlife/ui";

import { recordsEmptiness, repairResolutionText, sourceLabel } from "./records-logic";
import type { VehicleView } from "./types";
import "./ownership.css";

export interface RecordsScreenProps {
  theme: CharacterTheme;
  vehicle: VehicleView;
  onBack: () => void;
}

type MaintenanceItem = VehicleView["maintenance"][number];
type RepairItem = VehicleView["repairs"][number];

function fmtDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtKm(km: number): string {
  return `${Math.round(km).toLocaleString()} km`;
}

export function RecordsScreen({ theme, vehicle, onBack }: RecordsScreenProps) {
  const emptiness = recordsEmptiness(vehicle);
  return (
    <div className={`cown cown--${theme}`} aria-label="保养与维修记录">
      <div className="cown-sheet">
        <header className="cown-head">
          <span className="cown-head-icon" aria-hidden>
            <WrenchIcon />
          </span>
          <h2 className="cown-title">保养与维修</h2>
          <span className="cown-chip">
            {vehicle.model} · {vehicle.modelYear} 款
          </span>
          <span className="cown-head-spacer" />
          <button type="button" className="cown-btn cown-btn--ghost" onClick={onBack}>
            返回车辆档案
          </button>
        </header>

        {emptiness === "both-empty" ? (
          <div className="cown-card cown-note">
            <p>还没有保养或维修记录。</p>
            <p className="cown-dim">说一句「刚做完保养」助手就会记下；维修记录随问诊闭环自动追加。</p>
          </div>
        ) : (
          <div className="cown-grid2">
            <div className="cown-col">
              <section className="cown-card">
                <div className="cown-card-head">
                  <span className="cown-head-icon cown-head-icon--sm cown-head-icon--warn" aria-hidden>
                    <WrenchIcon />
                  </span>
                  <b>保养记录</b>
                  <span className="cown-head-spacer" />
                  <span className="cown-chip cown-chip--quiet">{vehicle.maintenance.length} 条</span>
                </div>
                {vehicle.maintenance.length === 0 ? (
                  <p className="cown-dim">还没有保养记录。说一句「刚做完保养」助手就会记下。</p>
                ) : (
                  <ul className="cown-records">
                    {vehicle.maintenance.map((m) => (
                      <MaintenanceRow key={`${m.at}-${m.odometerKm}`} m={m} />
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="cown-col">
              <section className="cown-card">
                <div className="cown-card-head">
                  <span className="cown-head-icon cown-head-icon--sm cown-head-icon--warn" aria-hidden>
                    <BoltIcon />
                  </span>
                  <b>维修记录</b>
                  <span className="cown-head-spacer" />
                  <span className="cown-chip cown-chip--quiet">{vehicle.repairs.length} 条</span>
                </div>
                {vehicle.repairs.length === 0 ? (
                  <p className="cown-dim">还没有维修记录。</p>
                ) : (
                  <ul className="cown-records">
                    {vehicle.repairs.map((r) => (
                      <RepairRow key={`${r.at}-${r.odometerKm}`} r={r} />
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MaintenanceRow({ m }: { m: MaintenanceItem }) {
  return (
    <li className="cown-record">
      <span className="cown-dot" aria-hidden />
      <span className="cown-record-main">
        <b>{m.items}</b>
        <small>
          {fmtDay(m.at)} · {fmtKm(m.odometerKm)} · {sourceLabel(m.source)}
        </small>
      </span>
    </li>
  );
}

function RepairRow({ r }: { r: RepairItem }) {
  return (
    <li className="cown-record">
      <span className="cown-dot" aria-hidden />
      <span className="cown-record-main">
        <b>{r.symptom}</b>
        <small className={r.resolution?.trim() ? undefined : "cown-record-missing"}>
          {repairResolutionText(r)}
        </small>
        <small>
          {fmtDay(r.at)} · {fmtKm(r.odometerKm)} · {sourceLabel(r.source)}
          {r.sessionId ? " · 来自问诊" : ""}
        </small>
      </span>
    </li>
  );
}

const S = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none" } as const;

function WrenchIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 3.5a5 5 0 0 0-6.2 6.2L3.6 15.4a2 2 0 0 0 2.8 2.8l5.7-5.7a5 5 0 0 0 6.2-6.2l-2.9 2.9-2.6-.7-.7-2.6z" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H13z" />
    </svg>
  );
}
