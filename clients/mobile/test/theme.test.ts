/**
 * [F-01-07][AC-01-7] 手机端主题跟随系统（M65-00 决策 5）。
 * 此前 `useState<ThemeName>("light")` 没有 setter，暗色 token 在手机端一次都没生效过。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { resolveTheme, setRootTheme } from "../src/app/theme";

describe("[F-01-07] resolveTheme", () => {
  it("?theme= 优先于系统（截图入口）", () => {
    assert.equal(resolveTheme("?theme=dark", false), "dark");
    assert.equal(resolveTheme("?theme=light", true), "light");
  });
  it("没有 query → 跟系统", () => {
    assert.equal(resolveTheme("", true), "dark");
    assert.equal(resolveTheme("?plan=demo", false), "light");
  });
  it("非法值当没写", () => {
    assert.equal(resolveTheme("?theme=blue", true), "dark");
  });
});

describe("[F-01-07] 主题必须在登录门之前落到 <html>", () => {
  it("setRootTheme 写的是 data-theme", () => {
    const root = { dataset: {} as Record<string, string> };
    setRootTheme(root as never, "dark");
    assert.equal(root.dataset.theme, "dark");
  });

  /*
   * 这条守的是**接线位置**，不是行为：`App` 的 effect 挂在 `LoginGate` 里面，
   * 登录页上一次都不执行。少了 main.tsx 里那次调用，登录页就是
   * 「深色底 + color-scheme: light」，iOS 会照浅色画输入辅助条，
   * 底部顶出一条浅蓝横带——而这在浏览器走查里完全看不出来。
   */
  it("登录页也跟随系统实时切换（App 的监听器挂在登录门里面，那会儿不存在）", () => {
    const src = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
    assert.match(src, /watchRootTheme\(document\.documentElement/);
  });

  it("main.tsx 在 render 之前就写好了根主题", () => {
    const src = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
    const applied = src.indexOf("setRootTheme(document.documentElement");
    const rendered = src.indexOf("createRoot(");
    assert.ok(applied > 0, "main.tsx 必须自己写一次根主题，不能只靠 App 的 effect");
    assert.ok(applied < rendered, "必须早于 createRoot——晚了登录页第一帧仍是浅色声明");
  });
});
