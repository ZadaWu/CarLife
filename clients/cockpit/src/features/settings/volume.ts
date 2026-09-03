/**
 * 播报音量的纯函数。单独一个文件是为了测试能 import 它——
 * `SettingsScreen.tsx` 经 `@carlife/ui` 带进 png 资源，node:test 加载不了。
 */

/** 出厂默认，与 Rust 侧 `DEFAULT_VOLUME_PERCENT` 同值——读命令之前界面先显示它。 */
export const DEFAULT_VOLUME = 15;

/** 播报音量只认 0~100 的整数；Rust 侧也钳，这里再钳一次是为了界面不显示 `NaN%`。 */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_VOLUME;
  return Math.min(100, Math.max(0, Math.round(v)));
}
