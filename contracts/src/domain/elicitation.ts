/**
 * 事实补录询问的槽位契约（施工单 M26-03，架构文档 **§4.6**，
 * FL-53 F-53-05 / FL-54 F-54-10）。
 *
 * # 这是系统里第二种"停下来问用户"
 *
 * 第一种是 §8.4 权限门的 `interrupt()`，它问的是**授权**（"要不要我替你下单"）。
 * 这一种问的是**事实**（"上次保养什么时候""现在还有多少油"）。两者外形相似，
 * 失败模式却相反，**接成同一条通路会出人命级的误用**：
 *
 * | | 问授权 | 问事实（本文件） |
 * |---|---|---|
 * | 不回答 | 动作不执行（fail-closed） | **继续，但降级并说明**（fail-open） |
 * | 载体 | `interrupt()` + HTTP 挂起 + 端上弹窗 | 一句话反问，走正常对话轮 |
 * | 拒答 | = 取消这次动作 | **必须被记住**（冷却），且**不得外溢** |
 *
 * # 三条硬约束（§4.6），本文件负责其中的形状
 *
 * 1. **一轮最多问一个事实**——多了就成表单，车机语音场景下答不全，
 *    而答一半比不问更糟（部分补录被当成完整补录）。
 * 2. **拒答留痕并冷却**——每次都问一遍是最快让人关掉功能的做法。
 * 3. **拒答不构成新的信息**——见 `ElicitationSlot` 的说明。
 */

/**
 * 可以向车主补录的事实种类。**受控词表，不是自由文本。**
 *
 * 受控的理由与 `MEMBER_NEEDS` 同源：下游要**机械消费**它——按 kind 选提问文案、
 * 选落库路径、选优先级。存自由文本那边就只能再调一次模型去猜。
 *
 * - `odometer` / `last_service` —— ④车辆档案，可落库（M26-04）。
 * - `energy_type` —— ④的能源类型。缺了它连"该问升还是问百分比"都定不了（M26-07）。
 * - `energy_level` —— **瞬时值，只进 ①Working，绝不落 ④**（§4.6，AC-54-8）。
 *
 * ⚠️ 这里**没有** `usage_trips`：⑥ 的行程流水补不回来。一句口述不是一次观测
 * （AC-53-7），问了车主也没用。
 */
export type ElicitationKind = "odometer" | "last_service" | "energy_type" | "energy_level";

export const ELICITATION_KINDS: readonly ElicitationKind[] = [
  "odometer",
  "last_service",
  "energy_type",
  "energy_level",
];

export function isElicitationKind(v: unknown): v is ElicitationKind {
  return typeof v === "string" && (ELICITATION_KINDS as readonly string[]).includes(v);
}

/** 给人看的项名。降级话术与提问文案都从这里取，不在各处再写一份。 */
export const ELICITATION_KIND_LABEL: Record<ElicitationKind, string> = {
  odometer: "当前里程",
  last_service: "上次保养",
  energy_type: "能源类型",
  energy_level: "当前能源余量",
};

/**
 * 时效性。**它压倒 `weight`**，是优先级排序里的第一维。
 *
 * - `perishable`：过了这个村就没这个店。`energy_level` 是唯一一个——
 *   出发之后再问"你出发时有多少油"毫无意义（AC-54-10 要求它优先）。
 * - `deferrable`：今天不问明天问，答案一样。④ 的三项都是。
 */
export type ElicitationTimeliness = "perishable" | "deferrable";

export type ElicitationState = "pending" | "asked" | "filled" | "declined";

export interface ElicitationSlot {
  kind: ElicitationKind;
  /** 为什么它是个缺口——直接取自 `data_freshness` 的 `reason`，要说得出口。 */
  reason: string;
  /** 同 `timeliness` 下的排序权重，越大越先问。 */
  weight: number;
  timeliness: ElicitationTimeliness;
  state: ElicitationState;
}

