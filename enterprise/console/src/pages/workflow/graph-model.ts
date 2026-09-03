/**
 * Workflow 图的结构定义（施工单 M9-02，FL-29 F-29-01）。
 *
 * # 只读可视化，不做图编辑
 *
 * 编排定义在代码里（`enterprise/backend/agent-runtime/src/graph/`）。
 * 页面上能拖动改图会立刻产生"图上画的"与"实际跑的"两个真相源——
 * 而这套系统里"看起来对、实际不是"正是最危险的形态。
 *
 * # 结构与实际代码对齐，不是示意图
 *
 * 节点名、边、分支目标都取自实际的图定义。若两边不一致，
 * 这张图就成了误导——它会让人相信一个并不存在的架构。
 *
 * # 对齐基准（改图时先看这里）
 *
 * 本文件对齐 `graph/supervisor.ts` 的 `enableIntent` 装配分支
 * （`addNode` / `addEdge` 那一段）与 `graph/route.ts` 的 `branchFor`。
 *
 * 这份对齐**曾经是纯手工、没有任何守护的**，于是漂过两次：
 * 一次是 M13-13 摘掉 `tripFanout`、M15/M19 加了购车/试驾/座舱三个节点，
 * 而本文件停在 M5-05 那一版；第二次是 TD-09 加了 `riskGate`、M24 把座舱改成 A 型，
 * 而本文件停在 M19 那一版。两次 `validateGraph()` 都一条没报——
 * 它校验的是这张图**自身**的内部一致性，不和 `supervisor.ts` 比对。
 *
 * 所以现在有一条**会红的**守护：`enterprise/console/test/graph-drift.test.ts` 直接读
 * `supervisor.ts` 与 `route.ts` 的源码，把 `addNode(...)` 与 `branchFor` 的
 * `return` 值抽出来和本文件比。它进了 `check:all`——上一次漂就是因为
 * 这个包的测试几个 Sprint 没人跑。
 *
 * 然后它漂了**第三次**，而且这条守护一样没红：M36 加了景区导游三分支、M66 加了
 * 出发导航 `nav`，四个 Agent 都是 **HTTP 触发的子图**（点景点 / 点「开始行程」），
 * 自己登记一轮、直接 `runFanout`，**不经 `addNode`、不经 `branchFor`**——
 * 上面那条守护抽的正好是这两样，所以它们对它是不可见的。症状在大屏上：
 * 一轮导航规划画出来是一张全暗的图外加一行「轨迹里还有图上没有的节点：nav-task」。
 * 所以 `graph-drift.test.ts` 又加了一条：拿 `registry.ts` 的 `AgentName` 联合类型
 * 与 `AGENT_ROSTER` 比——Agent 的真相源在那里，不在图装配里。
 *
 * # 这里有四张图：一张总链路 + 三张细节
 *
 * 总链路（`TOTAL_*`）是把主链路与旁路**组合**起来的全量图——
 * `[...WORKFLOW_NODES, ...SIDECAR_NODES, ...BRIDGE_NODES]`，一个细节都不省。
 * 组合而不是重画：主链路加一个节点，总链路自动就有了，不存在"总图停在上个月"。
 *
 * 合成一张之后最大的风险是把"并行存在"读成"路由过去"，所以引入了第三种边语义：
 * **只读旁观**（`WorkflowEdge.readonly`，渲染成点线）。主链路的任何节点
 * **都没有一条指向旁路的实线**——这条与"细节图的每个节点都必须在总图上"
 * 一起由 `validateTotal()` 断言，不靠画图的人记得。
 *
 * 三张细节图：主链路（`WORKFLOW_*`）、旁路陪伴（`SIDECAR_*`）、
 * 语音唤醒入口（`WAKE_*`）。后两张都不在编排图上：
 *
 * - 旁路不是主链路上的一步，也不是第六个子 Agent（`check:arch` 的 `sidecar-isolation`
 *   就守着这条）：生命周期绑在 turn 上、只读订阅轨迹、够不着任何业务能力。
 *   塞进主图会让人以为编排层会"路由到旁路"——不会，它从头到尾并行存在。
 * - 唤醒整条发生在**进图之前**，全在车机端 Rust 侧。塞进主图会让人以为
 *   编排层看得见那些未命中就被丢弃的转写——看不见，那道闸在 `voice/mod.rs` 里。
 */

export type NodeKind =
  | "entry"
  | "orchestration"
  | "agent"
  | "llm"
  | "guard"
  | "tool"
  | "sidecar"
  | "exit";

export interface WorkflowNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** 对应的源码位置——让读图的人能去核对 */
  source?: string;
  note?: string;
  /**
   * 是否为 `StateGraph` 里的一步——`addNode` 的那个名字，或 `START` / `END`。
   *
   * 图上另有几个方框画的是**节点体内部发生的事**：出行的五条 fan-out 分支、
   * 工具层、动作权限门。它们画出来是因为"并行发生在哪一层""敏感动作在哪一步被拦下"
   * 正是这张图最该回答的问题，但混为一谈会让人以为 LangGraph 会路由到权限门——不会，
   * 也会让人以为分支是图节点，从而去找那个并不存在的 `addNode("drive-task")`。
   *
   * 渲染上以实线 / 虚线区分（见 index.tsx）。
   */
  graphNode?: boolean;
  /**
   * **不在 StateGraph 里，由 HTTP 端点直接调用的子图**（M36 导游采集、M66 出发导航）。
   *
   * 它们与"节点内"的方框（fan-out 分支 / 工具层 / 权限门）不是一回事：
   * 后者发生在某个图节点体内，前者根本不经 START → dispatch，
   * 而是网关收到一次点击后直接调 `runGuideBrief` / `runNavPlan`——自己登记一轮、
   * 自己 `runFanout`。画进主链路是因为大屏与会话页画的就是这张图，
   * 一轮导航规划的轨迹（`llm.nav-task`、`tool.map_route`）要有地方落；
   * 但 `validateGraph()` 断言它们**从 START 不可达**——可达了就是把"点击触发"
   * 画成了"聊天路由得到"，而那正是这类子图刻意不做的事。
   */
  viaHttp?: boolean;
  /**
   * **这个方框画在这张图上，但不归这张图所有**。
   *
   * 旁路那张图里的 `turn`（轮次边界，归 turn-runner）与 `spanSink`
   * （轨迹并列扇出，是主链路发出来的）都是这种：旁路把它们画进来当源头，
   * 但它们不是旁路的一部分。
   *
   * 分清楚这件事在单张细节图上无所谓，到了总链路图上是硬需求——
   * `validateTotal()` 要判"哪些边跨进/跨出旁路"，把共享设施算成旁路的话，
   * `turn → start`（图执行）会被判成"旁路伸手去碰主链路"，
   * 而那恰恰是这条断言要防的相反方向。
   */
  shared?: boolean;
  /**
   * 这个方框对应 `AGENT_ROSTER` 里的哪几个 Agent。
   *
   * 只在方框不是"一个 Agent"时才给：`answer-agent` 一个框代表六个业务 Agent
   * （路由到谁就用谁的会话）。其余 Agent 框由 id 去掉后缀就能对上清单，
   * 与 `canonicalAgent()` 同一规则。
   */
  rosterNames?: readonly string[];
}

export interface WorkflowEdge {
  from: string;
  to: string;
  label?: string;
  /** 条件边：只在满足条件时走 */
  conditional?: boolean;
  /** 并行分支的一支（§11 par 段） */
  parallel?: boolean;
  /**
   * **只读旁观**：被指向的一方在观察，但对被观察的一方零影响。
   *
   * 单独一种边而不是复用条件边或并行边，是这张总链路图能不能成立的关键。
   * 用普通箭头画"主链路 → 旁路"，读出来就是"编排层会路由到旁路"——
   * 而那正是三张细节图刻意分开画所要避免的那个误读。
   * 渲染成点线（见 layout.ts），与条件边的虚线区分得开。
   */
  readonly?: boolean;
}

/**
 * `dispatch` 的条件边目标。与 `route.ts` 的 `BranchNode` 一一对应。
 *
 * 单独列出来是为了能被 `validateGraph()` 断言：漏画一个分支的症状是
 * "图上没有这条路"，而那正好等同于"这个 Agent 不存在"——最难被发现的那种错。
 */
export const BRANCH_NODES = [
  "itineraryPlan",
  "ownershipDual",
  "buyingCatalog",
  "testDriveFlow",
  "cabinCompanion",
  "answer",
] as const;

// ── 总链路（全量：主链路 + 旁路 + 两条跨链路，一个都不省）──────

