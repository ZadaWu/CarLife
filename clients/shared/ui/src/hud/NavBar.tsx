/**
 * 跟车顶栏（M31-03；M65-01 上提到 `clients/shared/ui`，两端共用）。
 * 样式在 `hud.css`（`.hud-navbar*`），竖屏落点在同文件的竖屏段。
 */
import type { NavTripProgress } from "../map";
import type { HudNavProps } from "./trip-map-props";

/**
 * 跟车顶栏（M31-03）：下一站 · 剩多远 · 预计多久 + 结束导航。
 *
 * # 三处「宁可少说一句」
 *
 *  1. **没有 ETA 就不显示时间**。`etaToNextStop` 在这一段车程没查到时返回
 *     undefined，那时只报距离。摆一个由常数算出来的"预计 3 分钟"，
 *     比不摆糟——它看起来和真的一模一样（同 `scheduleStops` 那条红线）。
 *  2. **演示倍速恒显**。车不在那个位置，这件事必须写在屏幕上。
 *  3. **走完了就说走完了**，不把"剩 0 公里"当成还在路上。
 */
export function NavBar({ nav, progress }: { nav: HudNavProps; progress?: NavTripProgress }) {
  const km = progress ? progress.remainingM / 1000 : undefined;
  const mins = progress?.remainingSec !== undefined ? Math.round(progress.remainingSec / 60) : undefined;
  return (
    <div className="hud-navbar" role="status" aria-live="polite">
      <div className="hud-navbar__main">
        {progress?.finished ? (
          <span className="hud-navbar__next">已到达今天的最后一站</span>
        ) : (
          <>
            <span className="hud-navbar__label">下一站</span>
            <span className="hud-navbar__next">{progress?.nextStopName ?? "准备中"}</span>
            {km !== undefined && (
              <span className="hud-navbar__metric">
                剩 {km >= 10 ? Math.round(km) : km.toFixed(1)} 公里
              </span>
            )}
            {/* 时间只在拿得到真实车程时出现——见本组件文件头第 1 条。 */}
            {mins !== undefined && <span className="hud-navbar__metric">预计 {mins} 分钟</span>}
          </>
        )}
      </div>
      {nav.speedup > 1 && (
        <span className="hud-navbar__sim" title="位置为按真实路线与车程模拟，车辆并非真的在此位置">
          演示车速 ×{nav.speedup}
        </span>
      )}
      {nav.onEnd && (
        <button type="button" className="hud-navbar__end" onClick={nav.onEnd}>
          结束导航
        </button>
      )}
    </div>
  );
}

