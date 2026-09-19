/**
 * 顶部日期条（施工单 M73-01）：主页**选中**某一程时地图上方那一条。
 *
 * 概念图 `output/imagegen/trip-list-dates/C-date-pill-above-map.png`：日历图标、大字「9/20 周六 → 9/22 周一」、
 * 琥珀小字「青岛 · 3 天 · 3 天后出发」、右端 ×。× = 取消选中，回到未选中态（周日历卡、地图跟最近一程）。
 * 与跟车顶栏互斥（由页面层决定不渲染）——跟车时屏幕顶部是下一站与 ETA。
 *
 * 没定日期的行程按默认明天出发画起止日（M75-03），后面跟一枚「待定」小标——日期是默认口径不是用户定的。
 *
 * # 工具按钮与下拉菜单（M83-02）
 *
 * × 左侧一枚同形态的圆钮，点开一张菜单。v1 只有「行程详情」一项——**菜单的价值不在这一项**，
 * 在于「行程变化」「取消行程」这些现在散在列表卡小红点上、散在"对着暖暖说"里的操作，
 * 以后有一个确定的地方可挂。
 *
 * 三件事在这里是刻意的：
 *
 * 1. **受控**：开合状态在上层（`App`），不是组件内部 state。抽屉、未保存变更的确认都要读它，
 *    藏在组件里的话上层没法在"换了一程""切走页面"时把它收起来。
 * 2. **收起靠一张透明遮罩，不靠 `document.addEventListener("click")`**。HUD 上没有"外面"——
 *    地图、卡片、暖暖各自吃指针事件，而长按说话的手势层在捕获阶段就处理了 pointer 事件，
 *    全局监听会和它打架。遮罩铺满视口、z 93：盖住所有比日期条（展开时 94）低的东西，
 *    而确认弹层（100）、摘要弹层（200）不受影响。
 *
 *    ⚠️ **遮罩必须是日期条的兄弟，不能是它的孩子**。`.hud-datebar` 带
 *    `transform: translateX(-50%)`，而**有 transform 的元素会成为 `position: fixed`
 *    后代的包含块**——放进去的话 `inset: 0` 量的是胶囊自己（实测 958×70 而不是整屏），
 *    于是点地图收不起菜单，且一个错都不报。2026-09-14 真机走查才看出来。
 *    所以组件返回的是 `<>遮罩 + 胶囊</>` 两个节点。
 * 3. **手机端不渲染**：`showTools` 缺省 `false`。竖屏也用 `.hud-datebar`，光靠 CSS 藏
 *    留下的是一个点得到、看不见的按钮。CSS 管样式、入参管 DOM，两道都要有。
 */

import { relativeDepartLabel, tripDateRange, weekdayLabel, type TripPlanListEntry } from "@carlife/shared";

export interface TripDateBannerProps {
  entry: TripPlanListEntry;
  /** 本地今天（YYYY-MM-DD），相对时间的口径。 */
  today: string;
  onClose: () => void;
  /** 是否渲染工具按钮（M83-02）。缺省 false = 与此前一字不差，手机端不传。 */
  showTools?: boolean;
  /** 菜单是否展开（受控，状态在上层）。 */
  menuOpen?: boolean;
  onToggleMenu?: () => void;
  /** 菜单项「行程详情」：打开右侧抽屉（M83-03 接）。 */
  onOpenDetail?: () => void;
}

/** 「9/20 周六」。 */
export function shortDateLabel(dateIso: string): string {
  const [, mm, dd] = dateIso.split("-");
  if (!mm || !dd) return dateIso;
  return `${Number(mm)}/${Number(dd)} ${weekdayLabel(dateIso)}`;
}

export function TripDateBanner({
  entry,
  today,
  onClose,
  showTools = false,
  menuOpen = false,
  onToggleMenu,
  onOpenDetail,
}: TripDateBannerProps) {
  const range = tripDateRange(entry.plan, today);
  const rel = relativeDepartLabel(entry.plan, today);
  const open = showTools && menuOpen;
  return (
    <>
      {/* 铺满视口的透明遮罩：点 HUD 上任何比日期条低的东西都收起菜单。必须在胶囊**外面**——理由见文件头。 */}
      {open && (
        <button
          type="button"
          className="hud-datebar__scrim"
          aria-label="收起菜单"
          onClick={onToggleMenu}
        />
      )}
      <div className={`hud-card hud-datebar${open ? " is-menu-open" : ""}`} role="status" aria-label="已选中的行程">
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
      {showTools && (
        <button
          type="button"
          className={`hud-datebar__tools${open ? " is-open" : ""}`}
          aria-label="这一程的操作"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={onToggleMenu}
        >
          <SlidersIcon />
        </button>
      )}
      <button type="button" className="hud-datebar__close" aria-label="取消选中" onClick={onClose}>
        ×
      </button>
      {open && (
        <div className="hud-datebar__menu" role="menu" aria-label="这一程的操作">
          <button type="button" className="hud-datebar__menuitem" role="menuitem" onClick={onOpenDetail}>
            <ListIcon />
            行程详情
          </button>
        </div>
      )}
      </div>
    </>
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

/** 工具（滑杆）：24 网格、线宽 2、圆端点，与仓库其它图标同一画法（没有图标库，一律内联）。 */
function SlidersIcon() {
  return (
    <svg className="hud-datebar__toolsicon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" strokeLinecap="round" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="10" cy="17" r="2.2" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg className="hud-datebar__menuicon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M9 6h11M9 12h11M9 18h11" strokeLinecap="round" />
      <circle cx="4.5" cy="6" r="1.2" />
      <circle cx="4.5" cy="12" r="1.2" />
      <circle cx="4.5" cy="18" r="1.2" />
    </svg>
  );
}
