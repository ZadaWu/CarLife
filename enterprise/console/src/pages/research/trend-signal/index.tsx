/**
 * 趋势与信号 `/research/trend-signal`（施工单 M82-09，Brief `trend-signal.brief.md`）。
 *
 * # 这一页的存在理由是「先排除我们自己」
 *
 * 提及率断崖式下降看起来像"用户不再抱怨了"，真实原因常常是我们换了 ASR 档位。
 * 所以事件轨道与信号列表同屏：`verdict = 'own-change'` 的主题标「我们自己的变更」
 * 并压暗，不与真正的信号并列。
 *
 * # 三条轨迹同色
 *
 * 主线一律 `--accent`，区分靠左侧标题与纵向分带。给每个主题一个色相，
 * 读者会先分辨颜色再读内容（同证据矩阵的判断）。
 *
 * # 没有预测段
 *
 * Brief §3⑤ 第 4 层是"预测 + 95% 区间"。快照里没有预测——没有模型在算它。
 * 画一段编出来的虚线比不画危险得多，所以这一层缺位，并在说明里写明。
 */

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ResearchFrame } from "../shell/ResearchFrame";
import { Unavailable } from "../shell/Unavailable";
import { useSnapshot } from "../shell/useSnapshot";
import { eventTracks, trendView, TRACK_LABEL, type EventTrack, type TrendData, type TrendView } from "./model";

const MAX_SERIES = 3;

