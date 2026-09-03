/**
 * domain/cabin-preference — 人员座舱偏好与组合偏好（施工单 M24-06，
 * FL-50 F-50-01/02/03/14）。
 *
 * # 偏好是"人想要什么"，不是"设备设成什么"
 *
 * 这里的形状与车机 op（`{domain, zone, set}`）刻意**不是同一个**：偏好可以是上限
 * （"温度别超 24"）、可以缺省；设备值必须具体。两者之间唯一的桥是翻译器
 * （F-50-07，`cabin-translate.ts`）。把偏好直接存成设备 op，上限语义就没了。
 *
 * # 字段宁少而准
 *
 * 每个字段都必须被翻译器机械消费——说不清的话继续走人员档案的 `note`
 * （只进提示词）。**没有条件化字段**（季节/地点/时段，§13-18 未决）：
 * 本契约不为未决预留字段，决定做时按 schema 迁移处理。
 *
 * # needs 与偏好是两组字段（AC-50-9）
 *
 * "晕车"（`needs`，驱动出行规划）与"通风 2 档 + 温度上限 24"（本契约，驱动设备）
 * 语义独立、互不派生存储：删一侧不牵连另一侧。登记时可以从 needs **建议**一组
 * 偏好草案，但落库的是这里的字段且必须经确认（F-50-05）。
 */

/** 座椅档位 0~3；0 = 不开。设备真实档位上限由能力表决定，翻译器会夹。 */
export type SeatLevel = 0 | 1 | 2 | 3;

/**
 * 一位常用人员的座舱偏好。**全部可缺省**——缺省 = 这一项没有偏好，
 * 翻译器落车主默认，不猜。
 */
export interface MemberCabinPreference {
  /** 偏好温度（℃）。与 tempMaxC 并存时取两者中更低的落值。 */
  tempC?: number;
  /** 温度上限（℃）——"别太高"的结构化形态（晕车场景的本体）。 */
  tempMaxC?: number;
  seatHeating?: SeatLevel;
  seatVentilation?: SeatLevel;
  /** 氛围灯亮度 0~100。 */
  ambientBrightness?: number;
  /** 媒体内容类型：儿歌 / 播客 / 戏曲 / 轻音乐……自由短语，≤20 字。 */
  mediaContentTag?: string;
  /** 音量上限 0~100（儿童场景常用）。 */
  mediaVolumeLimit?: number;
}

/** 温度的合法输入区间——比任何车机都宽，翻译时再按能力表夹。 */
const TEMP_MIN = 15;
const TEMP_MAX = 35;

export class CabinPreferenceError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`座舱偏好非法（${field}）：${message}`);
    this.name = "CabinPreferenceError";
  }
}

const PREFERENCE_KEYS = new Set([
  "tempC",
  "tempMaxC",
  "seatHeating",
  "seatVentilation",
  "ambientBrightness",
  "mediaContentTag",
  "mediaVolumeLimit",
]);

function checkTemp(field: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new CabinPreferenceError(field, "需要数字");
  if (v < TEMP_MIN || v > TEMP_MAX) {
    throw new CabinPreferenceError(field, `温度应在 ${TEMP_MIN}~${TEMP_MAX}℃ 之间`);
  }
  return v;
}

function checkLevel(field: string, v: unknown): SeatLevel {
  if (v !== 0 && v !== 1 && v !== 2 && v !== 3) throw new CabinPreferenceError(field, "档位应为 0~3");
  return v;
}

function checkPercent(field: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) {
    throw new CabinPreferenceError(field, "应为 0~100 的整数");
  }
  return v;
}

/**
 * 校验一份偏好。**抛错而不是归一化**（与 `validateMember` 同一条判断：
 * 猜一个"大概对"的值会把脏数据洗成看不出来的脏数据）。
 *
 * 未知字段直接拒——**这是"条件化字段不存在"的负向验收落点**：
 * 谁想塞一个 `season` 进来，会在这里被挡住而不是被静默存下。
 */
