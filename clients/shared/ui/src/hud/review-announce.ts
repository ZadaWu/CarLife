/**
 * 点火播报的判据（施工单 M72-05，F-19-07）。
 *
 * 主页首帧拿到行程列表后，若某程的每日核查是 **critical** 且车主没看过，暖暖主动说一句
 * 并问要不要调整。走的是与到站播报同一条路：一句报告式文本经 `sendText` 进会话
 * （`【行程提醒】…`，服务端 `reviewNoticeIntent` 只转述不进 fan-out）——车机的 TTS 挂在
 * 「助手回了一句话」上，开一个前端直调喇叭的命令等于让 WebView 绕过整条应答链。
 *
 * 三道闸（F-19-07「主动发起有频率上限且可关闭；行车中非安全类建议不打断」）：
 *  - **一份核查只播一次**（按 reviewId 记在端上）；
 *  - **同一天最多一次**（不管有几程 critical）；
 *  - **开关**（缺省开）与**行驶中不播**（跟车时留到停车后的首帧）。
 * 只播 critical：notice 那一档只在列表上打点。
 */

import { reviewIsStale, reviewNeedsAttention, type TripPlanListEntry } from "@carlife/shared";

export const REVIEW_NOTICE_PREFIX = "【行程提醒】";

/** 给暖暖念的那句：目的地 + 第一条变化 + 问一句。短句——他刚上车。 */
export function announceNote(entry: TripPlanListEntry): string {
  const first = entry.review?.changes[0]?.text ?? "行程环境有变化";
  return `${REVIEW_NOTICE_PREFIX}${entry.plan.destination} 行程：${first}，要不要我把相关安排调整一下`;
}

export interface AnnounceGate {
  /** 已经播过的 reviewId。 */
  announced: ReadonlySet<string>;
  /** 本地今天（YYYY-MM-DD）与上一次播报落在哪天。 */
  today: string;
  lastDay?: string;
  enabled: boolean;
  driving: boolean;
}

/** 该不该播、播哪一程；不该播返回 undefined。 */
export function shouldAnnounce(
  entries: readonly TripPlanListEntry[],
  gate: AnnounceGate,
): TripPlanListEntry | undefined {
  if (!gate.enabled || gate.driving) return undefined;
  if (gate.lastDay === gate.today) return undefined;
  return entries.find(
    (e) =>
      e.review !== undefined &&
      e.review.severity === "critical" &&
      reviewNeedsAttention(e.review) &&
      !reviewIsStale(e.review, e.updatedAt) &&
      !gate.announced.has(e.review.reviewId),
  );
}

export interface AnnounceStore {
  announced(): ReadonlySet<string>;
  markAnnounced(reviewId: string, day: string): void;
  lastDay(): string | undefined;
  enabled(): boolean;
}

export interface ReviewAnnouncer {
  /** 喂进每一次拿到的列表；只在闸门全过且上一句已回完时发。 */
  consider(entries: readonly TripPlanListEntry[], opts: { today: string; driving: boolean }): void;
}

export function createReviewAnnouncer(send: (note: string) => Promise<void>, store: AnnounceStore): ReviewAnnouncer {
  let inFlight = false;
  return {
    consider(entries, opts) {
      if (inFlight) return;
      const hit = shouldAnnounce(entries, {
        announced: store.announced(),
        today: opts.today,
        lastDay: store.lastDay(),
        enabled: store.enabled(),
        driving: opts.driving,
      });
      if (!hit?.review) return;
      // 先记再发：发失败也不再重播——一句话播两遍比少播一遍更像故障。
      store.markAnnounced(hit.review.reviewId, opts.today);
      inFlight = true;
      // 发失败只记日志：已经 mark 过，不重播（一句话播两遍比少播一遍更像故障）。
      void send(announceNote(hit))
        .catch((err: unknown) => console.warn("[trip-review] 点火播报没发出去", err))
        .finally(() => {
          inFlight = false;
        });
    },
  };
}
