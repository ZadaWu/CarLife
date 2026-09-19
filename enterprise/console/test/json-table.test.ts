/**
 * JSON → 表格（2026-09-15）：形状判定的纯逻辑 + 渲染落实。
 * 渲染测试同 `insight-card-render.test.ts` 的两条坑：createElement 留在 .ts，本包目录下跑。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JsonTable } from "../src/pages/sessions/JsonTable";
import { parseJsonText, shapeOf } from "../src/pages/sessions/json-table-model";

describe("形状判定", () => {
  it("对象数组 → 列表，列是各行键的并集、按首次出现排", () => {
    const s = shapeOf([{ name: "A", rating: "4.5" }, { name: "B", estPrice: "500" }]);
    assert.equal(s.kind, "rows");
    assert.deepEqual(s.kind === "rows" ? s.columns : [], ["name", "rating", "estPrice"]);
  });
  it("原始值数组 → list；对象 → record；空 → empty；原始值格式化", () => {
    assert.equal(shapeOf(["a", "b"]).kind, "list");
    assert.equal(shapeOf({ a: 1 }).kind, "record");
    assert.equal(shapeOf([]).kind, "empty");
    assert.equal(shapeOf({}).kind, "empty");
    const t = shapeOf(true);
    assert.equal(t.kind === "scalar" ? t.text : "", "是");
    const n = shapeOf(null);
    assert.equal(n.kind === "scalar" ? n.text : "", "—");
  });
  it("解析不了的文本（截断过的 JSON、散文）退回原文", () => {
    assert.ok("raw" in parseJsonText('{"hotels":[{"name":"A"'));
    assert.ok("raw" in parseJsonText("给您排了三天：第一天西湖"));
    assert.ok("value" in parseJsonText(' {"a":1} '));
  });
});

describe("渲染", () => {
  it("酒店名单：表头「中文(英文)」，行内嵌套折叠成子表，表下留原始 JSON", () => {
    const html = renderToStaticMarkup(
      createElement(JsonTable, {
        text: JSON.stringify({
          hotels: [
            { name: "西湖国宾馆", area: "西湖", estPrice: "800", coord: { lat: 30.2, lon: 120.1 } },
            { name: "杭州饭店", area: "武林" },
          ],
          findings: ["西湖周边周末溢价"],
        }),
      }),
    );
    assert.match(html, /酒店候选\(hotels\)/);
    assert.match(html, /名称\(name\)/);
    assert.match(html, /估算价格\(estPrice\)/);
    assert.match(html, /西湖国宾馆/);
    assert.match(html, /<summary>2 个字段<\/summary>/, "行内的坐标对象折叠成子表");
    assert.match(html, /原始 JSON/);
    assert.match(html, /<th scope="col">coord<\/th>/, "未收录的键原样显示英文（coord 是列头），不编中文");
  });
  it("散文不是 JSON：原样 pre", () => {
    const html = renderToStaticMarkup(createElement(JsonTable, { text: "给您排了三天" }));
    assert.match(html, /<pre class="bz-pre">给您排了三天<\/pre>/);
  });
});