export function validateCabinPreference(v: unknown): MemberCabinPreference {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new CabinPreferenceError("preference", "应为对象");
  }
  const obj = v as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!PREFERENCE_KEYS.has(key)) {
      throw new CabinPreferenceError(key, "未知字段（偏好没有生效条件——季节/地点/时段属 §13-18 未决）");
    }
  }
  const out: MemberCabinPreference = {};
  if (obj.tempC !== undefined) out.tempC = checkTemp("tempC", obj.tempC);
  if (obj.tempMaxC !== undefined) out.tempMaxC = checkTemp("tempMaxC", obj.tempMaxC);
  if (obj.seatHeating !== undefined) out.seatHeating = checkLevel("seatHeating", obj.seatHeating);
  if (obj.seatVentilation !== undefined) out.seatVentilation = checkLevel("seatVentilation", obj.seatVentilation);
  if (obj.ambientBrightness !== undefined) out.ambientBrightness = checkPercent("ambientBrightness", obj.ambientBrightness);
  if (obj.mediaVolumeLimit !== undefined) out.mediaVolumeLimit = checkPercent("mediaVolumeLimit", obj.mediaVolumeLimit);
  if (obj.mediaContentTag !== undefined) {
    if (typeof obj.mediaContentTag !== "string" || !obj.mediaContentTag.trim()) {
      throw new CabinPreferenceError("mediaContentTag", "应为非空字符串");
    }
    if (obj.mediaContentTag.length > 20) throw new CabinPreferenceError("mediaContentTag", "不超过 20 字");
    out.mediaContentTag = obj.mediaContentTag.trim();
  }
  return out;
}

export function isCabinPreferenceEmpty(p: MemberCabinPreference): boolean {
  return Object.keys(p).length === 0;
}

// ── 组合偏好（F-50-03）────────────────────────────────────────

/**
 * 成员组合 → 偏好覆盖。**按成员集合精确匹配**：孩子+妈妈 ≠ 孩子+妈妈+爸爸。
 * 覆盖项的形状就是 `MemberCabinPreference`——组合说的是"这几个人一起时，
 * 共享面（温度基调/内容/音量）怎么定"，优先于成员个人偏好（查找顺序见翻译器）。
 */
export interface MemberCombination {
  id: string;
  vin: string;
  ownerId: string;
  /** 车主起的名字（"孩子和妈妈"）。 */
  label: string;
  /** 归一化（排序去重）后的成员 id 集合，≥2 人——单人"组合"就是成员偏好，不许用组合表达。 */
  memberIds: string[];
  override: MemberCabinPreference;
  /** 失效（含某个已删除成员，AC-50-10）。失效保留待车主处置，不静默重组。 */
  invalidatedAt?: number;
  invalidReason?: string;
  updatedAt: number;
}

/** 排序去重——精确匹配的键。空/单人抛错。 */
export function normalizeMemberIds(ids: readonly string[]): string[] {
  const set = [...new Set(ids.map((s) => s.trim()).filter(Boolean))].sort();
  if (set.length < 2) {
    throw new CabinPreferenceError("memberIds", "组合至少要两个人——一个人的偏好直接写在他自己身上");
  }
  return set;
}

/** 集合精确匹配用的字符串键。 */
export function memberIdsKey(ids: readonly string[]): string {
  return normalizeMemberIds(ids).join("|");
}

// ── 设置单（翻译产物，F-50-02 / F-50-07 消费）────────────────

/** 车机操作形状——与 mock-cabin 契约对齐；shared 不 import tools，此处独立声明。 */
export interface CabinPlanOp {
  domain: string;
  zone?: string;
  set: Record<string, unknown>;
}

/** 一项设置的来源：翻译器写、播报层念——"每一项设置说得清因为谁"（AC-50-8）。 */
export interface CabinAttribution {
  opIndex: number;
  field: string;
  /** null = 车主默认，不是某个人的偏好。 */
  memberId: string | null;
  via: "round-override" | "combination" | "member" | "owner-default";
}

/** 没做到的项——播报必须念，静默丢弃是验收失败（US-50 场景 8）。 */
export interface CabinUndone {
  memberId: string | null;
  field: string;
  /** 机器可判的原因码。 */
  reason: "unsupported-on-vehicle" | "zone-not-separate" | "lost-arbitration";
  note: string;
}

/** 仲裁记录——结构化字段，可单测断言"谁赢了、为什么"（AC-50-6）。 */
export interface CabinArbitration {
  resource: "media" | "climate";
  rule: "child-first" | "driver-first";
  winnerMemberId: string | null;
  loserMemberIds: string[];
}

export interface CabinSettingPlan {
  ops: CabinPlanOp[];
  attributions: CabinAttribution[];
  undone: CabinUndone[];
  arbitrations: CabinArbitration[];
}
