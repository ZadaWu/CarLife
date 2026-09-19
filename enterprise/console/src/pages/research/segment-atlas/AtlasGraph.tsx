/**
 * 人群关系图的手写 SVG（施工单 M82-09，Brief `segment-atlas.brief.md` §3⑤）。
 *
 * Recharts 没有这种图（面积编码 + 无填充色差 + 边上带分数），所以直接画。
 * 做法沿用 `pages/finance/` 的 sparkline：布局是纯算术，不量 DOM。
 *
 * **圆无填充色差**——只有大小与位置是变量（Brief §4）。抑制群画虚线灰圈，
 * 与卡片区的抑制态对应。
 */

import type { AtlasNode } from "./model";

const W = 320;
const H = 300;
const CX = W / 2;
const CY = H / 2 - 6;
/** 圆心排在一个圆周上：五个群谁挨着谁不表达任何含义，别让读者从位置里读出关系。 */
const ORBIT = 96;

export interface AtlasGraphProps {
  nodes: AtlasNode[];
  edges: Array<{ a: string; b: string; score: number; label: string }>;
  selected: string | null;
  onSelect: (id: string) => void;
}

function positions(nodes: readonly AtlasNode[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const n = Math.max(1, nodes.length);
  nodes.forEach((node, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    out.set(node.id, { x: CX + ORBIT * Math.cos(a), y: CY + ORBIT * Math.sin(a) });
  });
  return out;
}

export function AtlasGraph(props: AtlasGraphProps): JSX.Element {
  const pos = positions(props.nodes);

  return (
    <svg className="sa-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="人群关系图">
      {props.edges.map((e) => {
        const p = pos.get(e.a);
        const q = pos.get(e.b);
        if (!p || !q) return null;
        return (
          <g key={`${e.a}-${e.b}`} className="sa-edge">
            <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
            <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 - 3}>{e.label}</text>
          </g>
        );
      })}

      {props.nodes.map((node) => {
        const p = pos.get(node.id);
        if (!p) return null;
        const on = node.id === props.selected;
        return (
          <g
            key={node.id}
            className={`sa-node${node.dashed ? " is-dashed" : ""}${on ? " is-on" : ""}`}
            onClick={() => props.onSelect(node.id)}
          >
            <circle cx={p.x} cy={p.y} r={node.r} />
            <text className="sa-node-name" x={p.x} y={p.y - 1}>{node.name}</text>
            <text className="sa-node-n" x={p.x} y={p.y + 12}>{node.size} 台</text>
          </g>
        );
      })}
    </svg>
  );
}
