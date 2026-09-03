/**
 * Agent Workflow 可视化（施工单 M9-02，FL-29 F-29-01）。
 *
 * # 只读，不做图编辑
 *
 * 编排定义在代码里（`enterprise/backend/agent-runtime/src/graph/`）。页面上能拖动改图
 * 会立刻产生"图上画的"与"实际跑的"两个真相源——而这套系统里
 * "看起来对、实际不是"正是最危险的形态。所以节点不可拖、边不可连。
 *
 * # 图与代码不一致时**页面自己喊出来**
 *
 * `validateGraph()` 的结果直接渲染在顶部。一张与实际不符的架构图比没有图更糟，
 * 它会让人相信一个并不存在的架构——所以宁可显示"这张图有问题"。
 *
 * # 这里有三张图，不是一张
 *
 * 主链路 / 旁路陪伴 / 语音唤醒入口。后两张都**不在编排图上**：
 * 旁路并行于整个 turn、只读、够不着业务能力；唤醒整条发生在进图之前、全在车机端 Rust 侧。
 * 画进主图会让人以为编排层会"路由到旁路"、或者以为编排层看得见那些被丢弃的转写——
 * 都不会。分开画，各自自检。
 */

import { useMemo } from "react";
import ReactFlow, { Background, Controls } from "reactflow";
import "reactflow/dist/style.css";

import {
  AGENT_ROSTER,
  SESSION_SUFFIXES,
  SIDECAR_EDGES,
  SIDECAR_NODES,
  TOTAL_EDGES,
  TOTAL_NODES,
  BRIDGE_NODES,
  validateGraph,
  validateTotal,
  validateSidecar,
  validateWake,
  WAKE_EDGES,
  WAKE_NODES,
  WORKFLOW_EDGES,
  WORKFLOW_NODES,
  type WorkflowNode,
} from "./graph-model";
import { POS, SIDECAR_POS, toEdges, toNodes, TOTAL_POS, WAKE_POS } from "./layout";
import { Hint } from "../../components/Hint";
import "./workflow.css";

/**
 * 说明文字里的 `**强调**` 按加粗渲染。
 *
 * 这些 note 是照仓里的行文写的，而那套行文用 `**` 标"这一句是重点"。
 * 直接当纯文本渲染的话，满屏字面星号——而重点恰恰是最该看见的那部分。
 *
 * 手动切分成节点而不是 `dangerouslySetInnerHTML`：这里的文本虽然是我们自己写的，
 * 但"能渲染 HTML 的表格单元格"是个迟早会被喂进别处内容的洞。
 */
