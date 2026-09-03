/**
 * 竖屏 HUD 的纵向生活时间轴（V2）。
 *
 * 横屏定稿的生活环是横向漫游地图；在窄而高的座舱屏上直接缩放会使节点和标签
 * 过小。因此此组件将相同的「家 → 日程节点」转译成自上而下的时间轴：仍是生活
 * 行程与记忆可视化，而非道路导航或转向指引。
 */
import type { CSSProperties } from "react";

export interface PortraitTimelineStop {
  /** 语义锚点（home / park / charge / rest / wetland 等）。 */
  anchor: string;
  /** 已脱敏的地点语义名，例如「亲子乐园」。 */
  name: string;
  /** 按主题传入的微缩地点精灵。 */
  sprite: string;
  /** 出发点不展示序号。 */
  origin?: boolean;
  /** 由调用方按真实计划顺序编号。 */
  index?: number;
  /** 最后一个计划节点显示收束光晕。 */
  terminal?: boolean;
}

export interface PortraitTimelineProps {
  /** 天气图标仅表达环境上下文，不引入导航状态。 */
  weatherIcon: string;
  origin: PortraitTimelineStop;
  nodes: PortraitTimelineStop[];
  /** 是否展示低速流动粒子；弱网时由调用方关闭。 */
  animated?: boolean;
  /**
   * 点击某个节点（M36-04，导览页入口）。**不传就没有任何可点语义**——
   * 既有调用方（cockpit 竖屏）一行不改、行为逐字不变。出发点不可点：
   * "家"没有景区内导览这回事。
   */
  onNodeClick?: (stop: PortraitTimelineStop) => void;
}

type TimelineSide = "left" | "right";

interface TimelineSlot {
  side: TimelineSide;
  top: number;
  dotY: number;
  width: number;
  /** 流动粒子抵达该节点的秒数；与 SVG 小球的 6s 行程精确同步。 */
  arrivalDelay: number;
}

/**
 * 390×844 竖屏基准中的落位。地点在轴线两侧交替，确保缩至窄屏后仍可顺序扫读。
 * 竖屏 HUD 只承载当前出行的 3–5 个节点；超过上限的完整日程进入对话层。
 */
const V2_SLOTS: readonly TimelineSlot[] = [
  // 小球从首站圆点出发（而非在线路上方才开始），沿 y=136 → 434 走完 6s。
  // 这样“离开第一站先放大，抵达下一站再放大”的顺序直观且无首站等待。
  { side: "right", top: 86, dotY: 136, width: 114, arrivalDelay: 0 },
  { side: "left", top: 160, dotY: 203, width: 120, arrivalDelay: 1.35 },
  { side: "right", top: 236, dotY: 273, width: 82, arrivalDelay: 2.76 },
  { side: "left", top: 312, dotY: 349, width: 110, arrivalDelay: 4.29 },
  { side: "right", top: 384, dotY: 420, width: 112, arrivalDelay: 5.72 },
];

function stopLabel(stop: PortraitTimelineStop) {
  return stop.origin ? "出发" : `${stop.index ?? ""} ${stop.name}`.trim();
}

export function PortraitTimeline({
  weatherIcon,
  origin,
  nodes,
  animated = true,
  onNodeClick,
}: PortraitTimelineProps) {
  const stops: PortraitTimelineStop[] = [origin, ...nodes.slice(0, V2_SLOTS.length - 1)];

  return (
    <section className="hud-portrait-timeline" aria-label="今日出行生活时间轴">
      <header className="hud-portrait-timeline__header">
        <img className="hud-portrait-timeline__weather" src={weatherIcon} alt="" aria-hidden="true" />
        <span className="hud-portrait-timeline__title">AI 生活向导</span>
        <span className="hud-portrait-timeline__subtitle">美好旅程，即刻出发</span>
      </header>

      <svg
        className="hud-portrait-timeline__track"
        viewBox="0 0 390 476"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <filter id="hud-portrait-track-glow" x="-120%" y="-20%" width="340%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="hud-portrait-terminal-glow">
            <stop offset="0%" stopColor="var(--hud-amber-bright)" stopOpacity="0.65" />
            <stop offset="100%" stopColor="var(--hud-amber)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="195" cy="420" r="36" fill="url(#hud-portrait-terminal-glow)" />
        <path
          d="M 195 82 L 195 454"
          fill="none"
          stroke="var(--hud-amber)"
          strokeWidth="5"
          strokeLinecap="round"
          opacity="0.82"
          filter="url(#hud-portrait-track-glow)"
        />
        <path
          d="M 195 82 L 195 454"
          fill="none"
          stroke="var(--hud-halo)"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.7"
        />
        {V2_SLOTS.slice(0, stops.length).map((slot, index) => (
          <g
            className={`hud-portrait-timeline__track-node${animated ? " is-animated" : ""}`}
            style={{ "--portrait-arrival-delay": `${slot.arrivalDelay}s` } as CSSProperties}
            key={index}
          >
            <circle cx="195" cy={slot.dotY} r="12" fill="var(--hud-card-bg)" stroke="var(--hud-amber)" strokeWidth="3" />
            <circle cx="195" cy={slot.dotY} r="4.5" fill="var(--hud-amber-bright)" />
          </g>
        ))}
      </svg>

      {/* 小球、轨道节点和地点节点均由同一 CSS 6s 时钟驱动，避免两套动画时钟漂移。 */}
      {animated && <span className="hud-portrait-timeline__particle" aria-hidden="true" />}

      <ol className="hud-portrait-timeline__stops">
        {stops.map((stop, index) => {
          const slot = V2_SLOTS[index];
          const style = {
            "--portrait-stop-top": slot.top,
            "--portrait-stop-width": slot.width,
            "--portrait-arrival-delay": `${slot.arrivalDelay}s`,
          } as CSSProperties;

          // 有回调且不是出发点 → 节点是按钮（导览页入口，M36-04）；否则维持纯展示。
          const clickable = onNodeClick !== undefined && !stop.origin;
          const NodeTag = clickable ? "button" : "div";
          return (
            <li
              className={`hud-portrait-timeline__stop is-${slot.side}${stop.origin ? " is-origin" : ""}${stop.terminal ? " is-terminal" : ""}${animated ? " is-animated" : ""}`}
              style={style}
              key={`${stop.anchor}-${index}`}
            >
              <NodeTag
                className="hud-portrait-timeline__node-content"
                {...(clickable
                  ? { type: "button" as const, onClick: () => onNodeClick(stop), "aria-label": `打开${stop.name}的景区导览` }
                  : {})}
              >
                <img className="hud-portrait-timeline__island" src={stop.sprite} alt="" aria-hidden="true" />
                <span className="hud-portrait-timeline__label">
                  {stop.origin ? (
                    <span className="hud-portrait-timeline__origin-label">{stopLabel(stop)}</span>
                  ) : (
                    <>
                      <span className="hud-portrait-timeline__index">{stop.index}</span>
                      <span className="hud-portrait-timeline__name">{stop.name}</span>
                    </>
                  )}
                </span>
              </NodeTag>
              <span className="hud-sr-only">
                {stop.origin ? `出发地 ${stop.name}` : `第 ${stop.index} 站 ${stop.name}${stop.terminal ? "（终点）" : ""}`}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
