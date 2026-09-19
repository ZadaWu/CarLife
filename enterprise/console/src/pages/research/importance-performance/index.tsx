/**
 * 重要度 × 表现度 `/research/importance-performance`（施工单 M82-08）。
 *
 * # 口径必须写在图上
 *
 * 两个轴都是**代理**：重要度用提及率代理，表现度用"该轮无追问/无打断/无拦截"代理。
 * 方法本体 §08 C 要求声明口径，所以那一行字是**必显**的，不是提示。
 *
 * # 象限底色只在 Measurement 门通过时画
 *
 * 象限底色在说"右下角这些该优先修"，而那句话建立在两个轴都可信之上。
 * 门没过就退化成散点 + 灰色参考线——图还在，那句话没了。
 */

import { useMemo } from "react";
import {
  CartesianGrid,
  ErrorBar,
  ReferenceArea,
  ReferenceLine,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  ResponsiveContainer,
} from "recharts";

import { ResearchFrame } from "../shell/ResearchFrame";
import { Unavailable } from "../shell/Unavailable";
import { ipaView, type IpaData } from "../shell/model";
import { useSnapshot } from "../shell/useSnapshot";

export function ImportancePerformancePage(): JSX.Element {
  const state = useSnapshot<IpaData>("importance-performance");
  const view = useMemo(() => (state.kind === "ready" ? ipaView(state.snapshot.data) : null), [state]);

  if (state.kind === "unavailable") return <Unavailable code={state.code} />;
  if (state.kind === "loading")
    return <div className="page"><h1>重要度 × 表现度</h1><p className="page-sub">读取中…</p></div>;
  if (state.kind === "computing")
    return <div className="page"><h1>重要度 × 表现度</h1><p className="page-sub">快照还在算，稍后刷新。</p></div>;
  if (state.kind === "error")
    return <div className="page"><h1>重要度 × 表现度</h1><p className="page-sub">读取失败：{state.message}</p></div>;
  if (!view) return <div className="page" />;

  const snap = state.snapshot;
  // ErrorBar 吃的是"到两端的距离"，不是绝对坐标。
  const points = view.points.map((p) => ({
    ...p,
    errX: [Math.max(0, p.importance - p.ci.lo), Math.max(0, p.ci.hi - p.importance)] as [number, number],
  }));

  return (
    <ResearchFrame
      title="重要度 × 表现度"
      subtitle="车主多在意 × 我们答得多好，产出「该先改哪里」的候选清单"
      population={snap.population}
      window={snap.window}
      codebookVersion={snap.codebookVersion}
      codebookLocked={snap.gates.measurement.status === "pass"}
      gates={snap.gates}
      toolbar={<span className="ipa-basis">{view.basisText}</span>}
      legend={
        <>
          <span><b>点的大小</b>：该需求码的证据轮次 n</span>
          <span><b>横向误差棒</b>：提及率的 95% Wilson 区间——点少的码不该和点多的看起来一样确定</span>
          <span>
            <b>象限底色</b>：仅在测量门通过时显示。
            {view.quadrantsEnabled ? "当前已显示。" : "当前门未过，退化为散点——两个轴还不够可信，不给「该优先修哪个」的暗示。"}
          </span>
          <span><b>阈值</b>：两轴各取中位数，非绝对标准；落在阈值附近的点见上方敏感性读数</span>
        </>
      }
    >
      {view.flipping.length > 0 ? (
        <p className="banner-warn ipa-sensitivity">
          敏感性：{view.flipping.join("、")} 落在阈值 ±0.02 内——换一个阈值就会换象限，不要当成确定的分类。
        </p>
      ) : null}

      <div className="ipa-chart">
        <ResponsiveContainer width="100%" height={380}>
          <ScatterChart margin={{ top: 16, right: 24, bottom: 32, left: 16 }}>
            {/* 象限底色：门通过才画。四块用极淡的 accent/warn，不给类目上色。 */}
            {view.quadrantsEnabled ? (
              <>
                <ReferenceArea
                  x1={view.thresholds.importance}
                  x2={1}
                  y1={0}
                  y2={view.thresholds.performance}
                  fill="var(--warn)"
                  fillOpacity={0.08}
                />
                <ReferenceArea
                  x1={view.thresholds.importance}
                  x2={1}
                  y1={view.thresholds.performance}
                  y2={1}
                  fill="var(--ok)"
                  fillOpacity={0.05}
                />
              </>
            ) : null}
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="importance"
              name="重要度"
              domain={[0, "dataMax"]}
              stroke="var(--fg-dim)"
              tick={{ fontSize: 11 }}
              label={{ value: "重要度（提及代理）", position: "insideBottom", offset: -16, fill: "var(--fg-dim)", fontSize: 11 }}
            />
            <YAxis
              type="number"
              dataKey="performance"
              name="表现度"
              domain={[0, 1]}
              stroke="var(--fg-dim)"
              tick={{ fontSize: 11 }}
              label={{ value: "表现度（该轮解决率）", angle: -90, position: "insideLeft", fill: "var(--fg-dim)", fontSize: 11 }}
            />
            <ZAxis type="number" dataKey="n" range={[40, 400]} name="证据轮次" />
            <ReferenceLine x={view.thresholds.importance} stroke="var(--fg-dim)" strokeDasharray="4 4" />
            <ReferenceLine y={view.thresholds.performance} stroke="var(--fg-dim)" strokeDasharray="4 4" />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              contentStyle={{ background: "var(--panel-2)", border: "1px solid var(--line)", fontSize: 12 }}
              formatter={(v, name) => [typeof v === "number" ? v.toFixed(3) : String(v ?? ""), String(name ?? "")]}
            />
            <Scatter data={points} fill="var(--accent)" fillOpacity={0.75}>
              <ErrorBar dataKey="errX" direction="x" width={4} stroke="var(--fg-dim)" />
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      <h3 className="ipa-h3">高重要 · 低表现候选</h3>
      {view.candidates.length === 0 ? (
        <p className="rm-dim">这一窗没有落在该象限的需求码。</p>
      ) : (
        <table className="rm-table ipa-table">
          <thead>
            <tr>
              <th>需求 / 痛点</th>
              <th>重要度</th>
              <th>表现度</th>
              <th>证据轮次</th>
            </tr>
          </thead>
          <tbody>
            {view.candidates.map((c) => (
              <tr key={c.code}>
                <td>{c.label}</td>
                <td className="rm-nn">{c.importance.toFixed(3)}</td>
                <td className="rm-nn">{c.performance.toFixed(3)}</td>
                <td className="rm-nn">{c.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ResearchFrame>
  );
}
