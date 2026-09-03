/**
 * 卡片底部那条调用吞吐柱状图。几何计算在 throughput.ts，这里只负责画和响应鼠标。
 * （文件名不叫 Throughput.tsx：macOS 的大小写不敏感文件系统里它会与 throughput.ts 撞名。）
 *
 * 画法上照抄余额曲线（`Sparkline.tsx`）的两个选择：viewBox `0 0 100 32` +
 * `preserveAspectRatio="none"` 让横坐标天然是百分比；悬浮圆点与气泡走 HTML。
 * 柱子是 `<rect>`，非等比缩放对矩形没有副作用，所以留在 SVG 里。
 *
 * 横轴与余额曲线**共用同一个窗口**（由页面算一次传进来），两张图叠在同一张卡上，
 * 同一个横坐标必须是同一个时刻——否则"余额掉得快的那段"对不上"那段跑了多少"。
 */

import { useState, type PointerEvent as ReactPointerEvent } from "react";

import { axisTicks, pointTimeLabel, spanLabel, type TimeWindow } from "./history";
import {
  avgTokensOf,
  buildThroughput,
  estimatedTitle,
  fmtTokens,
  nearestBar,
  stepLabel,
  throughputAriaLabel,
  tokensOf,
  tokPerSec,
  type ThroughputBar,
  type ThroughputSeries,
} from "./throughput";

export interface ThroughputProps {
  series: ThroughputSeries | null;
  window: TimeWindow | null;
  /** 加载中与"确实没有调用"是两回事，空态得说对 */
  loading: boolean;
}

function Note({ text }: { text: string }): JSX.Element {
  return (
    <div className="fin-spark fin-spark--empty">
      <span className="muted tiny">{text}</span>
    </div>
  );
}

export function ThroughputBars({ series, window: win, loading }: ThroughputProps): JSX.Element {
  const [hover, setHover] = useState<ThroughputBar | null>(null);

  const chart =
    series && win ? buildThroughput(series.buckets, { from: win.from, to: win.to, stepMs: series.stepMs }) : null;

  /*
   * 估算次数放标题行不放角标行：角标行只有 230px 宽，合计 + 峰值已经把它占满，
   * 再塞一项就是三个省略号——数字都在却一个也读不出来。
   */
  const estimated = chart?.total.estimatedCalls ?? 0;
  const head = (
    <div className="fin-tp-head">
      <span>调用吞吐</span>
      {estimated > 0 ? (
        <span className="fin-tp-est" title={estimatedTitle}>
          · {estimated} 次估算
        </span>
      ) : null}
      <span className="spacer" />
      {/* 单位是"每次请求"，不是"每个桶"：桶宽放在峰值的悬浮说明里 */}
      {series ? <span className="mono">tokens / 次</span> : null}
    </div>
  );

  if (!series) {
    return (
      <div className="fin-tp">
        {head}
        <Note text={loading ? "吞吐载入中…" : "吞吐暂不可用"} />
      </div>
    );
  }
  if (!chart) {
    // 这是真零：窗口内没有一次调用。与余额曲线的"还没有历史"不同——
    // 那边是"不知道"，这边是"知道，就是没跑"。
    return (
      <div className="fin-tp">
        {head}
        <Note text={win ? `${spanLabel(win.span)}没有记录到调用` : "还没有调用记录"} />
      </div>
    );
  }

  const ticks = win ? axisTicks(win, chart.width) : [];
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    setHover(nearestBar(chart.bars, ((e.clientX - rect.left) / rect.width) * chart.width));
  };

  const hb = hover?.bucket ?? null;
  const speed = hb ? tokPerSec(hb) : null;
  // 气泡有三行、接近卡片内容区的宽度，夹得比余额曲线的（18~82）紧得多：
  // 按 82 夹的话靠右的柱子会让气泡探出卡片被裁掉半截。
  const tipX = hover ? Math.min(58, Math.max(42, hover.x + hover.w / 2)) : 0;

  return (
    <div className={`fin-tp fin-spark-wrap${hover ? " fin-spark-wrap--hovering" : ""}`}>
      {head}
      <div
        className="fin-spark"
        role="img"
        aria-label={throughputAriaLabel(chart, series.stepMs, win ? spanLabel(win.span) : "")}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          className="fin-spark-svg"
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {ticks.map((k) => (
            <line
              key={`g${k.t}`}
              className="fin-spark-grid"
              x1={k.x}
              x2={k.x}
              y1={0}
              y2={chart.height}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {chart.bars.map((b) => (
            <rect
              key={b.bucket.t}
              className={`fin-tp-bar${hover === b ? " fin-tp-bar--hover" : ""}${
                b.bucket.failed > 0 && b.bucket.failed === b.bucket.calls ? " fin-tp-bar--failed" : ""
              }`}
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
            />
          ))}
          {hover ? (
            <line
              className="fin-spark-cursor"
              x1={hover.x + hover.w / 2}
              x2={hover.x + hover.w / 2}
              y1={0}
              y2={chart.height}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>

        {hover && hb ? (
          <div className="fin-spark-tip fin-tp-tip" style={{ left: `${tipX}%` }}>
            <span className="fin-spark-tip-time">{pointTimeLabel(hb.t)}</span>
            <span className="fin-spark-tip-val mono">
              均 {fmtTokens(avgTokensOf(hb))} tokens/次 · {hb.calls} 次
              {hb.failed > 0 ? ` · ${hb.failed} 失败` : ""}
            </span>
            <span className="fin-spark-tip-time">
              每次 入 {fmtTokens(hb.promptTokens / hb.calls)} / 出 {fmtTokens(hb.completionTokens / hb.calls)}
              {speed !== null ? ` · ${speed.toFixed(1)} tok/s` : ""}
              {hb.estimatedCalls > 0 ? ` · ${hb.estimatedCalls} 次估算` : ""}
            </span>
          </div>
        ) : null}
      </div>

      <div className="fin-spark-axis" aria-hidden="true">
        {ticks.map((k) => (
          <span key={k.t} className={`fin-spark-tick fin-spark-tick--${k.anchor}`} style={{ left: `${k.x}%` }}>
            {k.label}
          </span>
        ))}
      </div>

      {/*
       * 峰值必须一直显示：纵轴按峰值缩放，不说的话一根顶到头的柱子是每次 5 千还是
       * 5 万 token 无从判断。估算的次数在标题行——不标就是把估的当成量的。
       */}
      <div className="fin-spark-foot">
        <span
          className="mono"
          title={`窗口内 ${chart.total.calls} 次调用，合计 ${chart.total.tokens} tokens，平均每次 ${Math.round(chart.total.avgTokens)} tokens`}
        >
          均 {fmtTokens(chart.total.avgTokens)}/次 · {chart.total.calls} 次
        </span>
        <span className="spacer" />
        <span
          title={`平均每次 token 最高的一个桶（每 ${stepLabel(series.stepMs)}一桶）：${Math.round(avgTokensOf(chart.peak))} tokens/次，${chart.peak.calls} 次调用，合计 ${tokensOf(chart.peak)} tokens`}
        >
          峰值 {fmtTokens(avgTokensOf(chart.peak))}
        </span>
      </div>
    </div>
  );
}
