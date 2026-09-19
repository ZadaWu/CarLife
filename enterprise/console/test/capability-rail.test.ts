/**
 * 能力条的渲染决策（施工单 M85-04）。
 *
 * 断言的是 `railModel` 这个纯函数，不做 DOM 快照——快照对着改一行样式就会红，
 * 于是很快被改成"更新快照"，而这里有一条**不能被更新掉**的规则：
 * 被抑制的格上零按钮。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SelectionScope } from "@carlife/research/capabilities";

import {
  IMPLEMENTED,
  RAIL_PRIMARY_MAX,
  SUPPRESSED_NOTE,
  WORKORDER_OF,
  railModel,
} from "../src/pages/research/evidence-matrix/rail-model";

const cell = (over: Partial<Extract<SelectionScope, { kind: "cell" }>> = {}): SelectionScope => ({
  kind: "cell",
  needPainCode: "cold-range-loss",
  sceneCode: "charging",
  suppressed: false,
  catchAll: false,
  hasDirection: false,
  ...over,
});

describe("[M85-04] G1 的界面落点：被抑制的格上零按钮", () => {
  it("抑制态只出那句文案，一个按钮都不渲染", () => {
    const m = railModel(cell({ suppressed: true }), "小单元抑制：这一格只覆盖 3 台车");
    assert.equal(m.kind, "suppressed");
    assert.equal(m.kind === "suppressed" && m.note, SUPPRESSED_NOTE);
    assert.ok(!("primary" in m), "抑制态不该有按钮数组");
  });

  it("**判据是 suppressedReason，不是「能力列表为空」**", () => {
    /*
     * 两者今天恰好等价，但语义不同：列表为空还可能是"这个范围恰好没有适用的能力"。
     * 这里给一个**不抑制但没有能力**的范围，它必须落进 empty 而不是 suppressed——
     * 借用同一句文案会让两种情况在页面上长得一样。
     */
    const m = railModel({ kind: "card", insightId: "x" }, null);
    assert.notEqual(m.kind, "suppressed");
  });

  it("scope 为 null（下标越界）→ 什么都不渲染，不是抑制文案", () => {
    assert.equal(railModel(null, null).kind, "empty");
  });

  it("同一格不抑制时是有按钮的——证明上面几条不是恒空", () => {
    const m = railModel(cell(), null);
    assert.equal(m.kind, "rail");
    assert.ok(m.kind === "rail" && m.primary.length > 0);
  });
});

describe("[M85-04] 一次只露 2–3 个，其余进 ⋯", () => {
  it("主区按钮数不超过 3，其余落进 overflow", () => {
    const m = railModel(cell({ hasDirection: true, catchAll: true }), null);
    assert.equal(m.kind, "rail");
    if (m.kind !== "rail") return;
    assert.ok(m.primary.length <= RAIL_PRIMARY_MAX);
    // 有方向 + 兜底桶的格上有 8 条能力（M89-04 起多了 c10 / c12），装不下的要真的落进 ⋯。
    assert.equal(m.primary.length + m.overflow.length, 8);
    assert.ok(m.overflow.length > 0);
  });

  it("**能点的排前面**：否则整条能力条看起来像都没做", () => {
    const page = railModel({ kind: "page" }, null);
    if (page.kind !== "rail") throw new Error("应当是 rail");
    assert.equal(page.primary[0].id, "c9");
    assert.equal(page.primary[0].disabled, false);

    /*
     * M89-04 起十二条全部实现，"未实现的那条被挤到最后"这个靶子在**任何范围上
     * 都不存在了**（c8 曾是它）。所以这里不再钉某一条的 id——那只会变成一条
     * 跟着目录顺序走、与排序规则无关的断言——改成直接断言规则本身：
     * **一旦出现禁用的按钮，它后面不许再有能点的**。
     */
    for (const scope of [
      cell(),
      cell({ catchAll: true, hasDirection: true }),
      { kind: "row", needPainCode: "x", suppressed: false, catchAll: false } as const,
      { kind: "col", sceneCode: "charging" } as const,
      { kind: "page" } as const,
    ]) {
      const m = railModel(scope, null);
      if (m.kind !== "rail") throw new Error(`${scope.kind} 应当是 rail`);
      const ordered = [...m.primary, ...m.overflow];
      const firstOff = ordered.findIndex((b) => b.disabled);
      if (firstOff < 0) continue;
      assert.ok(
        ordered.slice(firstOff).every((b) => b.disabled),
        `${scope.kind} 上禁用的按钮后面还排着能点的：${ordered.map((b) => `${b.id}${b.disabled ? "✗" : "✓"}`).join(" ")}`,
      );
    }
  });
});

