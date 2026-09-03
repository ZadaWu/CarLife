/**
 * domain/visibility — 数据可见域与权限矩阵（施工单 M48-06，
 * FL-57 F-57-01，
 * 设计 用户体系 §4）。
 *
 * # 为什么矩阵要是**数据**而不是散在各端点的 if
 *
 * M48-03 把判断写成了各端点的 `need: "member" | "owner"` 参数——能用，
 * 但"矩阵长什么样"这件事就只存在于人的脑子和设计文档里。加一个端点时
 * 靠人记得传对，而传错**不会有任何现象**（多给了权限尤其如此）。
 *
 * 落成数据之后，矩阵可以被逐格单测，改一格就会有用例红。
 *
 * # 三个域，三把键
 *
 *  - **私有域**（键=userId）：②情景 ③偏好、对话历史、个人行程计划、日历授权、按人聚合的⑥画像；
 *  - **车辆共享域**（键=vin，授权成员可见）：④车辆档案与保养维修、成员名单、整车⑥聚合；
 *  - **平台公共域**（无键）：车型库、知识库 RAG、⑤环境缓存。
 *
 * 行程流水是切面：车主按 vin 读全部驾驶记录，driver 只读自己开的——
 * 所以它不是一个"域"，是两条读取路径（见 `trip.ts` 仓储的两个入口）。
 *
 * # guest 不是一种授权
 *
 * 它是**没有账号**的状态（车机上车声明选了访客，`activeUserId` 为空）。
 * 它进这个联合类型是因为下游必须为它给出答案——漏掉它，访客会话就会
 * 落进某个默认分支里，而默认分支通常是宽松的那一边。
 */

import type { GrantRole } from "./identity";

/** 数据可见域。 */
export const VISIBILITY_DOMAINS = ["private", "vehicle", "public"] as const;
export type VisibilityDomain = (typeof VISIBILITY_DOMAINS)[number];

/**
 * 各类数据归哪个域。**这张表是设计 §4.1 的代码化**，改它等于改可见性。
 *
 * 键用领域里已有的说法（Memory 的类别编号、DB 的表名），不另造一套词——
 * 另造一套的话，"③偏好到底是哪一条"就得靠人对照两份文档。
 */
export const DOMAIN_OF: Readonly<Record<string, VisibilityDomain>> = Object.freeze({
  // ① 短期任务状态（图状态 + pi session）
  working_state: "private",
  // ② 情景记忆 / ③ 偏好（Mem0）
  episodic_memory: "private",
  preference_memory: "private",
  // 对话历史、个人行程计划、常住地、日历授权
  chat_history: "private",
  trip_plan: "private",
  owner_profile: "private",
  calendar_grant: "private",
  // 按人聚合的⑥画像
  member_usage_profile: "private",

  // ④ 车辆档案与保养维修、成员名单、车辆提醒、整车⑥聚合
  vehicle_profile: "vehicle",
  maintenance_record: "vehicle",
  repair_record: "vehicle",
  vehicle_member: "vehicle",
  vehicle_reminder: "vehicle",
  vehicle_usage_profile: "vehicle",
  cabin_state: "vehicle",

  // 平台公共
  vehicle_catalog: "public",
  knowledge_base: "public",
  environment_cache: "public",
});

/** 受权限矩阵管辖的操作。 */
export const GUARDED_ACTIONS = [
  /** 读④车辆档案（含保养维修、车机状态、能量）。 */
  "vehicle:read",
  /** 写④车辆档案（保养记录、里程、保养周期）。 */
  "vehicle:write",
  /** 读整车⑥聚合画像。 */
  "vehicle_usage:read",
  /** 读成员名单（上车声明要用）。 */
  "member:read",
  /** 维护影子成员档案（增删改）。 */
  "member:write",
  /** 管理授权（添加/移除成员）、绑定解绑车机、设置默认车。 */
  "vehicle:manage",
  /** 读本人的②③记忆与个人画像。 */
  "self_private:read",
  /** 发起对话。 */
  "conversation:start",
  /** 调用有副作用的敏感工具（预约、日历写入）。 */
  "sensitive_tool:invoke",
] as const;
export type GuardedAction = (typeof GUARDED_ACTIONS)[number];