/**
 * 总链路 = **把已有的几张图组合起来**，不是另画一张。
 *
 * # 组合而不是重画，这是这张图能长期正确的唯一办法
 *
 * `TOTAL_NODES` 由 `WORKFLOW_NODES` / `SIDECAR_NODES` 展开而来，加上几个
 * 只在这里出现的连接点。所以主链路加一个节点，总链路**自动**就有了——
 * 不存在"总图停在上个月"这回事。本文件已经因为手工副本漂过两次
 * （见文件头），再开一份副本是明知故犯。
 *
 * `validateTotal()` 里那条"细节图的每个节点都必须在总图上"就是守这个的：
 * 哪天有人图省事把它改成手抄，那条会红。
 *
 * # 合成一张之后，最大的风险是把"并行存在"读成"路由过去"
 *
 * 所以边有三种语义，缺一不可：
 *
 * - **实线** = 控制流：A 触发 B，或 A 的产出流向 B；
 * - **点线**（`readonly`）= 只读旁观：B 在看 A，但对 A 零影响；
 * - **虚线**（`conditional`）= 有条件才发生。
 *
 * 主链路的任何一个节点**都没有一条指向旁路的实线**。旁路唯一的入口是
 * `spanSink → pair` 那条点线，唯一的出口是垫场话下行到端上。
 * `validateTotal()` 断言这两条，不靠画图的人记得该用哪种线。
 *
 * # 唯一被折叠的是语音唤醒入口
 *
 * 它整条发生在**进图之前**、全在车机端 Rust 侧，展开会再多 11 个方框、
 * 把图撑宽近一倍，而它与主链路的关系只有一句话："命中唤醒词才上行，
 * 之后走的路与打字、长按完全一样"。所以这里画成一个方框，细节在第 4 张。
 */

/**
 * 只在总链路上出现的连接点——它们不属于任何一张细节图。
 *
 * 前两条（标题旁路、工具进展）都是**做完了但细节图上没有**的链路：
 * 不是编排节点，各自画一张又太小。总链路正是它们该在的地方——
 * 在这里能看清"标题在 turn_end 之后才跑、且只跑首轮""工具进展从工具层旁出、
 * 不经应答节点"，而这两句话在任何一张细节图上都说不出来。
 */
export const BRIDGE_NODES: readonly WorkflowNode[] = [
  {
    id: "entry-voice",
    label: "语音唤醒入口\n（车机端 Rust，已折叠）",
    kind: "entry",
    source: "clients/cockpit/src-tauri/src/voice",
    note:
      "整条在进图之前。未命中唤醒词的转写就地丢弃，编排层看不见。" +
      "**这里折叠成一个方框**：展开是 11 个，而它与主链路的关系只有一句" +
      "「命中才上行，之后与打字、长按完全同路」。细节见第 4 张",
  },
  {
    id: "entry-touch",
    label: "打字 / 长按 PTT",
    kind: "entry",
    source: "clients/shared/ui/src/hooks/useAssistantInteraction.ts",
    note: "与唤醒后的指令**走完全同一条上行路径**——唤醒不是安检旁路",
  },
  {
    id: "gw",
    label: "网关\n协议转换 + 治理",
    kind: "orchestration",
    source: "enterprise/backend/gateway",
    note:
      "鉴权 / 限流 / 审计 / 多模态上传 / HITL 中转。**不含业务逻辑、不直接调 LLM 或工具**（§3）。" +
      "下行只用 SSE，不引入 WebSocket",
  },
  {
    id: "toolProgress",
    label: "工具进展下行\n正在查天气…",
    kind: "orchestration",
    source: "enterprise/backend/agent-runtime/src/events/tool-display.ts",
    note:
      "F-08-05。**从工具层旁出，不经应答节点**——它填的是等待期的事实，" +
      "垫场话填的是气氛，两条并存。产在 `invokeTool` 而不是 ACP 的 tool_call update：" +
      "后者只覆盖模型自己发起的调用，图节点直调那一半场景仍会空白",
  },
  {
    id: "titlePath",
    label: "会话标题旁路\n仅首轮，一次性",
    kind: "llm",
    source: "enterprise/backend/agent-runtime/src/title",
    note:
      "M28-01。**turn_end 之后**由网关 fire-and-forget 触发——挂进图里等于让每轮多判一次，" +
      "还要担「这一跳失败拖垮这一轮」，而它的约束恰恰相反：**失败必须无声**。" +
      "不走 pi/ACP、钉死非推理模型（给 15 字的名字起子进程装工具表是错的档位）",
  },
  {
    id: "client",
    label: "端上\nHUD / 对话层",
    kind: "exit",
    source: "apps",
    note:
      "四条链路最终都汇到这里，但**进历史的只有正文**：垫场话、工具进展、标题" +
      "都不进对话缓存（`fanout::project` 不碰 `acc`），也不进网关的补发窗口",
  },
  {
    id: "console",
    label: "运营控制台 / 大屏",
    kind: "exit",
    source: "enterprise/console",
    note: "轨迹落库供回放，实时总线供大屏。**只读**——控制台拿不到任何执行句柄",
  },
];

/** 跨链路的边——两张细节图内部的边由它们自己带过来。 */
export const BRIDGE_EDGES: readonly WorkflowEdge[] = [
  { from: "entry-voice", to: "gw", label: "命中唤醒词才上行", conditional: true },
  { from: "entry-touch", to: "gw" },
  /*
   * 网关打进来的是**一轮**，不是直接进图：`TurnRunner.run()` 先解析 thread、
   * 过输入内容管线、登记旁路，才 invoke 图。旁路的生命周期绑在这一层，
   * 不在图那一层——这正是"它不是图上的一步"的物理形态。
   */
  { from: "gw", to: "turn", label: "POST /messages" },
  { from: "turn", to: "start", label: "图执行" },
  /*
   * 点击触发的子图**不建轮**：网关收到「开始行程」/ 点景点，直接调 runtime 的
   * `/internal/trip/nav-plan` / `/internal/guide/brief`，不经 TurnRunner、没有旁路、
   * 没有内容管线的输入那一道（进分支的提示词全是代码拼的，不含用户原话）。
   */
  { from: "gw", to: "entry-http", label: "点击（不建轮，直接调子图）", conditional: true },
  /*
   * **本轮全部 span 并列扇出**，不是"某个节点发的"：`withNodeSpan` 包住每个
   * 图节点，工具/LLM/ACP 各自也发。从 `turn` 引这一条，因为轮次才是它们的作用域——
   * 从某个具体节点引会读成"只有那一步在发"。
   */
  { from: "turn", to: "spanSink", label: "本轮全部 span 并列扇出" },
  { from: "spanSink", to: "console", label: "落库供回放 + 实时总线供大屏" },
  { from: "tools", to: "toolProgress", label: "每次调用的起止" },
  { from: "toolProgress", to: "client", label: "SSE tool_call（不进历史）" },
  { from: "filler", to: "client", label: "SSE filler（不进历史、不留痕）" },
  {
    from: "end",
    to: "client",
    label: "本轮事件流（delta 在应答期间就在流，turn_end 收口）",
  },
  {
    from: "end",
    to: "titlePath",
    label: "turn_end 后由网关触发（仅首轮）",
    conditional: true,
  },
  { from: "titlePath", to: "client", label: "SSE update/title" },
];

/**
 * 与 `graph/supervisor.ts` 的实际图一一对应（图节点集自 M24 未变；节点语义随 M26/M28 更新），
 * 外加末尾**HTTP 触发的两条子图**（M36 导游采集、M66 出发导航）——它们不是图节点，
 * 与 START 之间没有任何一条边（`validateGraph()` 断言），画在这里只因为大屏与会话页画的就是这张图。
 */
