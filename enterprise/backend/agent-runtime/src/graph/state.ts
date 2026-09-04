/**
 * graph/state —— 图状态 schema（施工单 M2-02，M4-04 扩展）。
 *
 * 图状态即 ①Working 短期任务状态（§7①）：跨轮上下文的唯一承载。
 * 对话历史表（PG）不回灌模型；模型看到的历史来自这里。
 * 状态必须完全可序列化（FL-11 F-11-02 / FL-14 约束）——
 * **不得放函数、连接句柄、流对象、AbortController**：M4-06 要把它落 PG，放进去就炸。
 *
 * M4-04 新增的三个字段一律**可选**，保证旧检查点仍可读（切 PG 时会遇到）。
 */

import { Annotation } from "@langchain/langgraph";

import type { CompanionConstraint } from "./companions";
import type { TripPlanDaySnapshot, TripPlanSnapshot } from "@carlife/shared";
import type { ChatTurnMessage } from "../llm";
import type { ConsultationState } from "./subgraphs/service";
import type { RiskCategory, RiskDecision } from "../guard/risk-policy";

/**
 * 意图理解的四要素（§4.2、FL-11 F-11-01）。
 *
 * **它不是分类结果**。US-11 给的失败样例是"带我妈去黄山"被归为"出行规划"后，
 * "我妈"携带的时长约束就丢了——最终方案看起来完全正常，只有真的带着老人上路才发现问题。
 * 所以 `constraints` 是这个结构里最重要的字段，不是附属信息。
 */
export interface Intent {
  goal: string;
  /** 硬约束（同行者、时间窗、预算…）。**丢掉约束的分类等于没有理解。** */
  constraints: string[];
  context: string;
  /** 风险边界的**自由文本**说明——给人看的归因，进轨迹。判定用下面那一栏。 */
  riskBoundary: string;
  /**
   * 风险边界的**枚举判定**（AC-11-7）。由 LLM 在意图理解里给出，处置表在
   * `guard/risk-policy.ts`。`riskBoundary` 那一栏是散文，代码判不了；这一栏才是判据。
   *
   * **可选是为了旧检查点**（与 M4-04 那三个字段同一个理由）：切 PG 之前落的
   * 检查点里没有它，读出来是 undefined。`riskDecision()` 把 undefined 当
   * `unknown` 处理——放行并告警，不当作"无风险"。
   */
  riskCategory?: RiskCategory;
  /**
   * 这一轮该交给谁（M13-13）。**由 LLM 在意图理解里给出**，取值见 `ROUTE_TARGETS`。
   *
   * 模型没给、或给了候选表外的值时是 undefined——那时 `decideRoute` 退回规则表兜底
   * （离线/fake 路径根本不跑意图节点，也走同一条兜底）。
   */
  route?: string;
  /**
   * 顺带的副任务（ACR-023 / M69-01，F-11-06）：这一轮里**另外**要办的、不同领域的事。
   *
   * **只有 LLM 给**——规则表与粘性规则不产生副路由，也没有正则兜底（§4.5：判据是字面的而人的说法不是）。
   * 每项的 `route` 取值同 `ROUTE_TARGETS`、不得等于主 `route`、不得是 general；`goal` 是意图层改写的一句规范说法，
   * **必须自带地点与对象**（「在杭州预约一次保养」）：副 lane 与主 lane 并行、看不到主 lane 本轮的产出，地点只能从这里来。
   * 按 N 设计，上限 `MAX_SIDE_TASKS`（intent.ts）；可选是为了旧检查点。
   */
  sideTasks?: SideTask[];
  /**
   * 对已有行程草案的处置（M13-14）：`commit` / `cancel` / `cancel_all` / `none`，
   * 取值见 `PLAN_ACTIONS`。同样由 LLM 给，没给时退回 `itinerary.ts` 的正则兜底。
   *
   * 与 `route` 是两回事：route 说"交给谁"，action 说"要它干什么"。
   * 「帮我创建该行程」两者都要——route=itinerary 且 action=commit；
   * 只判出前者的表现是又规划一轮，弹窗始终不出现。
   */
  action?: string;
  /**
   * 车主这一轮提到的**具体时间点**，已标准化（M19-08）。
   *
   * # 为什么这一栏必须由 LLM 给
   *
   * 试驾选时段的判据原来全是正则，这个 Sprint 里翻了三次车，每次都是补一条正则：
   * 「下午三点」（12 小时制 + 中文数字）、「上午」是否含 11 点、
   * 「八月十七十点」（不带「号」字，且贪婪匹配吞成 `十七十`）。
   * **判据是字面的，而人的说法不是**——补正则只是把下一次翻车推后。
   *
   * 而 `turn-504db099` 那次，意图节点其实已经理解对了
   * （`constraints: ["日期：8月17日","时间：上午10点"]`），只是没人用。
   *
   * 与 `action` 是同一个搬法（那一栏也是从 `itinerary.ts` 的正则表迁过来的），
   * **正则同样没删，退成兜底**——意图节点会降级，那时还得认得出「14号10点」。
   *
   * # 模型给不出就留空
   *
   * **不要它猜。** 猜出来的日期会去过滤真实时段表，过滤出空集的表现是
   * "你选的那个时段不存在"，而排查方向完全不指向这里。
   */
  when?: {
    /** `YYYY-MM-DD`；只说了「十七号」没说月份时给 `--DD`。 */
    date?: string;
    /** **24 小时制**整点 0~23。「下午三点」是 15 不是 3。 */
    hour?: number;
  };
  /** 解析失败时的降级标记——理解层挂了不该把正常对话堵死（与 §8.2 input fail-open 同源）。 */
  degraded?: boolean;
}

