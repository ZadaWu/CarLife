/**
 * 卡片下方那条余额曲线。几何计算在 history.ts，这里只负责画和响应鼠标。
 *
 * 两个实现上的选择，改之前先看一眼：
 *
 * 1. **viewBox 是 `0 0 100 32` + `preserveAspectRatio="none"`**，于是横坐标
 *    天然就是百分比——悬浮竖线、圆点、气泡都能直接用 `left: x%` 定位，不需要
 *    测量元素宽度、不需要 ResizeObserver。代价是画布被横向拉伸，线会变粗变形；
 *    `vector-effect="non-scaling-stroke"` 抵消掉它。
 * 2. **圆点与气泡是 HTML 不是 SVG**。同样因为上面那个非等比缩放：SVG 里的
 *    `<circle>` 会被拉成椭圆。竖线不受影响（它只有一个方向），所以留在 SVG 里。
 */

import { useState, type PointerEvent as ReactPointerEvent } from "react";

import {
  axisTicks,
  buildSparkline,
  deltaLabel,
  deltaTitle,
  intervalLabel,
  nearestDot,
  pointTimeLabel,
  spanLabel,
  sparkAriaLabel,
  type FinanceHistory,
  type SparkDot,
  type TimeWindow,
} from "./history";

export interface SparklineProps {
  history: FinanceHistory | null;
  /**
   * 横轴窗口。**由页面算一次传给每张卡**，不是各卡自己算——
   * 各缩各的之后，两张并排卡片上同一个横坐标不再是同一个时刻。
   * 见 `windowFor()` 的注释。
   */
  window: TimeWindow | null;
  /** 加载中与"确实没有历史"是两回事，空态的话得说对 */
  loading: boolean;
  accountId: string;
  /** 卡片上显示的币种，历史里没有该账户时用它兜底 */
  currency: string;
}

/** 一行说明，占住曲线的位置——不占的话卡片高度会在数据到达时跳一下。 */
function SparkNote({ text }: { text: string }): JSX.Element {
  return (
    <div className="fin-spark fin-spark--empty">
      <span className="muted tiny">{text}</span>
    </div>
  );
}

