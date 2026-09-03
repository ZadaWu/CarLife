/**
 * ⑤环境缓存的分页（M-mem-cache）。
 *
 * 盯的是一条极易被"看起来一切正常"骗过去的事：**SCAN 的顺序跨调用不稳定**。
 * 不排序就切片的话，第 2 页会重复第 1 页的条目、或者整条跳过，
 * 而分页器该有的页码、总数、上一页下一页全都在，看不出任何异常。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KEY_PREFIX, namespaceOf, paginateKeys } from "../src/env-cache";

const k = (ns: string, id: string): string => `${KEY_PREFIX}${ns}:${id}`;

describe("namespaceOf", () => {
  it("取 carlife:env:<ns>: 之后的第一段", () => {
    assert.equal(namespaceOf(k("regeo", "30.59:114.3")), "regeo");
    assert.equal(namespaceOf(k("amap-forecast", "420100")), "amap-forecast");
  });

  it("不符合构造规则的键归「其他」而不是硬塞进某一类——那种键是别处直接写的，藏起来更糟", () => {
    assert.equal(namespaceOf("someone:elses:key"), "其他");
    assert.equal(namespaceOf(`${KEY_PREFIX}nocolon`), "其他");
  });
});

describe("paginateKeys", () => {
  const keys = [
    k("regeo", "c"),
    k("route", "b"),
    k("regeo", "a"),
    k("regeo", "b"),
    k("amap-forecast", "z"),
  ];

  it("分布按条数降序，给页面当筛选项", () => {
    const r = paginateKeys(keys, { offset: 0, limit: 10 });
    assert.deepEqual(r.namespaces, [
      { namespace: "regeo", count: 3 },
      { namespace: "amap-forecast", count: 1 },
      { namespace: "route", count: 1 },
    ]);
    assert.equal(r.totalAll, 5);
  });

  it("**排序后再切片**：同一批键换个顺序进来，翻出的页必须一模一样", () => {
    const a = paginateKeys(keys, { offset: 0, limit: 2 });
    const shuffled = [keys[3], keys[0], keys[4], keys[1], keys[2]];
    const b = paginateKeys(shuffled, { offset: 0, limit: 2 });
    assert.deepEqual(a.page, b.page);
  });

  it("翻完所有页恰好覆盖全集，不重不漏", () => {
    const seen: string[] = [];
    for (let off = 0; off < keys.length; off += 2) {
      seen.push(...paginateKeys(keys, { offset: off, limit: 2 }).page);
    }
    assert.deepEqual([...seen].sort(), [...keys].sort());
    assert.equal(new Set(seen).size, keys.length);
  });

  it("按命名空间筛：total 是筛后的（分页器要用），totalAll 仍是全库", () => {
    const r = paginateKeys(keys, { offset: 0, limit: 10, namespace: "regeo" });
    assert.equal(r.total, 3);
    assert.equal(r.totalAll, 5);
    assert.ok(r.page.every((x) => namespaceOf(x) === "regeo"));
  });

  it("越界的 offset 返回空页而不是报错——用户可能停在第 3 页时键正好过期没了", () => {
    assert.deepEqual(paginateKeys(keys, { offset: 999, limit: 10 }).page, []);
  });
});