/** 一件顺带的副任务：交给谁 + 一句自带地点的规范说法（ACR-023）。 */
export interface SideTask {
  route: string;
  goal: string;
}

/** 路由决策与依据（F-11-07：路由错误只表现为"答非所问"，没有埋点就无法归因）。 */
export interface RouteDecision {
  agent: string;
  reason: string;
  /**
   * 副路由（ACR-023）：与主路由同源——同一次意图理解给出，`decideRoute` 只在 LLM 路由生效时透传。
   * 规则表兜底、粘性规则路径下恒为空：那两条路没有模型的判断，不该凭空长出第二件事。
   */
  secondary?: SideTask[];
}

/**
 * 一条 lane 跑完的结果（ACR-023 分叉—汇合）。主 lane 写 `primaryLane`，副 lane 写 `sideLanes[本节点名]`。
 *
 * `patch` 用结构化写法不引用图类型：图状态要能序列化进检查点（与 `BuyingPlanState` 同一取向）。
 * `join` 节点按 `compound.ts` 的 `joinLanes` 把它们汇进主状态——lane 自己**不直接写** `agentResults` / `tripPlan` 这些通道，
 * 否则同 superstep 并行的两条 lane 会在 last-write reducer 上互相覆盖。
 */
export interface LaneResult {
  lane: "primary" | "side";
  /** 图节点名（`branchFor` 的返回值，副 lane 记的是主节点名，副节点名由 `sideNodeOf` 推）。 */
  node: string;
  /** 路由目标（主 lane 是 `route.agent`，副 lane 是 `SideTask.route`）。 */
  agent: string;
  goal?: string;
  status: "ok" | "failed" | "skipped";
  patch: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
  error?: string;
}

/**
 * 风险边界判定与处置（AC-11-7）。策略表在 `guard/risk-policy.ts`。
 *
 * 与 `RouteDecision` 同形：判定与依据一起存，否则回放时看得到"被拒了"
 * 却看不出"凭哪一类拒的"，而这一栏正是要用来判断门是不是判宽了。
 */
export interface RiskVerdict {
  category: RiskCategory;
  decision: RiskDecision;
}

/** 待澄清取消的候选（M13-12）。 */
export interface PendingCancelState {
  /** 候选行程，顺序与助手念出来的编号一致——"第二个"要能对上。 */
  candidates: Array<{ planId: string; label: string }>;
  /** 问出这个问题的轮次；只为排查时能对上，不参与判定。 */
  askedTurnId: string;
}

