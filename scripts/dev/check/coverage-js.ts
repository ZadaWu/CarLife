/**
 * TS 侧覆盖率（施工单 M38-03 / 变更单 ACR-009）。
 *
 * 逐个 workspace 成员用 **c8 包裹它自己的 `test` 脚本**跑一遍，按成员输出行/分支/函数覆盖率。
 *
 * # 为什么是"外层包裹"而不是改各包的 test 脚本
 *
 * c8 走 `NODE_V8_COVERAGE`，被包裹的命令**不必知道自己在被测**——实测
 * `c8 … corepack pnpm --filter X test` 能穿过 pnpm 子进程收集到覆盖。
 * 于是 17 个成员的 `test` 脚本一行都不用改（ACR-009 的红线之一）：
 * 覆盖率是外挂的观察者，不是测试链的一部分。
 *
 * # 为什么不用 Node 内置的 `--experimental-test-coverage`
 *
 * ACR-009 实测：它的行号落在**转译产物**上而不是 `.ts` 源。同一个
 * `enterprise/backend/shared/memory/src/client.ts` 实际 578 行，内置报告的最大行号只到 227；
 * `taxonomy.ts` 被报成 100%，而它的导出函数 `findMemoryCategory` 全仓零测试引用。
 * c8 在同一批实测里把那两行准确标了出来。
 *
 * # 口径（报告里也会打印，不许只在代码里写）
 *
 * - **分母是各成员自己的 `src/`**，用 `--include <成员>/src/**` 收敛。不收敛的话
 *   报告里会混进测试文件与 `@carlife/shared` 的传递依赖，那时"谁的覆盖率"就说不清了。
 * - `--all` 打开：**没被任何测试 import 的源文件也计入分母**。关掉它数字会好看，
 *   但好看的来源是"没测的文件干脆不算"——那正是覆盖率最容易骗人的地方。
 * - 按顶层目录分组分列（`enterprise/backend/` 与它的 `shared/`、`contracts/`、`clients/shared/`、`clients/`、`enterprise/console/`、`mocks/`），**不出全仓单值**：前端组件测试少，
 *   混进来会把数字打扮得难看或好看，两个方向都是失真。
 * - Rust 侧不接（ACR-009 决策），报告注明口径 = TS。
 *
 * 用法：
 *   corepack pnpm coverage:js                 # 全量
 *   corepack pnpm coverage:js -- --offline    # 跳过需基础设施的成员（并列名）
 *   corepack pnpm coverage:js -- --member @carlife/rag
 *   corepack pnpm coverage:js -- --json out.json
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../..", import.meta.url).pathname;
const GROUPS = [
  // ACR-020 起按新目录分组：真服务与它们的共享库分开列，假第三方单独一组。
  // 顺序即报告里的顺序。批⑤⑥（contracts/ clients/）落地后再补两组。
  "enterprise/backend",
  "enterprise/backend/shared",
  "contracts",        // 它本身就是一个包（端云契约），下面的枚举对此有特判
  "clients/shared",   // ui 有 package.json 进口径；rust/ 是 cargo 成员，被 package.json 判据自然跳过
  "clients",            // cockpit / mobile；shared/ 没有 package.json，自然跳过
  "enterprise/console", // 单包分组，同 contracts
  "mocks",
] as const;

/**
 * 跑测试需要真实基础设施的成员。**这份名单是实测出来的，不是按依赖猜的**
 * （2026-08-29，把 `DATABASE_URL` 指到一个死端口后逐个跑）：
 *
 * | 成员 | 无 PG 时 |
 * |---|---|
 * | `@carlife/db` | 112 例里 25 pass / 9 fail —— 进名单 |
 * | `@carlife/agent-runtime` | 1152 例全 pass —— **不进**（它有 2 个测试文件提到 DB，但都是桩） |
 * | `@carlife/worker` | 56 例全 pass —— **不进**（同上） |
 *
 * 按"测试里出现过 getPrisma/DATABASE_URL"来划名单会把 agent-runtime 的 65 个测试文件
 * 整包踢掉，而它们里只有 2 个碰 DB、且碰的是桩。名单宁可短，代价只是 `--offline`
 * 时多一条 fail 并被如实列出。
 */
const INFRA_DEPENDENT = new Set(["@carlife/db"]);

const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const OFFLINE = flag("offline");
const ONLY = opt("member");
const JSON_OUT = opt("json");

export interface Member {
  name: string;
  dir: string;
  group: (typeof GROUPS)[number];
}