export const WORKFLOW_NODES: readonly WorkflowNode[] = [
  { id: "start", label: "START", kind: "entry", graphNode: true },
  {
    id: "understand",
    label: "意图理解\n（四要素）",
    kind: "orchestration",
    graphNode: true,
    source: "graph/supervisor.ts intentNode",
    note:
      "抽 goal / constraints / when / …；不下发 token。" +
      "关掉意图节点时 START 直接进 dispatch，规则匹配改吃用户原文",
  },
  {
    id: "supervisor-intent",
    label: "Supervisor Agent\n-intent 会话",
    kind: "agent",
    source: "pi-agents/prompts/supervisor.md",
    note:
      "**必须与应答会话分开**：共用一个会话时，模型刚被要求输出四要素 JSON，" +
      "紧接着的应答就继续输出 JSON，用户看到的回答是一段 {\"goal\":…}。" +
      "走查时 6 次里出现 1 次，按 Agent 分进程后变必现。思考关闭（产出只被代码解析）",
  },
  {
    id: "riskGate",
    label: "风险边界门\n（硬禁四类）",
    kind: "guard",
    graphNode: true,
    source: "graph/supervisor.ts riskGateNode",
    note:
      "**它是图上唯一一条不经应答就收口的路**：判 deny 时直接下发拒绝话术进 END——" +
      "走 answer 等于为一句常量再开一次 LLM，并且给了模型改写这句话的机会。" +
      "判定读 `intent.riskCategory`（模型给的），所以模型抽风时这道门会失效，" +
      "`unknown` 要吵出来；兜底仍是工具权限门与内容管线。" +
      "M24 加了**单向平反**：只把 vehicle-control 的「拒」改成「放」（命中舒适域设备词且不命中安全域正则），" +
      "永远不能反过来——座舱指令天然长得像车辆控制，假阳性从舒适域打通那天起就是高频问题",
  },
  {
    id: "deny-end",
    label: "END\n（硬禁收口）",
    kind: "exit",
    graphNode: true,
    note:
      "**这是同一个 END 的第二次出现**，不是第二个终点——" +
      "`addConditionalEdges(\"riskGate\", … ? END : \"dispatch\")` 的那一支。" +
      "画成一条横跨全图连回右端的边会正好压住主干（它要穿过 dispatch 与整列分支），" +
      "所以在这里就地收口",
  },
  {
    id: "dispatch",
    label: "路由\n（规则决策）",
    kind: "orchestration",
    graphNode: true,
    source: "graph/route.ts branchFor",
    note:
      "规则不问模型——编排决策在图，语言理解在 Agent。" +
      "映射单独导出是为了能被断言：它当过图装配里的一个闭包，" +
      "而 service 漏接 ownershipDual 时售后拿不到 repair-kb 任何内容，回答却看起来完全正常",
  },
  {
    id: "itineraryPlan",
    label: "行程规划\n四专家 fan-out + 代码汇聚",
    kind: "orchestration",
    graphNode: true,
    source: "graph/subgraphs/itinerary.ts runItineraryFanout",
    note:
      "出行一律进这里（M13-13 起路由不再区分单程与多天，旧的 tripFanout 节点已从图里摘除）。" +
      "骨架轮四支全跑，细化轮只跑诉求指到的那支；" +
      "确认 / 取消不跑 fan-out，直接走权限门 → trip_plan_commit",
  },
  {
    id: "drive-task",
    label: "自驾分支 Agent",
    kind: "agent",
    source: "graph/fanout.ts + itinerary.ts branchPrompt",
  },
  { id: "hotel-task", label: "住宿分支 Agent", kind: "agent", source: "itinerary.ts branchPrompt" },
  { id: "tour-task", label: "游玩分支 Agent", kind: "agent", source: "itinerary.ts branchPrompt" },
  { id: "transit-task", label: "大交通分支 Agent", kind: "agent", source: "itinerary.ts branchPrompt" },
  {
    id: "ownership-task",
    label: "用车助手 Agent\n（续航 / 补能）",
    kind: "agent",
    source: "graph/energy.ts energyBranchPrompt",
    note:
      "续航评估是用车助手的活（§4.3②），由编排层并行驱动——不是出行分支去问它。" +
      "只在骨架轮跑；提示词按能源类型三分（含「不知道」那一档），" +
      "两条链路共用同一个函数，各写一份就会重演「给燃油车算续航」",
  },
  {
    id: "ownershipDual",
    label: "双路并发检索\nRAG × ⑥用车数据",
    kind: "orchestration",
    graphNode: true,
    source: "graph/subgraphs/ownership.ts runOwnershipDualPath",
    note:
      "做成节点不是两个工具：交给模型自己选，它调一路就敢下结论。" +
      "personalized 由代码判定，少一路即降级。售后与用车共用这一条，只换知识库",
  },
  {
    id: "buyingCatalog",
    label: "购车车型检索\n+ 成本 / 保费测算",
    kind: "orchestration",
    graphNode: true,
    source: "graph/subgraphs/buying.ts runCatalogRetrieval",
    note:
      "刻意**不复用双路**：购车阶段这辆车还不存在，硬套只会多出一句「未能读取你的用车数据」。" +
      "也不传 vehicleModel——「哪款好」必须跨车型看。" +
      "测算由代码发起：应答提示词写着「不要另行推算」，指望模型自己调 cost_calc 是跟这句话对着干",
  },
  {
    id: "testDriveFlow",
    label: "试驾预约\n多步引导 + 下单",
    kind: "orchestration",
    graphNode: true,
    source: "graph/subgraphs/test-drive.ts runTestDrive",
    note:
      "与购车的单路检索不是一件事：这里是多步引导 + 有副作用的下单。" +
      "「第二家」这类指代由代码消解——让模型记 storeId，出错的方式不是记不住，" +
      "是记成另一家店然后真把单下了，而链路看起来完全正常",
  },
  {
    id: "cabinCompanion",
    label: "座舱\n预取事实 + 发一次 cabin-task",
    kind: "orchestration",
    graphNode: true,
    source: "graph/supervisor.ts cabinNode（M24 全面 A 型）",
    note:
      "**这里不再判断车主说了什么**。从前它是个五分支的迷你路由器（等确认 / 登记 / 乘坐声明 / 设置指令 / 陪聊），" +
      "每一支都用正则理解人话——而它上面已经有一个 LLM 路由器了。真跑当天就打脸两支：" +
      "登记正则没有 `ambientBrightness` 字段，「氛围灯调暗一点」掉进即时指令；" +
      "没有设备词的「我妈上车喜欢安静点」掉进陪聊。判错的姿势都是**静默丢功能**。" +
      "现在只做一件事：把已知事实整理好发一次 `cabin-task`，是登记、是设置、是按人调好还是纯聊由模型自己判。" +
      "预取能力表与人员名单**不违反 A 型**：编排层准备事实，模型决定动作（与行程预取 energyFact 同形态）",
  },
  {
    id: "cabin-task",
    label: "座舱分支 Agent\n（A 型：自己选工具填参数）",
    kind: "agent",
    source: "supervisor.ts cabinTaskPrompt + prompts/cabin.md",
    note:
      "**单支 fan-out，不是并行**——发一次 `session/prompt` 收结构化结果。" +
      "敏感工具（`cabin_child_mode` 等）由 tools-endpoint 按 `reg.sensitive` 自动接管权限门，" +
      "不再由子图自己 check。分支失败才退兜底正则，而**兜底只覆盖即时指令**：" +
      "登记与按人调好宁可如实说「这次没处理成」，也不让正则猜一个动作去写用户家人的档案",
  },
  {
    id: "answer",
    label: "应答\n（流式）",
    kind: "orchestration",
    graphNode: true,
    source: "graph/supervisor.ts answerNode",
    note:
      "唯一下发 token 的节点。求解已在各分支做完，这里只负责把结果说成人话。" +
      "**六个业务 Agent 的 pi 会话就挂在这一步**——不在它们各自的编排节点上，" +
      "那些节点做的是检索与求解。" +
      "M26 起它还是**事实补录询问**的落点（§4.6，graph/elicitation.ts）：" +
      "正文非空时在末尾搭便车追加**至多一个**提问，fail-open——不答照常做、只降级并说明。" +
      "车主的口头回答由 elicitation/extract.ts 用模型抽取（理解交给模型，写不写由编排层定）",
  },
  {
    id: "narrator",
    label: "-voice 直连表述\n无工具、不经 ACP",
    kind: "llm",
    source: "graph/supervisor.ts narrator（TD-08 第三步）",
    note:
      "判据是「有没有求解结果」，不是「路由到了哪个 Agent」。" +
      "**Boolean(solved) 不够**：describeMerged 恒定输出一行能源类型，出行路由下它永远为真——" +
      "两条分支双双超时时表述路径照样接管，2 秒交出一份逐条报「没拿到」的答案。" +
      "所以再加一道 !solverDegraded",
  },
  {
    id: "answer-agent",
    label: "业务 Agent\nACP 应答会话",
    kind: "agent",
    rosterNames: ["trip", "ownership", "service", "buying", "test-drive", "cabin"],
    source: "pi-agents/prompts/{trip,ownership,service,buying,test-drive,cabin}.md",
    note:
      "ANSWER_AGENTS 六选一，itinerary 复用 trip 的会话（四个专家都是 -task 型、" +
      "没有面向车主的人设，不为此多养一个进程）。" +
      "**漏加一个新 Agent 就会退回 supervisor 会话**，而那个会话刚做完意图抽取",
  },
  {
    id: "guard",
    label: "动作权限门\n/internal/guard/check",
    kind: "guard",
    source: "guard/http-endpoint.ts",
    note:
      "不是图节点。硬禁自动拒、需确认则 interrupt() 挂起等 resume。" +
      "两条进入路径：pi 调敏感工具时经 tools-endpoint，" +
      "图节点直调工具时**子图自己 check**——漏了就是「无确认下单」。" +
      "它问的是**授权**（fail-closed，不答不做）；系统里另一种「停下来问用户」" +
      "是 answer 末尾的事实补录（§4.6，fail-open）——两者别接混：" +
      "接混的后果是「你不肯说油量，所以我不给你规划行程」",
  },
  {
    id: "tools",
    label: "工具层",
    kind: "tool",
    source: "enterprise/backend/shared/tools",
    note: "不是图节点。只读工具跳过权限门",
  },
  { id: "end", label: "END", kind: "exit", graphNode: true },

  // ── HTTP 触发的子图：不经 START → dispatch，网关收到一次点击就直接调 ──
  {
    id: "entry-http",
    label: "HTTP 触发\n点「开始行程」/ 点景点",
    kind: "entry",
    viaHttp: true,
    source: "server.ts /internal/trip/nav-plan · /internal/guide/brief",
    note:
      "**不是聊天，没有轮次**：网关收到端上的一次点击，直接调子图函数。" +
      "子图自己 `registerTurnSink` 登记一轮（会话 id 形如 `nav-xxxx` / `guide-xxxx`），" +
      "只为让 tools-endpoint 的 `currentTurnId` 有值——提交通道与候选白名单都按它归轮。" +
      "这条路上没有意图理解、没有风险门、没有路由：策略与约束在进分支之前就由代码定好",
  },
  {
    id: "navPlan",
    label: "出发导航规划\n代码定策略 + 单支 nav-task",
    kind: "orchestration",
    viaHttp: true,
    source: "graph/subgraphs/nav-plan.ts runNavPlan",
    note:
      "M66-02。走高速还是省道由 `route-preference.ts` 按③偏好判，单段最多开多久由 `nav-constraints.ts` " +
      "按常用人员的 needs 推——**模型的活只剩一件**：调 `map_route`、从它返回的休息点候选里挑、经 `submit_nav_plan` 交回。" +
      "汇聚在代码里：途经点零信任（必须与本轮 map_route 记录的候选名字全等 + 坐标 1e-6 内），" +
      "里程/时长/过路费从记录器取，不从提交里抄数字。无提交不是失败：退化成起终点直连 + 一条 caveat，端上照样能导",
  },
  {
    id: "nav-task",
    label: "导航分支 Agent\n（A 型：自己调 map_route）",
    kind: "agent",
    viaHttp: true,
    source: "graph/subgraphs/nav-plan.ts navPrompt + prompts/nav.md",
    note:
      "**单支 fan-out，不是并行**。预算 55 s（网关 60 s、Rust 65 s、端上 60 s 硬顶，逐层递增）。" +
      "唯一的工具 `map_route` 只读，不会产生权限中断",
  },
  {
    id: "guideBrief",
    label: "景区导游采集\n三分支 fan-out + 代码汇聚",
    kind: "orchestration",
    viaHttp: true,
    source: "graph/subgraphs/guide.ts runGuideBrief",
    note:
      "M36-01。点击景点触发（ACR-008 起经导览队列），三支并行各查各的，代码汇聚成一份导览简报。" +
      "出处全等校验（M32 不变量）：`sourceUrl` 必须与本轮 `web_search` 真实返回过的一致。" +
      "预算 90 s 而不是 fan-out 默认的 60 s——超时掐掉的不是慢，是**已经查到的结果**",
  },
  {
    id: "guide-access-task",
    label: "到达与停车分支",
    kind: "agent",
    viaHttp: true,
    source: "graph/subgraphs/guide.ts guidePrompt + prompts/guide-access.md",
    note: "停车 / 充电 / 加油与最后一公里",
  },
  {
    id: "guide-spots-task",
    label: "必玩点位分支",
    kind: "agent",
    viaHttp: true,
    source: "graph/subgraphs/guide.ts guidePrompt + prompts/guide-spots.md",
    note: "必玩 / 打卡",
  },
  {
    id: "guide-comfort-task",
    label: "休憩与避雷分支",
    kind: "agent",
    viaHttp: true,
    source: "graph/subgraphs/guide.ts guidePrompt + prompts/guide-comfort.md",
    note: "休息 / 餐饮 / 厕所 / 避雷",
  },
];

