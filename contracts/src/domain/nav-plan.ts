/**
 * 出发导航方案（施工单 M66-01，FL-18 F-18-15 数据面）。
 *
 * 「开始行程」那一下产出的东西：从此刻位置到今天第一站，走什么策略、途中在哪歇、每段多久。
 * 生产方是 agent-runtime 的 `subgraphs/nav-plan.ts`（汇聚后的形状），消费方是网关（原样透传）与车机端出发卡。
 *
 * # 它不落库
 *
 * 方案带着"此刻"的起点，寿命是一次出发（分钟级）。`TripPlanSnapshot.nav`（M31）记的是"正在导航第几天"，
 * 两者不是一回事：这里是**怎么去**，那里是**在不在去**。本文件不碰那个字段。
 *
 * # 途经点是零信任过滤后的
 *
 * `waypoints[]` 里的每一个都经汇聚层与本轮 `map_route` 返回过的服务区按名字+坐标全等核对过
 * （ADR-008 的推论：模型给的坐标当零信息）。被丢掉的会在 `caveats` 里计数——端上如实显示，不补。
 */

/** 端上可见的两档策略。工具层有四档（含 `default` / `no_highway`），本 Sprint 只暴露画像会落到的两档。 */
export type NavRouteStrategy = "highway" | "less_toll";

export interface NavPlanOrigin {
  lat: number;
  lon: number;
  /** `fix` = 端上最近一次定位；`home` = 常住地兜底（网关补的）。 */
  source: "fix" | "home";
  /** 定位距现在多少分钟（`fix` 才有）。老定位不拒绝，但要说出来。 */
  ageMinutes?: number;
}

export interface NavPlanWaypoint {
  name: string;
  lat: number;
  lon: number;
  /** 距出发约多少分钟处。 */
  atMinute?: number;
  /** 为什么选它（模型的一句话，针对同行者的需要）。 */
  reason?: string;
}

/** 一条被带入的硬约束及其出处（称呼列表，展示用）。 */
export interface NavPlanConstraint {
  text: string;
  from: string[];
}

export interface NavPlan {
  origin: NavPlanOrigin;
  destination: { name: string; lat: number; lon: number };
  strategy: NavRouteStrategy;
  /** 「按你平时省钱的偏好」/「默认走高速」——卡上原样显示。 */
  strategyReason: string;
  summary: { distanceKm: number; durationMin: number; tollYuan: number };
  waypoints: NavPlanWaypoint[];
  /** 休息点把路线切成的各段分钟数（`waypoints.length + 1` 段）；空 = 没拿到分段。 */
  legMinutes: number[];
  /** 同行者约束推出的单段上限；没有约束就没有。 */
  maxLegMinutes?: number;
  constraints: NavPlanConstraint[];
  /** 起点估算、被丢弃的途经点、超上限的段、省钱方案仍有过路费……端上逐条显示。 */
  caveats: string[];
  computedAt: string;
}

export type NavPlanStatus = "ready" | "failed";

/** `POST /v1/trip-plan/nav-plan` 的请求体。行程由网关按鉴权身份取，**不在这里传**。 */
export interface NavPlanRequest {
  /** 端上最近一次定位；没有就省略，网关退到常住地。`at` 是 ISO 采集时刻。 */
  origin?: { lat: number; lon: number; at?: string };
  /** 当前绑定的车（用于取该车的常用人员）；没有就按车主全部车辆。 */
  vin?: string;
}

export interface NavPlanResponse {
  status: NavPlanStatus;
  plan?: NavPlan;
  /** 网关侧从收到请求到拿到方案的毫秒数（排障与验收用）。 */
  elapsedMs?: number;
  /** failed 时一句可展示/可排障的原因（`no_plan` / `no_origin` / `timeout` / `failed`）。 */
  reason?: string;
}

/**
 * 方案能不能用来导航：有终点坐标即可。**空途经点不是不可用**——它是"这段不需要歇 / 没找到服务区"，
 * 起终点直连照样能导。这条判据在端上决定按钮走"方案"还是"直连"，两端一份规则。
 */
export function navPlanIsUsable(plan: NavPlan | undefined | null): plan is NavPlan {
  if (!plan) return false;
  const d = plan.destination;
  return (
    typeof d?.lat === "number" &&
    typeof d?.lon === "number" &&
    Number.isFinite(d.lat) &&
    Number.isFinite(d.lon) &&
    !(d.lat === 0 && d.lon === 0)
  );
}
