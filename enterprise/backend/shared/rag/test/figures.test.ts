/**
 * [F-24-03][AC-24-7] 手册图 → 段落锚定（ACR-029）：四条规则在合成块表上的行为，以及真块表上的整体形状。
 * 全部离线；真块表是 2026-09-11 探针落盘的 Model 3 车主手册第 8~40 页（`evals/figure-anchor/fixtures/`）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { anchorFigures, anchorStats, cleanBlockText, columnSplits, figureText, type MineruBlock } from "../src/figures";

const PW = 950;
const text = (page: number, bbox: number[], t: string, level?: number): MineruBlock => ({ type: "text", page_idx: page, bbox, text: t, ...(level ? { text_level: level } : {}) });
const image = (page: number, bbox: number[], name = "a"): MineruBlock => ({ type: "image", page_idx: page, bbox, img_path: `images/${name}.jpg`, image_caption: [], image_footnote: [] });
const footer = (page: number, t: string): MineruBlock => ({ type: "footer", page_idx: page, bbox: [40, 930, 120, 945], text: t });
const pageNo = (page: number, n: string): MineruBlock => ({ type: "page_number", page_idx: page, bbox: [900, 930, 930, 945], text: n });
/** 让页宽稳定在 950：每页放一块贴右边的页脚。 */
const edge = (page: number): MineruBlock => ({ type: "footer", page_idx: page, bbox: [800, 930, PW, 945], text: "MODEL 3 用户手册" });

describe("[F-24-03][AC-24-7] 分栏", () => {
  it("两栏页：文本左边界的最大空当超过页宽 15% → 在空当中点分", () => {
    const blocks = [text(0, [83, 100, 500, 130], "左1"), text(0, [88, 150, 500, 180], "左2"), text(0, [521, 100, 930, 130], "右1"), text(0, [619, 150, 930, 180], "右2")];
    const s = columnSplits(blocks, PW);
    assert.equal(s.length, 1);
    assert.ok(s[0] > 88 && s[0] < 521, String(s));
  });
  it("单栏页：空当不够宽 → 不分", () => {
    const blocks = [text(0, [83, 100, 900, 130], "a"), text(0, [88, 150, 900, 180], "b"), text(0, [95, 200, 900, 230], "c"), text(0, [83, 250, 900, 280], "d")];
    assert.deepEqual(columnSplits(blocks, PW), []);
  });
  it("三栏页（迈锐宝）：两个空当各 ~29% 页宽 → 两个栏界；栏内 12% 的缩进不算", () => {
    const blocks = [
      text(0, [37, 100, 300, 130], "a"), text(0, [68, 150, 300, 180], "b（缩进的警告正文）"), text(0, [176, 200, 226, 230], "警告", 2),
      text(0, [347, 100, 630, 130], "c"), text(0, [369, 150, 630, 180], "d"),
      text(0, [657, 100, 940, 130], "e"), text(0, [680, 150, 940, 180], "f"),
    ];
    const s = columnSplits(blocks, 998);
    assert.equal(s.length, 2, String(s));
    assert.ok(s[0] > 226 && s[0] < 347 && s[1] > 369 && s[1] < 657, String(s));
  });
});

describe("[F-24-03][AC-24-7] row：图标的说明在它右边同一行", () => {
  it("块表按栏不按行（七个图标先出、七段说明后出）时仍逐一对上", () => {
    // 复现探针第 16 页：左栏 3 枚图标在块表最前面，说明段在后面；右栏有无关文本
    const blocks: MineruBlock[] = [
      edge(0),
      image(0, [66, 97, 133, 136], "i1"),
      image(0, [68, 174, 133, 207], "i2"),
      image(0, [68, 251, 132, 284], "i3"),
      text(0, [133, 40, 258, 66], "车辆状态", 2),
      text(0, [174, 79, 395, 97], "近光大灯亮起（指示灯为绿色）。"),
      text(0, [176, 156, 464, 188], "远光大灯亮起（指示灯为蓝色）。"),
      text(0, [176, 234, 464, 279], "自适应大灯已启用且远光灯打开。"),
      text(0, [614, 79, 901, 151], "出现蓝色雪花时表示寒冷天气。"),
      text(0, [614, 169, 900, 200], "能量回收制动受限时显示。"),
      footer(0, "概述"),
      pageNo(0, "14"),
    ];
    const figs = anchorFigures(blocks, { doc: "D" });
    assert.deepEqual(
      figs.map((f) => [f.kind, f.anchor.rule, f.anchor.text]),
      [
        ["icon", "row", "近光大灯亮起（指示灯为绿色）。"],
        ["icon", "row", "远光大灯亮起（指示灯为蓝色）。"],
        ["icon", "row", "自适应大灯已启用且远光灯打开。"],
      ],
    );
    assert.equal(figs[0].location, "第 14 页");
    assert.equal(figs[0].breadcrumb, "D › 概述 › 车辆状态");
    assert.equal(figs[0].id, "D#p1#b1");
  });
  it("隔着一栏的文本不算同行：左栏大图不锚到右栏并排的段", () => {
    const blocks: MineruBlock[] = [
      edge(0),
      text(0, [83, 100, 500, 130], "讲这张图的段。"),
      image(0, [86, 150, 500, 600], "big"),
      text(0, [521, 100, 930, 130], "右栏第一段"),
      text(0, [521, 300, 930, 330], "右栏第二段"),
    ];
    const [f] = anchorFigures(blocks, { doc: "D" });
    assert.equal(f.kind, "figure");
    assert.equal(f.anchor.rule, "adjacent");
    assert.equal(f.anchor.text, "讲这张图的段。");
  });
});

