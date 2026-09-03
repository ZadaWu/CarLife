/**
 * 保养提醒与日历写入的合并确认（施工单 M8-04，FL-17）。
 *
 * # 本文件的核心设计是"搭便车"
 *
 * §5 明确：保养提醒**不单独触发一轮确认**，而是搭行程确认的便车——
 * 保养临近且用户正在做会写日历的出行规划时，它作为同一次写入的一项出现。
 *
 * 理由是确认疲劳：每次出行规划确认三次，林向东会关掉功能（FL-27 的裁定原则）。
 *
 * # 但风险也在这里
 *
 * 四条日程一起确认，用户可能只注意到行程那三条。因此：
 *  - 保养提醒项**视觉可区分**（`kind` 字段带出去，端上据此加标记）；
 *  - 写入后有**明确回执**（"已写入 4 条日程"），不是静默成功。
 */

export interface CalendarDraftItem {
  kind: "trip" | "maintenance";
  title: string;
  start: string;
  end: string;
  note?: string;
}

export interface MergeDecision {
  /** 要写入的全部条目。 */
  items: CalendarDraftItem[];
  /** 保养提醒是否搭上了便车。 */
  maintenanceMerged: boolean;
  /** 未合并时的原因——供决定是否走独立提醒路径（F-17-04 低打扰呈现）。 */
  notMergedReason?: string;
}

export interface MaintenanceHint {
  /** 距下次保养剩余公里；负数为已超期。 */
  remainingKm: number;
  etaDays?: number;
  degraded: boolean;
}

/** 提醒阈值：剩余里程或天数进入此范围才算"临近"。 */
export const NEAR_DUE_KM = 1_500;
export const NEAR_DUE_DAYS = 45;

export function isNearDue(h: MaintenanceHint): boolean {
  if (h.remainingKm <= NEAR_DUE_KM) return true;
  return h.etaDays !== undefined && h.etaDays <= NEAR_DUE_DAYS;
}

/**
 * 决定保养提醒是否并入本次日历写入。
 *
 * **没有行程写入时不强行创造一次写入**——那就变成了主动打扰，
 * 与"搭便车"的初衷相反（F-17-04：改走 HUD 提醒卡）。
 */
export function mergeMaintenanceIntoTrip(
  tripItems: readonly CalendarDraftItem[],
  hint: MaintenanceHint | undefined,
  makeTitle: (h: MaintenanceHint) => string,
  when: { start: string; end: string },
): MergeDecision {
  const items = [...tripItems];

  if (!hint) {
    return { items, maintenanceMerged: false, notMergedReason: "无保养推算结果" };
  }
  if (!isNearDue(hint)) {
    return { items, maintenanceMerged: false, notMergedReason: "保养未临近，不打扰" };
  }
  if (tripItems.length === 0) {
    // 关键取舍：不为了写提醒而单独发起一次确认。
    return {
      items,
      maintenanceMerged: false,
      notMergedReason: "本次没有行程写入，保养提醒改走低打扰呈现（HUD 提醒卡）",
    };
  }

  items.push({
    kind: "maintenance",
    title: makeTitle(hint),
    start: when.start,
    end: when.end,
    note: hint.degraded ? "基于通用保养周期估算（档案未记录周期）" : undefined,
  });
  return { items, maintenanceMerged: true };
}

/** 写入回执（F-17-03 的风险缓解）：说清楚写了几条、其中哪条是保养。 */
export function writeReceipt(items: readonly CalendarDraftItem[]): string {
  const trips = items.filter((i) => i.kind === "trip").length;
  const maint = items.filter((i) => i.kind === "maintenance").length;
  const parts = [`已写入 ${items.length} 条日程`];
  if (trips) parts.push(`行程 ${trips} 条`);
  if (maint) parts.push(`保养提醒 ${maint} 条`);
  return parts.join("：").replace("：", "（") + "）";
}
