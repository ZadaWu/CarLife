/**
 * 测试规模实测（施工单 M38-03）。
 *
 * # 它替掉的是什么
 *
 * 报告里那个「145 项测试」是 2026 年某天的快照——`@carlife/memory` 145 pass
 * 与 `cargo test` 145 passed 的巧合，文档自己都标了"远低于实际"。
 * **手抄的数字会随时间变成谎话，而且没有任何机制会发现**。本脚本让那个数字
 * 每次都从当次扫描来（同 ADR-002：做完了的证据必须来自运行时）。
 *
 * # 计数口径（写在这里，报告里也原样打印）
 *
 * - **TS 测试文件** = `*.test.ts` / `*.test.tsx` / `*.test.mts`。
 * - **TS 用例数** = 源码里 `it(` / `test(` 的调用点，含 `.skip` / `.todo` / `.only`
 *   等修饰形态；`describe(` 是分组不是用例，不计。
 * - **Rust 用例数** = `#[test]` 与 `#[tokio::test]` 属性行。
 * - 排除目录：`node_modules` / `dist` / `target` / `.git`，以及 **`.claude`**——
 *   那底下的 `worktrees/` 是别的会话的仓库副本（实测 154 个 `.test.ts`），
 *   把它算进来等于把同一批测试数好几遍。
 * - 归属按**最近的 `package.json`** 判（与 `dev.sh` 认进程的办法同源）；
 *   不属于任何 workspace 成员的（如 `infra/scripts/`）归「仓库根」。
 * - **零测试成员点名**，不因为难看就省略。
 *
 * 用法：`corepack pnpm test:inventory [-- --json out.json]`
 */

import { listWorkspaceMembers } from "../lib/workspace-members";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const EXCLUDED_DIRS = ["node_modules", "dist", "target", ".git", ".claude"];
const TS_TEST_SUFFIXES = [".test.ts", ".test.tsx", ".test.mts"];

/** `it(` / `test(`（含 `.skip` / `.only` / `.todo`），但不含 `describe(`、也不含 `xxx.test(` 这类方法调用。 */
const CASE_RE = /(^|[^.\w$])(it|test)(\.(skip|only|todo|concurrent|failing))*\s*\(/gm;
/** Rust 的 `#[test]` 与 `#[tokio::test]`。 */
const RUST_TEST_RE = /^\s*#\[(tokio::)?test\]/gm;

function listFiles(exts: string[]): string[] {
  const args = [ROOT, "-type", "f"];
  for (const d of EXCLUDED_DIRS) args.push("-not", "-path", `*/${d}/*`);
  args.push("(");
  exts.forEach((e, i) => {
    if (i > 0) args.push("-o");
    args.push("-name", `*${e}`);
  });
  args.push(")");
  return execFileSync("find", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean)
    .sort();
}

/** 归属：最近的 package.json 的 name；找不到就算仓库根。 */
export function ownerOf(file: string, root = ROOT): string {
  let dir = dirname(file);
  while (dir.startsWith(root) && dir.length >= root.length) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const name = (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name;
      if (name && name !== "carlife-ai-agent") return name;
      return "（仓库根）";
    }
    dir = dirname(dir);
  }
  return "（仓库根）";
}

export function countMatches(text: string, re: RegExp): number {
  return text.match(new RegExp(re.source, re.flags))?.length ?? 0;
}

export interface InventoryRow {
  owner: string;
  files: number;
  cases: number;
}

export interface Inventory {
  at: string;
  ts: { files: number; cases: number; byOwner: InventoryRow[] };
  rust: { files: number; cases: number };
  zeroTestMembers: string[];
  rules: string[];
}

export function collect(): Inventory {
  const tsFiles = listFiles(TS_TEST_SUFFIXES);
  const byOwner = new Map<string, InventoryRow>();
  let cases = 0;
  for (const f of tsFiles) {
    const owner = ownerOf(f);
    const n = countMatches(readFileSync(f, "utf8"), CASE_RE);
    cases += n;
    const row = byOwner.get(owner) ?? { owner, files: 0, cases: 0 };
    row.files += 1;
    row.cases += n;
    byOwner.set(owner, row);
  }

  const rustFiles = listFiles([".rs"]);
  let rustCases = 0;
  let rustFilesWithTests = 0;
  for (const f of rustFiles) {
    const n = countMatches(readFileSync(f, "utf8"), RUST_TEST_RE);
    if (n > 0) rustFilesWithTests += 1;
    rustCases += n;
  }

  // 零测试成员：有 package.json 但一个测试文件都没有的 workspace 成员。
  const zero: string[] = [];
  // 成员从 pnpm-workspace.yaml 展开（ACR-020）：目录搬家不用回来改清单。
  for (const m of listWorkspaceMembers(ROOT)) {
    if (!byOwner.has(m.name)) zero.push(`${m.name}（${m.dir}）`);
  }

  return {
    at: new Date().toISOString(),
    ts: { files: tsFiles.length, cases, byOwner: [...byOwner.values()].sort((a, b) => b.cases - a.cases) },
    rust: { files: rustFilesWithTests, cases: rustCases },
    zeroTestMembers: zero,
    rules: [
      "TS 测试文件 = *.test.ts / *.test.tsx / *.test.mts",
      "TS 用例 = it( / test( 的调用点（含 .skip/.only/.todo），describe( 不计",
      "Rust 用例 = #[test] 与 #[tokio::test] 属性行",
      `排除目录：${EXCLUDED_DIRS.join(" / ")}（.claude 下是别的会话的仓库副本，算进来会重复计数）`,
      "归属按最近的 package.json；不属于任何成员的归「仓库根」",
    ],
  };
}

export function render(inv: Inventory): string {
  const out: string[] = [];
  out.push(`TS：**${inv.ts.files}** 个测试文件 / **${inv.ts.cases}** 例；Rust：**${inv.rust.cases}** 例（分布在 ${inv.rust.files} 个文件）。`);
  out.push("");
  out.push("| 成员 | 测试文件 | 用例 |");
  out.push("|---|---|---|");
  for (const r of inv.ts.byOwner) out.push(`| \`${r.owner}\` | ${r.files} | ${r.cases} |`);
  out.push(`| **TS 合计** | **${inv.ts.files}** | **${inv.ts.cases}** |`);
  out.push(`| \`cargo\`（Rust，不按 crate 细分） | ${inv.rust.files} | ${inv.rust.cases} |`);
  out.push("");
  if (inv.zeroTestMembers.length) {
    out.push("**零测试成员（如实点名，不因为难看就省略）**：");
    for (const m of inv.zeroTestMembers) out.push(`- ${m}`);
    out.push("");
  }
  out.push("计数口径：");
  for (const r of inv.rules) out.push(`- ${r}`);
  return out.join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const i = args.indexOf("--json");
  const inv = collect();
  console.log(render(inv));
  if (i >= 0 && args[i + 1]) {
    writeFileSync(args[i + 1], JSON.stringify(inv, null, 2));
    console.log(`\n产物已写入 ${relative(ROOT, args[i + 1]) || args[i + 1]}`);
  }
}

// 直接执行时才跑 main。**必须锚定结尾**：`includes("x")` 会把 `x.test.ts` 也算上，
// 于是单测一 import 就真的去探活、真的打印检查单（实测踩到）。
if (/\/test-inventory\.ts$/.test(process.argv[1] ?? "")) main();
