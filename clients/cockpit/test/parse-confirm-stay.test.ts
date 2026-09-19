/**
 * [F-18-15][AC-18-11] 住宿行的解析（M93-03）：价格有长度闸门，「估算」括号里带话也认。
 *
 * 真实病例：确认弹窗第 2 晚那行，酒店名「上海迪士尼乐园酒店」一个字一行竖排九行，
 * 右边挤着一整句 `约2000-3500/晚（估算，国庆为全年最贵档期，以预订平台实际价格为准）`。
 * 端上这一半的成因有两处：剥「估算」的正则只认光秃秃四个字（剥不掉，角标也不亮），
 * 取价格的正则没有长度上限（36 字整串被当成价格，把名字挤到 0 宽）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfirm } from "../src/features/hitl/parseConfirm";

/** 确认摘要里逐天那一行的形状：`景点A、景点B；住 <名字> <价格>`。 */
const dayOf = (value: string) =>
  parseConfirm([{ label: "第1天 临港亲子日", value }], "确认行程").days[0]!;

describe("[F-18-15][AC-18-11] 住宿行解析 × 归一后的串", () => {
  it("归一后：名字是纯酒店名，价格 ≤ 16 字，「估」角标亮", () => {
    const stay = dayOf("上海海昌海洋公园；住 上海海昌奥特曼主题酒店 约700-1500/晚（估算）").stay!;
    assert.equal(stay.name, "上海海昌奥特曼主题酒店");
    assert.equal(stay.price, "约700-1500/晚");
    assert.ok(stay.price!.length <= 16);
    assert.equal(stay.estimated, true);
  });

  it("历史数据：36 字那一串靠放宽后的「估算」正则剥干净，名字与价格都归位", () => {
    // 库里的老快照没归一过，打开时照样要能看。整个 `（估算，…）` 连同免责一起剥掉，
    // 剩下的 `约2000-3500/晚` 才是价格——这是放宽 ESTIMATE_RE 换来的。
    const stay = dayOf(
      "上海迪士尼度假区；住 上海迪士尼乐园酒店 约2000-3500/晚（估算，国庆为全年最贵档期，以预订平台实际价格为准）",
    ).stay!;
    assert.equal(stay.name, "上海迪士尼乐园酒店");
    assert.equal(stay.price, "约2000-3500/晚");
    assert.equal(stay.estimated, true, "括号里带话的「估算」也要认出来，角标该亮");
  });

  it("长度闸门：没有「估算」两个字的长尾巴，不认它是价格（名字宁可长，不要 0 宽）", () => {
    // 剥不掉的那种：括号里没写「估算」，整串 30+ 字会被行尾价格正则整个吃下去。
    // 价格那一列一寸不让，于是名字被压到 0 宽、一个字一行竖着排。
    const stay = dayOf(
      "上海迪士尼度假区；住 上海迪士尼乐园酒店 约2000-3500/晚（国庆为全年最贵档期，以预订平台实际价格为准）",
    ).stay!;
    assert.equal(stay.price, undefined, "超过 16 字的片段不认它是价格");
    assert.ok(stay.name.includes("上海迪士尼乐园酒店"), stay.name);
    assert.equal(stay.estimated, false, "这一串里确实没有「估算」，角标就不该亮");
  });

  it("连住折叠不受归一影响：两晚同店同价仍然折叠成「同前一晚」", () => {
    const v = parseConfirm(
      [
        { label: "第1天 临港日", value: "海昌海洋公园；住 上海海昌奥特曼主题酒店 约700-1500/晚（估算）" },
        { label: "第2天 临港日", value: "滴水湖；住 上海海昌奥特曼主题酒店 约700-1500/晚（估算）" },
      ],
      "确认行程",
    );
    assert.equal(v.days[1]!.stay?.sameAsPrevious, true);
    assert.equal(v.days[0]!.stay?.sameAsPrevious, undefined);
  });

  it("没有价格的住宿行照旧：名字整串，price 缺省", () => {
    const stay = dayOf("外滩；住 上海和平饭店").stay!;
    assert.equal(stay.name, "上海和平饭店");
    assert.equal(stay.price, undefined);
    assert.equal(stay.estimated, false);
  });
});
