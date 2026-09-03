/**
 * `pretrip_items` 的推荐规则（施工单 M20-03）。
 *
 * 规则本身可以吵（该不该在 28℃ 推墨镜），但下面这几条不能松：
 * 去重、限量且截断要说出来、天气取不到时**如实标 fallback**、
 * 产出的 key 必须在契约表里（否则卡上会出现一个没有名字也没有图的格子）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { PRETRIP_ITEMS } from "@carlife/shared";

import {
  MAX_PRETRIP_ITEMS,
  classifyWeatherKind,
  allPretripKeysKnown,
  fallbackPretripItems,
  recommendPretripItems,
  reduceSegments,
} from "../src/pretrip-items";
import { TOOL_REGISTRY, listForAgent } from "../src/registry";

const keys = (d: ReturnType<typeof recommendPretripItems>) => d.items.map((i) => i.key);

test("高温晴天：帽 / 防晒 / 水；33℃ 起水排到最前", () => {
  const warm = recommendPretripItems({ phenomena: ["晴"], maxTempC: 30, minTempC: 24 });
  assert.deepEqual(new Set(keys(warm)), new Set(["water", "hat", "sunscreen", "sunglasses"]));
  assert.equal(warm.basis, "weather");

  const hot = recommendPretripItems({ phenomena: ["晴"], maxTempC: 34, minTempC: 28 });
  // 「忘了带水」在 33℃ 以上比「晒到」更难受——优先级表就是这么排的。
  assert.equal(keys(hot)[0], "water");
});

test("有雨：伞排第一；雨天补水但**不给防晒**（M13-12 修正）", () => {
  const rain = recommendPretripItems({ phenomena: ["雷阵雨"], maxTempC: 31, minTempC: 26 });
  assert.equal(keys(rain)[0], "umbrella");
  /*
   * 这条断言原先是 `includes("hat")`——它把 bug 钉住了：
   * 判据 `hot || 晴` 里的 `hot` 只是"最高 ≥28℃"，于是 31℃ 的雷阵雨天
   * 同时推出雨伞和遮阳帽。车主看到卡上一边伞一边防晒，当场问"雨天要墨镜？"。
   * 防晒现在看日晒不看气温。
   */
  assert.equal(keys(rain).includes("hat"), false, "雨天不给遮阳帽");
  assert.ok(keys(rain).includes("water"), "31℃ 的雨天照样要补水");
  // water 会被"高温补水"与"天热补水"各命中一次——去重之后只能有一件。
  assert.equal(new Set(keys(rain)).size, keys(rain).length, "同一 key 不得出现两次");

  // 现象里没有雨字，但预报有降水量：同样算有雨。
  const drizzle = recommendPretripItems({ phenomena: ["多云"], precipitationMm: 3.2, maxTempC: 20, minTempC: 15 });
  assert.ok(keys(drizzle).includes("umbrella"));
});

test("低温 / 大温差 → 外套；≤5℃ 或有雪 → 保温杯", () => {
  assert.ok(keys(recommendPretripItems({ phenomena: ["阴"], maxTempC: 18, minTempC: 9 })).includes("jacket"));
  // 温差大但都不低：白天 26 晚上 14，还是得带件外套。
  assert.ok(keys(recommendPretripItems({ phenomena: ["多云"], maxTempC: 26, minTempC: 14 })).includes("jacket"));

  const cold = recommendPretripItems({ phenomena: ["阴"], maxTempC: 6, minTempC: 1 });
  assert.ok(keys(cold).includes("thermos"));
  const snow = recommendPretripItems({ phenomena: ["小雪"], maxTempC: 3, minTempC: -4 });
  assert.ok(keys(snow).includes("thermos"));
});

test("霾 / 沙尘 → 口罩", () => {
  assert.ok(keys(recommendPretripItems({ phenomena: ["霾"], maxTempC: 20, minTempC: 12 })).includes("mask"));
  assert.ok(keys(recommendPretripItems({ phenomena: ["浮尘"], maxTempC: 20, minTempC: 12 })).includes("mask"));
});

