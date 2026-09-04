/**
 * 三张图共用的画法与坐标（施工单 M9-02；M25 追加唤醒入口那张）。
 *
 * # 为什么单独一个模块
 *
 * 会话页的逐轮流经图与演示大屏的实时流经图都要**画同一张主链路**。
 * 各自再拼一份坐标与配色，很快就会变成三种视觉语言——读者要学三遍，
 * 而且其中两份会悄悄漂掉（这一页刚因为同类毛病返工过）。
 *
 * # 手写坐标而不是自动布局
 *
 * 自动布局会在每次加节点时把整张图重排，读者上次记住的位置全没了；
 * 而这张图的读者是反复来核对同一处结构的人。**位置稳定比排得漂亮重要。**
 */

import { MarkerType, Position, type Edge, type Node } from "reactflow";

import type { NodeKind, WorkflowEdge, WorkflowNode } from "./graph-model";

/** 颜色只区分**职责类别**，不区分具体节点——一屏十几种颜色等于没有颜色。 */
export const KIND_STYLE: Record<NodeKind, { background: string; color: string }> = {
  entry: { background: "#1f2328", color: "#fff" },
  orchestration: { background: "#0969da", color: "#fff" },
  agent: { background: "#8250df", color: "#fff" },
  // 直连模型与 pi Agent **必须分色**：两者都"是个模型在说话"，
  // 但一个有工具表、有 prompt 文件、有独立进程，另一个什么都没有。
  // 同色会让人以为 -voice 那条路也能调工具，而它连查一次天气都做不到。
  llm: { background: "#6e40c9", color: "#fff" },
  guard: { background: "#cf222e", color: "#fff" },
  tool: { background: "#1a7f37", color: "#fff" },
  sidecar: { background: "#bf8700", color: "#fff" },
  exit: { background: "#1f2328", color: "#fff" },
};

export interface Point {
  x: number;
  y: number;
}

/** 边标签的世界坐标布局：偏移会随 React Flow 缩放一起缩放。 */
export interface EdgeLabelLayout {
  offsetX: number;
  offsetY: number;
  lines: readonly string[];
}

export interface FlowEdgeData {
  labelLayout?: EdgeLabelLayout;
}

/**
 * 把长标签拆成适合 SVG 多行显示的短行。
 *
 * 斜杠和双竖线是工具/并行语义的分隔符，保留在上一行末尾，读者仍能看出
 * 每个工具名属于同一组；没有结构化分隔符的短中文标签保持单行。
 */
export function splitEdgeLabel(label: string | undefined): readonly string[] {
  if (!label) return [];
  const normalized = label
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (!normalized) return [];
  const existingLines = normalized.split("\n");
  if (existingLines.length > 1) return existingLines;

  const parts = normalized.split(/\s*(\/|‖)\s*/);
  if (parts.length < 3 || normalized.length <= 12) return [normalized];

  const lines: string[] = [];
  let current = "";
  for (const part of parts) {
    if (!part) continue;
    if (part === "/" || part === "‖") {
      current = `${current.trim()} ${part}`.trim();
      lines.push(current);
      current = "";
    } else {
      current = current ? `${current} ${part}` : part;
    }
  }
  if (current) lines.push(current.trim());
  return lines.length > 1 ? lines : [normalized];
}

/**
 * 主链路坐标。
 *
 * `riskGate` 与 `dispatch` 之间刻意留了 190px：那一段上要落两条条件边的标签
 * （"硬禁：拒绝话术直接下发" / "其余"），挤在一起时图上只剩"有两条边"，
 * 看不出**哪条通向哪**——而那正是这道门的全部内容。
 *
 * 同理 `dispatch` 与分支列之间的 320px 是给六条路由标签的，不是留白。
 */
