/**
 * 来源护照（施工单 M82-01，总览已定决策 6）。
 *
 * # 为什么是代码常量而不是配置表
 *
 * "这张表能不能采、能不能逐条显示"是**权利边界**，不是运营策略。
 * 放进可热改的配置里，等于给"临时打开看一眼"留了一个不留痕的入口；
 * 而它一旦被打开，违规的那一次在界面上没有任何现象。
 * `research_sources` 表只是这份常量的可查询副本（由 seed 写入），
 * 判断一律读这里——**表被改了也不改变行为**。
 *
 * # 六项权限的读法
 *
 * `access` 读得到吗 · `collect` 能进证据层吗 · `store` 能落研究表吗 ·
 * `analyze` 能参与分析吗 · `share` 能出研究面吗 · `display` 能在界面上出现吗。
 * 六项独立：`analyze: "aggregate-only"` + `display: "none"` 是
 * "能算进分母、不能逐条露脸"，`elicitation_cooldowns` 就是这一档。
 */

/**
 * `aggregate-only` = 只能进聚合，逐条不可取；
 * `replay-audited` = 可取但每次都记审计（原声回放那一档）。
 */
export type PermissionValue = "yes" | "no" | "aggregate-only" | "replay-audited";

/** 谁控制这份数据。`third-party` 的一律不可采（我们没有它的授权链）。 */
export type SourceControl = "carlife" | "owner" | "third-party";

/**
 * `simulated` 的数据**不构成市场证据**（analysis.md §2 边界 2）。
 * `check:arch` 守的是依赖方向，拦不住"把 mock 门店的报价画进趋势图"——只能靠这一栏。
 */
export type SourceProvenance = "first-party" | "simulated";

export interface SourcePassport {
  /** 表名 / 逻辑来源名，与 `research_evidence_units.source_id` 同一个字符串。 */
  id: string;
  control: SourceControl;
  /** 采集的授权基础，一句话。Rights 门失败时原样上界面。 */
  basis: string;
  access: PermissionValue;
  collect: PermissionValue;
  store: PermissionValue;
  analyze: PermissionValue;
  share: PermissionValue;
  display: PermissionValue;
  /** 研究面自己的保留期；`null` = 跟随主表，不另设。 */
  retentionDays: number | null;
  provenance: SourceProvenance;
  notes: string;
}

const OWNER_GRANT = "车主授权（vehicle_grants / user_flags），排除 research_excluded 标记的账号";
const OPS_INTERNAL = "我们自己的运行记录，不含车主个人数据";

/**
 * 顺序 = analysis.md §2 的来源地图顺序，方便两处对读。
 * **新增一张来源表必须同时加这里**——`collect` 查不到的来源，取数层直接拒绝。
 */