export const WORKFLOW_EDGES: readonly WorkflowEdge[] = [
  { from: "start", to: "understand" },
  { from: "understand", to: "supervisor-intent", label: "四要素 JSON 抽取" },
  /*
   * 抽取结果**经图状态**回到路由，不是 supervisor-intent 直接把路由决定了。
   *
   * 这条边画的是数据依赖：`intentNode` 把 JSON 解析进 `state.intent`，
   * `decideRoute` 再连同用户原话一起吃。分开这两件事要紧——
   * 判路由的是规则表不是模型（`intent` 缺席时规则照跑，只是少了约束项）。
   */
  /*
   * 抽取结果的**第一个消费方是风险门**（`intent.riskCategory`），不是路由。
   * 画到 dispatch 会让人以为四要素只用来判路由——而它同时决定这一轮走不走得下去。
   */
  { from: "supervisor-intent", to: "riskGate", label: "四要素 → state.intent" },
  { from: "understand", to: "riskGate" },
  /*
   * 硬禁在这里收口，**不往下走**（AC-11-7）。判定在 `riskGateNode` 里写进
   * `state.risk`，图装配处只读结论——理由同 `branchFor`：把判定塞进装配处的闭包，
   * 缺陷就落在测不到的那一层。
   */
  { from: "riskGate", to: "deny-end", label: "硬禁：拒绝话术直接下发", conditional: true },
  { from: "riskGate", to: "dispatch", label: "其余", conditional: true },

  // 条件路由：branchFor 六选一。**不是每类请求都 fan-out**——那既浪费也拖慢首事件。
  { from: "dispatch", to: "itineraryPlan", label: "出行 / 多天行程", conditional: true },
  { from: "dispatch", to: "ownershipDual", label: "用车 / 售后", conditional: true },
  { from: "dispatch", to: "buyingCatalog", label: "购车", conditional: true },
  { from: "dispatch", to: "testDriveFlow", label: "试驾", conditional: true },
  { from: "dispatch", to: "cabinCompanion", label: "座舱", conditional: true },
  { from: "dispatch", to: "answer", label: "其余", conditional: true },

  // fan-out：各分支是独立的 session/prompt。**画成叶子是刻意的**——
  // 分支不自己往下走，结果由编排层汇聚回图状态（见 validateGraph 的叶子检查）。
  { from: "itineraryPlan", to: "drive-task", parallel: true },
  { from: "itineraryPlan", to: "hotel-task", parallel: true },
  { from: "itineraryPlan", to: "tour-task", parallel: true },
  { from: "itineraryPlan", to: "transit-task", parallel: true },
  { from: "itineraryPlan", to: "ownership-task", label: "仅骨架轮", parallel: true },

  // 各分支节点的工具调用
  { from: "itineraryPlan", to: "tools", label: "vehicle_profile / trip_plan_commit" },
  { from: "ownershipDual", to: "tools", label: "ragflow_retrieve ‖ usage_profile", parallel: true },
  { from: "buyingCatalog", to: "tools", label: "car_catalog / cost_calc / insurance_quote" },
  { from: "testDriveFlow", to: "tools", label: "dealer_stores / dealer_slots / test_drive_book" },
  /*
   * 座舱 A 型后工具**由模型选**（`cabin_control` / `cabin_child_mode` /
   * `cabin_apply_preferences` / `member_preference_set` / `vehicle_member` …），
   * 经 pi 的 tools-endpoint 出去；节点自己只预取 `cabin_status` 与人员名单这两件事实。
   */
  { from: "cabinCompanion", to: "cabin-task", label: "单支 fan-out" },
  { from: "cabinCompanion", to: "tools", label: "预取：cabin_status / 名单" },

  // 权限门的两条进入路径，语义不同：
  // 经 tools-endpoint 的是 pi 自己发起的调用；子图直调的必须自己 check。
  { from: "tools", to: "guard", label: "pi 调敏感工具", conditional: true },
  { from: "itineraryPlan", to: "guard", label: "确认 / 取消前，子图直调", conditional: true },
  { from: "testDriveFlow", to: "guard", label: "下单前，子图直调", conditional: true },
  { from: "ownershipDual", to: "guard", label: "售后留档前，子图直调", conditional: true },

  // 汇聚：各分支把结果写回图状态，由 answer 统一表述。
  // 后三条刻意不带标签：五条写同一句"汇聚回图状态"只会在 answer 左边叠成一团，
  // 而那句话前两条已经说清楚了——重复的标签不增加信息，只挡住别的边。
  { from: "itineraryPlan", to: "answer", label: "代码汇聚后的求解结果" },
  { from: "ownershipDual", to: "answer", label: "合成上下文回图状态" },
  { from: "buyingCatalog", to: "answer" },
  { from: "testDriveFlow", to: "answer" },
  { from: "cabinCompanion", to: "answer" },

  // 应答的两条出路。**这不是路由分支**，是同一个节点用哪种方式把话说出来。
  {
    from: "answer",
    to: "narrator",
    label: "有求解结果且未降级",
    conditional: true,
  },
  { from: "answer", to: "answer-agent", label: "否则回主链路（那侧有工具）", conditional: true },

  { from: "answer", to: "end" },

  /*
   * HTTP 触发的两条子图。**入口是一次点击，不是 START**——两条都标条件边：
   * 一次点击只会触发其中一条，且投影层不许"两端都亮就把它补上"
   * （那会让一轮导航规划顺带亮起导游采集）。
   *
   * 子图之后不接 answer 也不接 END：产出是结构化方案 / 简报，经 HTTP 响应回网关，
   * 没有"表述"这一步——车主看到的是卡片，不是一段话。
   */
  { from: "entry-http", to: "navPlan", label: "开始行程", conditional: true },
  { from: "entry-http", to: "guideBrief", label: "点击景点", conditional: true },
  // 单支 fan-out，同 cabinCompanion → cabin-task：不标 parallel，标了就成了"导航也在并行"。
  { from: "navPlan", to: "nav-task", label: "单支 fan-out" },
  { from: "guideBrief", to: "guide-access-task", parallel: true },
  { from: "guideBrief", to: "guide-spots-task", parallel: true },
  { from: "guideBrief", to: "guide-comfort-task", parallel: true },
];

