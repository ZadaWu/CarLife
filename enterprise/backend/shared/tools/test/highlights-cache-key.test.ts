/**
 * [F-58-02] 目的地亮点的缓存键归一（M77 走查追修）。
 *
 * 真跑一天的账：同一趟「上海 → 南通 → 张家港」，模型为它传过六种写法——
 * `南通`、`南通如东`、`南通 张家港`、`张家港（经南通）`、`南通如东—张家港`、`张家港`。
 * 六个键、六次真搜，每次 4~7 秒；唯一一次 13 毫秒的命中，是它碰巧把上一次的字符串
 * 一字不差又传了一遍。缓存机制没坏，是键太细。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { destinationCacheParts, splitPlaces, weekKeyOf } from "../src/destination-highlights";
import type { AmapClient, AmapRegion } from "../src/amap";

/** 只实现 resolveRegion 的假高德；其余方法用不到。 */
function fakeAmap(table: Record<string, AmapRegion>, calls?: string[]): AmapClient {
  return {
    async resolveRegion(name: string) {
      calls?.push(name);
      return table[name];
    },
  } as unknown as AmapClient;
}

const R = (adcode: string, name: string, level: AmapRegion["level"] = "city"): AmapRegion =>
  ({ adcode, name, level }) as AmapRegion;

const TABLE: Record<string, AmapRegion> = {
  南通: R("320600", "南通市"),
  张家港: R("320582", "张家港市", "district"),
  如东: R("320623", "如东县", "district"),
  上海: R("310000", "上海市"),
};

describe("[F-58-02] 拆分模型拼出来的目的地", () => {
  it("空格、括号、破折号、「经」都算分隔符", () => {
    assert.deepEqual(splitPlaces("南通 张家港"), ["南通", "张家港"]);
    assert.deepEqual(splitPlaces("张家港（经南通）"), ["张家港", "南通"]);
    assert.deepEqual(splitPlaces("南通如东—张家港"), ["南通如东", "张家港"]);
    assert.deepEqual(splitPlaces("上海到南通"), ["上海", "南通"]);
  });

  it("单个地名原样返回；一个字的碎片丢掉", () => {
    assert.deepEqual(splitPlaces("南通"), ["南通"]);
    assert.deepEqual(splitPlaces("南通 X"), ["南通"]);
  });
});

describe("[F-58-02] 六种写法归到同一批 adcode", () => {
  const parts = (raw: string) => destinationCacheParts(raw, fakeAmap(TABLE));

  it("真跑那六种写法，两两之间要么相等、要么是子集，不再各是一个新键", async () => {
    assert.deepEqual(await parts("南通"), ["320600"]);
    assert.deepEqual(await parts("张家港"), ["320582"]);
    // 顺序无关：这两种写法必须落到同一个键
    assert.deepEqual(await parts("南通 张家港"), ["320582", "320600"]);
    assert.deepEqual(await parts("张家港（经南通）"), ["320582", "320600"]);
    assert.deepEqual(await parts("南通如东—张家港"), ["320582", "320600", "320623"]);
  });

  it("连写的「南通如东」切得开：市 + 区两个码", async () => {
    assert.deepEqual(await parts("南通如东"), ["320600", "320623"]);
  });

  it("**不做前缀 / 模糊匹配**：认不出来就返回空，退回用原串当键", async () => {
    assert.deepEqual(await destinationCacheParts("火星基地", fakeAmap(TABLE)), []);
    // 错的命中比 miss 糟得多——它不报错（ADR-008 同一条取向）
    assert.deepEqual(await destinationCacheParts("南通市区某个不存在的地方啊", fakeAmap(TABLE)), ["320600"]);
  });

  it("没有高德客户端时不猜，直接空", async () => {
    assert.deepEqual(await destinationCacheParts("南通", undefined), []);
  });

  it("切两刀就停，不无限试——试探次数有上限", async () => {
    const calls: string[] = [];
    await destinationCacheParts("阿巴阿巴阿巴", fakeAmap(TABLE, calls));
    assert.ok(calls.length <= 3, `试了 ${calls.length} 次：整串 + 两刀，不该更多`);
  });
});

describe("[F-58-02] 日期按 ISO 周，不按天", () => {
  it("同一周的三天落到同一个键——三天行程原来是三个键", () => {
    const a = weekKeyOf("2026-09-14");
    assert.equal(weekKeyOf("2026-09-15"), a);
    assert.equal(weekKeyOf("2026-09-16"), a);
    assert.match(a, /^2026-W\d\d$/);
  });

  it("跨周就换键——两周 TTL 的依据是「周级变化」，不是「永不变化」", () => {
    assert.notEqual(weekKeyOf("2026-09-14"), weekKeyOf("2026-09-21"));
  });

  it("跨年边界按 ISO 周算（12/29 属于次年第 1 周）", () => {
    assert.equal(weekKeyOf("2026-12-29"), "2026-W53");
    assert.equal(weekKeyOf("2027-01-04"), "2027-W01");
  });

  it("没给日期 / 给了坏日期都落 `-`，不抛", () => {
    assert.equal(weekKeyOf(undefined), "-");
    assert.equal(weekKeyOf("下周二"), "-");
    assert.equal(weekKeyOf("2026-13-45"), "-");
  });
});