export const GraphState = Annotation.Root({
  /** 会话内消息序列（user/assistant 交替），reducer 追加。 */
  messages: Annotation<ChatTurnMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),

  /** 本轮意图四要素；每轮覆盖（不累积——它描述的是"这一轮要什么"）。 */
  intent: Annotation<Intent | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 本轮风险边界判定；每轮覆盖（与 intent/route 同语义）。
   *
   * `deny` 时这一轮到此为止——`riskGate` 之后不再有节点跑。
   */
  risk: Annotation<RiskVerdict | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /** 本轮路由决策；每轮覆盖。 */
  route: Annotation<RouteDecision | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 本轮各 Agent 分支的结果（F-13-09：下游只读状态，不重新问 Agent）。
   *
   * **每轮覆盖，不跨轮累积**——与 `intent`/`route` 同语义。
   * 累积语义踩过一次坑：第 1 轮的出行求解结果留在状态里，第 4 轮问天气时
   * 被当作"编排层已完成的求解"注入上下文，模型据此作答而**不再调用工具**
   * （smoke:acp 的"工具确实被执行"断言抓到了它）。
   * 一轮之内的多分支汇聚由 `mergeBranches` 在节点内完成，不依赖 reducer 累积。
   */
  /*
   * ── 座舱的三个状态字段已退休（M24 收口，全面 A 型）───────────────
   *
   * `cabinSeating` / `cabinPendingPreference` / `cabinRoundOverride` 都是
   * "编排层用正则理解人话"留下的状态位：谁坐哪、草案等谁确认、这一轮临时改了什么。
   * 改 A 型后三件事各归其位——谁坐哪进 `cabin_apply_preferences` 的入参；
   * 确认时序归权限门（确认前不落库由它保证，不再需要草案状态位）；
   * 本轮覆盖本来就只作用于这一次，模型看着上下文直接下发即可。
   *
   * 图状态里少三个字段，检查点也少三处要兼容的形状。
   */
  agentResults: Annotation<Record<string, string>>({
    reducer: (_left, right) => right,
    default: () => ({}),
  }),

  /**
   * 本轮**有分支彻底没跑成**（超时/失败/没交结构化字段）。
   *
   * # 它与 `missing` 不是一回事，别合并
   *
   * `missing` 里有两类东西，对应两种完全不同的处置：
   *  - **"查了但没有"**（`unmetAsks`：问的日期超出预报覆盖）——编排层已经尽力了，
   *    再问一次也是同样结果，应答如实说"这次没查到"就是最好的交付。
   *  - **"根本没跑完"**（分支超时/失败）——编排层没尽力，而应答那一侧
   *    **还有工具、还有机会补**。
   *
   * 分不开的代价实测过（turn-9fffa45d）：两条分支双双 60 秒超时，
   * 求解结果里除了能源类型一无所有，而表述路径（无工具）只能把三件事
   * 逐条报告"没拿到"——2 秒交付一份完全没用的答案。
   * 而同样的局面在 ACP 那条路上，应答模型会自己去调 weather 补回来一部分。
   *
   * **每轮覆盖**，与 `agentResults` 同语义。
   */
  solverDegraded: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),

  /**
   * 多天行程草案（M12-03，设计定稿 内部文档）。
   *
   * # 与 `agentResults` 的关键差别：**跨轮存活**
   *
   * `agentResults` 每轮覆盖清空——那是"本轮求解结果"。行程草案是"进行中的方案"：
   * 第 1 轮出骨架、第 2 轮说「第一天再细化」时它必须还在，否则细化轮只能从
   * 对话历史里猜——而"让意图理解每轮重新推导历史"正是 route.ts MIN_SCORE
   * 那次事故的根因，不能再走一遍。
   *
   * reducer 右值覆盖：itinerary 轮写整份更新后的 plan；其它节点不写它，
   * LangGraph 对未返回的 channel 保留旧值——跨轮存活由此而来，不需要特殊 reducer。
   * 过期跟随 thread 24h 轮换（检查点一起作废），不另建过期机制。
   */
  tripPlan: Annotation<TripPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 待澄清的取消（M13-12）。**跨轮存活**，与 `tripPlan` 同机制。
   *
   * # 为什么必须有它
   *
   * 名下有多份已确认行程时，取消要问"取消哪一份"——**而问了就得记住问过**。
   * 实测漏了这一条：助手问完，车主答「确认」，那一轮没有任何上下文表明
   * 上一句是个问题，于是「确认」两个字既不是取消指涉也不是确认指涉，
   * 被判成规划请求送进 fan-out，回一句"找不到"。
   * 提问却接不住回答，比不提问更糟——车主已经答了。
   *
   * 存的是候选的 planId 与一句话描述：下一轮据此认「全部」「第二个」「确认」。
   * 一轮用完即清（`itineraryNode` 处理后写 undefined），不留着误伤后面的对话。
   */
  pendingCancel: Annotation<PendingCancelState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次售后问诊（M14-03，F-20-13）。**跨轮存活**，与 `tripPlan` 同机制：
   * 问诊发生在第 N 轮，"帮我记录下来"发生在第 N+1 轮——每轮清空就没有可留档的对象。
   * service 问诊轮写入，answer 轮补回答摘要，留档成功置 `archived`；
   * 其余节点不写它，LangGraph 保留旧值。过期随 thread 24h 轮换。
   */
  consultation: Annotation<ConsultationState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次五年成本测算（M15-02，F-15-05）。**跨轮存活**，与 `tripPlan` 同机制。
   *
   * 它存在的唯一理由是「改一个假设重算」：车主说"我一年跑 3 万公里"时，
   * 要在**上一轮那份假设**上只覆盖 annualKm，车价、能源、年限原样保留。
   * 每轮清空的话，重算就得重新问一遍车价——那等于告诉他"我忘了刚才在算什么"。
   */
  costPlan: Annotation<CostPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次车型候选收敛（M15-05，F-15-14）。**跨轮存活**，与 `costPlan` 同机制。
   *
   * 存在的唯一理由是**购车功能页要读得到它**：`agentResults` 每轮覆盖，
   * 而且应答节点跑完之后它里面装的是助手回复而不是候选结构
   * （`answerNode` 的返回值会把 `agentResults[agent]` 覆盖成 `full`）。
   * 页面在用户切过去的那一刻要能显示上一轮比过的那几款车，不能要求他重问一遍。
   */
  buyingPlan: Annotation<BuyingPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次配置比较（M21-03，F-47-08）。**跨轮存活**，与 `buyingPlan` 同机制。
   *
   * 与 `buyingPlan` 分开：那是车型级收敛，这是配置级比较。
   * 合并的话，只问配置的一轮会把上一轮的候选收敛结论覆盖掉。
   */
  trimPlan: Annotation<TrimPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次贷款测算（M21-04，F-48-01）。**跨轮存活**，与 `costPlan` 同机制。
   *
   * 与 `costPlan` **分开存**：一个是买车的钱怎么付，一个是用车的钱花多少。
   * 合在一起会让两边的假设表纠缠——改一个"年行驶里程"不该动到月供。
   */
  loanPlan: Annotation<LoanPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次保费估算（M21-05，F-48-06）。**跨轮存活**，与 `loanPlan` 同机制。
   *
   * 它同时是「同一轮里保险数字口径唯一」（AC-48-7）的载体：
   * 成本测算要用分项合计当首年保险时，从这里取。
   */
  insurancePlan: Annotation<InsurancePlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 试驾预约的进行中状态（M19-04）。**跨轮存活**，与 `tripPlan` 同机制。
   *
   * 「查店 → 选店 → 查时段 → 选时段 → 确认」跨好几轮，
   * 选中的门店与时段必须还在——每轮清空就只能从对话历史里猜，
   * 而"让意图理解每轮重新推导历史"正是 route.ts MIN_SCORE 那次事故的根因。
   */
  testDrivePlan: Annotation<TestDrivePlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 维修预约的进行中状态（M44-02）。**跨轮存活**，与 `testDrivePlan` 同机制、
   * 同一条理由：「查站 → 选站 → 对时段 → 联系方式 → 确认」跨好几轮，
   * 每轮清空就只能从对话历史里猜。
   */
  repairBookingPlan: Annotation<RepairBookingPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 本轮由常用人员档案带入的硬约束（施工单 M17-05，F-46-10）。
   *
   * 与 `intent` 同频、每轮覆盖：它是"这一轮提到了谁"的结果，跨轮保留会让
   * 上一轮的同行人一直跟着。约束文本已经并进 `intent.constraints`（下游求解认那一份），
   * 这个 channel 存的是**出处**——应答层要能说"单段不超过 90 分钟是因为妈妈晕车"。
   */
  companionConstraints: Annotation<CompanionConstraint[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),

  /**
   * 主 lane 的结果（ACR-023 / M69-01）。每轮由 `dispatch` 清空，`join` 读。
   * last-write：一轮只有一条主 lane。
   */
  primaryLane: Annotation<LaneResult | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 副 lane 的结果，按副节点名键控（`sideOwnershipDual` …）。
   *
   * **这是本 ACR 唯一一个不是 last-write 的新通道**：多个副节点在同一个 superstep 各写自己的键，
   * last-write 会让后落的覆盖先落的。更新为 `null` 即清空（`dispatch` 每轮发一次）。
   */
  sideLanes: Annotation<Record<string, LaneResult>, Record<string, LaneResult> | null>({
    reducer: (left, right) => (right === null ? {} : { ...left, ...right }),
    default: () => ({}),
  }),

  /**
   * 副任务的求解文本，键 = Agent 名（与 `agentResults` 同口径，由 `join` 从各副 lane 的 patch 改道而来）。
   * 主副分两个通道是为了同 superstep 不撞 last-write；`answer` 的 `composeSolved` 主取 `agentResults`、副取这里。
   */
  sideResults: Annotation<Record<string, string>>({
    reducer: (_left, right) => right,
    default: () => ({}),
  }),
});