/** 枚举有 `test` 脚本的 workspace 成员（没有 test 脚本的不进覆盖率口径，报告里另行点名）。 */
export function listMembers(root = ROOT): { withTests: Member[]; withoutTests: Member[] } {
  const withTests: Member[] = [];
  const withoutTests: Member[] = [];
  for (const group of GROUPS) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    // 分组目录本身就是一个包（contracts/）：直接收，不再往下枚举。
    if (existsSync(join(base, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string> };
      if (pkg.name) (pkg.scripts?.test ? withTests : withoutTests).push({ name: pkg.name, dir: group, group });
      continue;
    }
    for (const entry of readdirSync(base).sort()) {
      const dir = join(base, entry);
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; scripts?: Record<string, string> };
      if (!pkg.name) continue;
      const m: Member = { name: pkg.name, dir: `${group}/${entry}`, group };
      (pkg.scripts?.test ? withTests : withoutTests).push(m);
    }
  }
  return { withTests, withoutTests };
}

export interface MemberResult {
  name: string;
  dir: string;
  group: string;
  status: "ok" | "failed" | "skipped";
  reason?: string;
  lines?: number;
  branches?: number;
  functions?: number;
  totalLines?: number;
  coveredLines?: number;
  durationMs?: number;
  /**
   * 该成员**实跑**的用例数（从 node:test 的 `ℹ tests N` 摘要读回）。
   *
   * 与 `test:inventory` 的静态计数是两个口径，报告里都要有：静态数的是
   * 源码里写了几个 `it(`，而循环里生成的用例静态只算一次——`@carlife/memory`
   * 实测静态 194、实跑 214，差的 20 例全来自 `for` 里的 `it(`。
   * **实跑数才是 ADR-002 意义上的证据**，静态数说的是结构。
   */
  casesRun?: number;
  casesPass?: number;
  casesFail?: number;
}

/** 从 node:test 的摘要行读回实跑用例数（`ℹ tests 214` / `ℹ pass 214` / `ℹ fail 0`）。 */
export function parseNodeTestSummary(stdout: string): { casesRun?: number; casesPass?: number; casesFail?: number } {
  const num = (key: string): number | undefined => {
    // 一次运行可能有多段摘要（pnpm 会把每个包的输出串起来），全部相加。
    const all = [...stdout.matchAll(new RegExp(`^\\s*\u2139\\s+${key}\\s+(\\d+)\\s*$`, "gm"))].map((m) => Number(m[1]));
    return all.length ? all.reduce((a, b) => a + b, 0) : undefined;
  };
  return { casesRun: num("tests"), casesPass: num("pass"), casesFail: num("fail") };
}

function pct(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(2)) : undefined;
}

