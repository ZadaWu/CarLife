/**
 * 记忆衰减正确性评测（施工单 M37-03）。
 *
 * **评测 = 测试之上的报告层，不是平行实现**：判定项全部落在三个 node:test
 * 文件里（decay.test.ts 点值 / decay-eval.test.ts 数学性质 / memory-decay.test.ts
 * cron 三道闸），本脚本只是带汇总的一次运行——避免"评测脚本与测试断言各一套、
 * 日后漂移"。输出 markdown 判定表，可直接贴进报告。
 *
 * 零外部依赖：三个文件全部可控时钟 + stub，停掉 PG/Redis 容器照跑。
 * 退出码：任一判定失败为非 0。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { NA, limitationsSection, metricsTable, provenanceSection, runMeta, scoreBlock } from "../lib/report";
import { assertionScore } from "../lib/score";

const args = process.argv.slice(2);
const JSON_OUT = ((): string | undefined => {
  const i = args.indexOf("--json");
  return i >= 0 ? args[i + 1] : undefined;
})();

const FILES = [
  "enterprise/backend/shared/memory/test/decay.test.ts",
  "enterprise/backend/shared/memory/test/decay-eval.test.ts",
  "enterprise/backend/worker/test/memory-decay.test.ts",
];

const r = spawnSync("node", ["--import", "tsx", "--test", ...FILES], {
  encoding: "utf8",
  cwd: new URL("../..", import.meta.url).pathname,
});
const out = `${r.stdout}\n${r.stderr}`;

// spec reporter 的逐项行：`✔ 名称 (Nms)` / `✖ 名称 (Nms)`。
// 套件收尾行与用例行同形，全部保留——分组行读起来就是表的小节。
const rows: Array<{ ok: boolean; name: string; indent: number }> = [];
for (const line of out.split("\n")) {
  const m = line.match(/^(\s*)([✔✖])\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)\s*$/);
  if (m) rows.push({ ok: m[2] === "✔", name: m[3], indent: m[1].length });
}
/** 把 spec 行按组折：组行（indent 0）收下它前面的用例行。 */
function groupRows(list: ReadonlyArray<{ ok: boolean; name: string; indent: number }>): Array<{ name: string; pass: number; total: number }> {
  const out: Array<{ name: string; pass: number; total: number }> = [];
  let pass = 0;
  let total = 0;
  for (const r of list) {
    if (r.indent === 0) {
      out.push({ name: r.name, pass, total });
      pass = 0;
      total = 0;
    } else {
      total += 1;
      if (r.ok) pass += 1;
    }
  }
  if (total > 0) out.push({ name: "（未归组）", pass, total });
  return out;
}

const summary: Record<string, string> = {};
for (const line of out.split("\n")) {
  const m = line.match(/^ℹ (tests|pass|fail|skipped) (\d+)/);
  if (m) summary[m[1]] = m[2];
}

/*
 * 头部走 runMeta 而不是手拼 bullet（M61-03）：元数据表此前有两个真相源，
 * 这份报告因此缺了「档位 / 模型 / 数据集 / 本次选中」四项。
 * 本评测确实没有档位与模型概念——它是三个 node:test 的汇总、零模型调用——
 * 但**缺席要写清是三种里的哪一种**，不能靠不显示来表达。
 */
const totalTests = Number(summary.tests ?? 0);
console.log(
  runMeta({
    name: "记忆衰减正确性评测",
    tier: "静态判定（node:test，零外部依赖，停掉 infra 容器照跑）",
    // 「模型」这一格不能留空：本评测确实不经模型，但**缺席要写清是哪一种**——
    // 是设计使然（本档位不适用），不是「这次没测」，更不是「算不出来」。
    model: `不经模型——判定由断言给出（模型维度${NA}）`,
    total: totalTests,
    selected: totalTests,
    at: new Date().toISOString(),
    command: "corepack pnpm eval:memory-decay",
  }),
);
// 总分 / 满分：紧跟元数据，与 M-M1 同一分母（score.ts）
const score = assertionScore("记忆衰减", Number(summary.pass ?? 0), totalTests);
console.log(scoreBlock([score]));
console.log(`- 覆盖：算法点值（decay.test.ts）· 数学性质（decay-eval.test.ts）· cron 三道闸（memory-decay.test.ts）`);
console.log(`- 口径：评测"实现与设计参数一致 + 安全闸有效"；参数取值依据见架构文档 §7`);
console.log("");
// §14 M-M1：判定通过率（施工单 M59-01——此前本报告零指标编号）
{
  const pass = Number(summary.pass ?? 0);
  const total = Number(summary.tests ?? 0);
  const rate = total === 0 ? "—" : `${((pass / total) * 100).toFixed(0)}%`;
  console.log(
    metricsTable([
      {
        id: "M-M1",
        name: "记忆衰减判定通过率",
        value: rate,
        denom: `${pass}/${total}`,
        note: "判定项 = decay 三个测试文件的用例",
      },
    ]),
  );
}
/*
 * 判定明细按组汇总（M62-07，M61-03 §7 债 1）：spec reporter 的输出是「用例行（缩进）… 组行（indent 0）」，
 * 组行跟在它的用例之后。48 行逐条测试名是测试日志的形状；报告先给「组 × 通过/总数」，
 * 逐条明细折进 <details>——**一行不删**，只是不再逼读者滚过 48 行才到局限性。
 */
