/**
 * 提示卡窗口的页脚：页码 + 圆点 + 滑动引导（施工单 M32-03 从 `TipsCard` 提出）。
 *
 * # 为什么提出来而不是各画一份
 *
 * 从 M32-03 起这个窗口里轮播的是**两类卡**（行前物品 / 目的地推荐）。
 * 页脚各画一份的必然结果是两边慢慢长歪——一边改了圆点间距另一边没改，
 * 而它们每 6 秒交替出现一次，差异会被放大成"卡片在抖"。
 *
 * 提取是**纯重构**：`TipsCard` 的渲染输出逐字节不变，由既有的
 * `@carlife/ui` 测试守着（`pageCount = 1` 时三者都不渲染那一条）。
 */

/** 页数 ≤ 1 时整块不渲染——翻页本身不存在，引导就是噪声（Brief §3.3）。 */
export interface CardPagerProps {
  /** 当前页（1 起）。 */
  page: number;
  pageCount: number;
  /**
   * 页码与圆点并排放（默认是上下两行）。
   *
   * 只为正文更挤的那张卡（目的地推荐）留的：并排能省下约 26px 正文高度，
   * 而这张卡的正文差的正是那么多。滑动引导两边都保留——
   * 「这张卡还能横滑」在车机上没有别的线索。
   */
  compact?: boolean;
}

export function CardPager({ page, pageCount, compact = false }: CardPagerProps) {
  if (pageCount <= 1) return null;
  return (
    <div
      className={`hud-tips__pager${compact ? " is-compact" : ""}`}
      aria-label={`第 ${page} 页，共 ${pageCount} 页`}
    >
      <div className="hud-tips__pagenum">
        <span className="hud-tips__pagenum-cur">{page}</span>
        <span className="hud-tips__pagenum-sep"> / </span>
        <span>{pageCount}</span>
      </div>
      <div className="hud-tips__dots">
        {Array.from({ length: pageCount }, (_, i) => (
          <span key={i} className={`hud-tips__dot${i === page - 1 ? " is-active" : ""}`} />
        ))}
      </div>
      <SwipeHint />
    </div>
  );
}

/**
 * 滑动手势引导（定稿图 §3.3：圆点下方一条右向箭头 + 点按手势）。
 *
 * 车机上「这张卡还能横滑」没有任何别的线索——圆点只说明有几页，
 * 不说明怎么翻。定稿里这条箭头就是干这个的，所以它跟随页码一起出现、
 * 也一起消失（单页时翻页本身不存在，引导就是噪声）。
 * 纯装饰，`aria-hidden`：页码那一层已经把"第几页共几页"读给屏幕阅读器了。
 */
function SwipeHint() {
  return (
    <svg
      className="hud-tips__hint"
      viewBox="0 0 148 40"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g className="hud-tips__hint-arrow">
        <path d="M4 26 H108" strokeLinecap="round" />
        <path d="M100 19 L110 26 L100 33" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g className="hud-tips__hint-hand" transform="translate(112 6) scale(1.15)">
        {/* Lucide `pointer` 同形：食指上翘的点按手势 */}
        <path d="M19 12a7 7 0 0 1-7 7" strokeLinecap="round" />
        <path d="M15.5 9.5v-1a1.8 1.8 0 0 0-3.5 0" strokeLinecap="round" />
        <path d="M12 8.6v-.9a1.8 1.8 0 0 0-3.5 0v.9" strokeLinecap="round" />
        <path d="M8.5 8.2V3.8a1.8 1.8 0 0 0-3.5 0v8.9" strokeLinecap="round" />
        <path
          d="M15.5 9.5a1.8 1.8 0 1 1 3.5 0v2.6a7 7 0 0 1-7 7h-1.7c-2.4 0-3.9-.8-5.2-2l-3.1-3.2a1.8 1.8 0 0 1 2.5-2.5L6.2 13"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
