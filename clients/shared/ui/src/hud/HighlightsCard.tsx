/**
 * 目的地推荐卡（施工单 M32-03）。
 *
 * 与「行前温馨提示」轮播在**同一个窗口**里：外框（`.hud-tips` 的 right/top/width/height）
 * 一字不改，换的只是这一页里画什么。外框跳尺寸的代价是每 6 秒地图被遮挡的面积跳一次，
 * 比多显示两行字糟得多。
 *
 * 版式（todo 2.a 的原话）：**左边是排行榜 / 打卡点，右边是对应的拍照建议**。
 *
 * # 出处**不上卡**（产品决定，2026-08-28）
 *
 * 契约里的 `sourceUrl` 照旧存在、照旧只有在工具那侧与真实搜索结果**字符串全等**
 * 时才有值（`enterprise/backend/shared/tools/src/destination-highlights.ts`：模型会把 URL 改写成
 * 打不开的短链）。核对那一层一点没松——松了就等于让模型编的链接进系统。
 *
 * 变的只是**画不画**：这张卡上不显示任何出处（角标、主机名、链接，一样都没有）。
 * 理由是车机这块地方寸土寸金，10px 的主机名在驾驶距离上读不出来，
 * 却要占掉店名那一行近一半的宽度。
 *
 * ⚠️ 所以这张卡**不许出现任何"据某某"式的来源字样**——不是"暂时没做"，
 * 是显示了就等于给一条无法当场核对的断言背书。要核对出处走轨迹与接口返回值。
 * 别的端（手机、控制台）要展示它，那是它们各自的取舍，与本组件无关。
 */
import type { ReactNode } from "react";

import type { DestinationHighlights, HighlightEntry, PhotoTipRef } from "@carlife/shared";

import { CardPager } from "./CardPager";

export interface HighlightsCardProps {
  highlights: DestinationHighlights;
  /** 当前页码（从 1 开始）与总页数——与物品卡共用同一套轮播状态。 */
  page: number;
  pageCount: number;
  /** 供轮播挂载滑动手势的容器属性（与物品卡同一份）。 */
  gestureProps?: Record<string, unknown>;
  footer?: ReactNode;
}

/** 卡高定死了能放几行。工具侧也截到 3，这里再兜一次——契约不保证上游守规矩。 */
export const MAX_ROWS_PER_SECTION = 3;

export function HighlightsCard({
  highlights,
  page,
  pageCount,
  gestureProps,
  footer,
}: HighlightsCardProps) {
  const foods = highlights.foods.slice(0, MAX_ROWS_PER_SECTION);
  const spots = highlights.spots.slice(0, MAX_ROWS_PER_SECTION);
  const tips = highlights.photoTips.slice(0, MAX_ROWS_PER_SECTION);

  return (
    <section
      className="hud-card hud-tips hud-highlights"
      aria-label={`目的地推荐 · ${highlights.destination}`}
      {...gestureProps}
    >
      <header className="hud-tips__head">
        <PinIcon />
        <h2 className="hud-tips__title">目的地推荐 · {highlights.destination}</h2>
      </header>

      <div className="hud-tips__divider" />

      <div className="hud-highlights__body">
        <div className="hud-highlights__col">
          <RankSection title="吃什么" entries={foods} />
          {/*
           * 打卡点**只给名字与出处，不给理由**。
           *
           * 不是省略，是右栏那条拍照建议就是这个点的"为什么去"——
           * 同一件事在一张卡上说两遍，代价是三条推荐里有一条被卡高吃掉
           * （走查实测：三节都带理由时正文高 300px、可用只有 232px）。
           */}
          <RankSection title="打卡点" entries={spots} showNote={false} />
        </div>
        <div className="hud-highlights__col hud-highlights__col--tips">
          <TipsSection tips={tips} />
        </div>
      </div>

      {/* 页脚与物品卡共用一份，只是这张卡的正文更挤，页码与圆点并排放（`compact`）。 */}
      <CardPager page={page} pageCount={pageCount} compact />
      {footer}
    </section>
  );
}

/**
 * 排行榜的一节。**整段为空就连小标题一起不渲染**——
 * 一个孤零零的「吃什么」下面什么都没有，读起来像加载失败。
 */
function RankSection({
  title,
  entries,
  showNote = true,
}: {
  title: string;
  entries: HighlightEntry[];
  showNote?: boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="hud-highlights__section">
      <h3 className="hud-highlights__label">{title}</h3>
      <ol className="hud-highlights__list">
        {entries.map((e, i) => (
          // key 带序号：两家同名的店在排行榜里是可能的（连锁），名字不唯一。
          <li className="hud-highlights__row" key={`${e.name}-${i}`}>
            <span className="hud-highlights__rank" aria-hidden="true">
              {i + 1}
            </span>
            <span className="hud-highlights__text">
              <span className="hud-highlights__name">{e.name}</span>
              {showNote && e.note && <span className="hud-highlights__note">{e.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TipsSection({ tips }: { tips: PhotoTipRef[] }) {
  if (tips.length === 0) return null;
  return (
    <section className="hud-highlights__section">
      <h3 className="hud-highlights__label">怎么拍</h3>
      <ul className="hud-highlights__list">
        {tips.map((t, i) => (
          <li className="hud-highlights__row hud-highlights__row--tip" key={`${t.spot}-${i}`}>
            <span className="hud-highlights__text">
              {t.spot && <span className="hud-highlights__spot">{t.spot}</span>}
              <span className="hud-highlights__note">{t.tip}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 地点针脚：卡头那一枚，与提示卡的天气图标占同一个位置。 */
function PinIcon() {
  return (
    <svg
      className="hud-tips__weather hud-highlights__pin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.6" />
    </svg>
  );
}
