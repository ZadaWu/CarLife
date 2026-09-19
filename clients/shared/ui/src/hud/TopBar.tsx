/**
 * 车机顶栏（新版 UI，定稿 `内部文档`）。
 *
 * 一条横贯屏顶的半透明白条：左端主页图标，中间「主页 / 对话 / 档案 / 设置」胶囊页签，
 * 右端天气 + 城市、日期与时间。它接替了车机端原来落在屏底的 `BottomNav`——
 * 屏底那一带在新版里让给了出行状态栏（`StatusBar`）。
 *
 * ⚠️ `BottomNav` 组件**没有删**：手机端仍在用它（`clients/mobile/src/app/index.tsx`）。
 * 页签的取值集合与顺序两边共用 `NAV_ITEMS`，别在这里再抄一份——
 * 抄了之后加一项就会出现"车机有、手机没有"。
 *
 * 右端只写**拿得到的事实**：城市来自网关给的常住地，天气来自快照的 `weather.label`，
 * 时间是本机时钟。定稿里画着「28°C」，但快照契约里没有气温——不为了像定稿去编一个数。
 */
import { useEffect, useState } from "react";

import { NAV_ITEMS, type NavView } from "./BottomNav";

/**
 * 主页数据这一路**此刻通不通**（2026-09-12）。
 *
 * 四个取值各自说一件不同的事，合并任意两个都会把一种情况说成另一种：
 *  - `connecting` 还没有拿到过任何一份数据——开机头几秒就是这样，它不是故障；
 *  - `online` 最近一次取数成功；
 *  - `offline` 最近一次取数**连不上**（网络、网关没起、地址配错）；
 *  - `noidentity` 服务答了，但这台车机此刻不代表任何人（没上车声明 / 访客），
 *    个人域端点一律 401；
 *  - `demo` 这个窗口根本不连服务（浏览器走查用的 mock 源）。
 *
 * `demo` 不能省成 `online`：浏览器里 mock 源永远"成功"，绿灯会把
 * "我压根没在跟网关说话"显示成"连得好好的"。
 *
 * `noidentity` 不能省成 `offline`：**两者的补救动作完全不同**——连不上要重试，
 * 没身份要重新上车声明，而对 401 重试一万次还是 401。2026-09-12 把 401 显示成
 * 「未连接」，用户照着去查 Docker 和端口，查到的全是好的（`hudSourceFailure` 文件注释）。
 */
export type TopBarLink = "connecting" | "online" | "offline" | "noidentity" | "demo";

export interface TopBarProps {
  active: NavView;
  onSelect: (view: NavView) => void;
  /** 档案页尚未落地时置为 true（占位不可点）。 */
  profileDisabled?: boolean;
  /** 服务连接状态；缺省不渲染这枚指示灯（不显示 = 没人告诉我，不是"正常"）。 */
  link?: TopBarLink;
  /**
   * 这枚灯**自己**的补救动作（目前只有 `noidentity` 有：重新挂出上车声明）。
   * 给了就把它渲染成可点的按钮。刷新按钮治不了 401，所以补救得挂在说明问题的那一处。
   */
  onLinkAction?: () => void;
  /** 补救动作的说明，进 `title` 与无障碍名——一句话说清"点它会发生什么"。 */
  linkHint?: string;
  /** 刷新主页数据。缺省不渲染刷新按钮。 */
  onRefresh?: () => void;
  /** 这一轮刷新还在路上（按钮转圈并锁住，避免连点叠发）。 */
  refreshing?: boolean;
  /** 右端的城市名（常住地）。缺省不渲染那一段，不写「未知城市」。 */
  city?: string;
  /** 右端的天气：图标地址 + 短描述（「晴」）。缺省不渲染。 */
  weather?: { icon: string; label: string };
  /** 时钟（测试注入）；缺省走 `Date.now()` 每分钟刷一次。 */
  now?: () => Date;
}

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 指示灯的字面。**写"连没连上"，不写"数据新不新"**——
 * 后者是状态栏每一格自己的事（`metric-text.ts`），两处各说各的才不会互相打架。
 */
export const TOP_BAR_LINK_LABEL: Record<TopBarLink, string> = {
  connecting: "连接中",
  online: "已连接",
  offline: "未连接",
  /* 「未上车」而不是「未登录」：车机上这件事的名字就叫上车声明，访客态也归它。 */
  noidentity: "未上车",
  demo: "演示数据",
};