export const POS: Record<string, Point> = {
  start: { x: 0, y: 300 },
  // 200 而不是 150：方框统一 170 宽，150 时它与 START 压掉 20px
  // ——这一处从 M9-02 一直叠到现在，只是 START 那两个字太短所以没人看出来。
  understand: { x: 200, y: 300 },
  /*
   * 抽取会话**夹在 understand 与 riskGate 中间**，不是吊在下游节点正上方。
   *
   * 它有进有出（进：发起抽取；出：四要素回图状态供风险门与路由取用）。
   * 吊在正上方时两条边里必有一条要往回绕——而这张图上只有"往右"是前进，
   * 一条回绕的边读起来就像有个环，得盯半天才确认没有。
   */
  "supervisor-intent": { x: 355, y: 130 },
  riskGate: { x: 520, y: 300 },
  // 硬禁那一支就地收口，不画一条横跨全图连回右端 END 的边（见 deny-end 的说明）。
  "deny-end": { x: 880, y: 480 },
  dispatch: { x: 880, y: 300 },
  // 五个路由分支排一列，出行在最上——它是唯一还会继续 fan-out 的那个。
  itineraryPlan: { x: 1200, y: 30 },
  ownershipDual: { x: 1200, y: 300 },
  buyingCatalog: { x: 1200, y: 390 },
  testDriveFlow: { x: 1200, y: 480 },
  cabinCompanion: { x: 1200, y: 570 },
  /*
   * 副 lane 节点（ACR-023）排在主分支列右侧同一高度区间：它们与主分支**同 superstep 并行**，
   * 画在同一带上才读得出"并排跑"；不进 -task 那一列（那是行程 fan-out 的五支）。
   */
  sideItineraryPlan: { x: 1440, y: 300 },
  sideOwnershipDual: { x: 1440, y: 380 },
  sideBuyingCatalog: { x: 1440, y: 460 },
  sideTestDriveFlow: { x: 1440, y: 540 },
  sideCabinCompanion: { x: 1440, y: 620 },
  // 出行的五条分支贴着 itineraryPlan 右侧展开。
  "drive-task": { x: 1470, y: -70 },
  "hotel-task": { x: 1470, y: 0 },
  "tour-task": { x: 1470, y: 70 },
  "transit-task": { x: 1470, y: 140 },
  "ownership-task": { x: 1470, y: 210 },
  /*
   * 座舱的单支分支排在右下角的空档里，**不进 -task 那一列**：
   * 那一列是出行 fan-out 的五支，混进去会读成"座舱也是并行分支之一"。
   */
  "cabin-task": { x: 1690, y: 620 },
  /*
   * 工具层与权限门排在分支列**正下方**，不排在它右侧。
   *
   * 放右侧时它们正好压在"分支 → 应答"那条主干上：九条汇聚边要绕过两个方框，
   * 边标签叠成一团，而这张图最该一眼看清的恰恰是主干。
   */
  tools: { x: 1220, y: 760 },
  guard: { x: 1490, y: 760 },
  // 汇合点在主副两列之后、应答之前；应答与它的两种说法整体右移一格。
  join: { x: 1670, y: 300 },
  answer: { x: 1900, y: 300 },
  // 应答的两种说法上下分开，END 仍在中线上——它才是图的终点。
  narrator: { x: 2140, y: 150 },
  "answer-agent": { x: 2140, y: 430 },
  end: { x: 2380, y: 300 },
  /*
   * HTTP 触发的两条子图排在**左下角**，与 START 同一列、在硬禁收口的下方：
   * 它们与主链路没有任何一条边相连（validateGraph 断言从 START 不可达），
   * 摆在分支列旁边会读成"路由的第七个去向"。左下角的空档正好够两条子图，
   * 右边止于 790，离 dispatch（880）还有一段，不与硬禁收口那条边打架。
   */
  "entry-http": { x: 0, y: 620 },
  navPlan: { x: 340, y: 560 },
  "nav-task": { x: 620, y: 560 },
  guideBrief: { x: 340, y: 760 },
  "guide-access-task": { x: 620, y: 690 },
  "guide-spots-task": { x: 620, y: 760 },
  "guide-comfort-task": { x: 620, y: 830 },
};

/** 旁路那张图：一条线，没有分支路由，所以排成横的一串。 */
export const SIDECAR_POS: Record<string, Point> = {
  turn: { x: 0, y: 60 },
  spanSink: { x: 0, y: 210 },
  pair: { x: 250, y: 135 },
  silence: { x: 480, y: 135 },
  l0: { x: 710, y: 45 },
  l1: { x: 710, y: 225 },
  outputGuard: { x: 940, y: 135 },
  filler: { x: 1170, y: 135 },
};

/**
 * 唤醒入口：采集到判定是一条直线，判定之后四散。
 *
 * `windows` 与 `dismiss` 一上一下**离中线远一点**是有原因的：
 * `classify → handoff`（带指令直达）那条要横穿这一段，
 * 它们贴着中线时那条主干就被压住了，而"一句直达"正是这张图要讲的事。
 */
export const WAKE_POS: Record<string, Point> = {
  micSwitch: { x: 0, y: 140 },
  ptt: { x: 0, y: 320 },
  capture: { x: 230, y: 140 },
  vad: { x: 460, y: 140 },
  ttsMute: { x: 690, y: 140 },
  transcribeOnly: { x: 920, y: 140 },
  classify: { x: 1150, y: 140 },
  windows: { x: 1400, y: -40 },
  dismiss: { x: 1400, y: 420 },
  handoff: { x: 1680, y: 140 },
  discard: { x: 1680, y: 340 },
};

