/**
 * 业务视图的词表（2026-09-15，会话页轨迹抽屉的「业务视图」）。
 *
 * # 只放"名字怎么叫"，不放"怎么算"
 *
 * 业务人员查"大量用户反馈酒店规划不合理"，看到的应当是「住宿候选」而不是
 * `llm.hotel-task`，是「查酒店」而不是 `hotel_search`。这张表回答的只是称呼；
 * 一步做了什么、查了什么、答了什么，由 `business-view.ts` 从轨迹里算出来。
 *
 * # Agent 名不另起一份
 *
 * Agent 的中文名直接读 `graph-model.ts` 的 `AGENT_ROSTER`——那份有漂移守卫
 * （`graph-drift.test.ts` 拿它与后端 `AgentName` 逐个比），再抄一份就是又一个
 * 会静默漂掉的副本。这里只做规范名的归一（剥 `-task` / `-intent` / `-voice`，
 * 与后端 `canonicalAgent()` 同一规则）与查不到时的兜底。
 *
 * # 工具名是本地表，查不到就退回原名
 *
 * 工具的真相源在 `enterprise/backend/shared/tools`，控制台不依赖那个包
 * （它会把 DB / RAG 客户端一起拖进浏览器包）。所以这里是一张手工表，
 * **查不到宁可显示 `hotel_search` 也不编一个中文**——错的中文比英文原名更误导。
 */

import { AGENT_ROSTER, WORKFLOW_NODES } from "../workflow/graph-model";

/** 与后端 `canonicalAgent()` 同一规则：会话后缀不是 Agent 名的一部分。 */
export function canonicalAgent(name: string): string {
  return name.replace(/-(task|intent|voice)$/, "");
}

const ROSTER_LABEL: ReadonlyMap<string, string> = new Map(AGENT_ROSTER.map((a) => [a.name, a.label]));

/**
 * 业务口径下几个名字要换个说法：名册上的「编排 / 兜底」是研发视角，
 * 业务人员看到它时它正在做的事是"听懂这句话"。只覆盖这几个，其余照名册。
 */
const BUSINESS_AGENT_LABEL: Record<string, string> = {
  supervisor: "总控（理解问题 / 兜底回答）",
  direct: "表述模型",
  general: "通用助手",
  unknown: "未标注的模型调用",
};

export function agentLabel(rawAgent: string): string {
  const canon = canonicalAgent(rawAgent);
  return BUSINESS_AGENT_LABEL[canon] ?? ROSTER_LABEL.get(canon) ?? canon;
}

/** `-voice` 后缀 = 直连表述那一步（把求解结果讲成人话），业务视图单独点明。 */
export function agentRoleNote(rawAgent: string): string | undefined {
  if (rawAgent.endsWith("-voice")) return "把求解结果讲成给车主听的话";
  if (rawAgent.endsWith("-intent")) return "从这句话里抽出目标、约束与该交给谁";
  if (rawAgent.endsWith("-task")) return "并行分支：独立查资料、交回结构化结论";
  return undefined;
}

const TOOL_LABEL: Record<string, string> = {
  hotel_search: "查酒店",
  spot_search: "查景点",
  poi_search: "查地点（POI）",
  map_route: "算路线",
  transit_route: "查公共交通",
  weather: "查天气",
  charging: "查充电站",
  refuel: "查加油站",
  energy_gap: "算续航缺口",
  route_services: "查沿途服务",
  route_audit: "路线体检",
  plan_audit: "行程体检",
  city_districts: "查城市片区",
  destination_highlights: "查目的地亮点",
  pretrip_items: "出发前清单",
  web_search: "网页搜索",
  ragflow_retrieve: "查知识库（手册 / 维修资料）",
  usage_profile: "查这辆车的用车画像",
  vehicle_profile: "查车辆档案",
  vehicle_profile_write: "写车辆档案",
  vehicle_member: "查同行成员",
  member_preference_set: "记成员偏好",
  preference_recall: "取偏好记忆",
  repair_history: "查维修记录",
  repair_quote: "查维修报价",
  repair_slots: "查维修时段",
  repair_stations: "查维修网点",
  appointment: "预约（有副作用）",
  // `calendar` 工具已随 FL-31 下线（2026-09-16）。标签**刻意保留**：
  // 库里的历史会话轨迹还有它的调用记录，删了那些行就只显示裸工具名。
  calendar: "写日历（有副作用，已下线）",
  car_catalog: "查车型库",
  trim_compare: "比配置",
  cost_calc: "算用车成本",
  loan_calc: "算贷款",
  insurance_quote: "算保费",
  insurance_precheck: "保险预审",
  insurance_policy: "查保单",
  dealer_stores: "查门店",
  dealer_slots: "查试驾时段",
  dealer_pricing: "查门店价格",
  test_drive_book: "下试驾单（有副作用）",
  cabin_status: "读座舱状态",
  cabin_control: "座舱控制",
  cabin_media: "座舱媒体",
  cabin_child_mode: "儿童模式",
  cabin_apply_preferences: "应用座舱偏好",
  contact_lookup: "查联系人",
  contact_update: "改联系人",
  data_freshness: "查数据新鲜度",
  refuel_log: "记加油",
  trip_plan_query: "查已定行程",
  trip_plan_list: "列行程",
  trip_plan_commit: "确定行程",
  trip_plan_update: "改行程",
  trip_plan_cancel: "取消行程",
  trip_plan_nav: "行程导航",
  submit_hotels: "交回酒店名单",
  submit_tour_days: "交回逐天玩法",
  submit_drive_draft: "交回自驾草案",
  submit_transit: "交回大交通方案",
  submit_nav_plan: "交回导航方案",
  submit_guide_spots: "交回必玩点位",
  submit_guide_access: "交回到达与停车",
  submit_guide_comfort: "交回休憩与避雷",
};

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name;
}