export function BalanceSparkline({
  history,
  window: win,
  loading,
  accountId,
  currency,
}: SparklineProps): JSX.Element {
  const [hover, setHover] = useState<SparkDot | null>(null);

  const series = history?.series[accountId] ?? null;
  const spark =
    history && series && win
      ? buildSparkline(series.points, { from: win.from, to: win.to, stepMs: history.stepMs })
      : null;

  if (!history) return <SparkNote text={loading ? "余额历史载入中…" : "余额历史暂不可用"} />;

  // 一个点连不成线。**不能画成一条横线**——那是"余额没变"，
  // 而真相是"只测过一次"，两句话完全不同（见 history.ts 文件头 ③）。
  if (!spark || spark.dots.length < 2) {
    const n = spark?.dots.length ?? 0;
    // 周期从 stepMs 推，不写死："每小时"这种话一旦与服务端的实际周期对不上，
    // 页面就在拿一句确定的假话回答"多久更新一次"。
    const every = intervalLabel(history.stepMs);
    return (
      <SparkNote
        text={
          n === 0
            ? `还没有余额历史（每 ${every}采样一次，攒够 2 个点才画曲线）`
            : `已有 1 个采样点，再过 ${every}开始画曲线`
        }
      />
    );
  }

  const cur = series?.currency ?? currency;
  const ticks = win ? axisTicks(win, spark.width) : [];
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    setHover(nearestDot(spark.dots, ((e.clientX - rect.left) / rect.width) * spark.width));
  };

  // 气泡贴边会被卡片裁掉，往里收一点。用 SVG 坐标（= 百分比）直接夹。
  const tipX = hover ? Math.min(82, Math.max(18, hover.x)) : 0;

  return (
    <div className={`fin-spark-wrap${hover ? " fin-spark-wrap--hovering" : ""}`}>
      <div
        className="fin-spark"
        role="img"
        aria-label={sparkAriaLabel(spark, cur, win?.span ?? 0)}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          className="fin-spark-svg"
          viewBox={`0 0 ${spark.width} ${spark.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {/* 刻度线垫在最底下：它是背景，压在曲线上会跟数据抢注意力 */}
          {ticks.map((k) => (
            <line
              key={`g${k.t}`}
              className="fin-spark-grid"
              x1={k.x}
              x2={k.x}
              y1={0}
              y2={spark.height}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {spark.areas.map((d, i) => (
            <path key={`a${i}`} className="fin-spark-area" d={d} />
          ))}
          {spark.segments.map((d, i) => (
            <path key={`s${i}`} className="fin-spark-line" d={d} vectorEffect="non-scaling-stroke" />
          ))}
          {hover ? (
            <line
              className="fin-spark-cursor"
              x1={hover.x}
              x2={hover.x}
              y1={0}
              y2={spark.height}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>

        {/*
          圆点走 HTML：SVG 的 circle 会被非等比缩放拉成椭圆。
          孤点（两侧都断开、连不进任何线段）也要画出来——丢掉的话图上一片空白，
          角标却说着"N 个采样点"，等于"有数据但不给看"。
        */}
        {spark.orphans.map((o) => (
          <span
            key={o.t}
            className="fin-spark-dot fin-spark-dot--orphan"
            style={{ left: `${o.x}%`, top: `${(o.y / spark.height) * 100}%` }}
          />
        ))}
        <span
          className="fin-spark-dot fin-spark-dot--last"
          style={{ left: `${spark.dots[spark.dots.length - 1].x}%`, top: `${(spark.dots[spark.dots.length - 1].y / spark.height) * 100}%` }}
        />
        {hover ? (
          <span
            className="fin-spark-dot fin-spark-dot--hover"
            style={{ left: `${hover.x}%`, top: `${(hover.y / spark.height) * 100}%` }}
          />
        ) : null}

        {/*
          气泡在曲线**下方**。放上方会盖住卡片的大数字——
          为了看历史而挡住"现在还剩多少"，把主次弄反了。
        */}
        {hover ? (
          <div className="fin-spark-tip" style={{ left: `${tipX}%` }}>
            <span className="fin-spark-tip-time">{pointTimeLabel(hover.t)}</span>
            <span className="fin-spark-tip-val mono">
              {hover.v.toFixed(2)} {cur}
            </span>
          </div>
        ) : null}
      </div>

      {/*
       * 横轴刻度。**动态窗口的前提**：跨度会在 1 小时~7 天之间伸缩，
       * 不标出来的话两条外形一样的曲线，一条讲的是一小时、另一条讲的是一星期。
       * 日期只在本地零点那一格出现（见 `axisTicks`）。
       */}
      <div className="fin-spark-axis" aria-hidden="true">
        {ticks.map((k) => (
          <span
            key={k.t}
            className={`fin-spark-tick fin-spark-tick--${k.anchor}`}
            style={{ left: `${k.x}%` }}
          >
            {k.label}
          </span>
        ))}
      </div>

      {/*
       * 极值必须一直显示：曲线是自适应缩放的（不从 0 起），
       * 不给刻度的话一道陡坡到底代表 4 分钱还是 40 块钱，看的人无从判断。
       * 跨度同理——横轴是伸缩的，"近 1 小时"和"近 7 天"必须说出来。
       * 悬浮时这两行让位给气泡：用 visibility 不用 display，
       * 后者会让卡片在鼠标进出时高度跳动。
       */}
      <div className="fin-spark-foot">
        <span className="mono">
          {spark.min.toFixed(2)} ~ {spark.max.toFixed(2)}
        </span>
        <span className="spacer" />
        {win ? <span className="fin-spark-span">{spanLabel(win.span)}</span> : null}
        <span title={deltaTitle}>{deltaLabel(spark)}</span>
        {spark.gaps > 0 ? (
          <span className="fin-spark-gap" title="这些时段网关没在跑，没有采样点；曲线在那里是断开的，没有补点">
            · {spark.gaps} 处缺口
          </span>
        ) : null}
      </div>
    </div>
  );
}