/** 把一整张图的坐标整体平移——总链路复用细节图的排布，不另抄一份。 */
function shift(pos: Record<string, Point>, dx: number, dy: number): Record<string, Point> {
  return Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, { x: v.x + dx, y: v.y + dy }]));
}

/**
 * 总链路：主链路照原样摆在中带，旁路整条压在它下面，两条跨链路各自贴边。
 *
 * # 坐标也是组合出来的
 *
 * `shift(POS, …)` / `shift(SIDECAR_POS, …)` —— 细节图调了位置，总图跟着动，
 * 不会出现"总图上的分支列还停在旧位置"。手抄一份坐标与手抄一份节点是同一个毛病。
 *
 * # 为什么旁路压在下面而不是并排
 *
 * 旁路与主链路在时间上**完全重叠**（它并行于整个 turn）。左右并排会读成
 * "先主链路后旁路"；上下叠放才读得出"同时在跑"，而那正是这张图要讲的第一件事。
 */
const MAIN_DX = 700;
const SIDECAR_DY = 1150;

export const TOTAL_POS: Record<string, Point> = {
  // 进图之前：入口与网关在最左。
  "entry-voice": { x: 0, y: 120 },
  "entry-touch": { x: 0, y: 300 },
  gw: { x: 250, y: 210 },
  // 主链路整体右移，给上面那三个让位。
  ...shift(POS, MAIN_DX, 0),
  // 旁路整条压在主链路下面；`turn` 与 `spanSink` 是共享设施，单独摆到主链路左侧，
  // 因为轮次边界在图执行**之前**（registerPair 在 run() 里，invoke 之前）。
  ...shift(SIDECAR_POS, MAIN_DX + 200, SIDECAR_DY),
  turn: { x: 480, y: 480 },
  spanSink: { x: 480, y: 700 },
  /*
   * 收口的三个**竖着叠**而不是横着排。
   *
   * 横排时它们给整张图又加了 1200px 宽，而这张图的可读性瓶颈正是宽高比：
   * 容器不到 1000px 宽，图每宽 1000px，默认缩放就掉一档。
   * 竖排后三个都落在同一列，宽度只多 500px。
   */
  toolProgress: { x: 3300, y: 640 },
  titlePath: { x: 3300, y: 100 },
  client: { x: 3560, y: 370 },
  console: { x: 1400, y: 1000 },
};

/**
 * 连接点。默认是"上进下出"（竖排图的约定），而这些图是横排的——
 * 不改的话每条边都要先向下绕再折回来，二十多条边一起绕就是一团麻。
 *
 * 只有工具层与权限门例外：它们在分支列**正下方**，边本来就是从上方落下来的。
 */
export const HANDLES: Record<string, Position> = { tools: Position.Top, guard: Position.Top };

type LabelLaneGroup =
  | "tools"
  | "guard"
  | "answer"
  | "answer-output"
  | "dispatch-bypass"
  | "cabin";

interface LabelLaneMember {
  index: number;
  edge: WorkflowEdge;
  group: LabelLaneGroup;
}

const TOOL_LABEL_X_OFFSET = 96;
const TOOL_LABEL_LANE_SPACING = 40;
const GUARD_LABEL_LANE_SPACING = 28;
const ANSWER_LABEL_LANE_SPACING = 28;
const ANSWER_LABEL_Y_BIAS = 10;
const DISPATCH_BYPASS_X_OFFSET = 48;
const CABIN_TOOL_LABEL_Y_OFFSET = 56;
const CABIN_TASK_LABEL_Y_OFFSET = -100;
const DIRECT_GUARD_LABEL_X_OFFSET = 120;
const TOOLS_GUARD_LABEL_Y_OFFSET = -62;
const ITINERARY_GUARD_LABEL_Y_OFFSET = 1;
const TEST_DRIVE_GUARD_LABEL_X_OFFSET = 40;
const TEST_DRIVE_GUARD_LABEL_Y_OFFSET = 90;
const ITINERARY_ANSWER_LABEL_X_OFFSET = -135;
const ANSWER_AGENT_LABEL_Y_OFFSET = -4;