/**
 * 默认权重。**只在同 `timeliness` 内比较**，跨时效性比较没有意义。
 *
 * `last_service` 高于 `odometer`：保养日期是推算的必要输入且车主答得上来；
 * 里程还能被 ⑥ 的流水推进，不是只有问才拿得到。
 * `energy_type` 最高：缺了它，能源那一侧的每一句话都问不对单位（M26-07 约束 3）。
 */
export const ELICITATION_WEIGHT: Record<ElicitationKind, number> = {
  energy_level: 100,
  energy_type: 30,
  last_service: 20,
  odometer: 10,
};

export const ELICITATION_TIMELINESS: Record<ElicitationKind, ElicitationTimeliness> = {
  energy_level: "perishable",
  energy_type: "deferrable",
  last_service: "deferrable",
  odometer: "deferrable",
};

/**
 * 一次拒答的持久记录。**必须活过会话与进程重启**——
 * 只放图状态等于没有冷却，下次上车又问一遍（M26-03 约束 2）。
 *
 * ⚠️ **它只有 elicitation 自己读**（§4.6 约束 4 / AC-53-13）。
 * 不进任何被子图或 prompt 拼装消费的图状态、不进 `VehicleProfile` 的出参、
 * 不进任何 Agent 的系统提示词。判据是一条可机械断言的不变量：
 *
 * > 同一辆数据陈旧的车，在"从未被问过"与"已拒答"两种状态下，
 * > 喂给出行规划 / 用车助手 / 座舱 / 售后 / 购车各 Agent 的上下文与
 * > 可用工具集**逐字段相同**。
 *
 * 下游的降级永远只是**数据本身**的函数，与提问历史无关。
 */
export interface ElicitationCooldown {
  vin: string;
  kind: ElicitationKind;
  /** 最后一次拒答的时刻（epoch ms）。 */
  declinedAt: number;
  /** 累计拒答次数——连着拒三次和第一次拒，后续策略可以不同（本期只记录）。 */
  declineCount: number;
}

/** 冷却时长默认值。**保守（宁可少问）**，取值依据未定见架构文档 §13-20。 */
export const DEFAULT_ELICITATION_COOLDOWN_DAYS = 30;

/**
 * ④ 档案里一条事实的来源（施工单 M26-04，F-53-08，架构文档 §4.6 约束 3 / §7 回填第 2 条）。
 *
 * **受控词表，不是自由文本**，理由同 `MEMBER_NEEDS`：下游要机械消费它——
 * 引用这条数据时要能说出"这是您上次告诉我的"而不是"根据行驶记录"。
 * 存自由文本那边就只能再调一次模型去猜。
 *
 * `MaintenanceRecord.source` 的 schema 注释里早就写着"用户自述要标注出来：
 * 它与门店记录的可信度不同"——语义一直是对的，缺的只是这张表。
 *
 * ⚠️ 读侧**兼容历史自由文本**（"用户自述" / 门店名 / 工单号都在库里），
 * 不做数据迁移：已写入的记录不改，这是"只追加不修改"的延伸。
 */
export type ProfileFactSource = "owner-stated" | "dealer" | "telemetry" | "owner-manual";

export const PROFILE_FACT_SOURCES: readonly ProfileFactSource[] = [
  "owner-stated",
  "dealer",
  "telemetry",
  /*
   * 档案页表单手录（M29-03）。与 `owner-stated`（对话口述）刻意分开：
   * 争议场景里"说过"与"填过"是两种证词——口述经模型抽取可能有转写偏差，
   * 表单是车主逐字段亲手填的。对话工具的 zod 枚举**不含**这个值：
   * 模型没有理由替用户声称"这是手动填的"。
   */
  "owner-manual",
];

export function isProfileFactSource(v: unknown): v is ProfileFactSource {
  return typeof v === "string" && (PROFILE_FACT_SOURCES as readonly string[]).includes(v);
}

/** 给人看的说法。引用这条数据的回答要说得出它的来源。 */
export const PROFILE_FACT_SOURCE_LABEL: Record<ProfileFactSource, string> = {
  "owner-stated": "您告诉我的",
  dealer: "门店记录",
  telemetry: "车辆上报",
  "owner-manual": "您手动记录的",
};
