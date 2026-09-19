/**
 * 诊断报告页（施工单 M104-04，设计 UI-01 v1.1 第 4 步）。覆盖层，与购车页同形态（不占底导）。
 *
 * 六张卡按 Brief 顺序：车辆行 → 风险卡（第一眼）→ 照片里看到的 → 暖暖的判断（回答正文）→ 先自查这几项 →
 * 什么时候必须立即停车（折叠；高风险时默认展开并上移）→ 到店可以这样问 → 页脚免责**只此一处**（F-20-14）。
 * 全部读结构化报告；正文是这一轮的回答，「可能的原因」由它承担。
 * 红只给「高风险」的判定（设计系统 §4.2）。
 */
import { Fragment, useState } from "react";
import { splitHighlights } from "@carlife/ui";

import type { HomeVehicle, VehicleReadState } from "../home/model";
import { formatKm, vehicleLine } from "../home/model";
import type { DiagnosisReport, DiagnosisRiskLevel } from "./types";

import "./diagnosis.css";

const LEVEL_LABEL: Record<DiagnosisRiskLevel, string> = { low: "低风险", medium: "中风险", high: "高风险" };

export function riskTitle(report: Pick<DiagnosisReport, "risk">): string {
  return `${LEVEL_LABEL[report.risk.level]} · ${report.risk.action}`;
}

function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface MobileDiagnosisReportProps {
  report: DiagnosisReport;
  vehicle?: HomeVehicle | null;
  vehicleState: VehicleReadState;
  /** 已留档到车辆档案（问诊留档成功后）；缺席不显示那枚勾。 */
  archived?: boolean;
  onClose: () => void;
  onBook: () => void;
  onFollowup: () => void;
  onGoProfile?: () => void;
}

