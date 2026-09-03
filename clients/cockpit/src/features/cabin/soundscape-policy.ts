/**
 * 音景的三个闸（施工单 M64-03）。
 *
 * # 静音与降级是两件事，别合并成一个 bool
 *
 * 「暖暖在说话」→ **全静**：播报是功能，音景是装饰，装饰不该盖住功能。
 * 「车内音乐在放」→ **降级**：音乐不是必须让路的对象，两者可以共存，只是不能吵。
 * 合并成一个 bool 的后果是将来改其中一条会误伤另一条——而两条的理由完全不同。
 *
 * # 音景只降低自己，绝不去压音乐
 *
 * `tts/ducking.rs` 的文件头写死了这条教训：「两处各写一遍让路，迟早对不齐，
 * 而对不齐的表现是**音乐一直压着没恢复**」。所以本文件里没有任何"压低音乐"的出口，
 * `music::set_ducked` 的调用方仍然只有 `tts::ducking::set_tts_playing` 一处。
 * 本单只读一个 `music_is_audible`，读完降的是音景自己。
 */

import type { AssistantState } from "@carlife/shared";
import type { CueName } from "@carlife/ui";

export type SoundscapePolicy = "full" | "minimal" | "silent";

export interface PolicyInput {
  /** 界面音效开关（用户设置）。 */
  enabled: boolean;
  /** 助手此刻的五态；`speaking` 即播报中。`null`/缺省 = 不知道，按没在说话算。 */
  assistantState?: AssistantState | null;
  /** 车内音乐此刻在不在出声（`invoke("music_is_audible")` 的结果）。 */
  musicAudible: boolean;
}

/**
 * 降级形态下保留哪些 cue。
 *
 * 只留一头一尾：按下去有反馈、走的时候有收束。中间那四个（铺底、就绪音、
 * 上行三音、关门闷响）全部让给音乐——它们是"氛围"，而氛围位已经被歌占了。
 */
export const MINIMAL_CUES: readonly CueName[] = ["jingle", "resolve"];

/**
 * 这一轮该用哪种形态。
 *
 * 判定顺序本身就是语义，别随手调换：
 *
 * 1. **开关关着 ⇒ 全静。** 它是用户的明确意愿，压过一切。
 * 2. **暖暖在说话 ⇒ 全静。** 优先于音乐那一条：正在播报时不该因为"音乐也在放"
 *    就退而求其次地出两个 earcon，那两个音照样盖在她说的话上。
 * 3. **音乐在放 ⇒ 降级。**
 * 4. 否则完整形态。
 */
export function decidePolicy({ enabled, assistantState, musicAudible }: PolicyInput): SoundscapePolicy {
  if (!enabled) return "silent";
  if (assistantState === "speaking") return "silent";
  if (musicAudible) return "minimal";
  return "full";
}

/** 这一帧跨过的 cue，按形态过一遍闸。顺序保持不变。 */
export function cuesForPolicy(policy: SoundscapePolicy, cues: readonly CueName[]): CueName[] {
  if (policy === "silent") return [];
  if (policy === "minimal") return cues.filter((c) => MINIMAL_CUES.includes(c));
  return [...cues];
}
