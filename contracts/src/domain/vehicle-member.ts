/**
 * domain/vehicle-member — 车辆常用人员（施工单 M17-01，FL-46 F-46-03）。
 *
 * # 它在 §7 的哪一族
 *
 * 人员的**基础档案**与④车辆档案同族：PostgreSQL、强一致、不衰减、事件驱动。
 * 人员的**画像**与⑥用车数据同族：流水按人聚合进 Mem0。两者不互相冗余——
 * 档案里不存日均里程，画像里不存"她是谁"。
 *
 * # 为什么硬约束必须是受控词表
 *
 * 下游（F-46-10）要把它**机械映射**成单段时长上限与停靠点质量门槛。
 * 如果存的是"我妈坐久了不舒服"，那边只能再调一次 LLM 去猜，
 * 而这条链路的失败形态是"方案里少了一条约束"——没人会归因到这里。
 *
 * 所以：能被程序消费的走 `MEMBER_NEEDS` 词表，说不清的走 `note` 自由文本，
 * 后者**只进提示词、不参与程序分叉**。
 *
 * # 这里定义的是契约，存储形态在 `@carlife/memory` 的 `member-store.ts`
 *
 * 与 `domain/vehicle.ts` 同一条依赖方向：服务/端 → shared，shared 不反向依赖。
 */

/** 角色。**是集合不是枚举**——妻子既开车也坐车，用枚举会逼出"常驾+常乘"这种第三个值。 */
export type MemberRole = "driver" | "passenger";

export const MEMBER_ROLE_LABEL: Record<MemberRole, string> = {
  driver: "常驾",
  passenger: "常乘",
};

export function isMemberRole(v: unknown): v is MemberRole {
  return v === "driver" || v === "passenger";
}

/**
 * 年龄段。**不存生日、不存年龄**：产品需要的只是"要不要按老人/儿童安排节奏"，
 * 精确到岁既没用，又平白多存一项他人可识别信息。
 */
export type MemberAgeBand = "adult" | "senior" | "child";

export const MEMBER_AGE_BAND_LABEL: Record<MemberAgeBand, string> = {
  adult: "成人",
  senior: "老人",
  child: "儿童",
};

export function isMemberAgeBand(v: unknown): v is MemberAgeBand {
  return v === "adult" || v === "senior" || v === "child";
}

/** 出行硬约束的受控词表 key。 */
export type MemberNeed =
  | "motion_sickness"
  | "restroom"
  | "child_seat"
  | "mobility"
  | "fatigue";

/**
 * 词表项的两种说法。
 *
 * `label` 给端上显示（短、名词），`hint` 给模型与求解器（完整句子、含可执行的判据）。
 * 两者放在同一处是刻意的：分开写必然分叉，而分叉之后
 * 端上显示"晕车"、提示词里却写着别的意思，用户会看到一条对不上的约束。
 */
export interface MemberNeedDef {
  key: MemberNeed;
  label: string;
  hint: string;
}

export const MEMBER_NEEDS: readonly MemberNeedDef[] = [
  {
    key: "motion_sickness",
    label: "晕车",
    hint: "同行者晕车：单段连续行驶不超过 90 分钟，弯道多的路段更早安排休息",
  },
  {
    key: "restroom",
    label: "需卫生间",
    hint: "停靠点必须有正规卫生间（不接受简易旱厕）",
  },
  {
    key: "child_seat",
    label: "儿童安全座椅",
    hint: "有儿童安全座椅：停靠时长需含抱下车与抱上车的时间",
  },
  {
    key: "mobility",
    label: "腿脚不便",
    hint: "停靠点必须能下车走动、需平地，不能是应急车道",
  },
  {
    key: "fatigue",
    label: "易疲劳",
    hint: "避免连续长时间驾驶，安排轮换或提前休息",
  },
] as const;

const NEED_KEYS = new Set<string>(MEMBER_NEEDS.map((n) => n.key));

export function isMemberNeed(v: unknown): v is MemberNeed {
  return typeof v === "string" && NEED_KEYS.has(v);
}

export function memberNeedDef(key: MemberNeed): MemberNeedDef {
  const def = MEMBER_NEEDS.find((n) => n.key === key);
  // 词表是闭集，找不到只能是调用方绕过了 `isMemberNeed`——抛错而不是返回一个空壳，
  // 空壳会一路流到提示词里变成一条没有内容的"硬约束"。
  if (!def) throw new Error(`未知的出行硬约束词表项：${key}`);
  return def;
}