test("限量 6 件，且**砍掉了什么要说出来**", () => {
  /*
   * 暴晒 + 有霾 + 昼夜极端——整程极值下命中的比卡片装得下的多。
   *
   * 原来的用例还带着「雷阵雨」「小雪」。M13-12 之后有雨/有雪就不给防晒，
   * 于是这组输入只剩 5 件、根本不触发截断——**用例测不到它要测的东西了**。
   * 极端性改由温差与霾提供，不再靠一个自相矛盾的天气。
   */
  const all = recommendPretripItems({
    phenomena: ["晴", "霾"],
    maxTempC: 35,
    minTempC: -2,
  });
  assert.equal(all.items.length, MAX_PRETRIP_ITEMS);
  assert.ok(all.dropped.length > 0, "静默截断 = 用户以为系统就推荐了这些");
  // 被砍的一定是优先级靠后的那些。
  assert.ok(all.dropped.every((d) => !["umbrella", "water"].includes(d.key)));
});

test("天气取不到：常备三件 + weatherAvailable=false（**调用方据此不许说「根据天气」**）", () => {
  const f = fallbackPretripItems();
  assert.deepEqual(f.items.map((i) => i.key), ["hat", "sunscreen", "water"]);
  assert.equal(f.weatherAvailable, false);
  assert.equal(f.basis, "fallback");
  assert.equal(f.weatherSummary, "");
});

test("一条规则都没命中的好天气：给常备三件，但 basis 仍是 fallback", () => {
  const mild = recommendPretripItems({ phenomena: ["多云"], maxTempC: 24, minTempC: 18 });
  assert.deepEqual(mild.items.map((i) => i.key), ["hat", "sunscreen", "water"]);
  // 天气是查到的，所以 weatherAvailable=true；但物品不是天气推出来的，basis 必须如实。
  assert.equal(mild.weatherAvailable, true);
  assert.equal(mild.basis, "fallback");
});

test("多天行程按整程极值判定：第 3 天有雨也要带伞", () => {
  const view = reduceSegments([
    { name: "D1", date: "2026-08-14", tempMinC: 26, tempMaxC: 33, precipitationMm: 0, weatherCode: 0, condition: "晴" },
    { name: "D2", date: "2026-08-15", tempMinC: 25, tempMaxC: 32, precipitationMm: 0, weatherCode: 1, condition: "多云" },
    { name: "D3", date: "2026-08-16", tempMinC: 24, tempMaxC: 29, precipitationMm: 12, weatherCode: 61, condition: "中雨" },
  ]);
  assert.equal(view.maxTempC, 33);
  assert.equal(view.minTempC, 24);
  assert.equal(view.precipitationMm, 12);
  assert.ok(keys(recommendPretripItems(view)).includes("umbrella"));
});

test("reduceSegments 只读预报字段，不读 observed（实况不能安到未来那天）", () => {
  const view = reduceSegments([
    {
      name: "D1",
      date: "2026-08-20",
      tempMinC: 20,
      tempMaxC: 24,
      precipitationMm: 0,
      weatherCode: 1,
      condition: "多云",
      observed: {
        station: "某站",
        stationDistanceKm: 3,
        observedAt: "2026-08-14T10:00:00Z",
        temperatureC: 36,
        feelsLikeC: 41,
        humidityPct: 80,
        precipitationMm: 20,
        pressureHpa: 1000,
        windDirection: null,
        windDirectionDeg: null,
        windSpeedMs: null,
        windScale: null,
      },
    },
  ]);
  // 实况 36℃/降水 20mm 一个都不能进极值视图，否则出发那天的建议是按今天的天气给的。
  assert.equal(view.maxTempC, 24);
  assert.equal(view.precipitationMm, 0);
});

test("没有高德 key 时只有 weatherCode：晴天照样认得出（否则墨镜是件死物品）", () => {
  // Open-Meteo 那一路 condition 恒为 null，现象只能从 WMO 代码翻。
  const view = reduceSegments([
    { name: "D1", date: "2026-08-20", tempMinC: 27, tempMaxC: 34, precipitationMm: 0, weatherCode: 0, condition: null },
  ]);
  assert.deepEqual(view.phenomena, ["晴"]);
  assert.ok(keys(recommendPretripItems(view)).includes("sunglasses"));

  const rainy = reduceSegments([
    { name: "D1", date: "2026-08-20", tempMinC: 20, tempMaxC: 24, precipitationMm: 0, weatherCode: 61, condition: null },
  ]);
  assert.deepEqual(rainy.phenomena, ["雨"]);
  assert.ok(keys(recommendPretripItems(rainy)).includes("umbrella"));
});

