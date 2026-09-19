/**
 * 入库前的筛选（施工单 M82-01）。
 *
 * 四类东西不能进证据层，四类的共同点是**进了不会报错，只会让数字变得可信而错误**：
 *
 *  - `fake` 档的对话是我们自己造的脚本，不是车主说的话；
 *  - 被打断的半句既不是完整诉求，也不该记进"追问率"的分母；
 *  - 空 ASR（识别出一片空白）会在证据矩阵里变成一堆无主题的轮次；
 *  - demo / eval 账号（`research_excluded`）与重复窗口切出来的同一条。
 *
 * 返回原因而不是布尔值：取数任务要把"这个小时窗筛掉了多少、为什么"写进
 * `job_runs`，否则某天筛掉 90% 也没人知道。
 */

import type { BehaviorUnitCandidate, UtteranceUnitCandidate } from "./unitize";

export type ScreenReason = "fake-llm" | "cancelled" | "empty-asr" | "excluded-user" | "duplicate";

export interface ScreenResult {
  keep: boolean;
  reason?: ScreenReason;
}

export interface ScreenContext {
  /** `user_flags` 里带 `research_excluded` 的账号。 */
  excludedUserIds: ReadonlySet<string>;
  /** 已经在库里的指纹。跨窗重叠靠它挡（见 `fingerprint.ts`）。 */
  knownFingerprints: ReadonlySet<string>;
}

/** `fake` 是离线确定性档，`mock` 是本机 ASR——后者转的是真人真声，留。 */
const FAKE_ENGINES = new Set(["fake"]);

const KEEP: ScreenResult = { keep: true };

export function screenUnit(
  candidate: UtteranceUnitCandidate | BehaviorUnitCandidate,
  ctx: ScreenContext,
): ScreenResult {
  // 顺序即优先级，但只影响 reason 的取值（都会被筛掉）。
  // 排除账号放最前：它是权利判断，比"这条内容质量如何"更根本。
  if (ctx.excludedUserIds.has(candidate.userId)) return { keep: false, reason: "excluded-user" };
  if (ctx.knownFingerprints.has(candidate.fingerprint)) return { keep: false, reason: "duplicate" };

  if (candidate.kind === "behavior") return KEEP;

  if (candidate.context.asrEngine !== null && FAKE_ENGINES.has(candidate.context.asrEngine)) {
    return { keep: false, reason: "fake-llm" };
  }
  if (candidate.cancelled) return { keep: false, reason: "cancelled" };
  if (candidate.rawText.trim().length === 0) return { keep: false, reason: "empty-asr" };

  return KEEP;
}

/** 一个窗筛下来的账目，直接写进 `job_runs` 的 detail。 */
export interface ScreenTally {
  kept: number;
  dropped: Record<ScreenReason, number>;
}

export function emptyTally(): ScreenTally {
  return {
    kept: 0,
    dropped: { "fake-llm": 0, cancelled: 0, "empty-asr": 0, "excluded-user": 0, duplicate: 0 },
  };
}

export function tally(t: ScreenTally, r: ScreenResult): ScreenTally {
  if (r.keep) t.kept += 1;
  else if (r.reason) t.dropped[r.reason] += 1;
  return t;
}