/** 一条主题轨迹：左轴原始量柱，右轴标准化率线，基线虚线。 */
function Track({ view, code, label, baseline }: { view: TrendView; code: string; label: string; baseline: number }): JSX.Element {
  return (
    <div className="ts-track">
      <div className="ts-track-head">
        <strong>{label}</strong>
        <span className="rm-dim">基线（前 90 天）{(baseline * 100).toFixed(1)}%</span>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <ComposedChart data={view.points} margin={{ top: 6, right: 46, bottom: 4, left: 6 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="weekLabel" stroke="var(--fg-dim)" tick={{ fontSize: 10 }} />
          <YAxis yAxisId="raw" stroke="var(--fg-dim)" tick={{ fontSize: 10 }} width={34} />
          <YAxis
            yAxisId="rate"
            orientation="right"
            stroke="var(--fg-dim)"
            tick={{ fontSize: 10 }}
            width={40}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          />
          <Tooltip
            contentStyle={{ background: "var(--panel-2)", border: "1px solid var(--line)", fontSize: 12 }}
            formatter={(v, name) => [
              typeof v === "number" ? (String(name).startsWith("rate_") ? `${(v * 100).toFixed(1)}%` : String(v)) : String(v ?? ""),
              String(name).startsWith("rate_") ? "标准化比率" : "原始量（轮）",
            ]}
          />
          {/* 基线：前 90 天的率，虚线 */}
          <ReferenceLine yAxisId="rate" y={baseline} stroke="var(--fg-dim)" strokeDasharray="4 4" />
          <Bar yAxisId="raw" dataKey={`raw_${code}`} fill="var(--fg-dim)" fillOpacity={0.18} isAnimationActive={false} />
          <Line
            yAxisId="rate"
            type="monotone"
            dataKey={`rate_${code}`}
            stroke="var(--accent)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 一条事件轨道：同一条横轴上的竖线 + 标签。上轨（系统变更）比下轨重。 */
function EventTrack({ view, track, heavy }: { view: TrendView; track: EventTrack; heavy: boolean }): JSX.Element {
  const weeks = eventTracks(view.events, track);
  return (
    <div className="ts-events">
      <div className="ts-track-head">
        <strong>{TRACK_LABEL[track]}</strong>
        <span className="rm-dim">{weeks.reduce((a, w) => a + w.count, 0)} 次</span>
      </div>
      <ResponsiveContainer width="100%" height={72}>
        {/* top 留 14px 给竖线上方的「n×」计数，否则它被裁掉 */}
        <ComposedChart data={view.points} margin={{ top: 14, right: 46, bottom: 4, left: 6 }}>
          <XAxis dataKey="weekLabel" stroke="var(--fg-dim)" tick={{ fontSize: 10 }} />
          {/*
            两根轴不能 `hide`：`hide` 会连带把轴宽也去掉，事件轨的时间轴就与上面
            三条轨迹错开几十像素——而"这次变更落在哪一周"正是要靠对齐读的。
            所以留住轴宽，只去掉刻度与轴线。
          */}
          <YAxis width={34} domain={[0, 1]} tick={false} axisLine={false} />
          <YAxis yAxisId="right" orientation="right" width={40} tick={false} axisLine={false} />
          {/* 透明柱只为让 Recharts 建立笛卡尔坐标系；没有任何系列时 ReferenceLine 不落笔 */}
          <Bar dataKey="turns" fill="transparent" isAnimationActive={false} />
          {weeks.map((w) => (
            <ReferenceLine
              key={w.weekLabel}
              x={w.weekLabel}
              stroke={heavy ? "var(--accent)" : "var(--fg-dim)"}
              strokeDasharray={heavy ? undefined : "3 3"}
              strokeWidth={heavy ? 2 : 1}
              label={{
                value: w.count > 1 ? `${w.count}×` : "·",
                position: "top",
                fill: "var(--fg-dim)",
                fontSize: 10,
              }}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <ul className="ts-event-list">
        {weeks.map((w) => (
          <li key={w.weekLabel} title={w.detail}>
            <span className="mono">{w.weekLabel}</span> {w.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TrendSignalPage(): JSX.Element {
  const state = useSnapshot<TrendData>("trend-signal");
  const [selected, setSelected] = useState<string[]>([]);

  const view = useMemo(
    () => (state.kind === "ready" ? trendView(state.snapshot.data, { selected, maxSeries: MAX_SERIES }) : null),
    [state, selected],
  );

  if (state.kind === "unavailable") return <Unavailable code={state.code} />;
  if (state.kind === "loading")
    return <div className="page"><h1>趋势与信号</h1><p className="page-sub">读取中…</p></div>;
  if (state.kind === "computing")
    return <div className="page"><h1>趋势与信号</h1><p className="page-sub">快照还在算，稍后刷新。</p></div>;
  if (state.kind === "error")
    return <div className="page"><h1>趋势与信号</h1><p className="page-sub">读取失败：{state.message}</p></div>;
  if (!view) return <div className="page" />;

  const snap = state.snapshot;
  const ownChanges = view.signals.filter((s) => s.verdict === "own-change");

  /** 点一条：已在轨道上就撤下，否则加进来（满 3 条时挤掉最早的）。 */
  const toggle = (code: string): void => {
    const now = view.series.map((s) => s.code);
    const next = now.includes(code) ? now.filter((c) => c !== code) : [...now, code].slice(-MAX_SERIES);
    setSelected(next);
  };

  return (
    <ResearchFrame
      title="趋势与信号"
      subtitle="主题提及率变化 × 我方变更同屏：拐点先归因到我们自己，再谈用户变化"
      population={snap.population}
      window={snap.window}
      codebookVersion={snap.codebookVersion}
      codebookLocked={snap.gates.measurement.status === "pass"}
      gates={snap.gates}
      toolbar={
        <>
          <span className="uz-seg">标准化：按当期总轮次</span>
          <span className="uz-seg">分档：按周</span>
          <span className="rm-spacer" />
          <span className="rm-dim">上图主题（最多 {MAX_SERIES} 条）：</span>
        </>
      }
      legend={
        <>
          <span><b>原始量</b>（淡柱，左轴）：当期提到该主题的去重轮次。<b>覆盖量变了它就会变</b></span>
          <span><b>标准化比率</b>（主线，右轴）：该主题轮次 ÷ 当期总轮次。<b>主线看这个</b></span>
          <span><b>基线</b>：前 90 天的率，虚线</span>
          <span><b>没有预测段</b>：快照里没有预测，没有模型在算它——画一段编出来的虚线比不画危险</span>
          <span><b>替代解释</b>：同期若有我方变更（配置 / 知识库 / codebook），<b>相关不是原因</b></span>
          <span><b>外部事件轨缺位</b>：`system_events` 的五个 kind 全是我方变更，本部署没有政策 / 天气 / 油价的数据源，不画恒空的轨道冒充"外面没发生事"</span>
        </>
      }
      drawer={
        <div className="rm-drawer">
          <div className="rm-drawer-title"><strong>指标定义</strong></div>
          <div className="rm-drawer-sec">
            <p className="rm-dim">
              <b>原始量</b>：该主题在该周的去重轮次。<br />
              <b>标准化比率</b>：原始量 ÷ 该周总轮次。<br />
              <b>基线</b>：前 90 天的率。<br />
              <b>判读</b>：`signal` / `own-change` / `noise` 三档，由快照给，本页不判。
            </p>
          </div>
          <div className="rm-drawer-sec">
            <h4>重点：先排除我们自己</h4>
            {ownChanges.length === 0 ? (
              <p className="rm-dim">本窗没有能归到我方变更上的拐点。这不等于没有——只等于同周没找到对得上的变更记录。</p>
            ) : (
              <ol className="sa-insights">
                {ownChanges.map((s) => (
                  <li key={s.code}>
                    <b>{s.label}</b>
                    <span className="ts-verdict ts-verdict--own">{s.verdictLabel}</span>
                    <span className="rm-dim"> {s.reason}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="rm-drawer-sec">
            <h4>允许用途</h4>
            <p className="rm-dim">内部排序 · 结论一律 Signal 级 · 不可作为对外趋势发布 · 回放记入操作审计</p>
          </div>
        </div>
      }
    >
      <div className="ts-picker">
        {view.options.map((o) => (
          <button
            key={o.code}
            type="button"
            className={`uz-seg ts-pick${o.selected ? " is-active" : ""}`}
            onClick={() => toggle(o.code)}
          >
            {o.label}
          </button>
        ))}
      </div>

      {view.series.map((s) => (
        <Track key={s.code} view={view} code={s.code} label={s.label} baseline={s.baseline} />
      ))}

      {/* 上轨视觉重量明显大于下轨：改系统比改语料更能解释拐点 */}
      <EventTrack view={view} track="system" heavy />
      <EventTrack view={view} track="corpus" heavy={false} />

      <div className="ts-coverage">
        <div className="ts-track-head">
          <strong>覆盖量变化（每周去重轮次）</strong>
          <span className="rm-dim">覆盖构成变了，提及率就会变——先排除它再谈用户变化。</span>
        </div>
        <ResponsiveContainer width="100%" height={90}>
          <BarChart data={view.points} margin={{ top: 4, right: 46, bottom: 4, left: 6 }}>
            <XAxis dataKey="weekLabel" stroke="var(--fg-dim)" tick={{ fontSize: 10 }} />
            <YAxis stroke="var(--fg-dim)" tick={{ fontSize: 10 }} width={34} />
            <Tooltip
              contentStyle={{ background: "var(--panel-2)", border: "1px solid var(--line)", fontSize: 12 }}
              formatter={(v) => [String(v ?? ""), "去重轮次"]}
            />
            <Bar dataKey="turns" fill="var(--accent)" fillOpacity={0.45} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
        <p className="rm-dim">
          已授权车主 {snap.population.owners.toLocaleString("zh-CN")} 人 ·
          车辆 {snap.population.vehicles.toLocaleString("zh-CN")} 台（窗口口径，不按周拆——快照只给了每周轮次）
        </p>
      </div>

      <h3 className="ipa-h3">信号列表</h3>
      <table className="rm-table">
        <thead>
          <tr>
            <th className="rm-idx">#</th>
            <th>信号主题</th>
            <th>判读</th>
            <th>替代解释 / 理由</th>
          </tr>
        </thead>
        <tbody>
          {view.signals.map((s, i) => (
            <tr key={s.code} className={s.dimmed ? "sa-row--dim" : undefined}>
              <td className="rm-idx">{i + 1}</td>
              <td>{s.label}</td>
              <td>
                <span className={`ts-verdict ts-verdict--${s.verdict}`}>{s.verdictLabel}</span>
              </td>
              <td className="rm-dim">{s.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResearchFrame>
  );
}