function labelLaneGroup(edge: WorkflowEdge): LabelLaneGroup | undefined {
  if (edge.to === "tools") return "tools";
  if (edge.to === "guard") return "guard";
  // 汇合走廊：主分支节点 → join（ACR-023 之前它们直连 answer；lane 的语义通道不变，只是终点换成 join）。
  if (
    edge.to === "join" &&
    [
      "itineraryPlan",
      "ownershipDual",
      "buyingCatalog",
      "testDriveFlow",
      "cabinCompanion",
    ].includes(edge.from)
  ) {
    return "answer";
  }
  if (edge.from === "dispatch" && edge.to === "answer") {
    return "dispatch-bypass";
  }
  if (edge.to === "cabin-task") return "cabin";
  if (edge.from === "answer") return "answer-output";
  return undefined;
}

function laneOffset(position: number, count: number, spacing: number): number {
  return (position - (count - 1) / 2) * spacing;
}

/**
 * 为边标签按拓扑走廊分道，避免把标签从它所描述的边上推走。
 *
 * React Flow 的默认标签都在路径中心，工具/权限/应答汇聚时自然会堆在同一
 * 条走廊。这里仅对这些有明确语义的汇聚组分配有限 lane；普通短路由标签
 * 保持原位。偏移是世界坐标，缩放时与流程图同步，不依赖当前视口像素。
 */
export function planEdgeLabelLayouts(
  defs: readonly WorkflowEdge[],
): Map<number, EdgeLabelLayout> {
  const groups = new Map<LabelLaneGroup, LabelLaneMember[]>();
  defs.forEach((edge, index) => {
    if (!edge.label) return;
    const group = labelLaneGroup(edge);
    if (!group) return;
    const members = groups.get(group) ?? [];
    members.push({ index, edge, group });
    groups.set(group, members);
  });

  const result = new Map<number, EdgeLabelLayout>();
  for (const members of groups.values()) {
    // 定义顺序本身就是稳定的语义顺序；不要依赖运行时事件到达顺序。
    members.forEach((member, position) => {
      const lines = splitEdgeLabel(member.edge.label);
      const spacing = member.group === "tools"
        ? TOOL_LABEL_LANE_SPACING
        : member.group === "guard" || member.group === "answer-output"
          ? GUARD_LABEL_LANE_SPACING
          : ANSWER_LABEL_LANE_SPACING;
      const offsetY = laneOffset(position, members.length, spacing);
      let offsetX = member.group === "tools"
        ? TOOL_LABEL_X_OFFSET
        : member.group === "dispatch-bypass"
          ? DISPATCH_BYPASS_X_OFFSET
          : 0;
      let adjustedOffsetY = offsetY + (member.group === "answer" ? ANSWER_LABEL_Y_BIAS : 0);

      // 这些是同一走廊里仍会相交的两条短边：给它们留出固定的阅读槽，
      // 但偏移保持在有限范围内，避免标签脱离所描述的连线。
      if (member.edge.from === "cabinCompanion" && member.edge.to === "tools") {
        adjustedOffsetY = CABIN_TOOL_LABEL_Y_OFFSET;
      }
      if (member.edge.from === "cabinCompanion" && member.edge.to === "cabin-task") {
        adjustedOffsetY = CABIN_TASK_LABEL_Y_OFFSET;
      }
      if (member.group === "guard" && member.edge.from === "tools") {
        adjustedOffsetY = TOOLS_GUARD_LABEL_Y_OFFSET;
        offsetX = DIRECT_GUARD_LABEL_X_OFFSET;
      }
      if (member.group === "guard" && member.edge.from === "itineraryPlan") {
        adjustedOffsetY = ITINERARY_GUARD_LABEL_Y_OFFSET;
      }
      if (member.group === "guard" && member.edge.from === "ownershipDual") {
        offsetX = DIRECT_GUARD_LABEL_X_OFFSET;
      }
      if (member.group === "guard" && member.edge.from === "testDriveFlow") {
        offsetX = TEST_DRIVE_GUARD_LABEL_X_OFFSET;
        adjustedOffsetY = TEST_DRIVE_GUARD_LABEL_Y_OFFSET;
      }
      if (member.group === "answer" && member.edge.from === "itineraryPlan") {
        offsetX = ITINERARY_ANSWER_LABEL_X_OFFSET;
      }
      if (member.group === "answer-output" && member.edge.to === "answer-agent") {
        adjustedOffsetY = ANSWER_AGENT_LABEL_Y_OFFSET;
      }
      result.set(member.index, {
        offsetX,
        offsetY: adjustedOffsetY,
        lines,
      });
    });
  }
  return result;
}