/**
 * 常用人员（端云共享形态）。
 *
 * **称呼是车主自己的叫法**："妈"就是合法输入。不校验真实姓名、不要求唯一——
 * 系统不判断"妈"和"妈妈"是不是同一个人，名单由用户自己管理。
 *
 * 这里**没有** `userId` / `inviteCode` 之类的字段，而且不打算有：
 * 登记一个人不发放任何权限，被登记者没有账号、不登录、看不到这些记录。
 * 一车多人的授权模型是 F-07-10 / F-23-09 名下的未决，加这个字段就等于偷偷开始做它。
 *
 * 同样**没有**任何评分、评级、等级字段（AC-46-10）：
 * 不给下游留发挥空间比在提示词里写"不要评价驾驶习惯"可靠。
 */
export interface VehicleMember {
  id: string;
  /** 所属车辆。人员挂在车上，不挂在账号上——换车时名单跟着车走。 */
  vin: string;
  ownerId: string;
  /** 称呼。 */
  displayName: string;
  /** 与车主的关系，自由文本，可空。 */
  relation?: string;
  /** 角色集合，至少一项。 */
  roles: MemberRole[];
  ageBand?: MemberAgeBand;
  /** 出行硬约束，受控词表。 */
  needs: MemberNeed[];
  /** 说不清的那一句。**只进提示词，不参与程序分叉。** */
  note?: string;
  /**
   * 座舱偏好（M24-06，F-50-01）。结构化设置值，④同族：PG、不衰减、不进向量库。
   * 与 `needs` 是两组字段（AC-50-9）：晕车驱动出行规划，这里只驱动设备。
   */
  cabinPreference?: import("./cabin-preference").MemberCabinPreference;
  /**
   * 手机号，中国大陆 11 位，明文存储（施工单 M19-06）。
   *
   * **这是这张表里唯一一个能直接联系到具体的人的字段**，与上面那些"称呼/关系/年龄段"
   * 不是一个量级——那些泄露了尴尬，这个泄露了会被骚扰。所以：
   *
   * - 出库一律先过 `phoneTail`，**明文不进模型上下文、不进 trace、不进日志**（AC-19-6）；
   * - 需要真号的只有下单那一步，由工具层按 `memberId` 自己去取，中间不经过 LLM。
   *
   * 没登记就是 `undefined`——**不要拿车主本人的号去顶替家人的**。
   */
  phone?: string;
  updatedAt: number;
}

/** 称呼长度上限。够写"外婆家的邻居张阿姨"，又不至于变成一段自述。 */
export const MEMBER_NAME_MAX = 20;
/** 自由补充长度上限。 */
export const MEMBER_NOTE_MAX = 100;

/**
 * 中文口语数字 → 阿拉伯数字（施工单 M19-06）。
 *
 * **放在 shared 是因为它有两个消费方**：`enterprise/backend/shared/tools` 的 `contact_update`
 * 与 `agent-runtime` 的 `pickContact`。这份映射表一旦有两份就必然漂移，
 * 而漂移的表现是"手机端能存进去、语音说的存不进去"这种没人会往这里查的现象。
 *
 * 语音是默认入口，ASR 出来的手机号长这样：`幺三九幺二三四五六幺三`。
 */
const CN_DIGITS: Record<string, string> = {
  零: "0", 〇: "0", 一: "1", 幺: "1", 二: "2", 两: "2", 三: "3", 四: "4",
  五: "5", 六: "6", 七: "7", 八: "8", 九: "9",
};

/** 中国大陆手机号。**不放宽到座机/虚拟号**——门店回拨打不通比没留号更糟。 */
const PHONE_RE = /1[3-9]\d{9}/;

/**
 * 从一段话里取手机号，取不到返回 `undefined`（**不猜、不补位**）。
 *
 * 只做逐字映射，**不处理「十/百」**：手机号是逐位念的，而"八月十五号上午十点"
 * 恰恰不该被拼成一串连续数字。
 */
export function normalizePhone(text: string): string | undefined {
  const direct = text.match(PHONE_RE)?.[0];
  if (direct) return direct;
  const arabized = text
    .replace(/[零〇一幺二两三四五六七八九]/g, (c) => CN_DIGITS[c])
    // 「139 1234 5613」「139-1234-5613」都是常见说法
    .replace(/[\s\-–—－]/g, "");
  return arabized.match(PHONE_RE)?.[0];
}

/** 完整手机号的判定。给校验层用——存进库之前必须过这一关。 */
export function isPhone(v: string): boolean {
  return /^1[3-9]\d{9}$/.test(v);
}

/**
 * 出库口径：**后四位**。
 *
 * 不是 `187****5613` 那种掩码串——车主要的是"听得懂"，
 * 而 TTS 会把四个星号念成"星星星星"（M19-06 的产品判断）。
 * 掩码串是给屏幕看的（HITL 弹窗那一块），尾号是给耳朵听的。
 */
export function phoneTail(phone: string): string {
  return phone.slice(-4);
}
