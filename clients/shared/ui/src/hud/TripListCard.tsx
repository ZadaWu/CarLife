/**
 * 行程列表卡（施工单 M72-04，设计 内部文档）。
 *
 * 右上角一张与提示卡同外壳的紧凑列表：每程一行「起点 → 终点 · 日期 · 天数」+ 逐日天气小图标 + 变化点。
 * 点某一程 = 选中（地图与提示卡跟着切）；点带点的那程 = 打开变化摘要。
 * 两个回调都**上抛**（F-01-04：卡片可点击、跳转由页面层决定）——卡自己不碰网络、不做判断，
 * 「变没变」「作没作废」全是 contracts 的纯函数（`reviewNeedsAttention` / `reviewIsStale`）。
 *
 * # 没有行程就不渲染
 *
 * 由调用方决定（`entries.length === 0` 时不挂这张卡），提示卡窗保持原尺寸——
 * 一张空列表卡占着右上角，比没有更像出了故障（F-01-05）。
 *
 * # 逐日天气位的三种形态
 *
 * 有核查且那天有 kind → 天气贴纸；核查缺失 / 那天 `unavailable` → **灰点**（不画太阳：
 * 拿不到预报不是晴天，F-01-05「不得把 0 当作有效值展示」）。
 * 没有核查时只把确认那一刻的整程 `weather.kind` 画在第 1 天——那是当时算过的，其余没有算过；
 * 但**没定日期的行程不这么兜底**：它按默认明天出发（M75-03），确认那天算的"明天"到第二天就不再是
 * 这一程的第 1 天了，拿它当第 1 天的天气就是把过期值当有效值。没核查前一律灰点，核查夜里会补上。
 */

import type { ReactNode } from "react";

import {
  reviewIsStale,
  reviewNeedsAttention,
  type TripPlanListEntry,
  type TripPlanSnapshot,
  type WeatherKind,
} from "@carlife/shared";

/** 一行最多画几天；多的折成 `+N`（列表卡只有这么宽）。 */
export const MAX_DAY_CELLS = 5;
/** 不滚动能放几行；超过卡内滚动，不撑破外框（外框跳尺寸 = 地图被遮挡的面积跳）。 */
export const MAX_ROWS_VISIBLE = 3;

export interface TripListCardProps {
  entries: readonly TripPlanListEntry[];
  selectedPlanId?: string;
  /** 常住地城市名：行程没写起点时用它；再没有显示「出发」。 */
  homeCity?: string;
  /** 天气贴纸（按主题传入，`SPRITES[theme].weather`）。 */
  weatherIcons: Readonly<Record<string, string>>;
  onSelect?: (planId: string) => void;
  onOpenReview?: (planId: string) => void;
  footer?: ReactNode;
}

/** 起点 → 终点。起点：行程写了的 → 常住地城市 → 「出发」。不编地名。 */
export function tripRouteLabel(plan: Pick<TripPlanSnapshot, "origin" | "destination">, homeCity?: string): string {
  const from = plan.origin?.trim() || homeCity?.trim() || "出发";
  return `${from} → ${plan.destination}`;
}

/** 「9/12 起 · 3 天」；没定日期显示「日期待定 · 3 天」。 */
export function tripMetaLabel(plan: Pick<TripPlanSnapshot, "startDate" | "days">): string {
  const daysText = `${plan.days} 天`;
  if (!plan.startDate) return `日期待定 · ${daysText}`;
  const [, mm, dd] = plan.startDate.split("-");
  if (!mm || !dd) return `日期待定 · ${daysText}`;
  return `${Number(mm)}/${Number(dd)} 起 · ${daysText}`;
}

export interface DayCell {
  day: number;
  /** undefined = 灰点（没查到 / 没定日期 / 没核查过那天）。 */
  kind?: WeatherKind;
}