console.log("## 判定明细（按组）");
console.log("");
console.log("| 判定组 | 通过 / 总数 |");
console.log("|---|---|");
for (const g of groupRows(rows)) {
  console.log(`| ${g.name.replace(/\|/g, "\\|")} | ${g.pass} / ${g.total}${g.pass === g.total ? "" : "（**有未通过**）"} |`);
}
console.log("");
console.log(`<details><summary>逐条明细（${rows.length} 项，含组行）</summary>`);
console.log("");
console.log("| 判定项 | 结果 |");
console.log("|---|---|");
for (const row of rows) {
  const prefix = "　".repeat(Math.min(3, Math.floor(row.indent / 2)));
  // 不用 ✅/❌：那是进度符号，报告是测评口径不是测试日志（M55-01 红线，M61-03 补齐）。
  console.log(`| ${prefix}${row.name.replace(/\|/g, "\\|")} | ${row.ok ? "通过" : "**未通过**"} |`);
}
console.log("");
console.log("</details>");
console.log("");
console.log(
  `**汇总：${summary.pass ?? "?"} pass / ${summary.fail ?? "?"} fail（共 ${summary.tests ?? "?"} 项）**`,
);
console.log("");
console.log(
  limitationsSection({
    defects: [
      {
        what: "判定的是「实现与 §7 参数表一致」，不是「记忆效果好」",
        impact: `M-M1 ${summary.pass ?? "?"}/${summary.tests ?? "?"} 说明代码照设计跑，**不说明那套半衰期选得对**`,
        next: "参数是否合适要看线上召回质量，本评测给不出；另立评测",
      },
      {
        what: "cron 三道闸跑在可控时钟与 stub 上，不是真实 worker 运行",
        impact: "真实运行里的并发、部分失败重试、时钟漂移不在覆盖内",
        next: "worker 的集成验证走 enterprise/backend/worker 的自身测试与线上巡检",
      },
      {
        what: "只覆盖三个测试文件里登记的路径",
        impact: "衰减的调用方（检索期 re-rank 的实际消费）只测了纯函数，没测端到端",
        next: "端到端属 memory 包的集成测试范围，另单",
      },
    ],
    notApplicable: [
      "**记忆召回的实际质量**——本评测一次真实检索都没发，判的是算法与闸门",
      "**性能与规模**——判定项全部在内存里跑，不反映真实数据量下的表现",
      `**跨模型差异**——本评测不经模型（${NA}）`,
    ],
    uncertainty: [
      {
        what: "判定确定性，重跑结果一致",
        basis: `可控时钟 + stub，零外部依赖（判定项 ${summary.tests ?? "?"} 项）`,
      },
    ],
  }),
);
console.log(
  provenanceSection([
    {
      figure: `M-M1 ${summary.pass ?? "?"}/${summary.tests ?? "?"}`,
      source: "`enterprise/backend/shared/memory/test/decay.test.ts` · `decay-eval.test.ts` · `enterprise/backend/worker/test/memory-decay.test.ts` 的 spec reporter 计数",
    },
    { figure: "半衰期 30 / 365 / 180 天等参数", source: "架构文档 §7 的衰减参数表（测试逐条断言它）" },
    { figure: "本报告全部数字的复跑", source: "`corepack pnpm eval:memory-decay`" },
  ]),
);

// 报告行数与判定项数一致性守护（防 reporter 吞项）：
// spec 输出的 tests 计数是叶子用例数，rows 含套件行所以只能 ≥。
const tests = Number(summary.tests ?? 0);
if (rows.length < tests) {
  console.error(`✗ 报告行数（${rows.length}）少于用例数（${tests}）——reporter 解析吞项了`);
  process.exit(2);
}

// 产物（M67 汇总 / 控制台读分数用）：只有计数，没有逐条——逐条在上面的报告里
if (JSON_OUT) {
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), pass: score.got, fail: Number(summary.fail ?? 0), tests: score.max }, null, 2));
}

process.exit(r.status === 0 && summary.fail === "0" ? 0 : 1);
