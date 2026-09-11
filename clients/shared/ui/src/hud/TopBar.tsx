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

export interface TopBarProps {
  active: NavView;
  onSelect: (view: NavView) => void;
  /** 档案页尚未落地时置为 true（占位不可点）。 */
  profileDisabled?: boolean;
  /** 右端的城市名（常住地）。缺省不渲染那一段，不写「未知城市」。 */
  city?: string;
  /** 右端的天气：图标地址 + 短描述（「晴」）。缺省不渲染。 */
  weather?: { icon: string; label: string };
  /** 时钟（测试注入）；缺省走 `Date.now()` 每分钟刷一次。 */
  now?: () => Date;
}

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

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

export function TopBar({ active, onSelect, profileDisabled = false, city, weather, now }: TopBarProps) {
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
