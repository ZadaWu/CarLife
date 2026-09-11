/**
 * 侧边导航的图标覆盖。
 *
 * # 为什么要有这条
 *
 * `NavIcon` 对缺图标的路径渲染一个**空的 svg 占位**——这是刻意的（缺一个不该让那一行左移），
 * 代价是加了菜单项却忘了加图标时**什么都不会报**：编译过、测试绿、页面也不塌，
 * 只有那一条菜单空着一格。2026-09-09 的「模型训练」就是这么漏的（M76-03 加了菜单没加图标）。
 *
 * 两个文件都是源码常量，没有运行时依赖，所以按文本抽——与 `graph-drift.test.ts` 同一路子。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (rel: string): string => readFileSync(new URL(rel, new URL("../", import.meta.url)), "utf8");

const LAYOUT = "src/app/Layout.tsx";
const ICONS = "src/app/nav-icons.tsx";

/** `NAV_GROUPS` 里每一条 `{ to: "/x", … }` 的路径。到数组结束（`];`）为止，不含后面别处的 `to:`。 */
function navPaths(src: string): string[] {
  const from = src.indexOf("const NAV_GROUPS");
  assert.notEqual(from, -1, `没能在 ${LAYOUT} 里找到 NAV_GROUPS`);
  const body = src.slice(from, src.indexOf("\n];", from));
  const paths = [...body.matchAll(/\bto:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length > 5, "没能从 NAV_GROUPS 抽到菜单项——正则该跟着改动更新了");
  return paths;
}

/** `PATHS` 这张表的键。 */
function iconKeys(src: string): Set<string> {
  const from = src.indexOf("const PATHS");
  assert.notEqual(from, -1, `没能在 ${ICONS} 里找到 PATHS`);
  const body = src.slice(from, src.indexOf("\n};", from));
  return new Set([...body.matchAll(/^\s{2}"([^"]+)":/gm)].map((m) => m[1]));
}

describe("侧边导航图标", () => {
  const nav = navPaths(read(LAYOUT));
  const icons = iconKeys(read(ICONS));

  it("每个菜单项都有图标——缺了不报错，只是那一格空着", () => {
    const missing = nav.filter((to) => !icons.has(to));
    assert.deepEqual(missing, [], `这些菜单项没有图标，去 ${ICONS} 的 PATHS 里补：${missing.join("、")}`);
  });

  it("图标表里没有指向不存在菜单的死键", () => {
    const orphan = [...icons].filter((to) => !nav.includes(to));
    assert.deepEqual(orphan, [], `这些图标的菜单项已经不在了，删掉：${orphan.join("、")}`);
  });
});