describe("[F-24-03][AC-24-7] reference：「下图」那句以及它引出的段", () => {
  it("上方最近几段里有「注：下图仅作示范」→ 锚在那句，锚段文本带上它上面那段", () => {
    const blocks: MineruBlock[] = [
      edge(0),
      text(0, [83, 224, 501, 309], "当车辆处于驻车状态时，状态区域会显示行驶模式。"),
      text(0, [83, 319, 482, 348], "注：下图仅作示范<sub>。</sub> 根据车辆选装件 软件版本显示 可能不同。"),
      image(0, [86, 357, 500, 832], "shot"),
    ];
    const [f] = anchorFigures(blocks, { doc: "D" });
    assert.equal(f.anchor.rule, "reference");
    assert.equal(f.anchor.blockIndex, 2);
    assert.equal(f.anchor.referenceText, "注：下图仅作示范。根据车辆选装件软件版本显示可能不同。");
    assert.equal(f.anchor.text, "当车辆处于驻车状态时，状态区域会显示行驶模式。\n注：下图仅作示范。根据车辆选装件软件版本显示可能不同。");
  });
  it("「注」上面是列表项时再往上找引出列表的那句", () => {
    const blocks: MineruBlock[] = [
      edge(0),
      text(0, [55, 440, 361, 455], "您还可以通过下列任何方法打开充电接口盖板："),
      text(0, [58, 470, 467, 500], "• 在触摸屏上点击。"),
      text(0, [58, 510, 467, 540], "• 使用语音命令。"),
      text(0, [53, 633, 462, 662], "注：下图仅作示范。"),
      image(0, [57, 667, 472, 919], "port"),
    ];
    const [f] = anchorFigures(blocks, { doc: "D" });
    assert.equal(f.anchor.rule, "reference");
    assert.equal(f.anchor.blockIndex, 4);
    assert.equal(f.anchor.text, "您还可以通过下列任何方法打开充电接口盖板：\n注：下图仅作示范。");
  });
});

describe("[F-24-03][AC-24-7] adjacent 与跨栏、跨页", () => {
  it("图正好开一节（上方紧挨着标题）→ 取下面那段", () => {
    const blocks: MineruBlock[] = [edge(0), text(0, [83, 40, 200, 66], "手套箱", 2), image(0, [86, 80, 500, 300], "g"), text(0, [83, 320, 500, 350], "如需关闭手套箱，请向上推动。")];
    const [f] = anchorFigures(blocks, { doc: "D" });
    assert.equal(f.anchor.rule, "adjacent");
    assert.equal(f.anchor.text, "如需关闭手套箱，请向上推动。");
  });
  it("像标题的数字（截图里的「0-83%」被标成标题）不算开一节：仍取上面那段", () => {
    const blocks: MineruBlock[] = [edge(0), text(0, [53, 347, 473, 377], "点击控制 > 充电来访问充电设置。"), text(0, [63, 388, 183, 412], "0-83%", 2), image(0, [117, 421, 468, 505], "s"), text(0, [57, 541, 465, 583], "1. 可用能量。")];
    const [f] = anchorFigures(blocks, { doc: "D" });
    assert.equal(f.anchor.text, "点击控制 > 充电来访问充电设置。");
  });
  it("图在右栏最顶上、上方没有标题 → 接左栏末尾那段（阅读顺序的前一块），不取下方的「注」", () => {
    const blocks: MineruBlock[] = [
      edge(0),
      text(0, [55, 662, 220, 684], "从车内打开车门", 2),
      text(0, [53, 696, 470, 727], "要从车内打开车门，可按下车门内把手顶部的按钮。"),
      image(0, [493, 77, 911, 354], "btn"),
      text(0, [491, 363, 901, 393], "注：为防止儿童打开后车门，请开启儿童锁。"),
      text(0, [491, 397, 911, 440], "注：没有低压电源时无法使用按钮。"),
    ];
    const [f] = anchorFigures(blocks, { doc: "D" });
    assert.equal(f.anchor.rule, "adjacent");
    assert.equal(f.anchor.confidence, 0.5);
    assert.equal(f.anchor.text, "要从车内打开车门，可按下车门内把手顶部的按钮。");
  });
  it("整页大图、本页没有正文 → previous-page，置信度 0.4", () => {
    const blocks: MineruBlock[] = [edge(0), text(0, [83, 100, 500, 130], "上一页末尾的段。"), edge(1), image(1, [60, 60, 900, 900], "full")];
    const [f] = anchorFigures(blocks, { doc: "D" });
    assert.equal(f.anchor.rule, "previous-page");
    assert.equal(f.anchor.confidence, 0.4);
    assert.equal(f.page, 2);
  });
  it("块表里一段正文都没有 → none，不抛", () => {
    const [f] = anchorFigures([edge(0), image(0, [60, 60, 900, 900])], { doc: "D" });
    assert.equal(f.anchor.rule, "none");
    assert.equal(f.anchor.blockIndex, null);
  });
});

