/**
 * 提交类工具「收下但丢掉」的两个字段位（M77 走查追修）。
 *
 * 真跑 turn-72be35d2：tour 写完一份三天行程交上去，每个景点带了 lat/lon，
 * pi 按 JSON Schema 的 `additionalProperties: false` **在工具执行之前**整次拒掉，
 * 模型只好把整份行程重写一遍。账是这样的——第一份 8.5 秒、被拒 4 毫秒、重写 6.0 秒，
 * 那 6 秒占掉整个规划节点 22 秒的四分之一。因为工具压根没执行，trace 里连一条
 * `tool.submit_tour_days` 都没有，从耗时剖面上只看得到「模型在生成」的一段空白。
 * 当天 13 个 tour 分支会话撞上 2 个；submit_guide_comfort 另有一次同形态的（5.4 秒）。
 *
 * 模型会写这两个字段是我们自己招来的：tour 提示词要它把坐标传给 route_audit，
 * submit_guide_spots 的同名字段又写着「poi_search 给过坐标就带上」；
 * guide 的 sourceUrl 本就是每条的属性，模型把它提到了顶层。
 *
 * 所以：**声明这几个名字（不打回）+ 值一律丢弃（ADR-008：模型给的坐标不要）**。
 * 两件事必须同时成立，少一件就出事。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getTool } from "../src/registry";

const jsonSchemaOf = (name: string): Record<string, any> =>
  zodToJsonSchema(getTool(name)!.schema as never, { target: "jsonSchema7" }) as Record<string, any>;

const tourSpotSchema = () =>
  jsonSchemaOf("submit_tour_days").properties.days.items.properties.spots.items;

describe("提交类工具：多余字段收下但丢掉", () => {
  it("pi 看到的 spots 里有 lat/lon——带坐标交上来不会被打回", () => {
    const spot = tourSpotSchema();
    assert.ok(spot.properties.lat, "lat 没声明的话 pi 会整次拒掉，模型要重写整份行程");
    assert.ok(spot.properties.lon);
  });

  it("但坐标不许进 parsed.data——ADR-008：模型给的坐标一律不要", () => {
    const parsed = getTool("submit_tour_days")!.schema.parse({
      days: [{ day: 1, spots: [{ name: "南通狼山风景名胜区", lat: 31.948766, lon: 120.88776 }] }],
    }) as { days: Array<{ spots: Array<Record<string, unknown>> }> };
    const spot = parsed.days[0].spots[0];
    assert.equal(spot.name, "南通狼山风景名胜区");
    assert.ok(!("lat" in spot), "模型坐标必须在这里就被丢掉，不能流到落库/地图");
    assert.ok(!("lon" in spot));
  });

  it("已声明的字段照常收下，不被这个 transform 误伤", () => {
    const parsed = getTool("submit_tour_days")!.schema.parse({
      days: [{ day: 1, spots: [{ name: "啬园", indoor: false, estStart: "08:30", estEnd: "10:00" }] }],
    }) as { days: Array<{ spots: Array<Record<string, unknown>> }> };
    assert.deepEqual(parsed.days[0].spots[0], {
      name: "啬园",
      indoor: false,
      estStart: "08:30",
      estEnd: "10:00",
    });
  });

  it("**不是**改成 passthrough：拼错的字段仍然要被 pi 当场打回", () => {
    // 这一条是整个改动的边界。zod 自己对未知键是静默 strip（从不报错），
    // 会当场喊出来的只有 pi 按 JSON Schema 做的这道 additionalProperties 检查。
    // 一旦为了图省事写成 .passthrough()，这里会变成 true，
    // 于是 `start` 之于 `estStart` 这种拼错会被静默吞掉、时段整天消失，
    // 而链路看起来完全正常——那正是本仓库栽过四次的坑（M13-06 / M13-07 / M34-01）。
    assert.equal(tourSpotSchema().additionalProperties, false);
    const allowed = Object.keys(tourSpotSchema().properties).sort();
    assert.deepEqual(allowed, ["estEnd", "estStart", "indoor", "lat", "lon", "name"]);
  });

  it("submit_guide_comfort：顶层 sourceUrl 收下（每条自己的那个照旧必填必验）", () => {
    const root = jsonSchemaOf("submit_guide_comfort");
    assert.ok(root.properties.sourceUrl, "模型把出处提到了顶层，不声明就要重写整份 entries");
    const entry = root.properties.entries.items;
    assert.ok(entry.properties.sourceUrl, "每条自己的出处不受影响");
    assert.ok(entry.required.includes("note"));
  });
});
