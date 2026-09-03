/**
 * 报告 markdown 的小渲染器（施工单 M67-04）。
 *
 * 只认 runner 报告用到的语法：`#`/`##`/`###` 标题、`| a | b |` 表格、`- ` 列表、`> ` 引用、
 * ```` ``` ```` 围栏、`<details>` / `<summary>`、`**粗体**`、`` `行内代码` ``、`~~删除~~`。
 * 其余原样成段落。**不用 innerHTML**：报告正文含题目原话与回答原文（来自模型），不能当 HTML；
 * 输出是一棵 React 元素树，由页面渲染。
 *
 * 不引依赖（引依赖要走 ACR）。
 */

import { createElement, Fragment, type ReactNode } from "react";

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "details"; summary: string; body: Block[] };

/** 表格行切分：识别 `\|` 转义。 */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let i = 0;
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 2;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  cells.push(cur.trim());
  return cells;
}

const isTableLine = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
const isSepLine = (l: string): boolean => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const parseUntil = (stop: (l: string) => boolean): Block[] => {
    const out: Block[] = [];
    while (i < lines.length && !stop(lines[i])) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        out.push({ kind: "h", level: h[1].length, text: h[2].trim() });
        i += 1;
        continue;
      }
      if (/^```/.test(line)) {
        const lang = line.replace(/^```/, "").trim();
        const body: string[] = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
        i += 1;
        out.push({ kind: "code", lang, lines: body });
        continue;
      }
      if (/^<details>/.test(line.trim())) {
        i += 1;
        let summary = "";
        const sm = /<summary>(.*?)<\/summary>/.exec(line);
        if (sm) summary = sm[1];
        else if (i < lines.length && /<summary>/.test(lines[i])) {
          summary = (/<summary>(.*?)<\/summary>/.exec(lines[i]) ?? ["", ""])[1];
          i += 1;
        }
        const body = parseUntil((l) => /^<\/details>/.test(l.trim()));
        i += 1;
        out.push({ kind: "details", summary, body });
        continue;
      }
      if (isTableLine(line) && i + 1 < lines.length && isSepLine(lines[i + 1])) {
        const header = splitRow(line);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && isTableLine(lines[i])) rows.push(splitRow(lines[i++]));
        out.push({ kind: "table", header, rows });
        continue;
      }
      if (/^>\s?/.test(line)) {
        const q: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
        out.push({ kind: "quote", lines: q });
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
        out.push({ kind: "list", items });
        continue;
      }
      // 段落：连续非空行合一段
      const p: string[] = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*]\s|<details>|\|)/.test(lines[i]) && !stop(lines[i])) p.push(lines[i++]);
      out.push({ kind: "p", text: p.join("\n") });
    }
    return out;
  };
  blocks.push(...parseUntil(() => false));
  return blocks;
}

/** 行内：**粗体**、`代码`、~~删除~~；其余原样文本（不解析 HTML）。 */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|~~[^~]+~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(createElement("strong", { key: k++ }, tok.slice(2, -2)));
    else if (tok.startsWith("`")) out.push(createElement("code", { key: k++ }, tok.slice(1, -1)));
    else out.push(createElement("s", { key: k++ }, tok.slice(2, -2)));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, idx) => {
    const key = idx;
    switch (b.kind) {
      case "h":
        return createElement(`h${Math.min(6, b.level + 1)}`, { key, className: "md-h" }, renderInline(b.text));
      case "p":
        return createElement("p", { key }, renderInline(b.text));
      case "quote":
        return createElement("blockquote", { key }, b.lines.map((l, j) => createElement("p", { key: j }, renderInline(l))));
      case "list":
        return createElement("ul", { key }, b.items.map((it, j) => createElement("li", { key: j }, renderInline(it))));
      case "code":
        return createElement("pre", { key, "data-lang": b.lang }, createElement("code", null, b.lines.join("\n")));
      case "table":
        return createElement(
          "div",
          { key, className: "md-table-wrap" },
          createElement(
            "table",
            { className: "table md-table" },
            createElement("thead", null, createElement("tr", null, b.header.map((c, j) => createElement("th", { key: j }, renderInline(c))))),
            createElement("tbody", null, b.rows.map((r, j) => createElement("tr", { key: j }, r.map((c, k) => createElement("td", { key: k }, renderInline(c)))))),
          ),
        );
      case "details":
        return createElement("details", { key }, createElement("summary", null, renderInline(b.summary)), ...renderBlocks(b.body));
      default:
        return createElement(Fragment, { key });
    }
  });
}

export function renderMarkdown(md: string): ReactNode {
  return createElement("div", { className: "md" }, ...renderBlocks(parseMarkdown(md)));
}
