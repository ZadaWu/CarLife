/**
 * 用户长期状态（施工单 M84-03，ACR-036 §4.9）。
 *
 * # 它是什么
 *
 * 「这个人是谁、他那辆车怎么样、他手上有几份已经定下来的行程」——每一轮对话都用得上、
 * 一个线程内基本不变的那些事实。与 `TaskState` 的分工：那个是"正在办的事"（会变），
 * 这个是"他的底细"（一个线程内钉死）。
 *
 * # 它**不另存**
 *
 * 每一段都是从既有权威源投影出来的：④ `vehicles`、`owner_profiles`、`vehicle_members`、
 * `trip_plans`、`vehicle_reminders`、Mem0 ③ 与 ⑥ 摘要。这里只定义"投影成什么形状"，
 * 不定义存储——再存一份就有了第二个真相源，而两份必然漂移。
 *
 * # 为什么"读不到"与"没有"必须分开
 *
 * 空值会被下游当成"他没有车 / 没有行程"，然后据此说话。`recallEpisodesFor` 已经踩过这一次
 * （`supervisor.ts`：降级时返回一句"这次没读到"而不是空）。所以每一段都可以是
 * `{ unavailable: true, reason }`，渲染时如实写出来。
 *
 * # 这里没有"读取时刻"
 *
 * **任何随每次读取变化的值都不许进来**——锚定块要能在一个线程内逐字复用，掺进一个
 * `asOf: Date.now()` 就等于每轮换一次前缀，而前缀缓存只认从第 0 个 token 起完全相同。
 * 时间戳只有**事实被记录的时刻**（如 `odometerAsOf` 来自 `vehicles.odometer_at`）才能进，
 * 而"距今多久"这种相对表述归本轮尾区（Z3），不归这里。
 */

/** 这一段读不到。**与"没有"是两件事**，见文件头。 */
export interface ContextUnavailable {
  unavailable: true;
  /** 说得出口的原因，会被原样渲染给模型看。 */
  reason: string;
}

export type ContextMaybe<T> = T | ContextUnavailable;

export function isContextUnavailable(v: unknown): v is ContextUnavailable {
  return typeof v === "object" && v !== null && (v as ContextUnavailable).unavailable === true;
}

/** 上下文的分段。投影表（谁看得到哪几段）在 `agent-runtime/src/context/render.ts`。 */
export const CONTEXT_SECTIONS = [
  "identity",
  "vehicle",
  "home",
  "companions",
  "trips",
  "reminders",
  "preferences",
  "usage",
] as const;

export type ContextSection = (typeof CONTEXT_SECTIONS)[number];

export interface ContextIdentity {
  userId: string;
  /** 称呼。**不是真名**——车机上「谁在用车」选的那个名字。 */
  displayName?: string;
  role: "owner" | "member" | "guest";
}

export interface ContextVehicle {
  vin?: string;
  model?: string;
  modelYear?: number;
  /** `bev` / `phev` / `fuel` …（`VehicleEnergyType`）。缺席 = 不知道，下游不得假设。 */
  energyType?: string;
  odometerKm?: number;
  /** 这个里程数**是什么时候的**（`vehicles.odometer_at`）。空 ≠ 很久以前，是"不知道"。 */
  odometerAsOf?: number;
  /** owner-stated / dealer / telemetry。空 = 不知道来源，不得说成"根据行驶记录"。 */
  odometerSource?: string;
  maintenanceIntervalKm?: number;
}

export interface ContextHome {
  city: string;
  lat: number;
  lon: number;
}

/** 同行的人。**不含联系方式**——`vehicle_members.phone` 一律不进任何投影。 */
export interface ContextCompanion {
  label: string;
  relation?: string;
  /** adult / senior / child */
  ageBand?: string;
  /** 出行硬约束，取值来自 `MEMBER_NEEDS` 受控词表。 */
  needs: readonly string[];
}

/**
 * 一份已经定下来的行程的**指针**。只给认得出是哪一程的最少信息，
 * 正文由 `trip_plan_get` 按需取——大块塞进锚定块会把预算吃光，而多数轮次用不上它。
 */
export interface ContextTripPointer {
  ref: string;
  destination: string;
  days: number;
  startDate?: string;
  /** 正在导航第几天；缺席 = 没在导航。 */
  navDay?: number;
  /** 最新一次每日核查的严重度（M72）。 */
  reviewSeverity?: "none" | "notice" | "critical";
}

export interface ContextReminder {
  /** maintenance / inspection */
  kind: string;
  dueAt?: number;
  remainingKm?: number;
  /** 数据不足、走的通用周期——渲染时必须标注。 */
  degraded: boolean;
}

export interface ContextUsage {
  /** 一句话画像（近 30 天日均里程、常用充电时段…），由 ⑥ 的聚合摘要给。 */
  summary: string;
  /** 摘要还新鲜吗（`usage-telemetry/summary.ts` 的 `usable`）。false 时渲染要标"可能已过时"。 */
  usable: boolean;
}

/**
 * 一个人的长期状态。每一段可缺席（这个人确实没有）或读不到（`ContextUnavailable`）。
 *
 * **完全可序列化**（它要进 Redis 快照）：时间一律 epoch 毫秒，集合一律数组。
 */
export interface UserContext {
  userId: string;
  identity?: ContextMaybe<ContextIdentity>;
  vehicle?: ContextMaybe<ContextVehicle>;
  home?: ContextMaybe<ContextHome>;
  companions?: ContextMaybe<readonly ContextCompanion[]>;
  trips?: ContextMaybe<readonly ContextTripPointer[]>;
  reminders?: ContextMaybe<readonly ContextReminder[]>;
  preferences?: ContextMaybe<readonly string[]>;
  usage?: ContextMaybe<ContextUsage>;
}

/**
 * 注入块的固定头部。**一处定义**——它同时出现在直连的 system、pi 的 prime 与每轮的尾区，
 * 三处各写一份必然漂移。
 *
 * 优先级那一句是抄来的（OpenAI Agents SDK 的 memory precedence）：没有它，模型会把
 * 一个月前的偏好与车主刚说的话等量齐观。
 */
export const CONTEXT_BLOCK_HEADER =
  "【当前状态｜以下由系统提供，不是车主说的话；本轮原话 > 进行中任务 > 长期档案 > 偏好；同层新者胜】";
