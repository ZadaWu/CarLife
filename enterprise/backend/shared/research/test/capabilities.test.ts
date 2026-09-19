/**
 * 能力目录与 `capabilitiesFor`（施工单 M85-02）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CAPABILITIES,
  CATCH_ALL_NEED_PAIN,
  capabilitiesFor,
  capabilityById,
  cellScope,
  requiresModel,
  type CapabilityId,
  type SelectionScope,
} from "../src/capabilities";

const idsFor = (scope: SelectionScope): CapabilityId[] => capabilitiesFor(scope).map((c) => c.id);

const cell = (over: Partial<Extract<SelectionScope, { kind: "cell" }>> = {}): SelectionScope => ({
  kind: "cell",
  needPainCode: "cold-range-loss",
  sceneCode: "charging",
  suppressed: false,
  catchAll: false,
  hasDirection: false,
  ...over,
});

const row = (over: Partial<Extract<SelectionScope, { kind: "row" }>> = {}): SelectionScope => ({
  kind: "row",
  needPainCode: "cold-range-loss",
  catchAll: false,
  suppressed: false,
  ...over,
});

describe("[M85-02] G1：被抑制的范围上一条能力都没有", () => {
  it("被抑制的格 → 空数组", () => {
    assert.deepEqual(capabilitiesFor(cell({ suppressed: true })), []);
  });

  it("被抑制的格即使有方向、即使是兜底桶，也还是空数组", () => {
    assert.deepEqual(
      capabilitiesFor(cell({ suppressed: true, hasDirection: true, catchAll: true, needPainCode: CATCH_ALL_NEED_PAIN })),
      [],
    );
  });

  it("被抑制的行 → 空数组", () => {
    assert.deepEqual(capabilitiesFor(row({ suppressed: true })), []);
  });

  it("同一格不抑制时是有能力的——证明上面三条不是恒空", () => {
    assert.ok(capabilitiesFor(cell()).length > 0);
    assert.ok(capabilitiesFor(row()).length > 0);
  });
});

describe("[M85-02 / M89-03] 十二条能力各自在哪些范围下出现", () => {
  /** 期望表：一行一个范围，写死这一刻该出现的 id。 */
  const EXPECTED: Array<{ name: string; scope: SelectionScope; ids: CapabilityId[] }> = [
    { name: "普通格（无方向、非兜底桶）", scope: cell(), ids: ["c1", "c2", "c4", "c5", "c10", "c12"] },
    { name: "有方向的格", scope: cell({ hasDirection: true }), ids: ["c1", "c2", "c3", "c4", "c5", "c10", "c12"] },
    {
      name: "兜底桶格",
      scope: cell({ needPainCode: CATCH_ALL_NEED_PAIN, catchAll: true }),
      ids: ["c1", "c2", "c4", "c5", "c8", "c10", "c12"],
    },
    { name: "普通行", scope: row(), ids: ["c2", "c4", "c5", "c10", "c11", "c12"] },
    {
      name: "兜底桶行",
      scope: row({ needPainCode: CATCH_ALL_NEED_PAIN, catchAll: true }),
      ids: ["c2", "c4", "c5", "c8", "c10", "c11", "c12"],
    },
    { name: "列（一个场景）", scope: { kind: "col", sceneCode: "charging" }, ids: ["c4"] },
    { name: "一张洞察卡", scope: { kind: "card", insightId: "insight-1" }, ids: ["c6", "c7", "c10", "c12"] },
    { name: "整屏", scope: { kind: "page" }, ids: ["c9", "c10", "c11"] },
  ];

  for (const row_ of EXPECTED) {
    it(row_.name, () => assert.deepEqual(idsFor(row_.scope), row_.ids));
  }

  it("C3 在没有方向变化的格上不出现", () => {
    assert.ok(!idsFor(cell({ hasDirection: false })).includes("c3"));
    assert.ok(idsFor(cell({ hasDirection: true })).includes("c3"));
  });

  it("C8 只在兜底桶上出现，且列与卡上都没有", () => {
    assert.ok(!idsFor(row()).includes("c8"));
    assert.ok(idsFor(row({ catchAll: true })).includes("c8"));
    assert.ok(!idsFor({ kind: "col", sceneCode: "charging" }).includes("c8"));
    assert.ok(!idsFor({ kind: "card", insightId: "x" }).includes("c8"));
  });

  it("C6 / C7 只在卡上出现", () => {
    for (const scope of [cell(), row(), { kind: "col", sceneCode: "c" } as const, { kind: "page" } as const]) {
      const ids = idsFor(scope);
      assert.ok(!ids.includes("c6"), "c6 出现在了卡以外的范围");
      assert.ok(!ids.includes("c7"), "c7 出现在了卡以外的范围");
    }
  });

  it("C9 只在整屏出现——它问的是这一屏本身", () => {
    assert.ok(idsFor({ kind: "page" }).includes("c9"));
    for (const scope of [cell(), row(), { kind: "card", insightId: "x" } as const]) {
      assert.ok(!idsFor(scope).includes("c9"));
    }
  });

  /*
   * ── C10–C12「问它」的范围矩阵（M89-03）──
   *
   * 三条各有各的范围，不是"都放开"：taxonomist 看的是码与主题的边界（行 / 整屏），
   * 一格答不了；archivist 看的是某几条证据的来源，整屏没有对象。
   * 放错的表现不报错——按钮出现在一个它答不了的范围上，模型照样编出一段像样的话。
   */
  it("[M89-03] 格上有 c10 c12，没有 c11——分类学家答不了一格", () => {
    const ids = idsFor(cell());
    assert.ok(ids.includes("c10"));
    assert.ok(ids.includes("c12"));
    assert.ok(!ids.includes("c11"));
  });

  it("[M89-03] 行上三条都有——码与主题的边界正是整行的事", () => {
    for (const id of ["c10", "c11", "c12"] as const) assert.ok(idsFor(row()).includes(id), `行上缺 ${id}`);
  });

  it("[M89-03] **列上一条 ask 都没有**——列是场景维度，三个角色都没有按场景的问法", () => {
    for (const id of ["c10", "c11", "c12"] as const) {
      assert.ok(!idsFor({ kind: "col", sceneCode: "charging" }).includes(id), `列上冒出了 ${id}`);
    }
  });

  it("[M89-03] 卡上有 c10 c12、整屏有 c10 c11", () => {
    const card = idsFor({ kind: "card", insightId: "x" });
    assert.deepEqual([card.includes("c10"), card.includes("c11"), card.includes("c12")], [true, false, true]);
    const page = idsFor({ kind: "page" });
    assert.deepEqual([page.includes("c10"), page.includes("c11"), page.includes("c12")], [true, true, false]);
  });

  it("[M89-03] **被抑制的格 / 行上三条 ask 也没有**——G1 在第一行，ask 不例外", () => {
    assert.deepEqual(capabilitiesFor(cell({ suppressed: true })), []);
    assert.deepEqual(capabilitiesFor(row({ suppressed: true })), []);
  });
});

