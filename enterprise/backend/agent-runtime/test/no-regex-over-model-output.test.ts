/**
 * [ADR-012] 闸门：`graph/` 下不许拿正则去读**模型已经读懂**的东西。
 *
 * 扫的是对 `constraints` / `kept` / `intent.*` 这几个模型产出变量做 `.exec(` / `.test(` /
 * `.match(` 的地方。三次事故（INC-0011 / INC-0152 / INC-0151）都是这个形状，
 * 而每次的当场修法都是"再补一条正则"——第 2 次与第 3 次隔一天，漏的是同一个字（日 vs 天）。
 *
 * 豁免写 `// ADR-012 例外：<理由>` 在**同一行或上一行**，让下一个人看见你想过。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../src/graph");

/**
 * 盯的是**约束文本**这一条通路：`intent.constraints` 与它的别名。
 *
 * 只收 `constraints` / `kept` 两个源头，且别名只认 `for (const x of …)` 这一种绑定——
 * 放宽到"任何从 intent 派生的变量"会把 `COST_INTENT.test(rawQuery)` 这类全扫进来，
 * 那些是对**原话**做字面兜底，ADR-012 明说保留。闸门宁可窄而准：
 * 它要挡的是"模型把值读懂了、压成文本、代码再解析回来"这一条路。
 */
const FOR_OF_ALIAS = /for\s*\(\s*const\s+(\w+)\s+of\s+[^)]*\b(?:constraints|kept)\b/;
/** 正则用法。`userText` 与它的派生不在名单里——原话本来就是文本。 */
const REGEX_USE = /\.(exec|test|match|matchAll)\s*\(/;
const EXEMPT = /ADR-012 例外/;

/** 一个文件里"来自约束文本"的变量名：源头 + for-of 绑出来的别名。 */
export function watchedNames(src: string): Set<string> {
  const names = new Set(["constraints", "kept"]);
  for (const line of src.split("\n")) {
    const m = FOR_OF_ALIAS.exec(line.split("//")[0] ?? "");
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

/** 扫一份源码，返回违规行的说明。导出给闸门自检用。 */
export function scanSource(src: string, label: string): string[] {
  const watched = watchedNames(src);
  const lines = src.split("\n");
  const bad: string[] = [];
  lines.forEach((line, i) => {
    const code = line.split("//")[0] ?? "";
    if (!REGEX_USE.test(code)) return;
    if (![...watched].some((n) => new RegExp(String.raw`\b${n}\b`).test(code))) return;
    // 豁免注释往上扫**整个连续注释块**：只看上一行的话，三行理由里有两行不带关键词就漏掉。
    if (EXEMPT.test(line)) return;
    let j = i - 1;
    let exempt = false;
    while (j >= 0 && (lines[j] ?? "").trim().startsWith("//")) {
      if (EXEMPT.test(lines[j]!)) { exempt = true; break; }
      j -= 1;
    }
    if (exempt) return;
    bad.push(`拿正则去读模型已经读懂的东西：${label}:${i + 1} → ${line.trim()}`);
  });
  return bad;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("[ADR-012] 不拿正则读模型的产出", () => {
  it("graph/ 下没有对约束文本（constraints / kept 及其别名）的正则解析", () => {
    const bad = walk(ROOT).flatMap((f) => scanSource(readFileSync(f, "utf8"), path.relative(ROOT, f)));
    assert.deepEqual(bad, [], `\n${bad.join("\n")}\n\n要一个值就在意图 JSON 里加一栏（见 ADR-012），别从 constraints 的文本里解析。`);
  });

  it("**闸门对改动前那份代码真的会报**——否则它只是个不可能失败的断言", () => {
    // 这就是被第一版闸门漏掉的形状：正则打在循环变量 c 上，而 c 绑自 constraints。
    const before = [
      "export function extractRequestedDays(constraints: readonly string[]) {",
      "  for (const c of constraints) {",
      "    for (const re of PATTERNS) {",
      "      const m = re.exec(c);",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const bad = scanSource(before, "merge.ts");
    assert.equal(bad.length, 1, `应当报出来，实际 ${JSON.stringify(bad)}`);
    assert.match(bad[0]!, /re\.exec\(c\)/);
  });

  it("userText 的字面兜底不被误伤——那是 ADR-012 明说保留的降级路径", () => {
    assert.deepEqual(scanSource("  return COMMIT_PATTERNS.test(userText);", "x.ts"), []);
  });

  it("写了豁免注释的那一行放行", () => {
    const src = "  const x = /x/.test(constraints[0]); // ADR-012 例外：端上协议前缀";
    assert.deepEqual(scanSource(src, "x.ts"), []);
  });
});
