/**
 * 用户级一次性标记（施工单 M14-03，F-23-12）。
 *
 * # 为什么单独一类存储
 *
 * "这个用户已经被引导过建档"需要**持久且精确**：
 * 图状态随 thread 24h 作废（会导致每天引导一次），
 * Mem0 是语义检索（"有没有引导过"不能是个近似结果）。
 * 所以落 PG 小表（实现在 `@carlife/db`），这里只定义接口。
 */

export interface UserFlagStore {
  has(userId: string, flag: string): Promise<boolean>;
  /** 幂等；无 unset——"发生过"是事实，要重新引导请换新 flag 名。 */
  set(userId: string, flag: string): Promise<void>;
}

/** 建档引导已做过（F-23-12 的"一次性"由它承载）。 */
export const VEHICLE_ONBOARDING_FLAG = "vehicle_onboarding_prompted";

/**
 * 常用人员的一次性引导（施工单 M17-05，F-46-10）。
 *
 * 与建档引导同一形态：只在"提到了同行者但一个人都没登记"时出现一次。
 * 与建档引导**分成两个 flag** 而不是共用一个——它们是两件不同的事，
 * 共用会让建过档的人再也看不到人员引导。
 */
export const COMPANION_ONBOARDING_FLAG = "companion_onboarding_prompted";
