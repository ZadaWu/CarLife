/**
 * 播报音量的纯函数。单独一个文件是为了测试能 import 它——
 * `SettingsScreen.tsx` 经 `@carlife/ui` 带进 png 资源，node:test 加载不了。
 */

/** 播报音量只认 0~100 的整数；Rust 侧也钳，这里再钳一次是为了界面不显示 `NaN%`。 */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.min(100, Math.max(0, Math.round(v)));
}
