/**
 * 集中式行前温馨提示卡（施工单 M1-02 静态形态，行为见 M1-03）
 *
 * Brief §3.3：唯一物品提醒入口。每页最多 3 件、三件等宽；超过 3 件拆页，
 * 用「1 / 2」+ 圆点表示页数。卡片、助手服饰与天气建议共用同一环境上下文。
 */
import type { ReactNode } from "react";

import { CardPager } from "./CardPager";

export interface TipItem {
  /** 物品 key，例如 hat / sunscreen / water。 */
  key: string;
  /** 物品名，例如「遮阳帽」。 */
  label: string;
  /** 物品图标 URL（按主题传入）。 */
  icon: string;
}

export interface TipsCardProps {
  /** 天气图标（晴热=太阳，降雨=雨伞等），与助手服饰同源。 */
  weatherIcon: string;
  /** 场景化提醒句。 */
  headline?: string;
  /** 当前页物品，调用方保证 ≤ 3 件。 */
  items: TipItem[];
  /** 当前页码（从 1 开始）与总页数。 */
  page: number;
  pageCount: number;
  /** 供 M1-03 挂载滑动手势的容器属性。 */
  gestureProps?: Record<string, unknown>;
  /** 页脚附加内容（M1-03 的滑动指示）。 */
  footer?: ReactNode;
}

/** Brief §3.3：每页最多 3 件物品。 */
export const MAX_ITEMS_PER_PAGE = 3;

export function TipsCard({
  weatherIcon,
  headline = "行前温馨提示",
  items,
  page,
  pageCount,
  gestureProps,
  footer,
}: TipsCardProps) {
  const shown = items.slice(0, MAX_ITEMS_PER_PAGE);

  return (
    <section
      className="hud-card hud-tips"
      aria-label="行前温馨提示"
      {...gestureProps}
    >
      <header className="hud-tips__head">
        <img className="hud-tips__weather" src={weatherIcon} alt="" aria-hidden="true" />
        <h2 className="hud-tips__title">{headline}</h2>
      </header>

      <div className="hud-tips__divider" />

      <ul className="hud-tips__items">
        {shown.map((item, i) => (
          // key 不能用 item.key——它是**图标品类**，同页出现两件同类物品
          // （防晒霜/防晒喷雾同归 sunscreen）就成了重复 key，React 会错配 DOM 节点，
          // 症状是列表看起来"复制"了同一件物品。带上序号才唯一。
          <li className="hud-tips__item" key={`${item.key}-${i}`}>
            <img className="hud-tips__icon" src={item.icon} alt="" aria-hidden="true" />
            <span className="hud-tips__label">{item.label}</span>
          </li>
        ))}
      </ul>

      {/* 页数仅在多页时出现（Brief §3.3）。页脚与目的地推荐卡共用，见 CardPager。 */}
      <CardPager page={page} pageCount={pageCount} />

      {footer}
    </section>
  );
}
