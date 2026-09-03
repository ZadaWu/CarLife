/**
 * 走查第一轮拦路缺陷的接线断言（施工单 M52-01）。
 *
 * 两条都是"编得过、跑得起来、功能不存在"，而且都**不报错**：
 *
 *  - **W3**：移除授权点了没反应。`window.confirm` 在 Tauri 里不弹窗、直接返回 false
 *    （wry 0.55.1 没实现 WKWebView 的 `runJavaScriptConfirmPanel`，全仓 grep 零命中），
 *    于是 `if (!window.confirm(...)) return;` 每次都从这里返回。
 *  - **W5**：没有退出登录的入口。`auth_logout` 注册在装配里（ACR-013 后是 `lib.rs`），端上零调用方——
 *    这是同一形状的第三次（前两次是 `switch_device_role`、`request_pairing_code`）。
 *
 * 读源码而不是渲染：`clients/mobile` 没有 jsdom，而要守的恰是接线不是像素。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

/** 去掉注释——第一版直接匹配整个文件，被解释「为什么不用它」的那段注释命中了。 */
const stripComments = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const GRANTS = read("../src/features/ownership/grants.tsx");
const GRANTS_CODE = stripComments(GRANTS);
const SETTINGS = read("../src/features/settings/index.tsx");

describe("[F-55-07][AC-55-5] W3 · 移除授权的二次确认不依赖 window.confirm", () => {
  it("**全文不再出现 `window.confirm`**", () => {
    assert.ok(
      !GRANTS_CODE.includes("window.confirm"),
      "它在 Tauri 里不弹窗、直接返回 false，表现是点了毫无反应",
    );
  });

  it("改成行内两段式：先记下待确认的那一行，再由「确认移除」真正提交", () => {
    assert.match(GRANTS, /setPendingRemove\(g\.userId\)/, "点「移除」只是进入待确认态");
    assert.match(GRANTS, /pendingRemove === g\.userId/, "只有那一行展开确认");
    assert.match(GRANTS, /确认移除/);
    assert.match(GRANTS, /取消/);
  });

  it("确认文案**说清后果**，不是只问「确定吗」", () => {
    assert.match(GRANTS, /从下一次操作起就用不了这辆车/);
    assert.match(GRANTS, /常用人员档案不受影响/, "两者生命周期独立，AC-55-6");
  });

  it("确认后才调 `removeGrant`——不是点第一下就删", () => {
    const confirmBtn = GRANTS.slice(GRANTS.indexOf("pendingRemove === g.userId"));
    assert.match(confirmBtn, /onClick=\{\(\) => void remove\(g\.userId\)\}/);
  });
});

describe("[F-07-03][AC-07-2] W5 · 手机端有退出登录的入口", () => {
  it("`auth_logout` 终于有调用方了", () => {
    assert.match(SETTINGS, /invoke\("auth_logout"\)/);
  });

  it("显示「现在登录的是谁」，走查要反复换人", () => {
    assert.match(SETTINGS, /auth_status/);
    assert.match(SETTINGS, /auth\.displayName \?\? auth\.userId/);
  });

  it("未登录 / 读不到状态时**整组不渲染**，不显示一个点了没用的按钮", () => {
    assert.match(SETTINGS, /auth\?\.authenticated \? \(/);
  });

  it("退出后整页重载——登录门在最外层，局部改状态到不了它", () => {
    assert.match(SETTINGS, /auth_logout[\s\S]{0,200}window\.location\.reload\(\)/);
  });

  it("退出失败也要重载：本地凭证已经清了，停在原地才是最坏的状态", () => {
    assert.match(SETTINGS, /\.catch\(\(\) => undefined\)[\s\S]{0,80}\.finally\(/);
  });
});
