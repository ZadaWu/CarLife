/**
 * 有序生活环 —— 琥珀轨迹（施工单 M1-02）
 *
 * Brief §3.1：生活环是日程与记忆的可视化，**不是道路导航**。
 * 只能用亮度渐变 + 低速流动粒子表达先后，禁止车道、道路指示箭头、转向提示。
 * 末站以收束光晕区分。
 */
import { DESIGN_HEIGHT, DESIGN_WIDTH, RING_SEGMENTS } from "./layout";

export interface LifeRingProps {
  /** 已完成/已抵达的段数，用于亮度渐变（越靠前越亮）。 */
  activeSegment?: number;
  /** 末站收束光晕的位置（设计基准坐标）。 */
  finalGlow?: { cx: number; cy: number };
  /** 是否播放流动粒子（弱网/降级时可关闭）。 */
  animated?: boolean;
}

export function LifeRing({ activeSegment = 0, finalGlow, animated = true }: LifeRingProps) {
  return (
    <svg
      className="hud-life-ring"
      viewBox={`0 0 ${DESIGN_WIDTH} ${DESIGN_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter id="hud-ring-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="9" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id="hud-final-glow">
          <stop offset="0%" stopColor="var(--hud-amber-bright)" stopOpacity="0.55" />
          <stop offset="60%" stopColor="var(--hud-amber)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--hud-amber)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 末站收束光晕：标记行程终点，不表示导航目的地指令 */}
      {finalGlow && (
        <circle cx={finalGlow.cx} cy={finalGlow.cy} r={132} fill="url(#hud-final-glow)" />
      )}

      <g filter="url(#hud-ring-glow)">
        {RING_SEGMENTS.map((d, i) => {
          // 亮度渐变表达先后：已过的段更亮，后续段渐暗
          const passed = i < activeSegment;
          return (
            <g key={i}>
              <path
                d={d}
                fill="none"
                stroke={passed ? "var(--hud-amber-bright)" : "var(--hud-amber)"}
                strokeWidth={13}
                strokeLinecap="round"
                opacity={passed ? 0.95 : 0.8 - i * 0.06}
              />
              <path
                d={d}
                fill="none"
                stroke="var(--hud-halo)"
                strokeWidth={5}
                strokeLinecap="round"
                opacity={passed ? 0.7 : 0.45}
              />
              {animated && (
                <circle r={7} fill="var(--hud-amber-bright)" opacity={0.9}>
                  {/* 低速流动粒子：仅表达时间顺序流向 */}
                  <animateMotion
                    dur={`${5 + i * 0.8}s`}
                    repeatCount="indefinite"
                    path={d}
                    begin={`${i * 0.9}s`}
                  />
                </circle>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