export const SOURCE_PASSPORTS: readonly SourcePassport[] = [
  {
    id: "messages",
    control: "owner",
    basis: OWNER_GRANT,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "车主主动说出来的话。落研究表的只有本地脱敏派生文本，原文不复制（总览已定决策 5）",
  },
  {
    id: "message_audio",
    control: "owner",
    basis: OWNER_GRANT,
    access: "yes",
    // 采得到（知道有这段音频），但研究表里只存引用；波形本体永远留在原处。
    collect: "yes",
    store: "no",
    analyze: "yes",
    display: "replay-audited",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "原声回放走既有 /console/message-audio/*，每次记 audit_logs（总览已定决策 5）",
  },
  {
    id: "trips",
    control: "owner",
    basis: OWNER_GRANT,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "行为证据：里程、路况、环境温度、充电起止 SOC。不解释原因",
  },
  {
    id: "refuel_records",
    control: "owner",
    basis: OWNER_GRANT,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "补能习惯",
  },
  {
    id: "maintenance_records",
    control: "owner",
    basis: OWNER_GRANT,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "只见来修的车——幸存者偏差写在快照口径里",
  },
  {
    id: "repair_records",
    control: "owner",
    basis: OWNER_GRANT,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "高频故障。同上，只见来修的车",
  },
  {
    id: "trace_events",
    control: "carlife",
    basis: OPS_INTERNAL,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "Diagnostics：系统在哪一步答不上。**是系统行为不是用户需求**，不能当 Discovery 用",
  },
  {
    id: "guard_audit_logs",
    control: "carlife",
    basis: OPS_INTERNAL,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "Boundary：硬禁范畴的真实需求量。措辞已被拦截流程影响",
  },
  {
    id: "vehicle_reminders",
    control: "owner",
    basis: OWNER_GRANT,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "Outcome：干预是否奏效（invalidated_at）。完成也可能与提醒无关",
  },
  {
    id: "devices",
    control: "owner",
    basis: OWNER_GRANT,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "aggregate-only",
    display: "no",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "Reach：推送能不能到。逐台设备与研究问题无关，只要端分布",
  },
  {
    id: "config_item_revisions",
    control: "carlife",
    basis: OPS_INTERNAL,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "系统变更事件源。密钥类只派生「变更过」，不含值（system-events.ts）",
  },
  {
    id: "guard_setting_revisions",
    control: "carlife",
    basis: OPS_INTERNAL,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "护栏策略变更，趋势图的竖线之一",
  },
  {
    id: "job_runs",
    control: "carlife",
    basis: OPS_INTERNAL,
    access: "yes",
    collect: "yes",
    store: "yes",
    analyze: "yes",
    display: "yes",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "知识库同步等定时任务的留痕，派生 kb-sync 事件",
  },
  {
    id: "user_flags",
    control: "carlife",
    basis: OPS_INTERNAL,
    access: "yes",
    // 它是**排除名单**本身，不是证据：读它是为了把人剔出去，不是把它变成一条证据。
    collect: "no",
    store: "no",
    analyze: "yes",
    display: "no",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "research_excluded / research_synthetic 的载体。只用于筛选，不产生证据单元",
  },
  {
    id: "elicitation_cooldowns",
    control: "owner",
    basis: OWNER_GRANT,
    access: "yes",
    collect: "yes",
    store: "yes",
    // 架构文档 §4.6 约束 4：**拒答不构成新的信息**。逐车显示"这辆车拒答过"
    // 会让拒答变成一条流向下游的事实，违反那条不变量。
    analyze: "aggregate-only",
    // 注意与 `DisplayLevel`（证据单元那一侧的枚举）区分：这里的 "no" 与那边的
    // "none" 说的是同一件事，两套枚举不同源是刻意的——护照讲权限，单元讲档位。
    display: "no",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "只允许出现聚合后的补录询问接受率（analysis.md §2 边界 3）",
  },
  {
    id: "mem0",
    control: "carlife",
    basis: OPS_INTERNAL,
    access: "yes",
    // 它是检索期 re-rank 后的摘要，还带衰减——**已是派生物**（方法本体 §18.7）。
    // 摘要用于导航，每个事实必须回到 messages 的原始记录。
    collect: "no",
    store: "no",
    analyze: "no",
    display: "no",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "偏好 / 情景 / 用车画像。不是证据层，研究面不读（总览边界）",
  },
  {
    id: "llm_usage",
    control: "carlife",
    basis: OPS_INTERNAL,
    access: "yes",
    collect: "no",
    store: "no",
    analyze: "no",
    display: "no",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "成本与时延，与用户需求无关。当需求证据用会得到「哪个模型贵」",
  },
  {
    id: "audit_logs",
    control: "carlife",
    basis: OPS_INTERNAL,
    access: "yes",
    collect: "no",
    store: "no",
    analyze: "no",
    display: "no",
    share: "no",
    retentionDays: null,
    provenance: "first-party",
    notes: "运营操作留痕，与用户需求无关",
  },
  // ── 四个假第三方：恒 collect=no ──────────────────────────
  // 它们是"替外面的系统站位"的模拟数据。把它们的应答画进任何一张图，
  // 得到的是我们自己编的市场——Rights 门因此把 mock 来源直接判 fail。
  {
    id: "mocks.dealer",
    control: "third-party",
    basis: "无——模拟数据，不构成市场证据",
    access: "yes",
    collect: "no",
    store: "no",
    analyze: "no",
    display: "no",
    share: "no",
    retentionDays: null,
    provenance: "simulated",
    notes: "假门店系统。联调用，不进研究面",
  },
  {
    id: "mocks.repair",
    control: "third-party",
    basis: "无——模拟数据，不构成市场证据",
    access: "yes",
    collect: "no",
    store: "no",
    analyze: "no",
    display: "no",
    share: "no",
    retentionDays: null,
    provenance: "simulated",
    notes: "假维修系统",
  },
  {
    id: "mocks.insurance",
    control: "third-party",
    basis: "无——模拟数据，不构成市场证据",
    access: "yes",
    collect: "no",
    store: "no",
    analyze: "no",
    display: "no",
    share: "no",
    retentionDays: null,
    provenance: "simulated",
    notes: "假保险系统",
  },
  {
    id: "mocks.cabin",
    control: "third-party",
    basis: "无——模拟数据，不构成市场证据",
    access: "yes",
    collect: "no",
    store: "no",
    analyze: "no",
    display: "no",
    share: "no",
    retentionDays: null,
    provenance: "simulated",
    notes: "假座舱系统",
  },
];

const BY_ID = new Map(SOURCE_PASSPORTS.map((p) => [p.id, p]));

/** 未登记的来源一律取不到护照——调用方按"不可采"处理，不要默认放行。 */
export function passportOf(sourceId: string): SourcePassport | null {
  return BY_ID.get(sourceId) ?? null;
}

/** 没登记 = 不可采。默认拒绝，新表忘了登记的表现是取不到数，而不是悄悄采了。 */
export function canCollect(sourceId: string): boolean {
  return passportOf(sourceId)?.collect === "yes";
}

/**
 * 能不能在界面上逐条显示。`replay-audited` 也算"能显示"，
 * 但调用方必须走审计路径——所以另有 `displayModeOf` 让调用方拿到具体档位。
 */
export function canDisplay(sourceId: string): boolean {
  const d = passportOf(sourceId)?.display;
  return d === "yes" || d === "replay-audited";
}

export function displayModeOf(sourceId: string): PermissionValue {
  return passportOf(sourceId)?.display ?? "no";
}

/** 只能进聚合的来源（`elicitation_cooldowns` 那一档）。 */
export function isAggregateOnly(sourceId: string): boolean {
  return passportOf(sourceId)?.analyze === "aggregate-only";
}

/** 模拟数据。Rights 门看这个：来源里出现一个就整块判 fail。 */
export function isSimulated(sourceId: string): boolean {
  return passportOf(sourceId)?.provenance === "simulated";
}