describe("[F-24-03][AC-24-7] 页码、面包屑与文本", () => {
  it("pageOffset 换算原 PDF 页序号；印刷页码优先进出处", () => {
    const blocks: MineruBlock[] = [edge(3), text(3, [83, 100, 500, 130], "段。"), image(3, [86, 150, 500, 600]), pageNo(3, "148")];
    const [f] = anchorFigures(blocks, { doc: "D", pageOffset: 145 });
    assert.equal(f.page, 149);
    assert.equal(f.printedPage, "148");
    assert.equal(f.location, "第 148 页");
  });
  it("章名取最近一页页脚里不是文档名的那个；标题链先一级再二级，去重；页眉里的文档名与列表项不进标题链", () => {
    const blocks: MineruBlock[] = [
      footer(0, "充电和能耗"),
      edge(1),
      text(1, [83, 20, 300, 36], "MODEL 3 2024+ 用户手册", 1),
      text(1, [83, 40, 200, 66], "充电说明", 1),
      text(1, [83, 70, 200, 78], "1. 按下右滚轮按钮。", 2),
      text(1, [83, 80, 200, 100], "打开充电端口", 2),
      text(1, [83, 120, 500, 150], "按下按钮可打开充电接口盖板。"),
      image(1, [86, 160, 500, 400]),
    ];
    const [f] = anchorFigures(blocks, { doc: "Model3_车主手册" });
    assert.deepEqual(f.headings, ["充电说明", "打开充电端口"]);
    assert.equal(f.breadcrumb, "Model3_车主手册 › 充电和能耗 › 充电说明 › 打开充电端口");
    assert.equal(figureText(f), "Model3_车主手册 › 充电和能耗 › 充电说明 › 打开充电端口\n按下按钮可打开充电接口盖板。");
  });
  it("cleanBlockText：剥上下标、压汉字间空格，英文与数字之间的空格保留", () => {
    assert.equal(cleanBlockText("本车集先进技术<sub>、</sub>安全性 于一体 Model 3 的"), "本车集先进技术、安全性于一体 Model 3 的");
  });
});

describe("[F-24-03][AC-24-7] 真块表（2026-09-11 探针）", () => {
  it("Model 3 车主手册第 8~40 页：158 张图全部有锚，没有 none / previous-page；小图全部走 row", () => {
    const fx = JSON.parse(readFileSync(new URL("../../../../../evals/figure-anchor/fixtures/model3-owners-p8-40.json", import.meta.url), "utf8")) as { meta: { doc: string; pageOffset: number }; blocks: MineruBlock[] };
    const figs = anchorFigures(fx.blocks, { doc: fx.meta.doc, pageOffset: fx.meta.pageOffset });
    const s = anchorStats(figs);
    assert.equal(figs.length, 158);
    assert.equal(s.none, 0);
    assert.equal(s["previous-page"], 0);
    assert.ok(s.row >= 100, `row ${s.row}`);
    for (const f of figs) assert.ok(f.anchor.text.length > 0 && !/<\/?su[bp]>/.test(f.anchor.text), f.id);
    for (const f of figs) assert.match(f.breadcrumb, /^Model3_车主手册 › /);
  });
});
