/**
 * M93-03：估价归一在汇聚边界做一次，四个消费者（车机 / 手机 / 控制台 / 播报）都对。
 *
 * 真实病例：`trip_plans.cmu3q9iip0006xulkc8gu71sa` 的 day2 estPrice 是
 * `约2000-3500/晚（估算，国庆为全年最贵档期，以预订平台实际价格为准）`——36 个字。
 * 端上把整串当成价格，而价格那一列一寸不让，于是「上海迪士尼乐园酒店」被压成
 * 一个字一行、竖排九行。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeEstPrice } from "../src/graph/subgraphs/itinerary";

test("[F-18-15][AC-18-11] 库里那两条真实值 → 只剩区间本身", () => {
  assert.equal(
    normalizeEstPrice("约600-1200/晚（估算，国庆为旺季，以预订平台实际价格为准）"),
    "约600-1200/晚（估算）",
  );
  assert.equal(
    normalizeEstPrice("约2000-3500/晚（估算，国庆为全年最贵档期，以预订平台实际价格为准）"),
    "约2000-3500/晚（估算）",
  );
});

test("[F-18-15][AC-18-11] 纯区间补标注；已经归一过的幂等", () => {
  assert.equal(normalizeEstPrice("约400-700/晚"), "约400-700/晚（估算）");
  assert.equal(normalizeEstPrice("约400-700/晚（估算）"), "约400-700/晚（估算）");
  assert.equal(
    normalizeEstPrice(normalizeEstPrice("约2000-3500/晚（估算，国庆最贵）")),
    "约2000-3500/晚（估算）",
  );
});

test("[F-18-15][AC-18-11] 各种写法的区间都认得出来", () => {
  assert.equal(normalizeEstPrice("¥800元"), "¥800元（估算）");
  assert.equal(normalizeEstPrice("约2000～3500/人"), "约2000～3500/人（估算）");
  assert.equal(normalizeEstPrice("约350/晚，含双早"), "约350/晚（估算）");
});

test("[F-18-15][AC-18-11] 空与缺省返回 undefined，不返回一个只有标注的空壳", () => {
  assert.equal(normalizeEstPrice(undefined), undefined);
  assert.equal(normalizeEstPrice(""), undefined);
  assert.equal(normalizeEstPrice("   "), undefined);
  assert.equal(normalizeEstPrice("（估算，以实际平台为准）"), undefined);
});

test("[F-18-15][AC-18-11] 提不出片段时保留原串（截断 24 字）——宁可难看也不丢数字", () => {
  // 没有「约 / ¥」开头，片段正则认不出来；这时不许把内容丢掉。
  const out = normalizeEstPrice("价格面议，旺季上浮，具体以门店告知为准，淡季可谈到三百多")!;
  assert.ok(out.endsWith("（估算）"), out);
  assert.equal(out.length, 24 + "（估算）".length);
  assert.ok(out.startsWith("价格面议，旺季上浮"), out);
});

test("[F-18-15][AC-18-11] 归一后的串一定进得了落库 schema 的「估」红线", () => {
  // `registry.ts` 的 estimatePrice 用 /估/ 守着最后一道门；归一产物必须恒过。
  for (const raw of ["约400-700/晚", "约2000-3500/晚（估算，旺季）", "¥800元", "面议"]) {
    assert.match(normalizeEstPrice(raw)!, /估/);
  }
});
