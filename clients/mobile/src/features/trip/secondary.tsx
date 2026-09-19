/**
 * 「行程规划」二级页（施工单 M103-02，设计 UI-01 v1.1 第 1b 步）。
 *
 * 2026-09-17 起主页不再展示行程规划：原主页整屏（`features/hud` 的 `MobileHud`，地图 + 站点卡 +
 * 住宿横幅 + 「我的行程」/「开始行程」+ 行前提示 + 车况条）**一行不改**地搬进这一页，
 * 上面盖一条页头。出发卡 / 行程抽屉 / 变化摘要 / 导览页都从这一页起（门在 App 壳里，`tripOpen`）。
 *
 * 页头是**盖在** HUD 舞台上面的（不是 flex 的上半截）：`HudStage` 的竖屏尺度按整个视口高算
 * （`hud.css` 竖屏块 `--hud-portrait-unit`），把它压矮会让底部那一摞的落点链全错。
 * 所以舞台仍铺满，页头浮在顶上，HUD 顶部锚定的几样（跟车顶栏 / 住宿横幅 / 日期条 / 日切换）
 * 在 `secondary.css` 里按 `--mtrip-head-h` 往下让。
 *
 * 没有暖暖：`MobileHud` 传 `assistant={false}`（由调用方传，本组件只管页头）。
 */

import type { ReactNode } from "react";

import "./secondary.css";

export interface MobileTripPageProps {
  /** 行程程数；0 时不渲染右上那枚「我的行程」。 */
  tripCount: number;
  /** 跟车中：不许「‹ 主页」——导航结束由既有 NavBar 流程回到非跟车态。 */
  navigating: boolean;
  onBack: () => void;
  onOpenList: () => void;
  children: ReactNode;
}

export function MobileTripPage({ tripCount, navigating, onBack, onOpenList, children }: MobileTripPageProps) {
  return (
    <div className="mtrip">
      <div className="mtrip-body">{children}</div>
      <header className="mtrip-head">
        {navigating ? (
          <span className="mtrip-head__back is-disabled" aria-disabled="true">
            导航中
          </span>
        ) : (
          <button type="button" className="mtrip-head__back" onClick={onBack} aria-label="返回主页">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            主页
          </button>
        )}
        <h1 className="mtrip-head__title">行程规划</h1>
        {tripCount > 0 ? (
          <button type="button" className="mtrip-head__list" onClick={onOpenList} aria-label={`我的行程，共 ${tripCount} 程`}>
            我的行程 · {tripCount}
          </button>
        ) : (
          <span className="mtrip-head__spacer" aria-hidden="true" />
        )}
      </header>
    </div>
  );
}