/** 提交类工具是分支"交作业"的动作，业务视图把它单独标出来，不与查询混在一起数。 */
export function isSubmitTool(name: string): boolean {
  return name.startsWith("submit_");
}

/**
 * 图节点 → 业务说法。键是 `node.*` span 剥掉前缀后的图节点 id。
 * 查不到退回 `graph-model.ts` 上的节点 label（去掉换行），再退回原 id。
 */
const BUSINESS_NODE_LABEL: Record<string, string> = {
  observeAttachments: "看照片",
  understand: "理解问题",
  dispatch: "决定交给谁",
  riskGate: "安全边界检查",
  itineraryPlan: "行程规划（多位专家并行）",
  tripFanout: "出行规划（旧路径）",
  ownershipDual: "查手册 + 查这辆车的数据",
  buyingCatalog: "车型检索与费用测算",
  testDriveFlow: "试驾预约流程",
  cabinCompanion: "座舱操作",
  sideItineraryPlan: "顺带任务 · 行程规划",
  sideOwnershipDual: "顺带任务 · 用车 / 售后",
  sideBuyingCatalog: "顺带任务 · 购车",
  sideTestDriveFlow: "顺带任务 · 试驾预约",
  sideCabinCompanion: "顺带任务 · 座舱",
  join: "汇合主任务与顺带任务",
  answer: "组织最终回答",
};

const GRAPH_LABEL: ReadonlyMap<string, string> = new Map(
  WORKFLOW_NODES.map((n) => [n.id, n.label.replace(/\s*\n\s*/g, " ")]),
);

export function nodeLabel(nodeId: string): string {
  return BUSINESS_NODE_LABEL[nodeId] ?? GRAPH_LABEL.get(nodeId) ?? nodeId;
}

/** 路由目标（`route.agent`）的业务说法。 */
const ROUTE_LABEL: Record<string, string> = {
  itinerary: "出行 · 行程规划",
  trip: "出行",
  ownership: "用车助手",
  service: "售后",
  buying: "购车顾问",
  testDrive: "试驾预约",
  cabin: "座舱",
  general: "通用回答（不进任何专项）",
};

export function routeLabel(target: string): string {
  return ROUTE_LABEL[target] ?? ROSTER_LABEL.get(target) ?? target;
}

/** 风险边界门的类别说法。`unknown` 是门失效不是没风险，措辞上要看得出来。 */
/** 键与后端 `guard/risk-policy.ts` 的 `MODEL_RISK_CATEGORIES` 逐字一致。 */
const RISK_LABEL: Record<string, string> = {
  none: "无风险",
  "autonomous-driving": "自动驾驶决策",
  "vehicle-control": "车辆安全控制",
  "repair-verdict": "替代专业维修的结论",
  "safety-assurance": "安全承诺",
  "side-effect": "有副作用的动作",
  unknown: "门失效（判不出类别）",
};

export function riskLabel(category: string): string {
  return RISK_LABEL[category] ?? category;
}

export function cancelReasonLabel(reason: string | undefined): string {
  if (reason === "submitted") return "结论已交回，收尾被主动省掉（正常）";
  if (reason === "timeout") return "超时被取消";
  if (reason === "cancelled" || reason === undefined) return "被取消";
  return `被取消（${reason}）`;
}
