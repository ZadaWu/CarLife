/**
 * 三列地图的手写 SVG（施工单 M82-09，Brief `emotion-job-map.brief.md` §3⑥）。
 *
 * 用 `<svg>` 而不是 Recharts 的 `Sankey`：三列里只有前两列是"节点"，
 * 第三列是每条链自己的解决率读数，`Sankey` 的 nodes/links 模型套不进来。
 * 手写的另一个好处是**连接带的粗细是唯一的视觉变量**——Sankey 会顺手给
 * 每个节点配一个颜色，而本页恰恰不要那个（Brief 判断 1）。
 *
 * 布局是纯算术，没有度量 DOM：行高固定，节点按索引排。
 */

import type { EmotionFlow, EmotionNode } from "./model";

const ROW = 30;
const NODE_H = 24;
const COL_W = 168;
const GAP = 96;
const PAD_TOP = 22;
/** `mixed` / `uncertain` 与上面六类之间的分隔留白（Brief C5）。 */
const DIVIDER_GAP = 14;

const X_JOB = 0;
const X_EMO = COL_W + GAP;
const X_OUT = (COL_W + GAP) * 2;
const WIDTH = X_OUT + COL_W;

export interface EmotionMapProps {
  jobs: EmotionNode[];
  emotions: EmotionNode[];
  flows: EmotionFlow[];
  selected: number;
  onSelect: (i: number) => void;
}

/** 节点纵坐标：`outOfGrid` 的两项整体下移一个分隔间距。 */
function nodeYs(nodes: readonly EmotionNode[]): number[] {
  let extra = 0;
  return nodes.map((n, i) => {
    if (n.outOfGrid && extra === 0) extra = DIVIDER_GAP;
    return PAD_TOP + i * ROW + extra;
  });
}

export function EmotionMap(props: EmotionMapProps): JSX.Element {
  const { jobs, emotions, flows, selected } = props;

  const jobY = nodeYs(jobs);
  const emoY = nodeYs(emotions);
  const outY = flows.map((_, i) => PAD_TOP + i * ROW);

  const jobIndex = new Map(jobs.map((j, i) => [j.code, i]));
  const emoIndex = new Map(emotions.map((e, i) => [e.code, i]));
  const maxFlow = Math.max(1, ...flows.map((f) => f.n));
  const maxJob = Math.max(1, ...jobs.map((j) => j.n));
  const maxEmo = Math.max(1, ...emotions.map((e) => e.n));

  const height =
    Math.max(
      PAD_TOP + jobs.length * ROW + DIVIDER_GAP,
      PAD_TOP + emotions.length * ROW + DIVIDER_GAP,
      PAD_TOP + flows.length * ROW,
    ) + 16;

  const mid = (y: number): number => y + NODE_H / 2;

  return (
    <svg className="ej-map" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="任务 → 情绪 → 结果 三列地图">
      <text className="ej-col-title" x={X_JOB} y={12}>车主任务</text>
      <text className="ej-col-title" x={X_EMO} y={12}>车主情绪</text>
      <text className="ej-col-title" x={X_OUT} y={12}>结果（该链解决率）</text>

      {/* 连接带：粗细 ∝ 该链证据数，颜色只有"选中 / 未选中"两种 */}
      {flows.map((f, i) => {
        const ji = jobIndex.get(f.job);
        const ei = emoIndex.get(f.emotion);
        if (ji === undefined || ei === undefined) return null;
        const y1 = mid(jobY[ji]);
        const y2 = mid(emoY[ei]);
        const y3 = mid(outY[i]);
        const w = Math.max(1, (f.n / maxFlow) * 9);
        const on = i === selected;
        return (
          <g key={`${f.job}|${f.emotion}`} className={`ej-flow${on ? " is-on" : ""}`} onClick={() => props.onSelect(i)}>
            <path
              d={`M${X_JOB + COL_W},${y1} C${X_JOB + COL_W + GAP / 2},${y1} ${X_EMO - GAP / 2},${y2} ${X_EMO},${y2}`}
              strokeWidth={w}
            />
            <path
              d={`M${X_EMO + COL_W},${y2} C${X_EMO + COL_W + GAP / 2},${y2} ${X_OUT - GAP / 2},${y3} ${X_OUT},${y3}`}
              strokeWidth={w}
            />
          </g>
        );
      })}

      {jobs.map((j, i) => (
        <Node key={j.code} x={X_JOB} y={jobY[i]} label={j.label} n={j.n} share={j.n / maxJob} node={j} />
      ))}
      {emotions.map((e, i) => (
        <Node key={e.code} x={X_EMO} y={emoY[i]} label={e.label} n={e.n} share={e.n / maxEmo} node={e} />
      ))}

      {/* 第三列：每条链一行，条长 = 快照给的 resolvedRate，前端不再算 */}
      {flows.map((f, i) => (
        <g
          key={`out-${f.job}-${f.emotion}`}
          className={`ej-out${i === selected ? " is-on" : ""}`}
          onClick={() => props.onSelect(i)}
        >
          <rect x={X_OUT} y={outY[i]} width={COL_W} height={NODE_H} rx={3} />
          <rect className="ej-out-track" x={X_OUT + 8} y={outY[i] + 16} width={COL_W - 60} height={3} />
          <rect
            className="ej-out-fill"
            x={X_OUT + 8}
            y={outY[i] + 16}
            width={Math.max(0, (COL_W - 60) * f.resolvedRate)}
            height={3}
          />
          <text className="ej-node-label" x={X_OUT + 8} y={outY[i] + 12}>
            已解决 {Math.round(f.resolvedRate * 100)}%
          </text>
          <text className="ej-node-n" x={X_OUT + COL_W - 8} y={outY[i] + 16}>
            n={f.n}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** 一个节点。**所有节点同一 `tone`**——类目靠位置与标签区分，不靠色相。 */
function Node(props: { x: number; y: number; label: string; n: number; share: number; node: EmotionNode }): JSX.Element {
  const { x, y, label, n, share, node } = props;
  return (
    <g className={`ej-node${node.outOfGrid ? " is-out-of-grid" : ""}`} data-tone={node.tone}>
      <rect x={x} y={y} width={COL_W} height={NODE_H} rx={3} />
      <rect className="ej-node-track" x={x + 8} y={y + NODE_H - 6} width={COL_W - 16} height={2} />
      <rect className="ej-node-fill" x={x + 8} y={y + NODE_H - 6} width={(COL_W - 16) * share} height={2} />
      <text className="ej-node-label" x={x + 8} y={y + 13}>
        {label}
        {node.outOfGrid ? " ·单列" : ""}
      </text>
      <text className="ej-node-n" x={x + COL_W - 8} y={y + 13}>
        {n.toLocaleString("zh-CN")}
      </text>
    </g>
  );
}
