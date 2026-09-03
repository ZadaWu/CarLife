/**
 * 手机端主题：跟随系统，不做手动切换（M65-00 决策 5）。
 *
 * 车机的主题按钮在 devbar（演示用）；手机没有 devbar，也不该为此长出一个设置项——
 * 系统已经有一个。`?theme=dark|light` 保留为截图入口（与车机 `demoTheme()` 同款）。
 * 此前手机端 `useState<ThemeName>("light")` 没有 setter，暗色 token 一次都没生效过。
 */
import type { ThemeName } from "@carlife/ui";

export function resolveTheme(search: string, systemPrefersDark: boolean): ThemeName {
  const q = new URLSearchParams(search).get("theme");
  if (q === "dark" || q === "light") return q;
  return systemPrefersDark ? "dark" : "light";
}

/**
 * 把主题写到文档根。
 *
 * # 为什么必须在登录门之前调一次
 *
 * `data-theme` 原来只在 `App` 的 effect 里写，而 `App` 挂在 `LoginGate` 里面——
 * **登录页上它一次都没执行过**。于是 `<html>` 上没有 `data-theme`，命中
 * `@carlife/ui` 的 `:root { color-scheme: light }`，而 `.login-gate` 自己硬写了深色底。
 *
 * 「深色页面 + 对外声明浅色」在浏览器里只是配色不搭，在 iOS 上是**可见的坏**：
 * 系统按 `color-scheme` 决定键盘与其上方输入辅助条的外观，于是深色登录页底部
 * 顶出一条**浅蓝色的横带**，看起来像布局漏了一块。2026-09-02 在 iPhone 16 Pro Max
 * 上就是这么被当成"底部空白"报上来的。
 *
 * 取 `HTMLElement` 而不是直接摸 `document`，是为了能在没有 jsdom 的测试里验它。
 */
export function setRootTheme(root: Pick<HTMLElement, "dataset">, theme: ThemeName): void {
  root.dataset.theme = theme;
}

/** 系统是不是深色。测试与非浏览器环境下当作浅色。 */
export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
}

/**
 * 持续跟随系统外观，把主题写到文档根。返回取消订阅。
 *
 * 与 `App` 里那份 effect 的分工：这一份**管的是登录门那段时间**——`App` 挂在
 * `LoginGate` 里面，用户还没登录时它连同它的监听器都不存在。少了这一份，
 * 停在登录页时拉下控制中心切深浅色，页面纹丝不动（首帧对、之后不再对）。
 *
 * `App` 那份不能省：它还要把主题作为 React 状态喂给 `HudStage` 的 `data-theme`。
 * 两份各写各的目标，写的值同源（都过 `resolveTheme`），不会互相打架。
 */
export function watchRootTheme(root: Pick<HTMLElement, "dataset">, search: string): () => void {
  const mq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
  if (!mq) return () => {};
  const onChange = () => setRootTheme(root, resolveTheme(search, mq.matches));
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
