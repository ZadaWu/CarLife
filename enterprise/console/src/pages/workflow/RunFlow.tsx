/**
 * 主链路图 + 一次运行的投影（会话页逐轮、演示大屏实时，两处共用）。
 *
 * # 为什么复用同一张图而不是画个简版
 *
 * 简版意味着第二份节点表——它会漂，而且漂的方式是"这张小图上没有的那一步
 * 你以为不存在"。这里直接吃 `WORKFLOW_NODES/EDGES`，压暗没走到的部分：
 * 读者看到的始终是**同一张图上的位置**，不是一条被抽出来的路径。
 *
 * # 三种颜色分别回答一个问题
 *
 * 绿 = 走完了；红 = 失败（回放页同一取向：失败靠颜色不靠筛掉别的）；
 * 黄 = 此刻停在这里。没有第四种——一屏十几种颜色等于没有颜色。
 */

import { memo, useMemo } from "react";
import ReactFlow, { Background, Controls } from "reactflow";

import { WORKFLOW_EDGES, WORKFLOW_NODES } from "./graph-model";
import { POS, toEdges, toNodes } from "./layout";
import { ParticleEdge, ReadableSmoothStepEdge } from "./ParticleEdge";
import { edgeWalked, type GraphRun } from "./projection";

const DONE = "#3fb950";
const FAILED = "#f85149";
const ACTIVE = "#d29922";

// 组件外定义：每次渲染新建这个对象的话，reactflow 会当成换了套边类型整图重挂。
const EDGE_TYPES = { smoothstep: ReadableSmoothStepEdge, particle: ParticleEdge };

/**
 * 重建整张图的判据是**内容变了**，不是 `run` 换了个对象。
 *
 * 实时视图每 250ms 并一批事件就产生一个新的 `run`，而一批里很可能什么都没变
 * （几条 prompt、几条只影响耗时的 span）。按对象身份重算的话，
 * 23 个节点 + 30 条边的样式对象每次全新建一遍，ReactFlow 跟着整片重渲染。
 */
function signature(run: GraphRun): string {
  const nodes = [...run.nodes.entries()]
    .map(([id, r]) => `${id}:${r.state}:${r.durationMs ?? ""}:${r.note ?? ""}`)
    .sort()
    .join("|");
  // finished 也进签名：粒子只在"进行中"的走过边上流动，收口那一刻要停下来。
  return `${nodes}#${[...run.edges].sort().join(",")}#${run.current ?? ""}#${run.finished}#${run.unknownNodes.join(",")}`;
}

interface RunFlowProps {
  run: GraphRun;
  /** 默认用固定高度；大屏可交给外层 flex 计算剩余视口高度。 */
  height?: number;
  fit?: boolean;
  className?: string;
}

function RunFlowInner({ run, height = 380, fit = false, className }: RunFlowProps): JSX.Element {
  const key = signature(run);
  const nodes = useMemo(
    () =>
      toNodes(WORKFLOW_NODES, POS, (n) => {
        const hit = run.nodes.get(n.id);
        if (!hit) return { dim: true };
        const active = run.current === n.id;
        return {
          accent: hit.state === "failed" ? FAILED : active ? ACTIVE : DONE,
          pulse: active,
          suffix: [
            active ? "▸ 此刻在这里" : undefined,
            hit.durationMs !== undefined ? `${hit.durationMs}ms` : undefined,
            hit.note,
          ]
            .filter(Boolean)
            .join(" · "),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按内容签名重算，见 signature()
    [key],
  );

  const edges = useMemo(
    () =>
      toEdges(WORKFLOW_EDGES, "r", (e) =>
        // 粒子只给"走过 + 本轮还没收口"的边——收口后的图是记录，不是流。
        edgeWalked(run, e) ? { accent: DONE, particle: !run.finished } : { dim: true },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上
    [key],
  );

  const flowClassName = ["run-flow", className].filter(Boolean).join(" ");
  return (
    <div className={flowClassName}>
      <div
        className="run-flow-canvas"
        style={
          fit
            ? {
                border: "1px solid var(--line, #2a2f3a)",
                borderRadius: 6,
              }
            : {
                height,
                border: "1px solid var(--line, #2a2f3a)",
                borderRadius: 6,
              }
        }
      >
        <ReactFlow nodes={nodes} edges={edges} edgeTypes={EDGE_TYPES} fitView nodesDraggable={false} nodesConnectable={false}>
          {/* 点阵是退后的定位辅助，不应与节点争夺视觉焦点。 */}
          <Background color="rgba(145, 145, 154, 0.28)" gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="muted tiny">
        亮起的是这一轮真的走过的节点与边，压暗的仍然画着——
        这样看到的是<strong>在整张图上的位置</strong>，而不是一条被抽出来的路径。
        <span style={{ color: DONE }}> ● 走完</span>
        <span style={{ color: ACTIVE }}> ● 此刻在这里</span>
        <span style={{ color: FAILED }}> ● 失败</span>
        {run.unknownNodes.length > 0 ? (
          <>
            {" "}
            ⚠️ 轨迹里还有图上没有的节点：<code>{run.unknownNodes.join("、")}</code>
            ——多半是已下线的旧节点（老会话的回放会有），也可能是图漂了。
          </>
        ) : null}
      </p>
    </div>
  );
}

/**
 * `memo` 是给实时视图的：它每 250ms 换一次 `run`，而大屏上还挂着别的东西。
 * 内容真变了才重画，判据见 `signature`。
 */
export const RunFlow = memo(
  RunFlowInner,
  (a, b) =>
    a.height === b.height &&
    a.fit === b.fit &&
    a.className === b.className &&
    signature(a.run) === signature(b.run),
);
