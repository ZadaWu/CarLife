/**
 * JSON 键词表的漂移守卫（2026-09-15）。
 *
 * 提交通道（`submit_*`）的字段是业务人员最常看的「交回的结论」。这里从
 * `enterprise/backend/shared/tools/src/registry.ts` 源码抽出每个 `submit*Schema` 的键，
 * 逐个核对词表里有中文——上游加了字段、这里没跟，测试先红，而不是页面上悄悄冒出英文表头。
 * 读源码文本而不 import：控制台不依赖那个包（与 `graph-drift.test.ts` 同一理由）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { hasKeyLabel, labelOfKey } from "../src/pages/sessions/json-keys";

const REGISTRY = new URL("../../backend/shared/tools/src/registry.ts", import.meta.url);

function submitSchemaKeys(): Map<string, string[]> {
  const src = readFileSync(REGISTRY, "utf8");
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(/const (submit\w+Schema)\s*=\s*z/g)) {
    const start = m.index ?? 0;
    let end = src.indexOf("\n});", start);
    if (end < 0) end = src.indexOf("\n})", start);
    const block = src.slice(start, end);
    const keys = [...block.matchAll(/^\s+(\w+):\s*z/gm)].map((k) => k[1]);
    out.set(m[1], [...new Set(keys)]);
  }
  return out;
}

describe("JSON 键词表", () => {
  it("提交通道的每个字段都有中文说法", () => {
    const schemas = submitSchemaKeys();
    assert.ok(schemas.size >= 8, `只抽到 ${schemas.size} 个 submit schema——抽取失败要报错，不能当成空集`);
    const missing: string[] = [];
    for (const [schema, keys] of schemas) {
      for (const k of keys) if (!hasKeyLabel(k)) missing.push(`${schema}.${k}`);
    }
    assert.deepEqual(missing, []);
  });

  it("显示形态是「中文(英文)」，查不到的只给英文、不编", () => {
    assert.equal(labelOfKey("hotels"), "酒店候选(hotels)");
    assert.equal(labelOfKey("someUnknownField"), "someUnknownField");
  });
});