/**
 * 权限矩阵。**与设计 §4.2 逐格一致**——那张表是这份数据的规格说明，
 * 两边不一致时以设计为准并回来改这里（且改动会让 §4.2 的逐格用例红）。
 *
 * 几处容易被改错的：
 *  - `vehicle:read` 对 driver / passenger 都是 true：车况与保养关系**行车安全**，
 *    授权使用一辆车就该知道它现在什么状况。
 *  - `vehicle:write` 只有 owner（设计裁决 R7）：driver 去做了保养也只能告诉车主。
 *  - `member:write` 只有 owner：与 FL-46 F-46-04「登记不发权限」同一取向。
 *  - guest 只剩公共域与车辆共享域的读——它连"自己的记忆"都没有，因为它没有账号。
 */
const MATRIX: Readonly<Record<GuardedAction, Readonly<Record<GrantRole, boolean>>>> = Object.freeze({
  "vehicle:read": { owner: true, driver: true, passenger: true, guest: true },
  "vehicle:write": { owner: true, driver: false, passenger: false, guest: false },
  "vehicle_usage:read": { owner: true, driver: true, passenger: false, guest: true },
  "member:read": { owner: true, driver: true, passenger: true, guest: true },
  "member:write": { owner: true, driver: false, passenger: false, guest: false },
  "vehicle:manage": { owner: true, driver: false, passenger: false, guest: false },
  "self_private:read": { owner: true, driver: true, passenger: true, guest: false },
  "conversation:start": { owner: true, driver: true, passenger: true, guest: true },
  "sensitive_tool:invoke": { owner: true, driver: true, passenger: false, guest: false },
});

/**
 * 这个角色能不能做这件事。
 *
 * **非成员没有角色**（`null`），一律 false——不给它任何默认值。
 * 传 null 进来是合法调用（"这个人不是成员，他能做什么"），答案永远是"不能"。
 */
export function can(role: GrantRole | null | undefined, action: GuardedAction): boolean {
  if (!role) return false;
  return MATRIX[action][role] === true;
}

/**
 * 这个角色能不能读这个域的数据。
 *
 * 私有域这里恒 false：它的判据不是角色而是**归属**——"是不是我自己的"。
 * 角色回答不了这个问题，所以不在这里回答，避免出现"driver 能读私有域"
 * 这种看起来成立、实则把别人的记忆放出去的判断。私有域的隔离在
 * `enterprise/backend/shared/memory` 的 userId 强制那一层。
 */
export function canReadDomain(role: GrantRole | null | undefined, domain: VisibilityDomain): boolean {
  if (domain === "public") return true;
  if (domain === "private") return false;
  return can(role, "vehicle:read");
}

/**
 * 访客（无账号）不可用的工具类别。
 *
 * 工具清单组装时按这个集合裁剪（F-57-03）——**裁剪在工具入参，不在提示词**
 * （FL-07 F-07-10 纪律）：写进提示词的规则迟早会被一句"忽略之前的指示"绕过，
 * 而清单里没有的工具，模型根本调不到。
 */
export const PRIVATE_DOMAIN_TOOLS = [
  // ③偏好：这个人喜欢什么。访客没有偏好可召回，读别人的更不行。
  "preference_recall",
  // 用户级 OAuth 凭证（§5 授权前提）——访客没有自己的日历。
  "calendar",
  // 按人聚合的⑥画像（个人驾驶习惯）。整车画像是 `usage_profile`，那个是共享域。
  "member_preference_set",
  // 已确认行程：属人不属车（一份承诺，落在某个人名下）。
  "trip_plan_list",
  "trip_plan_query",
  "trip_plan_commit",
  "trip_plan_cancel",
  "trip_plan_update",
] as const;

/**
 * 只有 owner 能调的写类工具（driver 读得到车况但改不了档案，设计裁决 R7）。
 *
 * `vehicle_member` 也在内：维护影子成员名单是车主的活（FL-46 F-46-04
 * 「登记不发权限」的对偶——不发权限，也不该由被授权者代管）。
 */
export const OWNER_ONLY_TOOLS = ["vehicle_profile_write", "vehicle_member"] as const;