describe("[M85-02] 目录自身的完整性", () => {
  it("十二条、id 不重复、key 不重复", () => {
    assert.equal(CAPABILITIES.length, 12);
    assert.equal(new Set(CAPABILITIES.map((c) => c.id)).size, 12);
    assert.equal(new Set(CAPABILITIES.map((c) => c.key)).size, 12);
  });

  it("[M89-03] 三条 ask 全是 dialog，且都产出 AgentNote", () => {
    for (const id of ["c10", "c11", "c12"] as const) {
      const c = capabilityById(id);
      assert.equal(c.tier, "dialog", `${id} 不是 dialog——界面会把它渲染成即点即出`);
      assert.equal(c.produces, "AgentNote");
      assert.match(c.key, /^ask-/);
    }
  });

  it("每条都产出 typed 对象、都有标题与至少一个范围", () => {
    for (const c of CAPABILITIES) {
      assert.ok(c.produces.length > 0, `${c.id} 没写 produces——产不出 typed 对象的不进目录`);
      assert.ok(c.title.length > 0, `${c.id} 没有标题`);
      assert.ok(c.scopes.length > 0, `${c.id} 一个范围都不在，它永远不会出现`);
    }
  });

  it("tier 与要不要模型是同一件事，不是两份名单", () => {
    const lookup = CAPABILITIES.filter((c) => c.tier === "lookup");
    // 五条不调模型：C2/C3/C4/C5 是四个查类，C9 是红队清单。C10–C12 是 dialog，要模型。
    assert.deepEqual(lookup.map((c) => c.id), ["c2", "c3", "c4", "c5", "c9"]);
    for (const c of lookup) assert.equal(requiresModel(c), false, `${c.id} 标了 lookup 却要模型`);
    for (const c of CAPABILITIES.filter((c) => c.tier !== "lookup")) assert.equal(requiresModel(c), true);
  });

  it("C9 标成 lookup 且守 no-model——它是唯一一条不需要模型就能回答「这一屏有什么问题」的", () => {
    const c9 = capabilityById("c9");
    assert.equal(c9.tier, "lookup");
    assert.ok(c9.guards.includes("no-model"));
  });

  it("capabilityById 对未知 id 抛错而不是给 undefined", () => {
    assert.throws(() => capabilityById("c99" as CapabilityId), /未知能力/);
  });
});

describe("[M85-02] cellScope：前后端共用同一份翻译", () => {
  it("方向为 flat 不算有方向", () => {
    const s = cellScope("cold-range-loss", { scene: "charging", direction: "flat" });
    assert.equal(s.kind === "cell" && s.hasDirection, false);
  });

  it("up / down 都算有方向", () => {
    for (const d of ["up", "down"] as const) {
      const s = cellScope("cold-range-loss", { scene: "charging", direction: d });
      assert.equal(s.kind === "cell" && s.hasDirection, true);
    }
  });

  it("兜底桶由码本身判定，不靠调用方传", () => {
    const s = cellScope(CATCH_ALL_NEED_PAIN, { scene: "charging", direction: "flat" });
    assert.equal(s.kind === "cell" && s.catchAll, true);
  });

  it("被抑制的格翻出来就是 suppressed，于是走进 G1", () => {
    const s = cellScope("cold-range-loss", { suppressed: true });
    assert.deepEqual(capabilitiesFor(s), []);
  });
});