/**
 * 多天行程草案。字段语义见设计文档；名字（spots/hotel.name）必须来自 poi_search。
 *
 * M13-01 起形状真相源在 `@carlife/shared`（`TripPlanSnapshot`）——网关返回给座舱的
 * 与图状态里的必须是同一份契约，两处定义必然漂移。status 因此多出
 * `confirmed` / `cancelled` 两态（M13-02 确认路径写入）。
 *
 * `committedPlanId` 是图状态**私有**的增量：确认落库后的行 id，
 * 细化轮经 structuredClone 保留——「行程取消掉」靠它判断 PG 里有没有要置位的行
 * （确认→细化→取消的路径上 status 已回 refining，光看 status 会漏掉 PG 那一行，
 * HUD 就会一直挂着一份用户已经不要了的行程）。
 * 它**不进落库快照**：`trip_plan_commit` 的 zod 是 strip 模式，多余键自然剥掉。
 */
export type TripPlanState = TripPlanSnapshot & { committedPlanId?: string };

/**
 * 一次候选收敛的完整快照。结构由 `subgraphs/buying.ts` 定义，
 * 这里用结构化写法而不是 import 那边的类型：图状态要能被序列化进检查点，
 * 与子图的类型演进解耦（同 `CostPlanState` 的取向）。
 */
