/**
 * 档案页的顶部 tab（车辆档案 / 人员档案）：**吸顶不动，且不钻进灵动岛**。
 *
 * # 三条容易被下一次改动无声破坏的前提
 *
 * 1. **滚动容器是页壳自己**（`.own-page` 是 `position:absolute; inset:0; overflow-y:auto`）。
 *    `sticky` 的 `top` 相对的是这个滚动口的 padding box，`top: 0` 会一路贴到最上沿。
 * 2. 于是**上内距必须在 tab 条身上**，不能留在页壳上：留在页壳上的话，tab 条滚上去
 *    会盖到状态栏与灵动岛底下——这正是 2026-09-02 在 iPhone 16 Pro Max 上踩过的那个坑
 *    （见 `safe-area.test.ts`），只是这次换了个地方复发。桌面走查里 `env()` 恒为 0，看不出来。
 * 3. **人员档案不能再自带页壳**。它原来是二级页，自己也是一张 `position:absolute; inset:0`
 *    的 `.own-page`；作为 tab 内容再套一层，里层会盖住外层的 tab 条，表现是"切过去 tab 没了"。
 *
 * 另外钉住换 tab 回顶：滚动条是两个面板共用的，不回顶就会落在新面板的中段
 * （实测在车那一面翻到底再切过去，落点在 742px 处）。
 *
 * 本包没有 jsdom，渲染不了组件：读源码。几何在浏览器与 iPhone 模拟器的 Safari 里都量过。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const here = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const CSS = here("../src/features/ownership/ownership.css").replace(/\/\*[\s\S]*?\*\//g, "");
const INDEX = here("../src/features/ownership/index.tsx").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "");
const PEOPLE = here("../src/features/ownership/people.tsx").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "");

/** 选择器（整条，含逗号分组）对应的声明块；同名多条取最后一条。 */
function body(selector: string): string | undefined {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].trim().replace(/\s+/g, " ") === selector)
    .pop()?.[2];
}

describe("档案页顶部 tab", () => {
  it("tab 条吸顶：sticky + top: 0", () => {
    const b = body(".own-tabs");
    assert.ok(b, "找不到 .own-tabs");
    assert.match(b, /position:\s*sticky/, "不是 sticky 的话，滚两下 tab 就跟着走了");
    assert.match(b, /top:\s*0/, "sticky 不给 top 等于没吸顶（它会一直跟着内容滚）");
  });

  it("刘海/灵动岛的避让在 tab 条身上，页壳那份被清零", () => {
    assert.match(
      body(".own-tabs") ?? "",
      /padding:[^;]*env\(safe-area-inset-top\)/,
      "tab 条自己不让开顶部安全区，吸顶之后就压在状态栏与灵动岛底下",
    );
    assert.match(
      body(".own-page--tabs") ?? "",
      /padding-top:\s*0/,
      "页壳还留着上内距的话，tab 条会从那段空白上面滑过去，顶上露出一条底色",
    );
  });

  it("tab 条铺满整宽：左右负外边距抵掉页壳的 16px 内距", () => {
    const b = body(".own-tabs") ?? "";
    const m = b.match(/margin:\s*([^;]+)/);
    assert.ok(m, ".own-tabs 没有 margin");
    assert.match(
      m[1],
      /-16px/,
      `不铺满的话，卡片会从两侧 16px 的缝里穿过去（现在是 ${m[1].trim()}）`,
    );
  });

  it("两个 tab 是真的 tab：role + aria-selected 都在", () => {
    const tabs = [...INDEX.matchAll(/role="tab"/g)];
    assert.equal(tabs.length, 2, "应该正好两个 role=\"tab\"");
    assert.equal([...INDEX.matchAll(/aria-selected=/g)].length, 2, "每个 tab 都要报自己选没选中");
    assert.match(INDEX, /role="tablist"/, "缺 tablist：读屏时这就是两枚普通按钮");
  });

  it("人员档案不再是二级页：没有 people 这一支 PageMode，也没有返回键", () => {
    assert.doesNotMatch(INDEX, /kind:\s*"people"/, "people 还留在 PageMode 里——两套导航并存迟早对不上");
    assert.doesNotMatch(PEOPLE, /own-back/, "人员档案还画着「‹ 车辆档案」返回键，而它已经是一个 tab 了");
  });

  it("人员档案不自带页壳——套两层 own-page 会把 tab 条盖掉", () => {
    assert.doesNotMatch(
      PEOPLE,
      /className=\{?`?own-page/,
      "people.tsx 又套了一层 .own-page：它是 position:absolute; inset:0，会整个盖住外层的 tab 条",
    );
  });

  it("换 tab 回到顶部——滚动条是两个面板共用的", () => {
    assert.match(
      INDEX,
      /scrollTo\(\{\s*top:\s*0/,
      "不回顶的话，在车那一面翻到底再切过去，人员那一面从中段开始",
    );
    assert.match(INDEX, /\}, \[tab\]\)/, "回顶要挂在 tab 变化上，不是挂在别的依赖上");
  });
});