test("产出的 key 永远在契约表里（否则卡上是个没名字也没图的格子）", () => {
  const cases = [
    { phenomena: ["晴"], maxTempC: 35, minTempC: 28 },
    { phenomena: ["雷阵雨", "霾"], maxTempC: 30, minTempC: 5 },
    { phenomena: ["小雪"], maxTempC: 2, minTempC: -8 },
    { phenomena: [] },
  ];
  for (const c of cases) {
    const d = recommendPretripItems(c);
    assert.ok(allPretripKeysKnown(d));
    for (const i of d.items) assert.ok(i.key in PRETRIP_ITEMS);
  }
});

test("registry：trip 拿得到、只读、轨迹摘要不含坐标", () => {
  const reg = TOOL_REGISTRY.find((t) => t.name === "pretrip_items");
  assert.ok(reg, "pretrip_items 没进注册表");
  assert.equal(reg!.sensitive, false, "只读工具不该走权限门");
  assert.ok(listForAgent("trip").some((t) => t.name === "pretrip_items"));

  const summary = reg!.traceSummary?.({
    points: [{ name: "广州塔", lat: 23.1064, lon: 113.3245 }],
    date: "2026-08-20",
  } as never);
  assert.equal(summary, "1 点 · 2026-08-20");
  // 坐标不进轨迹：weather 那条已经记过取整坐标，这里再记一遍等于写两遍位置。
  assert.ok(!/23\.|113\./.test(summary ?? ""));
});

test("trip_plan_commit 的 schema **不会 strip 掉 pretripItems**（M20-04 回归）", () => {
  // 这一条守的是最安静的那类失败：图里带上了、库里没有，全程零报错。
  const reg = TOOL_REGISTRY.find((t) => t.name === "trip_plan_commit");
  assert.ok(reg);
  const parsed = reg!.schema.parse({
    userId: "u1",
    plan: {
      status: "confirmed",
      destination: "广州",
      days: 1,
      skeleton: [{ day: 1, theme: "t", spots: [{ name: "广州塔" }] }],
      caveats: [],
      pretripItems: [{ key: "umbrella", reason: "这一程有降雨" }],
      updatedTurnId: "t",
    },
  }) as { plan: { pretripItems?: unknown[] } };
  assert.deepEqual(parsed.plan.pretripItems, [{ key: "umbrella", reason: "这一程有降雨" }]);
});

test("schema **不会 strip 掉 destinationHighlights**（M32-02 回归）", () => {
  /*
   * 同一条防线的第四次（坐标 → 贴纸品类 → pretripItems → nav → 这次）。
   *
   * 推荐按设计是读时补齐、不落库的，所以 commit 这条路上它本来就该缺省；
   * 声明它是为了 `trip_plan_update`——那条会原地改写整份快照，
   * 带着推荐的快照过一遍就被剥空了，症状是"推荐卡显示了几秒又没了"。
   */
  const highlights = {
    destination: "广州",
    foods: [{ name: "陶陶居", note: "百年茶楼", sourceUrl: "https://a.com/x", sourceTitle: "老字号" }],
    spots: [{ name: "永庆坊", note: "骑楼老街" }],
    photoTips: [{ spot: "永庆坊", tip: "入夜拍月亮桥倒影" }],
    computedAt: "2026-08-28T02:00:00.000Z",
  };
  const reg = TOOL_REGISTRY.find((t) => t.name === "trip_plan_commit");
  const parsed = reg!.schema.parse({
    userId: "u1",
    plan: {
      status: "confirmed",
      destination: "广州",
      days: 1,
      skeleton: [{ day: 1, theme: "t", spots: [{ name: "广州塔" }] }],
      caveats: [],
      destinationHighlights: highlights,
      updatedTurnId: "t",
    },
  }) as { plan: { destinationHighlights?: unknown } };
  assert.deepEqual(parsed.plan.destinationHighlights, highlights);
});

