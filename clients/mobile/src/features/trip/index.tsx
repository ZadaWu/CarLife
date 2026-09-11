/**
 * features/trip — 手机端的行程抽屉（施工单 M75-02；FL-18 `F-18-15` 指定的落点）。
 *
 * 竖屏主页只放得下**紧凑**周日历卡（提示卡的槽位，144u 高）：周条 + 色块，没有清单。
 * 清单与翻页在这里——从底部升起的 sheet（与出发卡 `.mobile-depart` 同形态），里面是
 * **完整**的 `TripCalendarCard`（`@carlife/ui`，与车机同一份组件）：周条 ‹ › 、色块、清单每页 3 程、页脚。
 *
 * 出口只有三个，全是无后果的：选中一程（关抽屉、主页进选中态）、点红点看变化（开摘要弹层）、关闭。
 * 抽屉自己不碰网络、不做判断——判据全在 contracts 的纯函数里（F-01-04）。
 */

import type { TripPlanListEntry } from "@carlife/shared";
import { TripCalendarCard } from "@carlife/ui";

export interface MobileTripSheetProps {
  entries: readonly TripPlanListEntry[];
  selectedPlanId?: string;
  /** 本地今天（YYYY-MM-DD）。 */
  today: string;
  homeCity?: string;
  weatherIcons: Readonly<Record<string, string>>;
  onSelect: (planId: string) => void;
  onOpenReview: (planId: string) => void;
  onClose: () => void;
}

export function MobileTripSheet({ entries, selectedPlanId, today, homeCity, weatherIcons, onSelect, onOpenReview, onClose }: MobileTripSheetProps) {
  return (
    <div className="mobile-trips" role="dialog" aria-modal="true" aria-label="我的行程">
      <button type="button" className="mobile-trips__backdrop" aria-label="关闭行程列表" onClick={onClose} />
      <div className="mobile-trips__panel">
        <div className="mobile-trips__grip" aria-hidden="true" />
        <TripCalendarCard
          entries={entries}
          today={today}
          selectedPlanId={selectedPlanId}
          homeCity={homeCity}
          weatherIcons={weatherIcons}
          onSelect={onSelect}
          onOpenReview={onOpenReview}
        />
        <button type="button" className="mobile-trips__close" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