// ── 旁路陪伴（US-45 / M18）────────────────────────────────────

/**
 * 旁路是**并行于整个 turn 的只读观察者**，不是主图上的一步。
 *
 * 四条硬约束（§4.1，`check:arch` 的 `sidecar-isolation` 守着前三条）：
 * 不是第六个子 Agent / 能力边界是依赖不是提示词 / 对主链路零同步成本 /
 * 不绕过 §8.3 的内容管线。
 *
 * ⚠️ **会话标题旁路（M28-01）不在这张图上**——commit 里叫它"旁路起名"，
 * 但它是 `src/title/` 下另一条独立链路（turn_end 后网关 fire-and-forget 触发、
 * 直连非推理模型），刻意不放 `sidecar/`：蹭这个名字去破 `sidecar-isolation`
 * 的依赖边界不值。在这里找它的人，去 roster 里 sidecar 那一行看说明。
 */
export const SIDECAR_NODES: readonly WorkflowNode[] = [
  {
    id: "turn",
    label: "turn 开始",
    kind: "entry",
    // 轮次边界归 turn-runner，不归旁路——旁路只是把它画进来当源头。
    shared: true,
    source: "turn-runner.ts registerPair",
    note:
      "生命周期绑在 turn 上：closePair 挂在 run() 的 finally，正常收口 / 异常 / 取消都会走到。" +
      "所以这里不另设条数或总时长上限——turn 会不会结束是会话超时的职责，" +
      "再设一个闸就是重复造闸，而那个闸（20 秒）正常等待就会撞上",
  },
  {
    id: "spanSink",
    label: "span sink\n并列扇出",
    kind: "orchestration",
    // 轨迹是**主链路发出来的**，落库与旁路订阅是它的两个下游。不归旁路。
    shared: true,
    source: "index.ts setSpanSink",
    note:
      "`traceRepo.write(e); observeTrace(e);` —— 并列，不是包装替换。" +
      "observeTrace 自己吞异常并计数，外面不包 try/catch：" +
      "包了会让「旁路挂了」被误算成「轨迹挂了」，而两者排查方向完全不同",
  },
  {
    id: "pair",
    label: "旁路 A-pair 会话\n只读观察者",
    kind: "sidecar",
    source: "sidecar/pair-session.ts",
    note:
      "**观察轨迹 span，不是 SessionEvent 流**。实测一次保养提问：整条 SSE 上只有 " +
      "created → thinking →（9.2 秒空白）→ delta，一个 branch 事件都没有——" +
      "branch 只在出行的并行 fan-out 里产生。只订 SessionEvent 的话，" +
      "它会在最长的那类等待里无话可说，除了「我在想」，而那正是明令禁止的无事件支撑话术",
  },
  {
    id: "silence",
    label: "静默判定 + 节拍",
    kind: "orchestration",
    source: "sidecar/silence.ts + budget.ts",
    note:
      "只有 delta / retract 推进静默基准：state / branch / tool_call 不是面向用户的内容，" +
      "拿它们重置的话，一个热闹但不出声的链路永远触发不了垫场——而那恰恰最需要垫场。" +
      "收到 permission 事件即静音：不往确认问句上插话，那是有后果动作的最后一道闸",
  },
  {
    id: "l0",
    label: "L0 轨迹模板\n零 LLM 查表",
    kind: "tool",
    source: "sidecar/templates.ts",
    note:
      "零 LLM 是硬要求不是省钱：先跑一次模型再说话，等于用一次等待去填另一次等待。" +
      "**匹配不到就返回 undefined，没有兜底话术**——「正在为您查询」在什么都没发生时" +
      "就是一句用户无法证伪、只会照单全收的假话",
  },
  {
    id: "l1",
    label: "L1 导游式闲聊\n直连模型",
    kind: "llm",
    source: "sidecar/l1.ts（接口）+ sidecar-writer.ts（实现）",
    note:
      "**只给地名、不给问题原文**。三轮探针量出来：让它看着用户的问题去闲聊，" +
      "它就会去回答那个问题（「估摸着还能撑一阵子」答续航）；加禁令无效，犯规率 40%→40% 纹丝不动。" +
      "换成只给地名后过滤器零命中——因为「回答问题」这一类在结构上就不存在了。" +
      "实现放在 sidecar/ 外面，是因为 sidecar/ 不许 import ../llm",
  },
  {
    id: "outputGuard",
    label: "输出管线\ncheckOutput",
    kind: "guard",
    source: "sidecar/speak.ts",
    note:
      "**旁路不是安全边界的旁路**。一条能出声却不过管线的通道就是把 §8.3 整层绕过去了；" +
      "「它只说寒暄所以不用过」站不住——L1 会把用户原话和记忆揉进去，PII 完全可能顺着它出来。" +
      "入口同步返回，过管线在 fire-and-forget 里做（主链路零同步成本）",
  },
  {
    id: "filler",
    label: "SSE filler 事件",
    kind: "exit",
    note: "与主回答同一条 SSE。但**不留痕**：垫场话不进主会话历史，轨迹 span 里也只存档位不存文本",
  },
];

export const SIDECAR_EDGES: readonly WorkflowEdge[] = [
  { from: "turn", to: "pair", label: "registerPair / closePair" },
  /*
   * **只读旁观，不是并行分支**。`parallel` 的意思是"两条同时走"，
   * 而这条说的是"旁路在看主链路发出来的东西，主链路对它一无所知"。
   * 两者在总链路图上必须分得开——那张图合了主路与旁路，
   * 一条画错的边就会读成"编排层会路由到旁路"。
   */
  { from: "spanSink", to: "pair", label: "只读订阅轨迹 span", readonly: true },
  { from: "pair", to: "silence" },
  { from: "silence", to: "l0", label: "命中模板", conditional: true },
  { from: "silence", to: "l1", label: "地名可闲聊", conditional: true },
  { from: "l0", to: "outputGuard" },
  { from: "l1", to: "outputGuard" },
  { from: "outputGuard", to: "filler", label: "过管线才出声" },
];

// ── 语音唤醒入口（US-52 / M25）────────────────────────────────

/**
 * 唤醒发生在**进图之前**，全在车机端 Rust 侧（`clients/cockpit/src-tauri/src/voice/`）。
 *
 * # 为什么值得单画一张，而不是在主图左边加两个方框
 *
 * 这条链路上真正要紧的判断——「没叫她的时候那些话去哪了」——一个字都不发生在编排层：
 * 未命中唤醒词的转写在端上判定后**就地丢弃**，不进会话历史、不写六类记忆、不落日志明文
 * （AC-52-5）。画进主图会让人以为编排层看得见它们，从而去编排层找那道丢弃闸——
 * 而那道闸在 `voice/mod.rs::on_transcript` 的一个 `else` 分支里。
 *
 * # 唯一实线的那个方框才是 LangGraph
 *
 * 这张图上除 `handoff` 外没有任何一个方框是 `StateGraph` 的一步。命中之后，
 * 指令走的是**与打字、与长按完全同一条**上行路径（`gateway.send_text`）——
 * 唤醒不是安检旁路，内容管线一视同仁。
 */
