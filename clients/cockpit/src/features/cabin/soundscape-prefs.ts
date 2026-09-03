/**
 * 「界面音效」开关的读写（施工单 M64-03）。
 *
 * # 为什么走 localStorage 而不是 Tauri 命令
 *
 * 端上的偏好在这个仓里有两路：Tauri `invoke`（哨兵、打断——Rust 侧真的要用它们）
 * 与 `localStorage`（会话 sid、走查 token）。界面音效是**纯前端**行为，
 * Rust 侧从头到尾不需要知道它，存到 Rust 去只是凭空多一条要同步的链。
 *
 * # 读写都要 try/catch
 *
 * `devAuth.ts` 已经写明"隐私模式下读 localStorage 会抛"。读不到时按**默认开**——
 * 音景是这条动画本来就该有的一半，不是需要用户主动发现的增强。
 *
 * # 键名与默认值只在这里定义一次
 *
 * 组件里散着写字符串的下场是改键名时漏掉一处，而漏掉的表现是"开关拨了没用"。
 */

/** localStorage 键。改它要同步改 runbook 与走查说明。 */
export const SOUNDSCAPE_PREF_KEY = "carlife.ui.soundscape";

/** 默认开。 */
export const SOUNDSCAPE_DEFAULT = true;

/** 读开关。读不到、存储不可用、值不认识——一律回默认。 */
export function readSoundscapePref(): boolean {
  try {
    const raw = window.localStorage.getItem(SOUNDSCAPE_PREF_KEY);
    if (raw === "on") return true;
    if (raw === "off") return false;
    return SOUNDSCAPE_DEFAULT;
  } catch {
    return SOUNDSCAPE_DEFAULT;
  }
}

/**
 * 写开关。写不进去**不影响当次生效**——调用方拿到的是它自己传进来的值，
 * 只是下次启动会退回默认。隐私模式下这是唯一能给的行为。
 */
export function writeSoundscapePref(on: boolean): void {
  try {
    window.localStorage.setItem(SOUNDSCAPE_PREF_KEY, on ? "on" : "off");
  } catch {
    // 存不下就存不下，不该让一个开关的点击抛出去。
  }
}