/** 逐日格：最多 `MAX_DAY_CELLS` 格 + 溢出数。 */
export function dayCells(entry: TripPlanListEntry, max = MAX_DAY_CELLS): { cells: DayCell[]; overflow: number } {
  const days = Math.max(0, entry.plan.days);
  const shown = Math.min(days, max);
  const review = entry.review && !reviewIsStale(entry.review, entry.updatedAt) ? entry.review : undefined;
  const cells: DayCell[] = [];
  for (let day = 1; day <= shown; day += 1) {
    const r = review?.days.find((d) => d.day === day);
    let kind: WeatherKind | undefined;
    if (review) {
      kind = r && !r.unavailable ? r.kind : undefined;
    } else if (day === 1 && entry.plan.startDate) {
      // 没核查过：只有确认那一刻的整程天气是算过的，画在第 1 天，其余不猜。
      // 没定日期的不画：默认出发日随今天移动，确认那天算的已经不是这一程的第 1 天（文件头）。
      kind = entry.plan.weather?.kind;
    }
    cells.push(kind ? { day, kind } : { day });
  }
  return { cells, overflow: days - shown };
}

/** 变化点：有未确认的变化且核查没作废。 */
export function entryNeedsAttention(entry: TripPlanListEntry): boolean {
  return Boolean(
    entry.review && reviewNeedsAttention(entry.review) && !reviewIsStale(entry.review, entry.updatedAt),
  );
}

export function TripListCard({
  entries,
  selectedPlanId,
  homeCity,
  weatherIcons,
  onSelect,
  onOpenReview,
  footer,
}: TripListCardProps) {
  return (
    <section className="hud-card hud-trips" aria-label="我的行程">
      <header className="hud-tips__head hud-trips__head">
        <RouteIcon />
        <h2 className="hud-tips__title hud-trips__title">我的行程</h2>
        <span className="hud-trips__count" aria-label={`共 ${entries.length} 程`}>
          {entries.length}
        </span>
      </header>
      <ul className={`hud-trips__list${entries.length > MAX_ROWS_VISIBLE ? " is-scroll" : ""}`}>
        {entries.map((entry) => {
          const attention = entryNeedsAttention(entry);
          const critical = attention && entry.review?.severity === "critical";
          const selected = entry.planId === selectedPlanId;
          const { cells, overflow } = dayCells(entry);
          const cls = [
            "hud-trips__row",
            selected ? "is-selected" : "",
            attention ? "has-attention" : "",
            critical ? "is-critical" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li className={cls} key={entry.planId}>
              <button
                type="button"
                className="hud-trips__main"
                aria-pressed={selected}
                onClick={() => onSelect?.(entry.planId)}
              >
                <span className="hud-trips__route">{tripRouteLabel(entry.plan, homeCity)}</span>
                <span className="hud-trips__meta">{tripMetaLabel(entry.plan)}</span>
              </button>
              <span className="hud-trips__days" aria-label="逐日天气">
                {cells.map((c) =>
                  c.kind && weatherIcons[c.kind] ? (
                    <img
                      key={c.day}
                      className="hud-trips__weather"
                      src={weatherIcons[c.kind]}
                      alt=""
                      aria-hidden="true"
                    />
                  ) : (
                    <span key={c.day} className="hud-trips__dot hud-trips__dot--unknown" aria-hidden="true" />
                  ),
                )}
                {overflow > 0 && <span className="hud-trips__more">+{overflow}</span>}
              </span>
              {attention ? (
                <button
                  type="button"
                  className="hud-trips__flag"
                  aria-label={critical ? "行程有重要变化，点击查看" : "行程有变化，点击查看"}
                  onClick={() => onOpenReview?.(entry.planId)}
                >
                  <span className="hud-trips__flag-dot" />
                </button>
              ) : (
                <span className="hud-trips__flag hud-trips__flag--none" aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ul>
      {footer}
    </section>
  );
}

/** 路线图标：与推荐卡的针脚、提示卡的天气图标占同一个位置。 */
function RouteIcon() {
  return (
    <svg
      className="hud-tips__weather hud-trips__icon"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="5" cy="6" r="2.4" />
      <circle cx="19" cy="18" r="2.4" />
      <path d="M7.2 6.6h6.3a3 3 0 0 1 0 6H10a3 3 0 0 0 0 6h6.6" strokeLinecap="round" />
    </svg>
  );
}