function runMember(m: Member, reportRoot: string): MemberResult {
  const base = { name: m.name, dir: m.dir, group: m.group };
  if (OFFLINE && INFRA_DEPENDENT.has(m.name)) {
    return { ...base, status: "skipped", reason: "--offline：该成员的测试需要真实 PG（实测无 PG 时 9 例 fail）" };
  }
  const reportDir = join(reportRoot, m.name.replace(/[@/]/g, "_"));
  const startedAt = Date.now();
  const r = spawnSync(
    join(ROOT, "node_modules/.bin/c8"),
    [
      "--reporter=json-summary",
      "--report-dir", reportDir,
      "--all",
      "--src", `${m.dir}/src`,
      "--include", `${m.dir}/src/**/*.ts`,
      "--exclude", "**/*.test.ts",
      "--exclude", "**/dist/**",
      "corepack", "pnpm", "--filter", m.name, "test",
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  const durationMs = Date.now() - startedAt;
  if (r.status !== 0) {
    // 测试没过就没有可信的覆盖率——**不出数字**，如实记 failed 并把尾部输出留给人看。
    const tail = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-3).join(" / ");
    return { ...base, status: "failed", reason: `测试未通过（退出码 ${r.status}）：${tail.slice(0, 200)}`, durationMs };
  }
  const summaryPath = join(reportDir, "coverage-summary.json");
  if (!existsSync(summaryPath)) {
    return { ...base, status: "failed", reason: "c8 没产出 coverage-summary.json", durationMs };
  }
  const total = (JSON.parse(readFileSync(summaryPath, "utf8")) as { total: Record<string, { pct?: number; total?: number; covered?: number }> }).total;
  return {
    ...base,
    status: "ok",
    ...parseNodeTestSummary(r.stdout ?? ""),
    lines: pct(total.lines?.pct),
    branches: pct(total.branches?.pct),
    functions: pct(total.functions?.pct),
    totalLines: total.lines?.total,
    coveredLines: total.lines?.covered,
    durationMs,
  };
}

/** 组内加权汇总：**按行数加权，不是把百分比取平均**——后者会让一个 20 行的小包和一个 2000 行的包等重。 */
export function groupTotal(results: MemberResult[]): { lines: number | undefined; covered: number; total: number } {
  const ok = results.filter((x) => x.status === "ok");
  const total = ok.reduce((s, x) => s + (x.totalLines ?? 0), 0);
  const covered = ok.reduce((s, x) => s + (x.coveredLines ?? 0), 0);
  return { lines: total === 0 ? undefined : Number(((covered / total) * 100).toFixed(2)), covered, total };
}

export function renderReport(results: MemberResult[], withoutTests: Member[]): string {
  const out: string[] = [];
  out.push(`口径：TS 侧行覆盖（c8，分母为各成员 \`src/\` 全部源文件，含未被任何测试 import 的文件）；Rust 侧不计入。`);
  out.push("");
  for (const group of GROUPS) {
    const list = results.filter((r) => r.group === group);
    if (!list.length) continue;
    out.push(`### ${group}/`);
    out.push("");
    out.push("| 成员 | 行 % | 分支 % | 函数 % | 已覆盖/总行 | 实跑用例 | 状态 |");
    out.push("|---|---|---|---|---|---|---|");
    for (const r of list) {
      const cell = (v?: number): string => (v === undefined ? "—" : `${v}`);
      const stateCell = r.status === "ok" ? "✓" : r.status === "skipped" ? `⏸ ${r.reason ?? ""}` : `✗ ${r.reason ?? ""}`;
      out.push(
        `| \`${r.name}\` | ${cell(r.lines)} | ${cell(r.branches)} | ${cell(r.functions)} | ${r.coveredLines ?? "—"}/${r.totalLines ?? "—"} | ${r.casesRun ?? "—"} | ${stateCell} |`,
      );
    }
    const g = groupTotal(list);
    const ranCases = list.reduce((n, r) => n + (r.casesRun ?? 0), 0);
    out.push(`| **${group}/ 小计** | **${g.lines ?? "—"}** | | | ${g.covered}/${g.total} | ${ranCases} | 按行加权 |`);
    out.push("");
  }
  if (withoutTests.length) {
    out.push(`**没有 \`test\` 脚本的成员（不进覆盖率分母，如实点名）**：`);
    for (const m of withoutTests) out.push(`- \`${m.name}\`（${m.dir}）`);
    out.push("");
  }
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length) {
    out.push(`**测试未通过、因而没有覆盖率数字的成员**：`);
    for (const r of failed) out.push(`- \`${r.name}\`：${r.reason}`);
    out.push("");
  }
  const skipped = results.filter((r) => r.status === "skipped");
  if (skipped.length) {
    out.push(`**本次跳过的成员**：`);
    for (const r of skipped) out.push(`- \`${r.name}\`：${r.reason}`);
    out.push("");
  }
  out.push("> **不出全仓单值**：前端（`clients/` 与 `enterprise/console/`）的组件测试天然少，混进来会把数字打扮得难看或好看，两个方向都是失真。");
  return out.join("\n");
}

function main(): void {
  const { withTests, withoutTests } = listMembers();
  const selected = ONLY ? withTests.filter((m) => m.name === ONLY) : withTests;
  if (!selected.length) {
    console.error(`没有匹配的成员${ONLY ? `：${ONLY}` : ""}`);
    process.exit(2);
  }
  const reportRoot = mkdtempSync(join(tmpdir(), "carlife-cov-"));
  console.log(`覆盖率：${selected.length} 个成员${OFFLINE ? "（--offline）" : ""}；中间产物 ${reportRoot}`);

  const results: MemberResult[] = [];
  for (const m of selected) {
    const r = runMember(m, reportRoot);
    results.push(r);
    const mark = { ok: "✓", failed: "✗", skipped: "⏸" }[r.status];
    console.log(
      `${mark} ${m.name.padEnd(26)} ${r.status === "ok" ? `行 ${r.lines}% / 分支 ${r.branches}% / 函数 ${r.functions}%；实跑 ${r.casesRun ?? "?"} 例（${Math.round((r.durationMs ?? 0) / 1000)}s）` : (r.reason ?? "")}`,
    );
  }

  console.log(`\n${renderReport(results, withoutTests)}`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), offline: OFFLINE, results, withoutTests }, null, 2));
    console.log(`\n产物已写入 ${JSON_OUT}`);
  }
  // 覆盖率**不设阈值门禁**（ACR-009 决策：首次基线没有历史参照，设线是拍脑袋）。
  // 退出码只反映"有没有成员的测试跑挂"——那是真问题，与覆盖率高低无关。
  process.exit(results.some((r) => r.status === "failed") ? 1 : 0);
}

// 直接执行时才跑 main。**必须锚定结尾**：`includes("x")` 会把 `x.test.ts` 也算上，
// 于是单测一 import 就真的去探活、真的打印检查单（实测踩到）。
if (/\/coverage-js\.ts$/.test(process.argv[1] ?? "")) main();