/** 三张图共用同一套画法——分开写迟早变成三种视觉语言，读者要学三遍。 */
export function toNodes(
  defs: readonly WorkflowNode[],
  pos: Record<string, Point>,
  /** 运行时投影：给每个方框叠一层"这一轮走没走到"。不传即纯结构图。
      `pulse` = 此刻停在这里的呼吸辉光（只给 current 节点，动效参数见 demo/design-spec.md）。 */
  decorate?: (n: WorkflowNode) => { dim?: boolean; accent?: string; suffix?: string; pulse?: boolean } | undefined,
): Node[] {
  return defs.map((n) => {
    const d = decorate?.(n);
    const nodeClassName = [
      d?.dim ? "flow-node-dim" : undefined,
      d?.pulse ? "flow-node-pulse" : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      id: n.id,
      position: pos[n.id] ?? { x: 0, y: 0 },
      className: nodeClassName || undefined,
      data: { label: d?.suffix ? `${n.label}\n${d.suffix}` : n.label },
      sourcePosition: Position.Right,
      targetPosition: HANDLES[n.id] ?? Position.Left,
      style: {
        ...KIND_STYLE[n.kind],
        // 虚线框 = 不是 StateGraph 的一步（fan-out 分支 / 工具层 / 权限门）。
        // 它们发生在节点体内部——画成实线会让人以为 LangGraph 会路由到权限门，
        // 或者去找那个并不存在的 addNode("drive-task")。
        border: d?.accent
          ? `2px solid ${d.accent}`
          : n.graphNode
            ? "none"
            : "2px dashed rgba(255,255,255,.65)",
        borderRadius: 8,
        padding: 10,
        fontSize: 12,
        whiteSpace: "pre-line",
        width: 170,
        // 没走到的方框压暗而不是删掉：**整张图必须还在**，
        // 否则读者看到的是"这一轮的路径"而不是"这一轮在整张图上的位置"。
        // 不用整体透明度：透明节点会让 Background 的点阵穿透，文字也会变成灰雾。
        opacity: 1,
      },
      // 只读：不可拖、不可连、不可删。
      draggable: false,
      connectable: false,
      deletable: false,
    };
  });
}

export function toEdges(
  defs: readonly WorkflowEdge[],
  prefix: string,
  /** `particle` = 光点沿边流动（只给"这一轮真正走过"且还在进行中的边——
      给没走的边加粒子与造假数据是同一类不实表述，见 demo/design-spec.md）。 */
  decorate?: (e: WorkflowEdge) => { dim?: boolean; accent?: string; particle?: boolean } | undefined,
): Edge[] {
  const labelLayouts = planEdgeLabelLayouts(defs);
  return defs.map((e, i) => {
    const d = decorate?.(e);
    const labelLayout = labelLayouts.get(i);
    return {
      id: `${prefix}${i}`,
      source: e.from,
      target: e.to,
      label: e.label,
      data: labelLayout ? { labelLayout } : undefined,
      // 正交折线而不是默认贝塞尔：二十多条边里有大量同起点的扇出，
      // 贝塞尔会让它们在起点附近糊成一片，折线至少能看出各自去了哪。
      // particle 类型只是"smoothstep + 一颗沿路径跑的光点"，画法完全一致（ParticleEdge）。
      type: d?.particle ? "particle" : "smoothstep",
      // 条件边虚线、并行边加粗——两者语义完全不同：
      // 条件边是"走这条或那条"，并行边是"两条同时走"。
      animated: e.parallel === true,
      style: {
        // 三种线必须一眼分得开（总链路图全靠这个）：
        //   点线 `2 3` = 只读旁观（看，但不影响被看的一方）
        //   虚线 `5 4` = 条件边（走这条**或**那条）
        //   实线      = 控制流
        strokeDasharray: e.readonly ? "2 3" : e.conditional ? "5 4" : undefined,
        strokeWidth: d?.accent ? 3 : e.parallel ? 2.5 : e.readonly ? 1.2 : 1.5,
        ...(d?.accent ? { stroke: d.accent } : {}),
        opacity: d?.dim ? 0.32 : 1,
      },
      // 标签压在边上就看不清了——给个不透明底衬。
      //
      // ⚠️ `labelStyle` 的字色必须显式给：reactflow 的默认边标签是深色字
      // （它假设浅色画布），而控制台是深色底——不给就是深色字压深色底，
      // 元素在 DOM 里、位置也对，**只是一个字都看不见**。
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      labelBgStyle: { fill: "var(--bg, #0f1115)", fillOpacity: 0.92 },
      labelStyle: { fill: "var(--fg, #e6e8ec)", fontSize: 11, opacity: d?.dim ? 0.65 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed },
    };
  });
}