export interface BuyingPlanState {
  candidates: BuyingCandidateSnapshot[];
  eliminated: BuyingCandidateSnapshot[];
  universe: { model: string; documents: string[] }[];
  constraints: Record<string, unknown>;
  unclassifiedDocs: number;
  at: number;
}

export interface BuyingCandidateSnapshot {
  model: string;
  specs: { label: string; value: string; source: BuyingSourceSnapshot }[];
  guidePrice?: { amount: number; trim: string; source: BuyingSourceSnapshot };
  eliminatedBy?: { dimension: string; reason: string }[];
  /** 配置级事实（M21-02）。拿不到报价系统时缺省，判定回落到车型级。 */
  trimSpecs?: { trim: string; priceCny?: number; rangeKm?: number; seats?: number }[];
  /** 让这台车通过硬约束的是哪几个配置（M21-02）——「六座来自 Model Y L」靠它。 */
  matchedTrims?: string[];
}

/**
 * 一次贷款测算的快照（M21-04，F-48-01）。
 *
 * `breakdown` 的结构由 `enterprise/backend/shared/tools` 的 `LoanBreakdown` 定义，这里用结构化写法
 * 而不是 import 它——图状态要能序列化进检查点，与工具的类型演进解耦（同 `CostPlanState`）。
 */