export function MobileDiagnosisReport({ report, vehicle, vehicleState, archived, onClose, onBook, onFollowup, onGoProfile }: MobileDiagnosisReportProps) {
  const high = report.risk.level === "high";
  const [stopOpen, setStopOpen] = useState(high);
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const obs = report.observation;
  /*
   * 三张清单卡**空了就不出**（2026-09-18 用户走查）。
   *
   * 以前它们恒出：一张「安全带没系」的照片也会带出「什么时候必须立即停车 · 刹车踏板变软…」
   * 和一屏异响自查项。服务端现在会在没内容时给空数组（`graph/diagnosis.ts` 的 `lampFacts`），
   * 这里就得真的不渲染——留一张空标题的卡，比那份无关内容好不了多少。
   */
  const hasStop = report.stopNowSigns.length > 0;
  const stopCard = (
    <section className={`dx-card dx-card--stop${stopOpen ? " is-open" : ""}`} data-testid="dx-stop">
      <button type="button" className="dx-card__row" aria-expanded={stopOpen} onClick={() => setStopOpen((v) => !v)}>
        <b className="dx-card__title">什么时候必须立即停车</b>
        <span className="dx-chevron" aria-hidden="true">
          {stopOpen ? "⌃" : "›"}
        </span>
      </button>
      {stopOpen && (
        <ul className="dx-list">
          {report.stopNowSigns.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="dxr" role="dialog" aria-modal="true" aria-label="车辆诊断报告">
      <header className="dxr-head">
        <button type="button" className="dxr-head__back" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          返回
        </button>
        <h1 className="dxr-head__title">车辆诊断报告</h1>
        <span className="dxr-head__spacer" aria-hidden="true" />
      </header>

      <div className="dxr-body">
        {/* 车辆行：来自默认车档案（AC-20-11 关联档案）；没有档案就说没有 + 去建档。 */}
        <section className="dx-card dx-card--vehicle">
          {vehicleState === "ready" && vehicle ? (
            <>
              <b className="dx-card__title">
                {vehicle.model} · {vehicle.modelYear} 款
              </b>
              <span className="dx-card__caption">
                表显 {formatKm(vehicle.odometerKm)} km · {whenLabel(report.at)}
                {archived && <span className="dx-archived">· 已留档到车辆档案 ✓</span>}
              </span>
            </>
          ) : (
            <>
              <b className="dx-card__title">{vehicleLine(vehicleState, vehicle)}</b>
              <span className="dx-card__caption">
                {whenLabel(report.at)}
                {vehicleState === "empty" && onGoProfile && (
                  <>
                    {" · "}
                    <button type="button" className="dx-link" onClick={onGoProfile}>
                      去建档
                    </button>
                  </>
                )}
              </span>
            </>
          )}
        </section>

        {/* 风险卡：第一眼可见；色条与徽按等级；红只在 high。 */}
        <section className={`dx-card dx-card--risk dx-risk--${report.risk.level}`} data-testid="dx-risk">
          <span className="dx-risk__badge" aria-hidden="true">
            !
          </span>
          <div className="dx-risk__text">
            <b className="dx-risk__title">{riskTitle(report)}</b>
            <ul className="dx-list dx-list--basis">
              {report.risk.basis.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
          <span className="dx-card__caption dx-risk__hint">依据</span>
        </section>

        {high && hasStop && stopCard}

        {obs && (
          <section className="dx-card" data-testid="dx-seen">
            <b className="dx-card__title">照片里看到的</b>
            {obs.unreadable ? (
              <p className="dx-card__body">这张照片没读出来：{obs.retakeHints.join("；") || "请把部位正对镜头再拍一张"}</p>
            ) : obs.items.length === 0 ? (
              /* 零符号（2026-09-19 用户走查）：报告页也得有这一段，否则「照片里看到的」是一张空卡。 */
              <p className="dx-card__body">
                这张没认出仪表上的符号——不代表车上没有提示灯，只是没对上手册图标。
                {obs.retakeHints.length > 0 && `${obs.retakeHints.join("；")}。`}
              </p>
            ) : (
              <ol className="dx-list dx-list--num">
                {obs.items.map((it, i) => (
                  <li key={`${it.name ?? "?"}-${i}`}>
                    {it.suspected ? "疑似 " : ""}
                    {it.name ?? "未能对上的符号"} · {it.color === "red" ? "红色" : it.color === "amber" ? "琥珀色" : it.color} · {it.manualAnchor ?? "未能完全对上"}
                    {/* 对话里那张卡把说明封了两行，全文在这里（`diagnosis.css` 的 `.dx-item__desc` 注释指向这一处）。
                        疑似那条同样写成条件句，理由见 `guided.tsx` 的 `descLine`。 */}
                    {it.description && (
                      <span className="dx-seen__desc">{it.suspected && it.name ? `若是「${it.name}」：${it.description}` : it.description}</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        <section className="dx-card" data-testid="dx-answer">
          <b className="dx-card__title">暖暖的判断</b>
          {report.answer
            .split(/\n{2,}/)
            .filter((p) => p.trim())
            .map((p, i) => (
              <p className="dx-card__body" key={i}>
                {/*
                  正文里的 `**关键信息**` 与对话气泡走**同一个**渲染
                  （`splitHighlights`，@carlife/ui）。报告页此前直出字符串，
                  于是车主在这里看到的是一堆星号——而这段正文与气泡里那段是同一句话
                  （2026-09-18 用户走查图二）。
                */}
                {splitHighlights(p).map((seg, j) =>
                  seg.key ? (
                    <mark key={j} className="dlg-key">
                      {seg.text}
                    </mark>
                  ) : (
                    <Fragment key={j}>{seg.text}</Fragment>
                  ),
                )}
              </p>
            ))}
        </section>

        {report.selfChecks.length > 0 && (
        <section className="dx-card" data-testid="dx-selfchecks">
          <b className="dx-card__title">先自查这几项</b>
          <ul className="dx-checks">
            {report.selfChecks.map((c, i) => (
              <li key={c}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked.has(i)}
                    onChange={() =>
                      setChecked((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      })
                    }
                  />
                  <span>{c}</span>
                </label>
              </li>
            ))}
          </ul>
          <span className="dx-card__caption">做完可以回到对话里告诉暖暖结果</span>
        </section>
        )}

        {!high && hasStop && stopCard}

        {report.questionsForShop.length > 0 && (
          <section className="dx-card" data-testid="dx-shop">
            <b className="dx-card__title">到店可以这样问</b>
            <ul className="dx-list dx-list--quote">
              {report.questionsForShop.map((q) => (
                <li key={q}>“{q}”</li>
              ))}
            </ul>
          </section>
        )}

        <p className="dxr-disclaimer">{report.disclaimer}</p>
      </div>

      <footer className="dxr-actions">
        <button type="button" className="dx-primary dx-primary--wide" onClick={onBook}>
          预约门店检查
        </button>
        <button type="button" className="dx-secondary dx-secondary--wide" onClick={onFollowup}>
          基于报告继续问
        </button>
      </footer>
    </div>
  );
}