test("天气分类：逐类命中；混合取最该注意的那一种（M20-05）", () => {
  assert.equal(classifyWeatherKind({ phenomena: ["晴"] }), "sunny");
  assert.equal(classifyWeatherKind({ phenomena: ["多云"] }), "cloudy");
  assert.equal(classifyWeatherKind({ phenomena: ["阴"] }), "overcast");
  assert.equal(classifyWeatherKind({ phenomena: ["中雨"] }), "rain");
  assert.equal(classifyWeatherKind({ phenomena: ["小雪"] }), "snow");
  assert.equal(classifyWeatherKind({ phenomena: ["霾"] }), "haze");
  assert.equal(classifyWeatherKind({ phenomena: ["雾"] }), "haze");

  // 现象没写雨，但预报有降水：同样算雨（与物品那条规则同一判据）。
  assert.equal(classifyWeatherKind({ phenomena: ["多云"], precipitationMm: 4 }), "rain");
  // 一程里晴了三天下了一天雨 → 卡上是雨。反过来会让"带伞"配着太阳出现。
  assert.equal(classifyWeatherKind({ phenomena: ["晴", "晴", "多云", "雷阵雨"] }), "rain");
  // 认不出来就按晴——它是唯一有定稿图的那张。
  assert.equal(classifyWeatherKind({ phenomena: [] }), "sunny");
});

test("图标与物品同源：有雨时 kind=rain 且清单带伞（M20-05）", () => {
  const rain = recommendPretripItems({ phenomena: ["雷阵雨"], maxTempC: 30, minTempC: 25 });
  assert.equal(rain.weatherKind, "rain");
  assert.equal(rain.weatherLabel, "有雨");
  assert.ok(keys(rain).includes("umbrella"), "分两处判就会出现『图标晴天 + 物品雨伞』");

  // 天气取不到时图标回落太阳，与端上 `?? sprites.weather.sunny` 同一个兜底。
  assert.equal(fallbackPretripItems().weatherKind, "sunny");
});

test("雨天不给防晒（M13-12 走查：车主当场问「为什么雨天要墨镜和防晒」）", () => {
  /*
   * 原判据是 `hot || 晴`，而 `hot` 只是"最高 ≥28℃"——上海夏天下雨照样 30℃，
   * 于是同一张卡上一边雨伞、一边遮阳帽加防晒霜。
   * 推荐自相矛盾会毁掉整张卡的可信度，下次真该带的那件也不会有人看。
   */
  const rainyHot = recommendPretripItems({
    phenomena: ["中雨"], maxTempC: 30, minTempC: 25, precipitationMm: 8,
  } as never);
  const keys = rainyHot.items.map((i) => i.key);
  assert.ok(keys.includes("umbrella"), "有雨必须给伞");
  for (const k of ["hat", "sunscreen", "sunglasses"]) {
    assert.equal(keys.includes(k as never), false, `雨天不该出现 ${k}`);
  }
  // 补水与日晒无关：30℃ 的雨天照样要喝水。
  assert.ok(keys.includes("water"), "热就要补水，不管下不下雨");

  // 反向：晴热天防晒三件齐全，不能矫枉过正。
  const sunny = recommendPretripItems({ phenomena: ["晴"], maxTempC: 33, minTempC: 26 } as never);
  const sk = sunny.items.map((i) => i.key);
  for (const k of ["hat", "sunscreen", "sunglasses"]) {
    assert.ok(sk.includes(k as never), `晴热天应有 ${k}`);
  }

  // 雨夹雪：给伞与保暖，同样不给防晒。
  const snow = recommendPretripItems({
    phenomena: ["雨夹雪"], maxTempC: 3, minTempC: -1, precipitationMm: 2,
  } as never);
  const nk = snow.items.map((i) => i.key);
  assert.ok(nk.includes("umbrella"));
  assert.equal(nk.includes("sunscreen" as never), false);
});