export const WAKE_NODES: readonly WorkflowNode[] = [
  {
    id: "micSwitch",
    label: "麦克风总开关\nMicSwitch",
    kind: "entry",
    source: "clients/shared/rust/carlife-media/src/listen.rs",
    note:
      "**第一顺位**，不允许出现在任何分支内部。关闭时麦克风占用与网络上行双双归零——" +
      "AC-52-6 要的是这两件事同时验证，只验其一的话「指示灭了但还在传」看起来完全正常",
  },
  {
    id: "capture",
    label: "持续采集\nContinuousHandle → 16k 单声道",
    kind: "orchestration",
    source: "voice/sentinel.rs + carlife-media StreamConverter",
    note:
      "cpal 归专用线程，外部经 `Send` 句柄控制——与 PTT 同一套线程哲学。" +
      "设备起流失败不放弃，按 `REBUILD_EVERY` 重试（设备可能只是暂时被占）",
  },
  {
    id: "ptt",
    label: "长按 PTT\nPause / Resume",
    kind: "orchestration",
    source: "commands/media.rs start/stop_push_to_talk",
    note:
      "**PTT 是回归对象不是改造对象**（M25 红线）：一行为不改。" +
      "新增的只是互斥——按下瞬间哨兵让出麦克风，松手恢复。" +
      "它与总开关正交：Pause 期间开关仍是开的",
  },
  {
    id: "vad",
    label: "VAD 分段\n预卷 + 段上限",
    kind: "orchestration",
    source: "clients/shared/rust/carlife-media/src/vad.rs + SegmentAssembler",
    note: "webrtc-vad，16kHz/30ms 帧，连续 8 帧去抖（>5 帧 hangover 的教训在 crate 注释里）",
  },
  {
    id: "ttsMute",
    label: "播报期丢帧\nTTS_PLAYING",
    kind: "guard",
    source: "voice/sentinel.rs TTS_PLAYING",
    note:
      "**丢帧不丢流**：起停 cpal 流的抖动比丢几帧贵得多，所以麦克风保持打开、采到的一律丢弃。" +
      "M25-02 活体实测：播报会被回采成串转写调用——唤醒词闸门挡住了成环，但白烧 ASR",
  },
  {
    id: "transcribeOnly",
    label: "只转写通道\nPOST /v1/asr/transcribe",
    kind: "orchestration",
    source: "enterprise/backend/gateway/src/http/index.ts",
    note:
      "**与既有音频端点分开的一条**：那条转写完直接成轮进历史，哨兵段走它" +
      "等于把车内闲聊全写进会话。这条只回文本，不建轮、不落历史",
  },
  {
    id: "classify",
    label: "唤醒词判定\nwake::classify（拼音归一）",
    kind: "tool",
    source: "clients/shared/rust/carlife-voice/src/wake.rs",
    note:
      "纯文本函数，不碰网络设备。判定顺序是纪律：先剥唤醒词 → 再查控制口令（**精确集合匹配**，" +
      "防「查一下退下高速的路线」误伤）→ 剩下的才是业务指令。" +
      "「暖」接受 n/l/r 声母混淆（ASR 对 nuan 的常见误写是「软软」「乱乱」——鼻边音不分是中文 ASR 的经典错位）。" +
      "**不做任何模型化判定**，置信度门槛等误唤醒数据回来再说",
  },
  {
    id: "discard",
    label: "未命中即弃\n只计数",
    kind: "exit",
    source: "voice/mod.rs on_transcript 的 Miss 分支",
    note:
      "**本 Sprint 的隐私底线**：不进会话历史、不写六类记忆、不落日志明文（AC-52-5）。" +
      "连长度都不记——判定完文本到此为止，无任何副本",
  },
  {
    id: "windows",
    label: "对话窗口\n聆听 15s / 追问 20s",
    kind: "orchestration",
    source: "clients/shared/rust/carlife-voice/src/windows.rs",
    note:
      "唤醒词换来的对话许可是**有边界的**，且是**一次性**：窗口内送出一句即消耗，" +
      "下一轮追问窗口由那句话的回复播完再开。" +
      "唤醒应答播完才重新起算聆听窗口，否则应答本身吃掉窗口头几秒。" +
      "窗口不是会话生命周期——M22 的 30 分钟空闲语义与它无关（Instant 级 vs 分钟级）",
  },
  {
    id: "dismiss",
    label: "语音退下\nclose_session",
    kind: "orchestration",
    source: "voice/mod.rs Dismiss 分支",
    note: "与点「退下」按钮**走同一条 close 链路**（幂等）：会话软关闭、回休息、历史一条不删",
  },
  {
    id: "handoff",
    label: "主链路 START\n（与打字 / 长按同一条）",
    kind: "entry",
    graphNode: true,
    source: "gateway.send_text → agent-runtime",
    note:
      "**唤醒不是安检旁路**：唤醒后的指令文本进内容管线的行为与打字、长按完全一致。" +
      "409 收编是这条边上唯一的特殊处置——暖暖休息时绑定会话往往已过期，" +
      "指令不能因此被丢：新建会话、重发、经 `SessionAdopted` 事件交还前端收编",
  },
];

export const WAKE_EDGES: readonly WorkflowEdge[] = [
  { from: "micSwitch", to: "capture", label: "开" },
  { from: "ptt", to: "capture", label: "Pause / Resume（互斥）", conditional: true },
  { from: "capture", to: "vad" },
  { from: "vad", to: "ttsMute" },
  { from: "ttsMute", to: "transcribeOnly", label: "非播报期的段" },
  { from: "transcribeOnly", to: "classify", label: "转写文本（不建轮）" },
  { from: "classify", to: "discard", label: "Miss 且无窗口", conditional: true },
  { from: "classify", to: "dismiss", label: "控制口令", conditional: true },
  { from: "classify", to: "windows", label: "Wake（只喊名字）", conditional: true },
  { from: "classify", to: "handoff", label: "Wake 带指令 / 窗口内 Miss", conditional: true },
  { from: "windows", to: "handoff", label: "窗口内说话，许可一次性消耗", conditional: true },
  { from: "windows", to: "discard", label: "窗口到期，静默回哨兵", conditional: true },
];

// ── Agent 清单 ──────────────────────────────────────────────

/** 会话形态。后缀只影响**会话隔离与思考开关**，不新增进程 / prompt / 工具表。 */
export type SessionForm = "直达路由" | "-task 分支" | "-intent 抽取" | "旁路";

export interface AgentEntry {
  /** 规范 Agent 名——`canonicalAgent()` 归一之后的那个，也就是 prompt 文件名。 */
  name: string;
  label: string;
  /** `enterprise/backend/pi-agents/prompts/` 下的文件；旁路没有 prompt 文件。 */
  prompt?: string;
  forms: readonly SessionForm[];
  /** 由谁驱动：图节点名，或"编排层 fan-out"。 */
  drivenBy: string;
  note: string;
}

/**
 * 15 个 pi Agent + 旁路。**数量不要写死在断言里**——`graph-drift.test.ts` 拿
 * `registry.ts` 的 `AgentName` 联合类型与这里逐个比，多一个少一个都红。
 * 从前断言的是 `=== 11`，于是 M36 加三个、M66 加一个，这里静默停在 11 一个多月。
 *
 * # 为什么这里不列工具数
 *
 * 工具 ACL 的真相源是 `enterprise/backend/shared/tools/src/registry.ts` 的 `agents` 字段，
 * 而控制台不依赖那个包（它会把 DB / RAG 客户端一起拖进浏览器包）。
 * 抄一份数字过来就是**又一个会静默漂掉的副本**——这一整页刚因为同一个毛病返工过。
 * 所以这里只列变动极慢的东西（prompt 文件、会话形态、由谁驱动），
 * 要看工具面去 `registry.ts`。
 *
 * ⚠️ `AgentName` 联合类型在仓里有**两份**（`registry.ts` 与
 * `acp-client/connection.ts`），加 Agent 时三处都要动。
 */
