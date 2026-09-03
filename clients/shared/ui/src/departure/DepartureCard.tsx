/**
 * 出发卡（设计决议 2026-08-30；M66-04 加导航方案区；2026-09-02 从 cockpit `CabinArrivalDemo.tsx` 上提）。
 *
 * 目的地 / 今日路线 / 途径补能 / 导航方案 + 「开始导航」。三态按钮由 `nav-state` 的纯函数决定，
 * 本组件只渲染它的输出——这里**没有墙钟**（`Date.now` 只在 `useDepartureNav` 里）。
 *
 * 唤起高德是各端注入的（`openExternal`）：Tauri 端走 opener 插件（WKWebView 会静默吞掉
 * `target=_blank`，0830 实测），浏览器走查不注入、让 `<a>` 自己跳。本组件不 import `@tauri-apps/api`。
 * 样式在 `departure-card.css`，经 `styles.ts` 统一出（组件不自己 import css——node:test 里才渲染得了）。
 */
import { useLayoutEffect, useRef, useState } from "react";

import type { TripPlanSnapshot } from "@carlife/shared";

import { amapAppNavUri, amapNavUri, navLaunchDegradation, pickNavTarget, stopsViewportHeight, todayStopNames } from "./amap";
import { navButtonState, navHint, navLaunchFrom, type NavPlanState } from "./nav-state";
import type { OpenExternal } from "./origin";

export interface DepartureCardProps {
  /** null/缺省 = 没有可出发的行程，卡上如实说，不编一份。 */
  plan: TripPlanSnapshot | null | undefined;
  navState: NavPlanState;
  onClose: () => void;
  /** 缺省 = 浏览器形态，`<a target=_blank>` 自己跳。 */
  openExternal?: OpenExternal;
  /** 「今天」的 ISO 日期（`YYYY-MM-DD`）。由调用方给：本组件不读时钟。 */
  todayIso: string;
}

