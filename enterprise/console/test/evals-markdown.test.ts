/** 报告 markdown 小渲染器（施工单 M67-04）：只认报告用到的语法；未知语法成段落、不当 HTML。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidElement, type ReactElement } from "react";

import { parseMarkdown, renderBlocks, renderInline, splitRow } from "../src/pages/evals/markdown";

/** 把 React 元素树摊平成 [tag, text] 序列，便于断言结构而不依赖 DOM。 */
function flatten(node: unknown, out: Array<[string, string]> = []): Array<[string, string]> {
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out);
    return out;
  }
  if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: unknown }>;
    const text = textOf(el.props.children);
    out.push([String(el.type), text]);
    flatten(el.props.children, out);
  }
  return out;
}
function textOf(n: unknown): string {
  if (typeof n === "string") return n;
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (isValidElement(n)) return textOf((n as ReactElement<{ children?: unknown }>).props.children);
  return "";
}

describe("splitRow", () => {
  it("识别 \\| 转义，去首尾竖线", () => {
    assert.deepEqual(splitRow("| a | b \\| c | d |"), ["a", "b | c", "d"]);
  });
});

describe("parseMarkdown", () => {
  it("标题 / 表格 / 列表 / 引用 / 围栏 / details 各一块，段落合并", () => {
    const md = [
      "# 报告",
      "",
      "| 指标 | 值 |",
      "|---|---|",
      "| `M-P1` | **87%** |",
      "",
      "- 一",
      "- 二",
      "> 引一",
      "> 引二",
      "```bash",
      "corepack pnpm eval:scenarios",
      "```",
      "<details><summary>逐条明细（64 项）</summary>",
      "",
      "| 判定项 | 结果 |",
      "|---|---|",
      "| x | 通过 |",
      "",
      "</details>",
      "普通段落第一行",
      "第二行",
    ].join("\n");
    const blocks = parseMarkdown(md);
    assert.deepEqual(blocks.map((b) => b.kind), ["h", "table", "list", "quote", "code", "details", "p"]);
    const table = blocks[1] as { header: string[]; rows: string[][] };
    assert.deepEqual(table.header, ["指标", "值"]);
    assert.deepEqual(table.rows, [["`M-P1`", "**87%**"]]);
    const details = blocks[5] as { summary: string; body: Array<{ kind: string }> };
    assert.equal(details.summary, "逐条明细（64 项）");
    assert.deepEqual(details.body.map((b) => b.kind), ["table"]);
    assert.equal((blocks[6] as { text: string }).text, "普通段落第一行\n第二行");
  });

  it("未知语法原样成段落，不被当 HTML", () => {
    const blocks = parseMarkdown('<script>alert(1)</script> 与 <b>粗</b>');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, "p");
    const flat = flatten(renderBlocks(blocks));
    assert.deepEqual(flat[0][0], "p");
    assert.match(flat[0][1], /<script>alert\(1\)<\/script>/);
    assert.ok(!flat.some(([tag]) => tag === "script" || tag === "b"));
  });
});

describe("渲染", () => {
  it("行内：粗体 / 行内代码 / 删除线", () => {
    const flat = flatten(renderInline("a **b** `c` ~~d~~ e"));
    assert.deepEqual(flat, [["strong", "b"], ["code", "c"], ["s", "d"]]);
  });
  it("标题降一级（报告的 # 不该盖过页面的 h1），表格用站内 .table", () => {
    const flat = flatten(renderBlocks(parseMarkdown("# T\n\n| a |\n|---|\n| 1 |")));
    assert.equal(flat[0][0], "h2");
    assert.ok(flat.some(([tag]) => tag === "table"));
  });
});