export const AGENT_ROSTER: readonly AgentEntry[] = [
  {
    name: "supervisor",
    label: "编排 / 兜底",
    prompt: "prompts/supervisor.md",
    forms: ["-intent 抽取", "直达路由"],
    drivenBy: "understand（抽取）/ answer（general 路由兜底直答）",
    note: "两种会话严格分开——共用会导致应答继续吐 JSON",
  },
  {
    name: "buying",
    label: "购车顾问",
    prompt: "prompts/buying.md",
    forms: ["直达路由"],
    drivenBy: "buyingCatalog → answer",
    note: "单路检索：购车阶段这辆车还不存在，没有第二路可查",
  },
  {
    name: "ownership",
    label: "用车助手",
    prompt: "prompts/ownership.md",
    forms: ["直达路由", "-task 分支"],
    drivenBy: "ownershipDual → answer；另以 ownership-task 被行程骨架轮拉去做续航评估",
    note:
      "与 cabin 一样同时有直达路由与 -task 两种形态（M24 前它是唯一的一个）。" +
      "M26 起还是事实补录询问的主要载体之一（ELICITATION_CARRIER_AGENTS）",
  },
  {
    name: "service",
    label: "售后",
    prompt: "prompts/service.md",
    forms: ["直达路由"],
    drivenBy: "ownershipDual → answer（与用车共用节点，按 ctx.agent 换成 repair-kb）",
    note: "判断形状和用车相同——「我这车 X 正不正常」，只是 X 不同",
  },
  {
    name: "trip",
    label: "出行",
    prompt: "prompts/trip.md",
    forms: ["直达路由"],
    drivenBy: "itineraryPlan → answer",
    note: "itinerary 路由的应答会话复用它：四个专家都是 -task 型，没有面向车主的人设",
  },
  {
    name: "cabin",
    label: "座舱",
    prompt: "prompts/cabin.md",
    forms: ["直达路由", "-task 分支"],
    drivenBy: "cabinCompanion 发 cabin-task 求解 → answer 用直达会话表述",
    note:
      "M24 起是 A 型：**参数由模型自己填**，五个「用正则理解人话」的分支归零。" +
      "与 ownership 一样同时有直达路由与 -task 两种形态",
  },
  {
    name: "test-drive",
    label: "试驾预约",
    prompt: "prompts/test-drive.md",
    forms: ["直达路由"],
    drivenBy: "testDriveFlow → answer",
    note: "有副作用的下单：图直调不过 tools-endpoint，权限门由子图自己调",
  },
  {
    name: "drive",
    label: "自驾路线",
    prompt: "prompts/drive.md",
    forms: ["-task 分支"],
    drivenBy: "itineraryPlan 的 fan-out",
    note: "无直达路由。工具面刻意收窄——分支只负责交出候选与事实",
  },
  {
    name: "hotel",
    label: "住宿候选",
    prompt: "prompts/hotel.md",
    forms: ["-task 分支"],
    drivenBy: "itineraryPlan 的 fan-out",
    note: "无直达路由。只有 poi_search——酒店名必须逐字取自它，不许缩写",
  },
  {
    name: "tour",
    label: "逐天玩法",
    prompt: "prompts/tour.md",
    forms: ["-task 分支"],
    drivenBy: "itineraryPlan 的 fan-out",
    note: "无直达路由。每天配雨天备选",
  },
  {
    name: "transit",
    label: "大交通",
    prompt: "prompts/transit.md",
    forms: ["-task 分支"],
    drivenBy: "itineraryPlan 的 fan-out",
    note: "无直达路由",
  },
  {
    name: "guide-access",
    label: "导游 · 到达与停车",
    prompt: "prompts/guide-access.md",
    forms: ["-task 分支"],
    drivenBy: "guideBrief 的 fan-out（HTTP 触发：点击景点，不经聊天路由）",
    note: "M36-01。停车 / 充电 / 加油与最后一公里。只读工具，不会产生权限中断",
  },
  {
    name: "guide-spots",
    label: "导游 · 必玩点位",
    prompt: "prompts/guide-spots.md",
    forms: ["-task 分支"],
    drivenBy: "guideBrief 的 fan-out（HTTP 触发：点击景点，不经聊天路由）",
    note: "M36-01。必玩 / 打卡。出处全等校验：sourceUrl 必须与本轮 web_search 真实返回过的一致",
  },
  {
    name: "guide-comfort",
    label: "导游 · 休憩与避雷",
    prompt: "prompts/guide-comfort.md",
    forms: ["-task 分支"],
    drivenBy: "guideBrief 的 fan-out（HTTP 触发：点击景点，不经聊天路由）",
    note: "M36-01。休息 / 餐饮 / 厕所 / 避雷",
  },
  {
    name: "nav",
    label: "出发导航规划",
    prompt: "prompts/nav.md",
    forms: ["-task 分支"],
    drivenBy: "navPlan 的单支 fan-out（HTTP 触发：点「开始行程」，不经聊天路由）",
    note:
      "M66-01。策略（高速 / 省道）与约束（单段上限、停靠点要什么）在进分支之前就由代码定好，" +
      "模型只调 `map_route` 挑休息点并经 `submit_nav_plan` 交回；途经点零信任，代码汇聚。" +
      "名字刻意不叫 `navigation`——短、且不以 -task/-intent/-voice 结尾",
  },
  {
    name: "sidecar",
    label: "旁路陪伴",
    forms: ["旁路"],
    drivenBy: "turn-runner（与图并行，只读订阅轨迹）",
    note:
      "**不是第 12 个 Agent**：没有 pi 进程、没有 prompt 文件、没有工具表。" +
      "L0 零 LLM 查表，L1 直连模型只谈地名。能力边界靠依赖守（check:arch）。" +
      "**会话标题不归它管**——那是另一条独立的标题旁路（src/title/，M28-01）：" +
      "首轮收口后直连非推理模型起 15 字内的名字，一个会话只起一次，失败必须无声。" +
      "它刻意不放 sidecar/（那里的隔离禁 import ../llm），也不画进任何一张图",
  },
];

/**
 * 三种会话后缀的说明。**不新增 Agent**——它们只影响会话隔离与思考开关。
 *
 * `-voice` 刻意也列在这里：它正常根本不经 `loadAgentPrompt`，
 * 但后缀家族必须在一处说全——漏掉它的话，哪天有人把这条路接回 ACP，
 * `loadAgentPrompt` 会去找 `trip-voice.md` 并抛错，而外部症状只是"应答失败"。
 */
export const SESSION_SUFFIXES: ReadonlyArray<{ suffix: string; use: string; thinking: string }> = [
  { suffix: "-task", use: "fan-out 分支，与直达路由不共享上下文", thinking: "关闭（产出被代码正则解析）" },
  { suffix: "-intent", use: "四要素抽取，必须与应答会话分开", thinking: "关闭（产出被代码解析成 JSON）" },
  { suffix: "-voice", use: "表述路径，直连非推理模型，不经 ACP", thinking: "不适用（直连）" },
];

// ── 总链路的组合 ────────────────────────────────────────────

/**
 * 全量总链路。**展开已有定义，不重写**——这是它能长期正确的唯一办法。
 *
 * 放在这里（而不是 BRIDGE_* 旁边）只是因为它要等 `WORKFLOW_*` / `SIDECAR_*`
 * 都声明完才能展开。
 */
export const TOTAL_NODES: readonly WorkflowNode[] = [
  ...WORKFLOW_NODES,
  ...SIDECAR_NODES,
  ...BRIDGE_NODES,
];

export const TOTAL_EDGES: readonly WorkflowEdge[] = [
  ...WORKFLOW_EDGES,
  ...SIDECAR_EDGES,
  ...BRIDGE_EDGES,
];

// ── 结构自检 ────────────────────────────────────────────────

/**
 * 与图形无关的通用结构检查：端点存在、可达、Agent 不互连。
 *
 * 抽出来是因为两张图都要跑一遍——旁路那张同样会漂。
 */
function structuralProblems(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  entryId: string,
): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const problems: string[] = [];

  for (const e of edges) {
    if (!ids.has(e.from)) problems.push(`边的起点不存在：${e.from}`);
    if (!ids.has(e.to)) problems.push(`边的终点不存在：${e.to}`);
  }

  // 每个非入口节点都应可达。入口不止一个：主链路上除了 START 还有 HTTP 触发的点击入口，
  // 旁路那张图有 turn 与 spanSink 两个源头——**有出边、无入边**的都算源头，从它们一起出发。
  const sources = nodes
    .filter((n) => edges.some((e) => e.from === n.id) && !edges.some((e) => e.to === n.id))
    .map((n) => n.id);
  const reachable = new Set<string>([entryId, ...sources]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if (reachable.has(e.from) && !reachable.has(e.to)) {
        reachable.add(e.to);
        grew = true;
      }
    }
  }
  for (const n of nodes) {
    // 入口不止一个时（旁路那张图有 turn 与 spanSink 两个源头），另一个源头
    // 靠"有出边"证明自己不是孤儿——它本来就不该有入边。
    const isSource = edges.some((e) => e.from === n.id) && !edges.some((e) => e.to === n.id);
    if (!reachable.has(n.id) && !isSource) problems.push(`节点不可达：${n.id}`);
  }

  // **子 Agent 之间不得有直接边**（§11 关键原则）——图上出现这种边说明架构被违反了
  const agents = new Set(nodes.filter((n) => n.kind === "agent").map((n) => n.id));
  for (const e of edges) {
    if (agents.has(e.from) && agents.has(e.to)) {
      problems.push(`子 Agent 之间不得直接相连：${e.from} → ${e.to}（§11 关键原则）`);
    }
  }

  /*
   * **fan-out 分支**是叶子：结果由驱动它的节点汇聚，不是自己流向下一步。
   *
   * 这条以前是画错的——旧图把 `trip-task → answer` 画成一条边，读起来像
   * "分支直接把答案交给应答节点"，而实际是分支返回结构化文本、代码做装配与校验
   * （超限就拆段、缺"估算"就补），再由 answer 表述。差别不是画法，是
   * "约束求解到底由谁做"。
   *
   * # 为什么只管并行分支，不是所有 Agent 框
   *
   * `supervisor-intent → dispatch` 是**数据依赖**，不是"分支自己往下走"：
   * 中间没有汇聚这一步，`intentNode` 只是把 JSON 解析进 `state.intent`。
   * 一刀切会把这条正常的边判成违规——而那时候红的是判据，不是架构。
   * 判并行分支就够，那正是这条规则当初要防的形态。
   */
  const branchAgents = new Set(edges.filter((e) => e.parallel).map((e) => e.to));
  const outFrom = new Set(edges.map((e) => e.from));
  for (const id of agents) {
    if (branchAgents.has(id) && outFrom.has(id)) {
      problems.push(`fan-out 分支不该有出边：${id}（结果由驱动它的节点汇聚，不自己流向下一步）`);
    }
  }

  // 每个 Agent 方框都要能在清单里找到——图上有、清单里没有，说明清单漏了一个 Agent。
  const roster = new Set(AGENT_ROSTER.map((a) => a.name));
  for (const n of nodes) {
    if (n.kind !== "agent") continue;
    // 图上的 id 带 `-task` / `-intent` 后缀，清单按规范名列——与 canonicalAgent 同一规则。
    const names = n.rosterNames ?? [n.id.replace(/-(task|intent|voice)$/, "")];
    for (const name of names) {
      if (!roster.has(name)) problems.push(`Agent 清单里没有：${name}（图上画作 ${n.id}）`);
    }
  }

  return problems;
}