function Emphasis({ text }: { text: string }): JSX.Element {
  return (
    <>
      {text.split("**").map((part, i) =>
        // 奇数段落在一对 ** 之间。落单的 ** 会让尾段被当成强调——
        // 这种笔误在页面上一眼可见，不值得为它加一层校验。
        i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

function Problems({ title, items }: { title: string; items: readonly string[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="wf-problems">
      <strong>{title}</strong>
      <ul>
        {items.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

function NodeTable({ nodes }: { nodes: readonly WorkflowNode[] }): JSX.Element {
  return (
    <table className="wf-table">
      <thead>
        <tr>
          <th>节点</th>
          <th>层次</th>
          <th>源码</th>
          <th>要点</th>
        </tr>
      </thead>
      <tbody>
        {nodes
          .filter((n) => n.source || n.note)
          .map((n) => (
            <tr key={n.id}>
              <td className="wf-node-name">{n.label.replace(/\n/g, " ")}</td>
              {/* 「图节点」是能被路由到的一步；「节点内」是它体内发生的事；
                  「HTTP 子图」不在 StateGraph 里，网关收到一次点击就直接调（M36 导游、M66 导航）。 */}
              <td>
                <span className={n.graphNode ? "wf-tier wf-tier--graph" : "wf-tier"}>
                  {n.graphNode ? "图节点" : n.viaHttp ? "HTTP 子图" : "节点内"}
                </span>
              </td>
              <td className="wf-src">{n.source ?? "—"}</td>
              <td className="wf-note">{n.note ? <Emphasis text={n.note} /> : "—"}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

export function WorkflowPage(): JSX.Element {
  const totalProblems = useMemo(() => validateTotal(), []);
  const problems = useMemo(() => validateGraph(), []);
  const sidecarProblems = useMemo(() => validateSidecar(), []);
  const wakeProblems = useMemo(() => validateWake(), []);

  const totalNodes = useMemo(() => toNodes(TOTAL_NODES, TOTAL_POS), []);
  const totalEdges = useMemo(() => toEdges(TOTAL_EDGES, "t"), []);
  const nodes = useMemo(() => toNodes(WORKFLOW_NODES, POS), []);
  const edges = useMemo(() => toEdges(WORKFLOW_EDGES, "e"), []);
  const sidecarNodes = useMemo(() => toNodes(SIDECAR_NODES, SIDECAR_POS), []);
  const sidecarEdges = useMemo(() => toEdges(SIDECAR_EDGES, "s"), []);
  const wakeNodes = useMemo(() => toNodes(WAKE_NODES, WAKE_POS), []);
  const wakeEdges = useMemo(() => toEdges(WAKE_EDGES, "w"), []);

  return (
    <section className="wf-page">
      <h1>
        Agent Workflow
        <Hint label="本页说明">
          <p>
            编排定义在代码里（<code>graph/supervisor.ts</code> 的装配段 +{" "}
            <code>graph/route.ts</code> 的 <code>branchFor</code>），
            <strong>本页只读</strong>——能在页面上改图就会有两个真相源。
          </p>
        </Hint>
      </h1>
      <p className="wf-desc">
        这几张图画的是<strong>一次对话在服务端经过了什么</strong>，从上到下由全到细。
      </p>
      {/*
        图例常驻——它是读图的钥匙，收进问号等于每看一张图都要先开一次锁。
        但"为什么该用这种线"是设计判据不是读图必需，收进问号。
      */}
      <ul className="wf-legend">
        <li><i className="wf-lg wf-lg--solid" />实线 · 控制流</li>
        <li><i className="wf-lg wf-lg--dashed" />虚线 · 条件边（走这条<em>或</em>那条）</li>
        <li><i className="wf-lg wf-lg--dotted" />点线 · 只读旁观（零影响）</li>
        <li><i className="wf-lg wf-lg--bold" />加粗动画 · 并行分支（<em>同时</em>走）</li>
        <li>
          <i className="wf-lg wf-lg--box" />虚线框 · 不是 LangGraph 的一步
          <Hint label="虚线框说明">
            <p>
              虚线框里的事发生在<strong>节点体内部</strong>——fan-out 分支、Agent 会话、
              工具层、动作权限门。画成实线会让人以为 LangGraph 会路由到权限门，
              或者去找那个并不存在的 <code>addNode("drive-task")</code>。
            </p>
          </Hint>
        </li>
      </ul>

      {/* ── 总链路：altitude 与下面三张不同，所以排在最前 ── */}
      <section className="wf-section">
        <h2>
          总链路（全量）
          <Hint label="总链路说明">
            <p>
              主链路与旁路<strong>全部细节都在这一张上</strong>，一个方框都不省——
              它是把下面几张<strong>组合</strong>出来的（<code>[...WORKFLOW_NODES,
              ...SIDECAR_NODES, ...BRIDGE_NODES]</code>），不是另画的一张。
              所以主链路加一个节点，这张自动就有了，不存在"总图停在上个月"。
            </p>
            <p>
              最该注意那条<strong>点线</strong>（<code>span sink → 旁路 A-pair</code>）：
              旁路只是在看主链路发出来的轨迹，<strong>编排图对它一无所知、也不等它</strong>。
              画成实线就成了"编排层会路由到旁路"——有一条会红的断言拦着
              （<code>validateTotal()</code>），不靠画图的人记得该用哪种线。
              而 <code>turn 开始 → 旁路 A-pair</code> 是实线，那是对的：
              <code>registerPair</code> / <code>closePair</code> 的生命周期归 turn-runner。
            </p>
            <p>
              <strong>会话标题旁路</strong>（M28-01）与<strong>工具进展下行</strong>（F-08-05）
              只在这张图上：它们不是编排节点，各自画一张又太小。
              唯一被折叠的是<strong>语音唤醒入口</strong>——它整条在进图之前、全在车机端 Rust 侧，
              展开会把图撑宽近一倍，细节见最后一张。
            </p>
          </Hint>
        </h2>
        <p className="wf-desc">一次对话的全貌：主链路 + 旁路 + 两条跨链路，一个方框不省。</p>
        <Problems title="总链路这张图与实际结构不一致：" items={totalProblems} />
        {/*
          **这张图刻意不用 `fitView`**。
          全量图约 3700×1500，而容器不到 1000px 宽——fitView 算出来的缩放
          会被 reactflow 默认的 `minZoom`(0.5) 卡住，于是既看不清字（12px×0.5=6px）
          又没显示全（实测 transform 被裁掉了左边 565px）。两头不讨好。

          所以默认给一个**看得清的缩放**停在左上角，全貌交给左下角那个 fit 按钮
          （`minZoom` 放到 0.2 它才真的能缩到全图）。
        */}
        <div className="wf-graph" style={{ height: 820 }}>
          <ReactFlow
            nodes={totalNodes}
            edges={totalEdges}
            defaultViewport={{ x: 24, y: 24, zoom: 0.72 }}
            minZoom={0.2}
            nodesDraggable={false}
            nodesConnectable={false}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <p className="wf-desc">
          可拖动平移、滚轮缩放；一眼看全貌点左下角「适应画面」。
          <Hint label="缩放与节点表说明">
            <p>
              默认停在<strong>看得清字</strong>的缩放上而不是缩到全图——
              38 个方框缩进一屏时每个字只有 6px，那种"看全了"没有意义。
            </p>
            <p>
              方框逐个说明见下面各张细节图的表，这里不重复列：
              <strong>重复一份就是又一个会漂的副本</strong>。
              下表只列<strong>仅在总链路出现</strong>的那几个（网关、工具进展、标题旁路、端上、控制台）。
            </p>
          </Hint>
        </p>
        <NodeTable nodes={BRIDGE_NODES} />
      </section>

      {/* ── 主链路 ── */}
      <section className="wf-section">
        <h2>
          主链路（编排图）
          <Hint label="主链路说明">
            <p>
              上半部是聊天进来的一轮：START → 意图理解 → 风险门 → 路由 → 五条分支 → 应答 → END。
            </p>
            <p>
              <strong>左下角两条是 HTTP 触发的子图</strong>（M36 景区导游采集、M66 出发导航规划）：
              网关收到端上的一次点击就直接调它们，<strong>与 START 之间没有任何一条边</strong>——
              它们不经意图理解、不经路由、也不经应答，产出是卡片不是一段话。
              画在同一张图上是因为大屏与会话页画的就是这张图，一轮导航规划的轨迹要有地方落。
            </p>
          </Hint>
        </h2>
        <Problems title="主链路这张图与实际结构不一致：" items={problems} />
        {/* 高度跟着图长：分支从 5 个涨到 9 个之后，520 会把字压到看不清。 */}
        <div className="wf-graph" style={{ height: 660 }}>
          <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false}>
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <h3>节点说明</h3>
        <NodeTable nodes={WORKFLOW_NODES} />
      </section>

      {/* ── 旁路陪伴 ── */}
      <section className="wf-section">
        <h2>
          旁路陪伴
          <Hint label="旁路说明">
            <p>
              它<strong>不是第六个子 Agent</strong>，也不是主链路上的一步：没有 pi 进程、
              没有 prompt 文件、没有工具表——能力边界靠<strong>依赖</strong>守
              （<code>check:arch</code> 的 <code>sidecar-isolation</code> 禁止它 import{" "}
              <code>../graph</code> / <code>../llm</code> / <code>@carlife/memory</code>），不靠提示词。
            </p>
            <p>
              <strong>会话标题不在这张图上</strong>：M28-01 的"旁路起名"是{" "}
              <code>src/title/</code> 下另一条独立链路——首轮收口后由网关触发、直连非推理模型、
              一个会话只起一次、失败无声。它刻意不放 <code>sidecar/</code>，
              正是为了不破上面那条依赖边界。
            </p>
          </Hint>
        </h2>
        <p className="wf-desc">并行于整个 turn 的<strong>只读观察者</strong>：用户等太久时说句闲话。</p>
        <Problems title="旁路这张图与实际结构不一致：" items={sidecarProblems} />
        <div className="wf-graph" style={{ height: 360 }}>
          <ReactFlow
            nodes={sidecarNodes}
            edges={sidecarEdges}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <h3>节点说明</h3>
        <NodeTable nodes={SIDECAR_NODES} />
      </section>

      {/* ── 语音唤醒入口 ── */}
      <section className="wf-section">
        <h2>
          语音唤醒入口
          <Hint label="唤醒入口说明">
            <p>
              US-52 / M25。整条链路发生在<strong>进图之前</strong>，全在车机端 Rust 侧
              （<code>clients/cockpit/src-tauri/src/voice/</code>）——所以这张图上
              <strong>只有一个实线框</strong>（主链路 START），其余都不是 LangGraph 的一步。
            </p>
            <p>
              最要紧的判断也不在编排层：没叫她的时候，那些转写在端上判定后
              <strong>就地丢弃</strong>——不进会话历史、不写六类记忆、不落日志明文。
              命中之后走的是与打字、与长按<strong>完全同一条</strong>上行路径，
              唤醒不是安检旁路。
            </p>
          </Hint>
        </h2>
        <p className="wf-desc">"你好暖暖"到进图之前的那一段，<strong>全在车机端</strong>。</p>
        <Problems title="唤醒入口这张图与实际结构不一致：" items={wakeProblems} />
        <div className="wf-graph" style={{ height: 420 }}>
          <ReactFlow
            nodes={wakeNodes}
            edges={wakeEdges}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <h3>节点说明</h3>
        <NodeTable nodes={WAKE_NODES} />
      </section>

      {/* ── Agent 清单 ── */}
      <section className="wf-section">
        <h2>
          Agent 清单
          <Hint label="Agent 清单说明">
            <p>
              每个 Agent 有<strong>独立进程、prompt 文件与工具 ACL</strong>。
            </p>
            <p>
              <strong>工具面不在本页</strong>——真相源是{" "}
              <code>enterprise/backend/shared/tools/src/registry.ts</code> 的 <code>agents</code> 字段，
              抄一份过来就是又一个会静默漂掉的副本。
            </p>
          </Hint>
        </h2>
        {/* 旁路在清单里但不是 pi Agent（没有 prompt 文件）——按清单长度数会多报一个。 */}
        <p className="wf-desc">
          {AGENT_ROSTER.filter((a) => a.prompt).length} 个 pi Agent，各自独立进程与工具表；另有旁路陪伴一条（不是 Agent）。
        </p>
        <div className="wf-agents">
          {AGENT_ROSTER.map((a) => (
            <div className="wf-agent" key={a.name}>
              <div className="wf-agent-head">
                <span className="wf-agent-name">{a.name}</span>
                <span className="wf-agent-label">{a.label}</span>
              </div>
              <div className="wf-agent-chips">
                {a.prompt && <span className="wf-chip wf-chip--mono">{a.prompt}</span>}
                {a.forms.map((f) => (
                  <span key={f} className="wf-chip">{f}</span>
                ))}
              </div>
              <span className="wf-agent-driven">
                由谁驱动　<b>{a.drivenBy}</b>
              </span>
              <p className="wf-agent-note">
                <Emphasis text={a.note} />
              </p>
            </div>
          ))}
        </div>

        <h3>
          会话后缀不增加 Agent 数
          <Hint label="会话后缀说明">
            <p>
              同一个 Agent 会有多个 ACP 会话，用后缀区分。后缀只影响
              <strong>会话隔离与思考开关</strong>，不新增进程、prompt 文件或工具表——
              归一规则见 <code>acp-client/agent-prompt.ts</code> 的 <code>canonicalAgent()</code>。
            </p>
          </Hint>
        </h3>
        <table className="wf-table">
          <thead>
            <tr>
              <th>后缀</th>
              <th>用在哪</th>
              <th>思考</th>
            </tr>
          </thead>
          <tbody>
            {SESSION_SUFFIXES.map((s) => (
              <tr key={s.suffix}>
                <td>
                  <span className="wf-agent-name">{s.suffix}</span>
                </td>
                <td className="wf-note">{s.use}</td>
                <td className="wf-note">{s.thinking}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}
