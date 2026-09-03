/**
 * 行前物品契约表（施工单 M20-02）。
 *
 * 这张表的职责只有一个：**让"图标下的字与图对不上"没有入口**。
 * 所以测的不是数据本身，而是三条使用纪律：名字必须查得到、未知 key 必须被挡在外面、
 * 挡住的方式是**丢掉这一格**而不是渲染一个没名字的框。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRETRIP_ITEMS,
  WEATHER_KINDS,
  WEATHER_LABELS,
  isWeatherKind,
  isPretripItemKey,
  pretripItemLabel,
  tipItemsFromKeys,
} from "../src/index";

test("每个 key 都有非空名字，且名字互不重复", () => {
  const labels = Object.values(PRETRIP_ITEMS).map((v) => v.label);
  for (const [key, v] of Object.entries(PRETRIP_ITEMS)) {
    assert.ok(v.label.trim().length > 0, `${key} 的 label 为空`);
  }
  // 两件物品同名，用户看到的就是"推荐了两次同一件东西"——这正是 M19-05 那次走查的抱怨。
  assert.equal(new Set(labels).size, labels.length, "物品名不得重复");
});

test("未知 key：查不到名字，也不进展示列表", () => {
  assert.equal(pretripItemLabel("hat"), "遮阳帽");
  assert.equal(pretripItemLabel("rain-boots"), undefined);
  assert.equal(isPretripItemKey("rain-boots"), false);

  // 丢掉这一格，而不是渲染一个有图没名字（或有名字没图）的框。
  assert.deepEqual(tipItemsFromKeys(["hat", "rain-boots", "water"]), [
    { key: "hat", label: "遮阳帽" },
    { key: "water", label: "水" },
  ]);
});

test("首批 8 件覆盖冷/热/雨/霾四类天气，缺一件推荐规则就无处落脚", () => {
  for (const key of ["hat", "sunscreen", "water", "umbrella", "jacket", "sunglasses", "thermos", "mask"]) {
    assert.ok(isPretripItemKey(key), `契约表缺 ${key}`);
  }
});

test("天气种类：每种都有中文名，名字互不重复（M20-05）", () => {
  for (const k of WEATHER_KINDS) {
    assert.ok(WEATHER_LABELS[k]?.trim().length > 0, `${k} 没有中文名`);
    assert.ok(isWeatherKind(k));
  }
  const labels = WEATHER_KINDS.map((k) => WEATHER_LABELS[k]);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(isWeatherKind("rainy"), false, "M1 的 rainy 已改名为 rain，旧值不该再被认");
});