/**
 * 主链路自检：图上画的必须与实际能跑的一致。
 *
 * 这不是防御性编程——**一张与实际不符的架构图比没有图更糟**，
 * 它会让人相信一个并不存在的架构。
 *
 * ⚠️ 但要清楚它**查不到什么**：它只看这张图自身，不读 `supervisor.ts`。
 * 上游加了节点而这里没跟，它一条都不会报（M13-13 之后就是这样静默漂了几个 Sprint）。
 */
export function validateGraph(): string[] {
  const problems = structuralProblems(WORKFLOW_NODES, WORKFLOW_EDGES, "start");

  // `dispatch` 的条件边必须覆盖 branchFor 的全部目标——漏一个等于图上没有这个 Agent。
  const dispatchTargets = new Set(
    WORKFLOW_EDGES.filter((e) => e.from === "dispatch").map((e) => e.to),
  );
  for (const b of BRANCH_NODES) {
    if (!dispatchTargets.has(b)) problems.push(`dispatch 缺少分支：${b}（见 route.ts branchFor）`);
  }
  for (const t of dispatchTargets) {
    if (!(BRANCH_NODES as readonly string[]).includes(t)) {
      problems.push(`dispatch 多了一个 branchFor 里没有的分支：${t}`);
    }
  }

  /*
   * HTTP 触发的子图**从 START 不可达**，且它们的入口是图上唯一的第二个源头。
   *
   * 这两条子图画在主链路上只是为了让大屏与会话页有地方落它们的轨迹；
   * 一旦有人给 `dispatch → navPlan` 连上一条边，图就在说"聊天可以路由到导航规划"——
   * 而 M66 刻意不做这件事（触发是点「开始行程」，策略与约束在进分支前由代码定好）。
   * 反方向也守：非 HTTP 的节点不许从 `entry-http` 可达，否则就是把主链路接到了点击入口上。
   */
  const http = new Set(WORKFLOW_NODES.filter((n) => n.viaHttp).map((n) => n.id));
  const reachFrom = (entry: string): Set<string> => {
    const seen = new Set<string>([entry]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of WORKFLOW_EDGES) {
        if (seen.has(e.from) && !seen.has(e.to)) {
          seen.add(e.to);
          grew = true;
        }
      }
    }
    return seen;
  };
  for (const id of reachFrom("start")) {
    if (http.has(id)) problems.push(`HTTP 触发的子图从 START 可达：${id}（它不经聊天路由，图上不该有这条路）`);
  }
  for (const id of reachFrom("entry-http")) {
    if (!http.has(id)) problems.push(`从 HTTP 入口可达了主链路的节点：${id}（点击触发的子图不接 answer / END）`);
  }

  return problems;
}

/**
 * 总链路自检。
 *
 * 除通用结构外，它守三件事，每一件都对应一个具体的失败形态：
 *
 * 1. **旁路只能被点线指到**。三张细节图之所以刻意分开画，理由就是
 *    "塞进主图会让人以为编排层会路由到旁路"。现在既然合了，那个风险就实实在在
 *    地回来了——差别只在于这次有一条会红的断言拦着。
 * 2. **旁路的出口只有端上**。它够不着任何业务能力（`check:arch` 的
 *    `sidecar-isolation` 守着依赖那一侧，这里守图这一侧）。
 * 3. **细节图的每个节点都必须在总图上**。这条守的是"总图是组合出来的，
 *    不是手抄的"——哪天有人图省事改成手抄，它当天就会漂，而这个文件
 *    已经因为手工副本漂过两次。
 */
export function validateTotal(): string[] {
  const problems = structuralProblems(TOTAL_NODES, TOTAL_EDGES, "entry-voice");

  /*
   * **旁路真正拥有的那些**，不含 `shared` 的共享设施（`turn` / `spanSink`）。
   *
   * 这条区分是本函数第一版漏掉的，当场被自己的断言抓出来：把 `spanSink` 算成
   * 旁路的话，`spanSink → console`（轨迹落库供回放）会被判成"旁路伸手去碰控制台"，
   * 而轨迹本来就是主链路发的、控制台读的也是它——旁路只是它的另一个下游。
   */
  const sidecars = new Set(SIDECAR_NODES.filter((n) => !n.shared).map((n) => n.id));
  /** 编排图那张图上的节点——生命周期边由 turn-runner 拥有，不在此列。 */
  const graphNodes = new Set(WORKFLOW_NODES.map((n) => n.id));
  for (const e of TOTAL_EDGES) {
    // 旁路内部的边不在此列——它们是旁路自己那张图的事。
    const crossesIn = sidecars.has(e.to) && !sidecars.has(e.from);
    const crossesOut = sidecars.has(e.from) && !sidecars.has(e.to);
    /*
     * 禁的是**编排图的节点**伸手碰旁路，不是"任何指向旁路的实线"。
     *
     * 这条也是被自己抓出来才改准的：`turn → pair` 是 `registerPair` /
     * `closePair`，**生命周期管理**——turn-runner 本来就拥有旁路的生死
     * （`closePair` 挂在 `run()` 的 finally 里，正常收口/异常/取消都会走到）。
     * 一刀切会把这条正常的边判成违规，而那时红的是判据不是架构。
     *
     * 真正不能有的是 `graph/` 里的某个节点指过去：那意味着编排图知道旁路存在、
     * 甚至等它的结果——而 `check:arch` 的 `sidecar-isolation` 守的正是反面
     * （旁路不许 import `../graph`）。两边合起来才是完整的一条边界。
     */
    if (crossesIn && !e.readonly && graphNodes.has(e.from)) {
      problems.push(
        `编排图的节点不得有指向旁路的控制边：${e.from} → ${e.to}` +
          "（那意味着图知道旁路存在、甚至等它的结果；旁路是并行的只读观察者）",
      );
    }
    if (crossesOut && e.to !== "client") {
      problems.push(
        `旁路的出口只能是端上：${e.from} → ${e.to}（它够不着任何业务能力）`,
      );
    }
  }

  // **组合出来的，不是手抄的**——这条一红就说明有人开了第二份副本。
  const total = new Set(TOTAL_NODES.map((n) => n.id));
  for (const n of [...WORKFLOW_NODES, ...SIDECAR_NODES]) {
    if (!total.has(n.id)) problems.push(`细节图有、总链路没有：${n.id}（总图必须是组合出来的）`);
  }

  return problems;
}

/** 旁路自检。同样要跑——它一样会漂，而且更没人看。 */
export function validateSidecar(): string[] {
  return structuralProblems(SIDECAR_NODES, SIDECAR_EDGES, "turn");
}

/**
 * 唤醒入口自检。
 *
 * 这张图额外守一条主链路那边不需要的：**未命中必须有一条通往丢弃的路**。
 * 少了它，图上读起来就成了「所有转写最终都会进主链路」——
 * 而那正好是这条链路承诺不做的那件事。
 */
export function validateWake(): string[] {
  const problems = structuralProblems(WAKE_NODES, WAKE_EDGES, "micSwitch");
  if (!WAKE_EDGES.some((e) => e.from === "classify" && e.to === "discard")) {
    problems.push("判定后缺少「未命中即弃」这条路（AC-52-5 的隐私底线）");
  }
  // 进主链路的每条边都必须是条件边：无条件就成了「听到什么都往上送」。
  const toGraph = WAKE_EDGES.filter((e) => e.to === "handoff");
  if (toGraph.length === 0) problems.push("唤醒图没有接回主链路 START");
  for (const e of toGraph) {
    if (!e.conditional) problems.push(`进主链路的边必须是条件边：${e.from} → ${e.to}`);
  }
  return problems;
}