describe("[M85-05] 做不到与还没做是两回事", () => {
  /*
   * C4 的能力目录把它开在整列上，而分群切分按主题做、主题只按需求码切、不带场景。
   * 服务端对整列的 C4 回 400 `scope_not_supported`，所以界面上这个按钮必须按不下去。
   * 留着它可点，点了就是一个技术错误码，而按钮看起来完全正常。
   */
  it("整列上的「谁被漏掉了」按不下去，且 title 说的是原因不是工单号", () => {
    const m = railModel({ kind: "col", sceneCode: "charging" }, null);
    if (m.kind !== "rail") throw new Error("应当是 rail");
    const c4 = [...m.primary, ...m.overflow].find((b) => b.id === "c4")!;
    assert.equal(c4.disabled, true);
    assert.ok(!/M85-/.test(c4.title), `说成了「还没做」：${c4.title}`);
    assert.match(c4.title, /整列答不了/);
  });

  it("同一条能力在格与整行上照常可点——上一条不是把它关掉了", () => {
    for (const scope of [cell(), { kind: "row", needPainCode: "x", suppressed: false, catchAll: false } as const]) {
      const m = railModel(scope, null);
      if (m.kind !== "rail") throw new Error("应当是 rail");
      const c4 = [...m.primary, ...m.overflow].find((b) => b.id === "c4")!;
      assert.equal(c4.disabled, false, `${scope.kind} 上的 c4 被误禁用`);
    }
  });
});

describe("[M85-04] 未实现的能力：显示但不可点，且说明属于哪张单", () => {
  it("禁用按钮的 title 点名工单号", () => {
    const m = railModel(cell(), null);
    if (m.kind !== "rail") throw new Error("应当是 rail");
    for (const b of [...m.primary, ...m.overflow].filter((x) => x.disabled)) {
      assert.ok(b.title.length > 0, `${b.id} 没有 title`);
      assert.match(b.title, /M85-\d\d/, `${b.id} 的 title 没点名工单号：${b.title}`);
    }
  });

  it("已实现的按钮可点，且 title 说的是耗时预期不是工单号", () => {
    const page = railModel({ kind: "page" }, null);
    if (page.kind !== "rail") throw new Error("应当是 rail");
    const c9 = page.primary.find((b) => b.id === "c9")!;
    assert.equal(c9.disabled, false);
    assert.ok(!/M85-/.test(c9.title));
    assert.match(c9.title, /即点即出/);
  });

  it("每个按钮都带层图标", () => {
    const m = railModel(cell({ hasDirection: true, catchAll: true }), null);
    if (m.kind !== "rail") throw new Error("应当是 rail");
    for (const b of [...m.primary, ...m.overflow]) {
      assert.ok(["🔍", "✎", "💬"].includes(b.icon), `${b.id} 的图标不对：${b.icon}`);
    }
  });
});

/*
 * 前端这张表本该由后端给（能力目录没有 status 字段，而本单不改后端）。
 * 下面两条是它与后端对账的机械检出点：后端实现了新能力而这里忘了改的话，
 * 表现是"后端已经能跑了，界面上那个按钮还是灰的"——一个不报错的故障。
 */
const RUNTIME_SRC = readFileSync(
  // `test/` → `console/` → `enterprise/`，所以是两级。
  join(
    new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
    "backend/research-runtime/src/internal-api/capabilities.ts",
  ),
  "utf8",
);

