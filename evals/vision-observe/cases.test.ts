/**
 * [M71-01] 真值文件与词表的守卫。零依赖：直接读 jsonl 与 schema，不起服务。
 *
 * 守两件事：① 每条真值过结构校验（越界、负样本非空、警示灯漏 symbol_id 都拦）；
 * ② `truth.schema.json` 的枚举与 `lib.ts` 的 VOCAB 逐字相等——评测、提示词、
 * 未来 `@carlife/tools` 的 schema 必须是同一套词表，漂了就在这里红。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { VOCAB, parseJsonl, validateCase, type TruthCase } from "./lib";

const CASES = parseJsonl<TruthCase>(readFileSync(new URL("./cases.jsonl", import.meta.url), "utf8"));
const SCHEMA = JSON.parse(readFileSync(new URL("./truth.schema.json", import.meta.url), "utf8")) as {
  properties: { items: { items: { properties: Record<string, { enum?: unknown[]; items?: { enum?: unknown[] } }> } }; frame: { properties: { cut_off_sides: { items: { enum: string[] } } } }; provenance: { enum: string[] } };
};

describe("[M71-01] 真值文件", () => {
  it("至少有一条正样本，且 id 唯一", () => {
    assert.ok(CASES.some((c) => !c.negative));
    assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  });

  for (const c of CASES) {
    it(`${c.id} 过结构校验`, () => {
      assert.deepEqual(validateCase(c), []);
    });
    it(`${c.id} 的照片文件存在且 provenance 在枚举里`, () => {
      assert.doesNotThrow(() => readFileSync(new URL(`./${c.file}`, import.meta.url)));
      assert.ok(SCHEMA.properties.provenance.enum.includes(c.provenance));
    });
  }

  it("[M79-01] 负样本 ≥10 张，且每张 items 为空、不带 symbol_id", () => {
    const neg = CASES.filter((c) => c.negative);
    assert.ok(neg.length >= 10, `负样本只有 ${neg.length} 张——误接受率没有分母`);
    for (const c of neg) {
      assert.deepEqual(c.items, [], `${c.id} 是负样本，items 必须为空`);
      assert.ok(!JSON.stringify(c).includes("symbol_id"), `${c.id} 是负样本，不该出现 symbol_id`);
    }
  });

  it("拒收：词表越界 / 负样本非空 / 警示灯漏 symbol_id / bbox 越界", () => {
    const base = structuredClone(CASES[0]);
    const bad1 = structuredClone(base);
    bad1.items[0].color = "purple";
    assert.ok(validateCase(bad1).some((e) => e.includes("color 越界")));
    const bad2 = structuredClone(base);
    bad2.negative = true;
    assert.ok(validateCase(bad2).some((e) => e.includes("负样本")));
    const bad3 = structuredClone(base);
    const wl = bad3.items.find((i) => i.category === "warning_light")!;
    delete (wl as { symbol_id?: unknown }).symbol_id;
    assert.ok(validateCase(bad3).some((e) => e.includes("symbol_id")));
    const bad4 = structuredClone(base);
    bad4.items[0].bbox = [0, 0, 1001, 10];
    assert.ok(validateCase(bad4).some((e) => e.includes("bbox")));
  });
});

describe("[M71-01] 词表同源：truth.schema.json ⇔ lib.ts VOCAB", () => {
  const props = SCHEMA.properties.items.items.properties;
  const pairs: Array<[string, readonly string[], unknown[] | undefined]> = [
    ["category", VOCAB.category, props.category.enum],
    ["shape", VOCAB.shape, props.shape.enum],
    ["color", VOCAB.color, props.color.enum],
    ["state", VOCAB.state, props.state.enum],
    ["elements", VOCAB.elements, props.elements.items?.enum],
    ["sides", VOCAB.sides, SCHEMA.properties.frame.properties.cut_off_sides.items.enum],
  ];
  for (const [name, vocab, schemaEnum] of pairs) {
    it(`${name} 枚举逐字相等`, () => {
      assert.deepEqual([...vocab], schemaEnum);
    });
  }
  it("class 枚举相等（schema 里多一个 null 允许值）", () => {
    assert.deepEqual((props.class.enum ?? []).filter((x) => x !== null), [...VOCAB.class]);
  });
});