export interface LoanPlanState {
  breakdown: {
    vehiclePrice: number;
    downPayment: number;
    downPaymentRatio: number;
    principal: number;
    months: number;
    /** `source` 一律非空：**不存在无标注的利率**。 */
    annualRate: { low: number; high: number; source: "user" | "assumed" };
    equalInstallment: {
      monthlyPayment: { low: number; high: number };
      totalInterest: { low: number; high: number };
      totalPayment: { low: number; high: number };
    };
    equalPrincipal: {
      firstMonthPayment: { low: number; high: number };
      lastMonthPayment: { low: number; high: number };
      totalInterest: { low: number; high: number };
      totalPayment: { low: number; high: number };
    };
    cashVsLoan: { extraInterest: { low: number; high: number }; cashKept: number; note: string };
    notes: string[];
  };
  model: string;
  priceSource: { document: string; trim: string; kind: string };
  /** 车主自己转述了免息方案。**系统从不主动声称任何品牌有免息。** */
  interestFreeClaimed: boolean;
  at: number;
}

/**
 * 一次保费估算的快照（M21-05，F-48-06）。
 *
 * 与 `LoanPlanState` 同样用结构化写法而不是 import 工具层的类型——
 * 图状态要能序列化进检查点。
 */
export interface InsurancePlanState {
  quote: {
    items: { key: string; label: string; amount: { low: number; high: number }; note?: string }[];
    /** **`usable: false` 时不存在**——给了，车主记住的就是那个数。 */
    total?: { low: number; high: number };
    usable: boolean;
    assumptions: {
      compulsory: { low: number; high: number; source: "user" | "assumed" };
      damageRate: { low: number; high: number; source: "user" | "assumed" };
      passengerPerSeat: { low: number; high: number; source: "user" | "assumed" };
      coefficientsEffectiveFrom: string;
    };
    notes: string[];
  };
  model: string;
  priceSource: { document: string; trim: string; kind: string };
  at: number;
}

/**
 * 一次配置比较的快照（M21-03，F-47-08）。**跨轮存活**，与 `buyingPlan` 同机制。
 *
 * 与 `buyingPlan` 分开存而不是塞进去：那一份是**车型级**收敛的结果（哪几台进候选、
 * 哪台被什么淘汰），这一份是**配置级**的比较（哪个配置对哪个、差在哪）。
 * 合在一起的话，只问配置的那一轮会把上一轮的候选收敛结论一起覆盖掉。
 */
export interface TrimPlanState {
  models: string[];
  rows: { model: string; trim: string; priceCny?: number; rangeKm?: number; seats?: number }[];
  alignment: string;
  alignmentNote: string;
  pairs: {
    left: { model: string; trim: string };
    right: { model: string; trim: string };
    diffs: { field: string; label: string; left?: number; right?: number; delta?: number; note?: string }[];
    marginalPricePerKm?: number;
  }[];
  unpricedModels: { model: string; note: string }[];
  missingModels: string[];
  /** 被整车价下界挡掉的行。**留着是因为静默截断读起来像"覆盖了全部"。** */
  droppedRows: { model: string; trim: string; priceCny: number; reason: string }[];
  /** 配置说明的出处（来自 `car-catalog`）。检索不到就是空数组，不补。 */
  sources: BuyingSourceSnapshot[];
  at: number;
}

/** 可点开的出处。`snippet` 是**原文片段**不是摘要——摘要是我们写的，片段才可核对。 */
export interface BuyingSourceSnapshot {
  document: string;
  snippet: string;
  score: number;
}