export function DepartureCard({ plan, navState, onClose, openExternal, todayIso }: DepartureCardProps) {
  const target = plan ? pickNavTarget(plan, todayIso) : undefined;
  const stops = plan ? todayStopNames(plan, todayIso) : [];
  const energy = plan?.energyStops ?? [];
  const [navError, setNavError] = useState<string | undefined>(undefined);
  const button = navButtonState(navState, target !== undefined);
  const launch = navLaunchFrom(navState, target);
  const navPlan = button.mode === "plan" ? navState.plan : undefined;
  /*
   * 卡上的方案区只放 4 样：策略一句、休息点（≤3）、里程/时长/过路费一行、提醒（≤3，多的折叠成一句）。
   * 出发卡不是时间轴的复读机（`todayStopNames` 的 limit 5 是同一取向）。
   * 唤起入口的降级（网页版只带第一个途经点 / App 策略以本地设置为准）也算提醒——"不标不猜"。
   */
  const degradations = launch
    ? [navLaunchDegradation(launch, "app"), navLaunchDegradation(launch, "web")].filter((s): s is string => Boolean(s))
    : [];
  const caveats = [...(navPlan?.caveats ?? []), ...degradations];
  const shownCaveats = caveats.slice(0, 3);
  const hiddenCaveats = caveats.length - shownCaveats.length;
  /*
   * 途经点**全部展示**，高度按 3.5 条封顶后可上下滑（走查 2026-09-02）。
   *
   * 高度只能量出来，不能算：条目换不换行取决于名字与理由的长度（见 `stopsViewportHeight`）。
   * 用 `useLayoutEffect` 在绘制前量：放 `useEffect` 里会先按无限高铺一帧，
   * 卡片高度当场跳一下，在 18.9 秒动画刚结束的那个时刻格外显眼。
   */
  const stopsRef = useRef<HTMLOListElement>(null);
  const [stopsMaxHeight, setStopsMaxHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = stopsRef.current;
    if (!el) {
      setStopsMaxHeight(undefined);
      return;
    }
    const items = Array.from(el.querySelectorAll("li"));
    const measure = () => {
      const heights = items.map((li) => li.getBoundingClientRect().height);
      setStopsMaxHeight(stopsViewportHeight(heights));
    };
    measure();
    /*
     * 量一次不够（2026-09-02 走查）：布局还没成形时量到的是一排 0，而 0 一旦写进
     * `max-height`，列表就再也长不回来。字体晚到、转屏、从后台切回前台都会改变行数。
     * 只观察 `li`——观察 `ol` 会因为我们自己写上去的 `max-height` 再次触发，绕成一个圈。
     */
    /*
     * 字体单独再量一次：Noto Sans SC 有 1.1MB，落地前后行高不一样，而 `ResizeObserver`
     * 在隐藏标签页里不一定送达（走查实测量到的是字体落地前的 22px，之后没被纠正）。
     * 真机上卡片在 18.9 秒动画之后才出现，字体早就到了——这一条是给边角准备的。
     */
    void document.fonts?.ready.then(measure).catch(() => {});
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(measure);
    for (const li of items) ro.observe(li);
    return () => ro.disconnect();
  }, [navPlan]);

  /*
   * Tauri 端（车机/iPad/手机客户端）里 WKWebView 会静默吞掉 target=_blank——
   * 浏览器走查一切正常、真机点了没反应零报错（0830 实测）。所以注入了 `openExternal` 时
   * preventDefault 改走它（各端接 opener 插件：iOS 是 UIApplication openURL，macOS 开默认
   * 浏览器；可开清单钉在各端 capabilities/default.json）。顺序是**先 App scheme 再
   * web 兜底**：装了高德的设备一步进导航；scheme 打不开（没装/在桌面）落到
   * uri.amap.com。两跳都失败必须说出来，不能表现得像成功。
   */
  const openViaPort = (e: { preventDefault: () => void }, appUrl: string, webUrl: string) => {
    if (!openExternal) return; // 浏览器：让 <a> 自己跳
    e.preventDefault();
    void (async () => {
      try {
        await openExternal(appUrl);
        setNavError(undefined);
      } catch {
        try {
          await openExternal(webUrl);
          setNavError(undefined);
        } catch (err) {
          console.warn("[depart] 打开高德失败", err);
          setNavError("没能打开高德——请手动打开高德地图导航。");
        }
      }
    })();
  };

  if (!plan) {
    return (
      <div className="cabin-depart-card" role="dialog" aria-label="出发卡">
        <span className="cabin-depart-card__kicker">出发准备</span>
        <h2>还没有已确认的行程</h2>
        <p className="cabin-depart-card__hint">先和暖暖定一份行程，出发卡才有地方可去。</p>
        <div className="cabin-depart-card__actions">
          <button type="button" className="cabin-depart-card__ghost" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cabin-depart-card" role="dialog" aria-label="出发卡">
      <span className="cabin-depart-card__kicker">行程就绪</span>
      <h2>{plan.destination}</h2>
      {stops.length > 0 && (
        <ol className="cabin-depart-card__stops">
          {stops.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ol>
      )}
      {energy.length > 0 && (
        <p className="cabin-depart-card__energy">⚡ 途径补能：{energy.join("、")}</p>
      )}
      <div className="cabin-depart-card__actions">
        {/*
          CTA 是 <a> 不是 window.open：后者在嵌入式 WebView（Tauri WKWebView、
          走查用的浏览器面板）里返回 null 被静默吞掉——按钮点了没反应、零报错，
          正是本仓最忌讳的假成功形态（实测 0830）。真实链接的用户手势导航不受
          弹窗拦截约束。uri.amap.com 在手机/车机经 callnative=1 唤起高德 App，
          电脑浏览器退到网页版路径规划——"电脑上如何模拟"的答案就是这条退路。
        */}
        {launch && !button.disabled ? (
          <a
            className="cabin-depart-card__primary"
            href={amapNavUri(launch)}
            target="_blank"
            rel="noopener noreferrer"
            data-nav-mode={button.mode}
            onClick={(e) => openViaPort(e, amapAppNavUri(launch), amapNavUri(launch))}
          >
            {button.label}
          </a>
        ) : (
          <button type="button" className="cabin-depart-card__primary" disabled aria-live="polite" data-nav-mode={button.mode}>
            {button.label}
          </button>
        )}
        <button type="button" className="cabin-depart-card__ghost" onClick={onClose}>
          稍后再说
        </button>
      </div>
      {navPlan && (
        <div className="cabin-depart-card__plan" aria-label="导航方案">
          <p className="cabin-depart-card__plan-strategy">
            {navPlan.strategy === "less_toll" ? "少收费路线" : "高速优先"}
            {" · "}
            {navPlan.strategyReason}
          </p>
          {navPlan.waypoints.length > 0 ? (
            <ol
              className="cabin-depart-card__plan-stops"
              ref={stopsRef}
              style={stopsMaxHeight !== undefined ? { maxHeight: `${stopsMaxHeight}px` } : undefined}
            >
              {navPlan.waypoints.map((w) => (
                <li key={`${w.name}-${w.lat}`}>
                  {w.name}
                  {typeof w.atMinute === "number" ? `（约 ${w.atMinute} 分钟处）` : ""}
                  {w.reason ? ` — ${w.reason}` : ""}
                </li>
              ))}
            </ol>
          ) : (
            <p className="cabin-depart-card__plan-stops-none">这一程不需要中途休息</p>
          )}
          {navPlan.summary.durationMin > 0 && (
            <p className="cabin-depart-card__plan-summary">
              约 {navPlan.summary.distanceKm} km · {navPlan.summary.durationMin} 分钟 · 过路费 {navPlan.summary.tollYuan} 元
            </p>
          )}
          {shownCaveats.length > 0 && (
            <ul className="cabin-depart-card__plan-caveats">
              {shownCaveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
              {hiddenCaveats > 0 && <li>另有 {hiddenCaveats} 条提示</li>}
            </ul>
          )}
        </div>
      )}
      <p className="cabin-depart-card__hint">
        {navError ??
          navHint(
            navState,
            target !== undefined,
            target
              ? "将打开高德地图——车机/手机上直接进导航，电脑上打开网页版路径规划。"
              : "这份行程还没有可导航的坐标，重新确认一次行程即可补上。",
          )}
      </p>
    </div>
  );
}