describe("[M85-04] 前端的可用性表与后端对账", () => {
  it("工单号映射与后端的 WORKORDER_OF 逐条相同", () => {
    const block = RUNTIME_SRC.slice(RUNTIME_SRC.indexOf("const WORKORDER_OF"));
    for (const [id, wo] of Object.entries(WORKORDER_OF)) {
      assert.match(
        block.slice(0, block.indexOf("};")),
        new RegExp(`${id}:\\s*"${wo}"`),
        `${id} 的工单号与后端对不上（前端写的是 ${wo}）`,
      );
    }
  });

  it("已实现集合与后端的那张表逐条相同", () => {
    /*
     * 后端把"已实现"写成一行字面量 `new Set([...])`，就是为了这条能读得出来。
     * 它改成别的形状（推导、多行、按 CAPABILITIES 过滤）时这条会红——
     * 那正是要的：红了就回去核对两边，而不是让它静默失效。
     */
    const line = RUNTIME_SRC.split("\n").find((l) => /IMPLEMENTED.*new Set\(/.test(l));
    assert.ok(line, "后端的已实现表变了形状，回来核对 IMPLEMENTED 这张表");
    /*
     * ⚠️ `c[1-9]` 会漏掉 c10–c12（M89-04 真踩到：后端十二条、前端九条，
     * 而这条对账用例照样绿——它只比对了它自己匹配得出的那九条）。
     */
    const ids = [...line.matchAll(/"(c\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      [...IMPLEMENTED].sort(),
      ids.sort(),
      `前端的 IMPLEMENTED 与后端实际实现的对不上：后端是 ${ids.join("、")}`,
    );
  });
});

/*
 * 「问它」三条（C10–C12）的范围矩阵（施工单 M89-04）。
 *
 * 三个角色的适用范围**各不相同**（设计稿 §4）：分类学家看的是码与主题的边界，
 * 那是行与整屏的事，一格答不了；档案员看的是某几条证据的来源，整屏没有对象。
 * 抄错的表现是界面上多出一个按得动、点下去回 400 `capability_not_available`
 * 的按钮——而它看起来完全正常。
 */
describe("[M89-04] 「问它」三条的范围矩阵", () => {
  const idsOn = (scope: SelectionScope): string[] => {
    const m = railModel(scope, null);
    if (m.kind !== "rail") return [];
    return [...m.primary, ...m.overflow].map((b) => b.id);
  };

  const row: SelectionScope = { kind: "row", needPainCode: "cold-range-loss", suppressed: false, catchAll: false };

  it("格上有 c10 / c12，**没有 c11**——一格答不了主题边界", () => {
    const ids = idsOn(cell());
    assert.ok(ids.includes("c10"), "格上少了「问分析师」");
    assert.ok(ids.includes("c12"), "格上少了「问档案员」");
    assert.ok(!ids.includes("c11"), "格上多出了「问分类学家」：点下去是 400 capability_not_available");
  });

  it("整行上三条都在", () => {
    const ids = idsOn(row);
    for (const id of ["c10", "c11", "c12"]) assert.ok(ids.includes(id), `整行上少了 ${id}`);
  });

  it("**整列上一条都没有**——三个角色都没有「按场景」的问法", () => {
    const ids = idsOn({ kind: "col", sceneCode: "charging" });
    for (const id of ["c10", "c11", "c12"]) assert.ok(!ids.includes(id), `整列上多出了 ${id}`);
  });

  it("卡片上是 c10 / c12，整屏上是 c10 / c11", () => {
    const card = idsOn({ kind: "card", insightId: "i-1" });
    assert.ok(card.includes("c10") && card.includes("c12"));
    assert.ok(!card.includes("c11"));
    const page = idsOn({ kind: "page" });
    assert.ok(page.includes("c10") && page.includes("c11"));
    assert.ok(!page.includes("c12"), "整屏上多出了「问档案员」：整屏没有可检索的对象");
  });

  it("三条都可点，且带 💬 图标——不是「还没做」的灰按钮", () => {
    const m = railModel(row, null);
    if (m.kind !== "rail") throw new Error("应当是 rail");
    for (const b of [...m.primary, ...m.overflow].filter((x) => ["c10", "c11", "c12"].includes(x.id))) {
      assert.equal(b.disabled, false, `${b.id} 还被当成没实现：${b.title}`);
      assert.equal(b.icon, "💬", `${b.id} 的层图标不对：${b.icon}`);
      assert.ok(!/还没做/.test(b.title), `${b.id} 的 title 说的是「还没做」：${b.title}`);
    }
  });
});
