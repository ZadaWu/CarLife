/**
 * 上车声明的临时策略：绑定后自动以车主身份进入（2026-09-03，演示前产品决定）。
 *
 * 守两件事：**藏而不删**（选择屏与访客入口的代码还在，开关一关就回来），
 * 以及自动路径失败时**退回选择屏**（不能把人锁在一个空屏上）。
 * 与 boarding-gate-failure.test.ts 同一种测法：读源码断形状，这类行为没有别的断言能抓到。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const POLICY = read("../src/features/auth/boardingPolicy.ts");
const GATE = read("../src/features/auth/BoardingGate.tsx");
const ACCOUNT = read("../src/features/settings/AccountSection.tsx");

describe("上车声明临时策略：默认车主", () => {
  it("开关是一个常量，且当前为真", () => {
    assert.match(POLICY, /export const AUTO_DECLARE_OWNER = true;/);
  });

  it("BoardingGate 读开关，自动只替用户点「车主」，且只试一次", () => {
    assert.match(GATE, /import \{ AUTO_DECLARE_OWNER \} from "\.\/boardingPolicy"/);
    assert.match(GATE, /members\.find\(\(m\) => m\.role === "owner"\)/, "自动声明只能选 owner，不能选第一个成员");
    assert.match(GATE, /setAutoTried\(true\)/, "只试一次，失败退回选择屏，不能循环");
  });

  it("藏而不删：选择屏、访客入口、名单只显示自设称呼——代码都还在", () => {
    assert.match(GATE, /现在是谁在用车？/);
    assert.match(GATE, /访客模式/);
    assert.match(GATE, /declare\(null\)/, "访客入口（activeUserId = null）还在");
    assert.match(GATE, /m\.displayName \?\? m\.userId/, "名单只显示账号自设的 displayName");
  });

  it("自动路径失败时露出原来的选择屏，不是空屏", () => {
    // 自动进行中显示一句话（不是 return null）；一旦有 error，就落到下面的选择屏
    assert.match(GATE, /if \(AUTO_DECLARE_OWNER && !error\) \{/);
    assert.match(GATE, /正在以车主身份进入/);
    assert.match(GATE, /成员名单里没有车主，无法自动进入/);
  });

  it("设置页在开关为真时不给「更换使用人」按钮", () => {
    assert.match(ACCOUNT, /import \{ AUTO_DECLARE_OWNER \} from "\.\.\/auth\/boardingPolicy"/);
    assert.match(ACCOUNT, /\{AUTO_DECLARE_OWNER \? null : \(/);
    assert.match(ACCOUNT, /更换使用人/, "按钮代码还在，只是不渲染");
  });
});