/** 「9月3日 周四」。 */
export function topBarDateLabel(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY[d.getDay()]}`;
}

/** 「14:26」。 */
export function topBarTimeLabel(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function useMinuteClock(now?: () => Date): Date {
  const read = now ?? (() => new Date());
  const [tick, setTick] = useState(() => read());
  useEffect(() => {
    // 对齐到下一个整分再每分钟刷：秒不显示，每秒重渲是白费。
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const t = read();
      setTick(t);
      timer = setTimeout(schedule, 60_000 - (t.getSeconds() * 1000 + t.getMilliseconds()));
    };
    timer = setTimeout(schedule, 60_000 - (tick.getSeconds() * 1000 + tick.getMilliseconds()));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
  return tick;
}

export function TopBar({
  active,
  onSelect,
  profileDisabled = false,
  link,
  onLinkAction,
  linkHint,
  onRefresh,
  refreshing = false,
  city,
  weather,
  now,
}: TopBarProps) {
  const clock = useMinuteClock(now);
  return (
    <header className="hud-topbar" aria-label="顶栏">
      <button
        type="button"
        className="hud-topbar__home"
        aria-label="主页"
        aria-current={active === "hud" ? "page" : undefined}
        onClick={() => onSelect("hud")}
      >
        <HomeIcon />
      </button>

      {/*
        主页图标右侧：连接指示灯 + 刷新。两者挨着是因为它们是一问一答——
        灯说"这一路通不通"，按钮是"再试一次"。分开摆的话灯变红时用户得满屏找按钮。
      */}
      {link &&
        (onLinkAction ? (
          /*
           * 有补救动作时它是**按钮**：能修的那一下就在说明问题的这一处，
           * 用户不必猜"该点哪个"。没有动作时仍是 `role="status"` 的纯播报，
           * 不给一个点了什么都不会发生的东西装上按钮的长相。
           */
          <button
            type="button"
            className={`hud-topbar__link is-${link} is-actionable`}
            title={linkHint}
            aria-label={linkHint ? `${TOP_BAR_LINK_LABEL[link]}：${linkHint}` : TOP_BAR_LINK_LABEL[link]}
            onClick={onLinkAction}
          >
            <span className="hud-topbar__link-dot" aria-hidden="true" />
            <span className="hud-topbar__link-text">{TOP_BAR_LINK_LABEL[link]}</span>
          </button>
        ) : (
          <span className={`hud-topbar__link is-${link}`} role="status" aria-live="polite" title={linkHint}>
            <span className="hud-topbar__link-dot" aria-hidden="true" />
            <span className="hud-topbar__link-text">{TOP_BAR_LINK_LABEL[link]}</span>
          </span>
        ))}

      {onRefresh && (
        <button
          type="button"
          className={`hud-topbar__refresh${refreshing ? " is-busy" : ""}`}
          /* 说清刷的是什么：车机上「刷新」两个字可以指地图、指音乐、指这一屏。 */
          aria-label="刷新主页数据"
          aria-busy={refreshing || undefined}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
      )}

      <nav className="hud-topbar__tabs" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const disabled = item.key === "profile" && profileDisabled;
          return (
            <button
              key={item.key}
              type="button"
              className={`hud-topbar__tab${active === item.key ? " is-active" : ""}`}
              aria-current={active === item.key ? "page" : undefined}
              disabled={disabled}
              onClick={() => onSelect(item.key)}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="hud-topbar__status">
        {weather && <img className="hud-topbar__weather" src={weather.icon} alt="" aria-hidden="true" />}
        {(city || weather) && (
          <span className="hud-topbar__place">
            {[city, weather?.label].filter(Boolean).join(" · ")}
          </span>
        )}
        {(city || weather) && <span className="hud-topbar__divider" aria-hidden="true" />}
        <span className="hud-topbar__date">{topBarDateLabel(clock)}</span>
        <time className="hud-topbar__time" dateTime={clock.toISOString()}>
          {topBarTimeLabel(clock)}
        </time>
      </div>
    </header>
  );
}

/** 环形箭头。转圈动画加在外层按钮上（`.is-busy`），图标本身不含动画。 */
function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path d="M20 4v4.5h-4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M3.5 10.5 12 3.5l8.5 7v9a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-5v6H5a1.5 1.5 0 0 1-1.5-1.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </svg>
  );
}
