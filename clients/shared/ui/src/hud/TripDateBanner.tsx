/**
 * 顶部日期条（施工单 M73-01）：主页**选中**某一程时地图上方那一条。
 *
 * 概念图 `output/imagegen/trip-list-dates/C-date-pill-above-map.png`：日历图标、大字「9/20 周六 → 9/22 周一」、
 * 琥珀小字「青岛 · 3 天 · 3 天后出发」、右端 ×。× = 取消选中，回到未选中态（周日历卡、地图跟最近一程）。
 * 与跟车顶栏互斥（由页面层决定不渲染）——跟车时屏幕顶部是下一站与 ETA。
 *
 * 没定日期的行程按默认明天出发画起止日（M75-03），后面跟一枚「待定」小标——日期是默认口径不是用户定的。
 */

import { relativeDepartLabel, tripDateRange, weekdayLabel, type TripPlanListEntry } from "@carlife/shared";

export interface TripDateBannerProps {
  entry: TripPlanListEntry;
  /** 本地今天（YYYY-MM-DD），相对时间的口径。 */
  today: string;
  onClose: () => void;
}

/** 「9/20 周六」。 */
export function shortDateLabel(dateIso: string): string {
  const [, mm, dd] = dateIso.split("-");
  if (!mm || !dd) return dateIso;
  return `${Number(mm)}/${Number(dd)} ${weekdayLabel(dateIso)}`;
}

export function TripDateBanner({ entry, today, onClose }: TripDateBannerProps) {
  const range = tripDateRange(entry.plan, today);
  const rel = relativeDepartLabel(entry.plan, today);
  return (
    <div className="hud-card hud-datebar" role="status" aria-label="已选中的行程">
      <CalendarIcon />
      <span className="hud-datebar__dates">
        <b>{shortDateLabel(range.start)}</b>
        <span className="hud-datebar__arrow" aria-hidden="true">
          →
        </span>
        <b>{shortDateLabel(range.end)}</b>
        {range.tentative && (
          <span className="hud-trips__date hud-datebar__tentative" title="没定日期，按明天出发算">
            待定
          </span>
        )}
      </span>
      <span className="hud-datebar__meta">
        {entry.plan.destination} · {entry.plan.days} 天 · {rel}
      </span>
      <button type="button" className="hud-datebar__close" aria-label="取消选中" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg className="hud-datebar__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
    </svg>
  );
}
