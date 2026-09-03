/**
 * [F-01-07] 贴视口顶边的浮层必须让开刘海屏安全区。
 *
 * 用户 2026-09-02 的原话：「iphone 挖孔屏顶部的时间和 Wi-Fi 状态那一栏，
 * 用户其实是看不见下面的 UI 的」。落在那一带的元素等于不存在，而且**它自己不报错**：
 *
 *   - `.hud-daytabs` / `.hud-lodging` / `.hud-navbar`：整条藏进灵动岛
 *   - `.hud-map-recenter`（「回到全程」）：压在 WiFi/电量图标下。它是镜头的唯一
 *     回程入口，所以症状是"手滑动了地图就再也回不去"——离根因非常远
 *
 * 这一类在桌面走查里一个都看不出来（env() 恒为 0），只能靠这条守。
 * 读文件不渲染：`clients/mobile` 没有 jsdom，要守的是"有没有写这一条"。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SHEETS = [
  "../../shared/ui/src/hud/hud.css",
  "../../shared/ui/src/map/map.css",
  "../../shared/ui/src/dialog/dialog.css",
  "../../shared/ui/src/guide/guide.css",
  "../src/styles/app.css",
] as const;

/** 顶边判定阈值：iPhone 的顶部安全区最小 44pt，比它小的 top 一定落在里面。 */
const NOTCH_PT = 70;

/**
 * 豁免：参照系不是视口，而是一个**自己已经带了顶部偏移**的父容器。
 * 值是那个父容器的选择器——下面会真的去断言它带了偏移，
 * 豁免不能只靠一句注释成立。
 */
const ANCHORED_TO: Record<string, string> = {
  ".hud-portrait-timeline__header": ".hud-portrait-timeline",
};

type Rule = { sheet: string; selector: string; body: string; top: string };

/**
 * 找出「脱流 + 自带层级 + 贴着顶边」的规则。
 *
 * 要求带 `z-index` 是为了压误报：视口级浮层基本都自带层级，而卡片内部那些
 * 装饰性的 absolute 不带——不加这条，误报比真问题多一个量级（实测）。
 */
function topEdgeRules(sheet: string): Rule[] {
  const css = readFileSync(new URL(sheet, import.meta.url), "utf8");
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().split("\n").pop()!.trim();
    const body = m[2];
    if (!/position:\s*(fixed|absolute)/.test(body)) continue;
    if (!/z-index:/.test(body)) continue;
    const top = body.match(/(?:^|;)\s*top:\s*([^;]+)/)?.[1]?.trim();
    if (!top || top === "auto") continue;
    out.push({ sheet, selector, body, top });
  }
  return out;
}

function hasTopInset(value: string): boolean {
  return value.includes("safe-area-inset-top") || value.includes("--hud-portrait-top");
}

/**
 * top 的字面像素量（`calc(8 * var(...))` 取 8，`14px` 取 14）。取不到当 0。
 *
 * **百分比返回 Infinity**（即"不算贴顶"）：`top: 50%` 配 `translateY(-50%)` 是居中，
 * `top: 20%` 是相对卡片内部——把 50 当成 50px 会把这类全部误报。
 * 第一版就是这么错的，而"判据自己错了"比没有判据更危险。
 */
function topMagnitude(value: string): number {
  if (value.includes("%")) return Number.POSITIVE_INFINITY;
  const n = value.match(/(\d+(?:\.\d+)?)/);
  return n ? Number.parseFloat(n[1]) : 0;
}

/** 某个选择器的**任意**一条规则带了顶部偏移。同名规则可能有好几条（基础态 + 媒体查询）。 */
function selectorHasTopInset(css: string, selector: string): boolean {
  const rules = css.matchAll(
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`, "g"),
  );
  for (const r of rules) {
    const top = r[1].match(/(?:^|;)\s*top:\s*([^;]+)/)?.[1];
    if (top && hasTopInset(top)) return true;
  }
  return false;
}

describe("[F-01-07] 挖孔屏顶部浮层", () => {
  const rules = SHEETS.flatMap(topEdgeRules);

  it("没有贴顶浮层遗漏安全区", () => {
    const missing = rules
      .filter((r) => !hasTopInset(r.top))
      .filter((r) => topMagnitude(r.top) < NOTCH_PT)
      .filter((r) => !(r.selector in ANCHORED_TO))
      .map((r) => `${r.sheet} · ${r.selector} · top: ${r.top}`);
    assert.deepEqual(missing, [], "这些浮层贴着视口顶边却没让开 env(safe-area-inset-top)");
  });

  it("豁免项的父容器确实带了偏移（否则豁免是假的）", () => {
    for (const [child, parent] of Object.entries(ANCHORED_TO)) {
      const holder = rules.find((r) => r.selector === child);
      assert.ok(holder, `${child} 不在扫描结果里，豁免名单已经过期`);
      const css = readFileSync(new URL(holder.sheet, import.meta.url), "utf8");
      assert.ok(
        selectorHasTopInset(css, parent),
        `${parent} 没带顶部偏移，${child} 不能豁免`,
      );
    }
  });

  /* 判据自身要有效：扫描器认不出问题的话，第一条会永远是空数组假绿。 */
  it("扫描器确实认得出遗漏", () => {
    assert.ok(rules.length >= 5, `只扫到 ${rules.length} 条贴顶规则，选择器八成没匹配上`);
    assert.ok(rules.some((r) => hasTopInset(r.top)), "一条带安全区的都没认出来");
  });
});
