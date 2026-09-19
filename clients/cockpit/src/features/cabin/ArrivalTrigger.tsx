/**
 * HUD 上的「开始行程」入口——车尾挂板 + 垂下来的钥匙，以及它的待机心跳。
 *
 * # 为什么它从 `CabinArrivalDemo.tsx` 里搬出来
 *
 * 那个文件守着 M64 的「没有第二个时钟」红线：出发流程的时序真相源只有
 * `DEPARTURE_TIMELINE`（WAAPI）与 `useDepartureNav.ts` 的那一个墙钟，
 * 组件里不许再出现 `setTimeout` / `setInterval`
 * （`departure-audio-invariants.test.ts` / `departure-nav-invariants.test.ts` 逐字守）。
 *
 * 待机摆动需要一个定时器，但它**不属于出发时序**：它既不编排任何一段动画，
 * 也不参与规划倒计时，只决定「这枚装饰件多久招一次手」。把它和红线关在同一个
 * 文件里，要么破红线、要么放弃优化。所以把入口整个拆出来——顺带也是更好的分工：
 * 触发按钮和出发流程本来就是两件事。
 *
 * 这个文件里不出现任何出发时序的东西（同名不变量守着），它只知道自己会被点。
 */

import { useEffect, useState } from "react";

/**
 * 摆一轮之间隔多久（毫秒）。
 *
 * 这个数不是观感调出来的，是成本决定的：摆动即使落在合成层上，也仍然让显示管线
 * 每个 vsync 出一帧——iPad 模拟器上那是 28% CPU 的地板，与画的是什么无关
 * （2026-09-13 实测：canvas 2D 85.2%、WebGL 88.5%、合成层 transform 32.1%、
 * 完全不动 4.4%）。**能省的只有帧数**，所以一轮 3.8 秒、歇到 20 秒，占空比 19%。
 *
 * 调它就是在调「注意力钩子的密度」与「待机功耗」之间的那条线；证据在
 * `docs/perf/2026-09-13-idle-cpu-clients.md`。
 */
const SWING_PERIOD_MS = 20_000;

/** 进屏之后第一轮摆动的延迟：让入场动画先落定，再招手。 */
const SWING_FIRST_DELAY_MS = 1_200;

/**
 * 挂钩上的车钥匙 —— 出发入口的卡通形态（M26 走查）。
 *
 * 上半是一截卡通车尾（尾窗 / 尾灯 / 车牌 / 排气），车牌就是按钮文案「开始行程」；
 * 钥匙经保险杠下的挂钩垂下来，钥匙圈以下整组轻摆——挂板本体不动，
 * 整块一起晃会看起来像挂板要从墙上掉下来。
 */
function CarKeyBoard({ swinging, onSwingEnd }: { swinging: boolean; onSwingEnd: () => void }) {
  return (
    <span className="cabin-arrival-trigger__key">
      {/* 钥匙先画、车尾后画：挂钩要压在钥匙圈上才像「穿过圈」。
          两层是两张 SVG 而不是一张里的两组：摆动必须落在 <svg> 元素本身，
          写在内部 <g> 上 WebKit 不会给它单独的合成层，每一帧都要把整张图
          重新栅格化并连带整页重绘——iPad 模拟器实测 86% → 34% CPU
          （2026-09-13 性能排查，见 docs/perf/）。 */}
      <svg
        className={`cabin-arrival-trigger__layer cabin-arrival-trigger__swing${swinging ? " is-swinging" : ""}`}
        viewBox="0 0 150 172"
        aria-hidden="true"
        focusable="false"
        onAnimationEnd={onSwingEnd}
      >
        <circle className="cabin-key__ring" cx="75" cy="92" r="8.5" />
        <rect className="cabin-key__fob" x="59" y="101" width="32" height="44" rx="12" />
        <rect className="cabin-key__panel" x="66" y="107" width="18" height="11" rx="5" />
        <rect className="cabin-key__btn" x="66.5" y="124" width="17" height="5.5" rx="2.75" />
        <rect className="cabin-key__btn" x="66.5" y="131.5" width="17" height="5.5" rx="2.75" />
        {/* 钥匙齿只在一侧开齿：两侧对称会看起来像插销不像钥匙 */}
        <path className="cabin-key__blade" d="M69 145h12v8h-4v5h4v9H69z" />
      </svg>

      <svg
        className="cabin-arrival-trigger__layer cabin-arrival-trigger__board"
        viewBox="0 0 150 172"
        aria-hidden="true"
        focusable="false"
      >
      {/* 车尾挂板：车顶弧线 → 尾窗 → 行李箱盖折线 → 两角尾灯 → 车牌 → 保险杠。
          尾灯必须在**左右两角**且压亮：没有它们这个轮廓会被读成一辆巴士。 */}
      <path
        className="cabin-car__body"
        d="M18 40C20 18 34 8 75 8s55 10 57 32l2 14c0 14-8 22-24 22H40c-16 0-24-8-24-22Z"
      />
      <path className="cabin-car__window" d="M44 14c8-3 54-3 62 0 5 2 8 8 8 14H36c0-6 3-12 8-14Z" />
      {/* 行李箱盖折线：一条弧线就够，让红色大块有"盖子"的结构感 */}
      <path className="cabin-car__crease" d="M30 36c14-4 76-4 90 0" />
      <rect className="cabin-car__lamp" x="20" y="42" width="26" height="11" rx="5.5" />
      <rect className="cabin-car__lamp" x="104" y="42" width="26" height="11" rx="5.5" />
      <rect className="cabin-car__plate" x="42" y="39" width="66" height="21" rx="5" />
      <text className="cabin-car__plate-text" x="75" y="55" textAnchor="middle">
        开始行程
      </text>
      <rect className="cabin-car__bumper" x="18" y="64" width="114" height="13" rx="6.5" />
      <circle className="cabin-car__pipe" cx="38" cy="70.5" r="3.6" />
      <circle className="cabin-car__pipe" cx="112" cy="70.5" r="3.6" />
      <path className="cabin-car__hook" d="M75 75v8" />
      </svg>
    </span>
  );
}

/** HUD 上的出发入口按钮。时序无关，点它才把出发流程交回 `CabinArrivalDemo`。 */
export function ArrivalTrigger({ onPlay }: { onPlay: () => void }) {
  /**
   * 挂件此刻在不在摆（见 `SWING_PERIOD_MS`）。
   *
   * 由定时器置真、由 `animationend` 置假——**不能用第二个定时器去关**，
   * 两个时钟迟早对不齐，对不齐的表现是摆到一半被摘掉、钥匙从半空跳回竖直。
   */
  const [swinging, setSwinging] = useState(false);

  /*
   * 间歇摆动的节拍器。两条早退各有各的理由：
   *  - `prefers-reduced-motion`：CSS 那边已经 `animation: none`，这里再置真只会
   *    永远等不到 `animationend`，`swinging` 卡在真上；
   *  - `document.hidden`：窗口不可见时摆给谁看——而且后台的 `setInterval` 会被
   *    节流，醒来时补发的那几拍会挤成一串。
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const kick = () => {
      if (document.hidden) return;
      setSwinging(true);
    };
    const first = window.setTimeout(kick, SWING_FIRST_DELAY_MS);
    const timer = window.setInterval(kick, SWING_PERIOD_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <button type="button" className="cabin-arrival-trigger" onClick={onPlay} aria-label="开始行程">
      <CarKeyBoard swinging={swinging} onSwingEnd={() => setSwinging(false)} />
    </button>
  );
}
