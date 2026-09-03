/**
 * 静默检测（施工单 M18-03，F-45-03 / F-45-12；M18-09 改间隔基准）。
 *
 * # 事件驱动 + 节拍
 *
 * 内容来自事件，但 span 是**完成时**才落的——检索跑的那几秒轨迹侧没有事件，
 * 纯事件驱动会在最长的那段等待里哑掉。所以 M18-08 加了节拍来重新判定，
 * 判定逻辑（也就是本文件）仍然是纯函数，可逐条断言。
 *
 * # 这里**不管什么时候收摊**
 *
 * 条数与总时长上限在 M18-09 被移除了：turn 会不会结束是会话超时的职责，
 * 旁路的生命周期绑在 turn 上（见 `budget.ts` 的模块注释）。
 */

import type { SidecarConfig } from "./budget";

export interface SilenceState {
  /** 最后一次**面向用户的内容**的时刻（只有 delta / retract 会推进它）。 */
  lastUserFacingAt: number;
  /**
   * 上一句垫场**估算念完**的时刻；没说过为 0。
   *
   * ⚠️ 是"念完"不是"发出"。按发出算是 M18-09 修掉的一个真 bug：
   * 第 1 句 48 字要念 10 秒，而间隔 4 秒——第 4 秒就会发出下一句，
   * 端上 `speak_filler` 会 `stop()` 掉正在播的那句，用户听到的是半句。
   */
  speakingUntil: number;
  /** 静音原因集合（HITL / 告警）。非空即闭嘴。 */
  mutedBy: ReadonlySet<string>;
  closed: boolean;
}

/** 不说话的原因。分因计数是调参时唯一的依据。 */
export type SuppressReason = "closed" | "muted" | "silence" | "gap";

/**
 * 该不该开口。**纯函数**——判据可逐条断言，这是它值钱的地方。
 *
 * 返回 `undefined` 表示可以说；否则是被挡住的原因。
 */
export function suppressReason(
  state: SilenceState,
  now: number,
  cfg: SidecarConfig,
): SuppressReason | undefined {
  if (state.closed) return "closed";

  /*
   * 静音优先于静默判定（F-45-12）。
   *
   * HITL 挂起期间的"没声音"是**在等用户**，不是在等系统——两者从事件流上看
   * 一模一样，而猜错的方向恰好是最坏的那个：往确认问句上插话，
   * 盖掉有后果动作的最后一道用户侧闸门。所以信号取自真实 `permission` 事件。
   */
  if (state.mutedBy.size > 0) return "muted";

  if (now - state.lastUserFacingAt < cfg.silenceMs) return "silence";

  // 上一句还在念，或者念完还没到间隔——两种都归 gap。
  if (state.speakingUntil > 0 && now - state.speakingUntil < cfg.minGapMs) return "gap";

  return undefined;
}

export function shouldSpeak(state: SilenceState, now: number, cfg: SidecarConfig): boolean {
  return suppressReason(state, now, cfg) === undefined;
}