/** 门店（来自 `dealer_stores`，**不是模型编的**）。 */
export interface TestDriveStore {
  storeId: string;
  name: string;
  district: string;
  address: string;
  distanceKm?: number;
}

/** 可预约时段（来自 `dealer_slots`）。`slotId` 带不可猜的签名后缀，编一个会被 404 拒掉。 */
export interface TestDriveSlot {
  slotId: string;
  startAt: string;
  endAt: string;
  remaining: number;
}

/**
 * 试驾预约的进行中状态。
 *
 * `status` 只是给上下文与测试看的路标，真正的推进判据是
 * `chosenStoreId` / `chosenSlotId` / `contact` 齐不齐——
 * 拿一个字符串当状态机唯一真相，改一处忘一处时它会说谎。
 */
/** 维修站（M44-02）。字段与 mock-repair 的 /stations 一致。 */
export interface RepairBookingStation {
  stationId: string;
  name: string;
  city: string;
  district: string;
}

/** 维修进厂窗口（M44-02）。remaining 来自维修站的容量减占用。 */
export interface RepairBookingSlot {
  slotId: string;
  startAt: string;
  remaining: number;
}

/**
 * 维修预约的进行中状态（M44-02）。形状照 `TestDrivePlanState`——
 * 同一套"明文不进图状态"的纪律：`contactRef` 只有尾号，真号由工具层按
 * `memberId` 自己取（M44-01 的 appointment 档案路）。
 */
export interface RepairBookingPlanState {
  /** 目标车辆。来自默认车档案；缺失时子图只引导建档、不下单。 */
  vin?: string;
  /** 预估维修项目（自由文本给维修站参考，不是防编面）。 */
  items: string;
  city?: string;
  stations: RepairBookingStation[];
  chosenStationId?: string;
  slots: RepairBookingSlot[];
  chosenSlotId?: string;
  /** 车主当场口述的联系方式。**档案里查得到时不该走这条**——见 `contactRef`。 */
  contact?: { name: string; phone: string };
  contactRef?: { memberId: string; displayName: string; phoneTail: string };
  orderId?: string;
  status: "choosing_station" | "choosing_slot" | "confirming" | "booked" | "cancelled";
  at: number;
}

export interface TestDrivePlanState {
  model: string;
  trim?: string;
  city?: string;
  district?: string;
  stores: TestDriveStore[];
  chosenStoreId?: string;
  slots: TestDriveSlot[];
  chosenSlotId?: string;
  /** 车主当场口述的联系方式。**档案里查得到时不该走这条**——见 `contactRef`。 */
  contact?: { name: string; phone: string; note?: string };
  /**
   * 档案里登记的联系方式（M19-06）。
   *
   * **只有后四位**，明文留在库里，下单时由工具层按 `memberId` 自己取。
   * 图状态会进检查点、会被回放页读到，所以这里放明文等于给它开了三条外泄路径。
   */
  contactRef?: { memberId: string; displayName: string; phoneTail: string };
  orderId?: string;
  status: "choosing_store" | "choosing_slot" | "confirming" | "booked" | "cancelled";
  at: number;
}

/**
 * 一次成本测算的完整快照。
 *
 * `priceSource` 必须留着：下一轮重算时要沿用同一个车价，而"这个车价哪来的"
 * 在重算轮同样要说得出——车主问"你按多少钱算的"，答不上就等于这个数是编的。
 */
export interface CostPlanState {
  /** `CostBreakdown`（`@carlife/tools`）。放宽成结构体避免图状态与工具版本耦合。 */
  breakdown: {
    years: number;
    items: Record<string, number>;
    total: number;
    perKm: number;
    assumptions: Record<string, number>;
    notes: string[];
  };
  model: string;
  energy: "bev" | "phev" | "icev";
  priceSource: { document: string; trim: string; kind: "user" | "dealer" | "catalog" };
  /** 本轮被覆盖的假设名。空数组＝这是第一次算。 */
  changed: string[];
  at: number;
}

export type TripPlanDay = TripPlanDaySnapshot;

export type GraphStateType = typeof GraphState.State;
