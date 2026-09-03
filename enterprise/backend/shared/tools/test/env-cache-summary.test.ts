/**
 * ⑤列表行的人话摘要（走查②："你看看你现在展示的啥啊，可读性太低了"）。
 * 每一类的标题与摘要里不得出现 JSON 的痕迹：没有引号包着的字段名、没有花括号。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeEnvCacheEntry } from "../src/env-cache-summary";

const noJson = (s: string) => assert.ok(!/[{}"]/.test(s), `像 JSON：${s}`);

describe("describeEnvCacheEntry", () => {
  it("逆地理：行政区当标题，地址 + 键上的坐标当摘要", () => {
    const d = describeEnvCacheEntry(
      "carlife:env:regeo:23.18:113.3",
      JSON.stringify({ adcode: "440111", city: "广州市", district: "白云区", formatted: "广东省广州市白云区白云山" }),
    );
    assert.equal(d.title, "逆地理 · 广州市 · 白云区");
    assert.equal(d.summary, "广东省广州市白云区白云山 · 查询坐标 23.18°N 113.30°E");
  });

  it("天气预报：城市当标题，前三天各一句", () => {
    const d = describeEnvCacheEntry(
      "carlife:env:amap-forecast:320303",
      JSON.stringify({
        city: "云龙区",
        casts: [
          { date: "2026-09-02", dayWeather: "小雨", nightWeather: "小雨", dayTempC: 29, nightTempC: 25 },
          { date: "2026-09-03", dayWeather: "小雨", nightWeather: "多云", dayTempC: 30, nightTempC: 25 },
          { date: "2026-09-04", dayWeather: "多云", nightWeather: "多云", dayTempC: 30, nightTempC: 26 },
          { date: "2026-09-05", dayWeather: "晴", nightWeather: "晴", dayTempC: 29, nightTempC: 25 },
        ],
      }),
    );
    assert.equal(d.title, "天气预报 · 云龙区");
    assert.equal(d.summary, "9/2 周三 小雨 25~29℃；9/3 周四 小雨转多云 25~30℃；9/4 周五 多云 26~30℃");
  });

  it("气象局实况：站名当标题，实况 + 预警当摘要", () => {
    const d = describeEnvCacheEntry(
      "carlife:env:cma-view:58027",
      JSON.stringify({
        station: { id: "58027", name: "徐州" },
        observation: { temperatureC: 21.5, humidityPct: 87, windDirection: "东北风", windScale: "2级" },
        alarms: [{ type: "暴雨", level: "橙色" }],
        lastUpdate: "2026/09/02 20:10",
      }),
    );
    assert.equal(d.title, "气象局实况 · 徐州");
    assert.equal(d.summary, "实况 21.5℃ · 湿度 87% · 东北风2级 · 预警：暴雨橙色 · 观测 2026/09/02 20:10");
  });

  it("导览简报：景区（城市）当标题，点位/停车/休憩计数 + 前几个必玩点", () => {
    const d = describeEnvCacheEntry(
      "carlife:env:guide-brief:杭州:灵隐寺",
      JSON.stringify({
        spot: "灵隐寺",
        city: "杭州",
        spots: [{ name: "飞来峰" }, { name: "大雄宝殿" }],
        access: { parking: [{ name: "P1" }, { name: "P2" }], charging: [], refuel: [] },
        comfort: [{ kind: "food", note: "素斋" }],
        caveats: ["舒适分支缺席"],
      }),
    );
    assert.equal(d.title, "导览简报 · 灵隐寺（杭州）");
    assert.equal(d.summary, "必玩点 2：飞来峰、大雄宝殿 · 停车场 2 · 休憩 1 · 缺口 1");
  });

  it("目的地推荐：目的地（+出发日）当标题，吃/逛各前三当摘要", () => {
    const d = describeEnvCacheEntry(
      "carlife:env:dest-highlights:广州:2026-09-03",
      JSON.stringify({
        destination: "广州",
        foods: [{ name: "宏图府" }, { name: "新斗记" }, { name: "超记煲仔饭" }, { name: "第四家" }],
        spots: [{ name: "永庆坊" }, { name: "沙面岛" }],
        photoTips: [],
      }),
    );
    assert.equal(d.title, "目的地推荐 · 广州 · 9/3 周四出发");
    assert.equal(d.summary, "吃：宏图府、新斗记、超记煲仔饭 · 逛：永庆坊、沙面岛");
    assert.equal(describeEnvCacheEntry("carlife:env:dest-highlights:上海:-", JSON.stringify({ destination: "上海", foods: [], spots: [] })).title, "目的地推荐 · 上海");
  });

  it("路线与充电站", () => {
    const r = describeEnvCacheEntry(
      "carlife:env:route:31.23:121.47:30.75:120.75:-:default",
      JSON.stringify({ distanceM: 98_600, durationS: 5_400, tollYuan: 45, trafficLights: 12, steps: [{}, {}, {}] }),
    );
    assert.equal(r.title, "路线 · 31.23°N 121.47°E → 30.75°N 120.75°E");
    assert.equal(r.summary, "99 公里 · 1 小时 30 分 · 过路费 45 元 · 红绿灯 12 · 3 段");
    const c = describeEnvCacheEntry("carlife:env:charging:30.24:120.11:5000", JSON.stringify([{ name: "国网A" }, { name: "蔚来B" }]));
    assert.equal(c.title, "充电站 · 30.24°N 120.11°E 半径 5.0 公里");
    assert.equal(c.summary, "2 个：国网A、蔚来B");
  });

  it("不认识的命名空间与坏值也不吐 JSON；过期的说过期", () => {
    const d = describeEnvCacheEntry("carlife:env:brand-new:x", JSON.stringify({ a: 1, b: "two", c: [1, 2], d: { e: 1 } }));
    assert.equal(d.title, "carlife:env:brand-new:x");
    assert.equal(d.summary, "a 1 · b two · c 2 项");
    noJson(d.summary);
    assert.equal(describeEnvCacheEntry("carlife:env:regeo:1:2", null).summary, "（读取时已过期）");
    assert.equal(describeEnvCacheEntry("carlife:env:regeo:1:2", "not json").summary, "not json");
  });

  it("摘要有长度上限，不靠前端截", () => {
    const d = describeEnvCacheEntry(
      "carlife:env:regeo:1:2",
      JSON.stringify({ city: "c", district: "d", formatted: "很长的地址".repeat(60) }),
    );
    assert.ok(d.summary.length <= 140);
    assert.ok(d.summary.endsWith("…"));
  });
});
