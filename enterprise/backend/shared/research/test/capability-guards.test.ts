/**
 * G2 / G3 / G4 的机械检出点（施工单 M85-02）。
 *
 * # 为什么是源码扫描，不是运行时断言
 *
 * 这三条守的是"能力不得改变既成事实"。运行时断言要先有人写出那条调用、
 * 再有人把它跑到，而能力是一条条加上去的——第十条能力里多一行
 * `level: "candidate"`，既有的单测一条都不会红。扫描则在文件存在的那一刻就红。
 *
 * 形状照 `research-runtime/test/{opportunity,challenge}.test.ts` 里已有的两条源码扫描，
 * 不另发明一套框架。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../../../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * 扫哪几个目录——**加新能力时往这里加目录**。
 *
 * 收的是"能力的实现面"：能力被点一下之后会跑到的代码。
 * 明确**不收**两处，它们是人工决定的落点而不是能力：
 *  - `research-runtime/src/review/`：升级到 candidate 经 `review/:threadId/resume`，那是人点的；
 *  - `research-runtime/src/index.ts`：codebook 的 upsert / lock、售后提醒的 create 都在这里，
 *    它们是启动装配与人工审阅通道，不是模型能触发的路径。
 * 把这两处纳进来只会逼着写一堆例外，而例外多了之后这三条扫描就形同虚设。
 */
const SCAN_DIRS = [
  "enterprise/backend/shared/research/src",
  "enterprise/backend/research-runtime/src/capabilities",
  "enterprise/backend/research-runtime/src/challenge",
  "enterprise/backend/research-runtime/src/stages",
];

interface GuardRule {
  id: "G2" | "G3" | "G4";
  title: string;
  /** 命中即违规。写成"这一行干了什么"，不是"这一行长什么样"。 */
  patterns: Array<{ re: RegExp; why: string }>;
}

const GUARDS: readonly GuardRule[] = [
  {
    id: "G2",
    title: "能力不得升级 level",
    patterns: [
      {
        re: /level\s*:\s*["'`](candidate|validated)["'`]/,
        why: "把 level 写成 candidate / validated：升级只经 review 的人工 resume",
      },
      { re: /\.level\s*=(?!=)/, why: "直接给 level 赋值" },
    ],
  },
  {
    id: "G3",
    title: "能力不得写 codebook（update / lock 之外）",
    patterns: [
      { re: /codebooks?\.(upsert|create|delete|deleteMany|createMany)\s*\(/, why: "改 codebook 的内容" },
      { re: /researchCodebook\.(upsert|create|delete|update)\s*\(/, why: "绕开仓储直接写 codebook 表" },
    ],
  },
  {
    id: "G4",
    title: "能力不得写 roadmap 与车主侧提醒",
    patterns: [
      { re: /vehicleReminder\.(create|update|upsert|delete)\s*\(/, why: "给车主下提醒——那有个体后果" },
      { re: /tripPlan|trip_plans/, why: "写计划文件" },
      { re: /writeFileSync|writeFile\s*\(/, why: "往磁盘写东西（roadmap / docs）" },
    ],
  },
];

/** 一条规则在一段源码上的全部命中，`[]` 即通过。 */
function violations(rule: GuardRule, src: string): string[] {
  const out: string[] = [];
  src.split("\n").forEach((line, i) => {
    // 注释里提到这些词是在解释为什么不许——不算违规。
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const p of rule.patterns) {
      if (p.re.test(line)) out.push(`${i + 1}: ${p.why} → ${line.trim().slice(0, 80)}`);
    }
  });
  return out;
}

function tsFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return []; // 目录还没建出来（后续工单才落）——不是失败。
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(abs);
  return out;
}

describe("[M85-02] G2 / G3 / G4：能力不改变既成事实", () => {
  it("扫描范围至少包含本包与挑战实现，且都真的存在", () => {
    const present = SCAN_DIRS.filter((d) => existsSync(join(ROOT, d)));
    assert.ok(present.includes("enterprise/backend/shared/research/src"));
    assert.ok(present.includes("enterprise/backend/research-runtime/src/challenge"));
  });

  for (const rule of GUARDS) {
    it(`${rule.id}：${rule.title}`, () => {
      const hits: string[] = [];
      for (const dir of SCAN_DIRS) {
        for (const file of tsFiles(dir)) {
          for (const v of violations(rule, readFileSync(file, "utf8"))) {
            hits.push(`${file.slice(ROOT.length + 1)}:${v}`);
          }
        }
      }
      assert.deepEqual(hits, [], `${rule.id} 被违反：\n${hits.join("\n")}`);
    });
  }
});

describe("[M85-02] 扫描自身可信：注入一行违规代码它必须报出来", () => {
  /** 用临时字符串而不是真改文件——改文件的自检会在中途失败时把仓库留在脏状态。 */
  const CASES: Array<{ id: GuardRule["id"]; bad: string; ok: string }> = [
    {
      id: "G2",
      bad: `await repo.insights.upsert({ id, level: "candidate" });`,
      ok: `await repo.insights.upsert({ id, level: "signal" });`,
    },
    {
      id: "G2",
      bad: `insight.level = "validated";`,
      ok: `if (insight.level === "validated") return;`,
    },
    {
      id: "G3",
      bad: `await repo.codebooks.upsert({ version, hash });`,
      ok: `const book = await repo.codebooks.byVersion(version);`,
    },
    {
      id: "G4",
      bad: `await prisma.vehicleReminder.create({ data });`,
      ok: `const rows = await prisma.vehicleReminder.findMany({ where });`,
    },
    {
      id: "G4",
      bad: `writeFileSync(join(root, "roadmap.md"), body);`,
      ok: `const body = readFileSync(join(root, "roadmap.md"), "utf8");`,
    },
  ];

  for (const [i, c] of CASES.entries()) {
    it(`${c.id} 自检 ${i + 1}：违规行报出、对照行放过`, () => {
      const rule = GUARDS.find((g) => g.id === c.id)!;
      assert.equal(violations(rule, c.bad).length, 1, `没报出违规：${c.bad}`);
      assert.deepEqual(violations(rule, c.ok), [], `误伤了合法写法：${c.ok}`);
    });
  }

  it("注释里提到违规写法不算违规——否则没人敢在注释里解释为什么不许", () => {
    const rule = GUARDS.find((g) => g.id === "G2")!;
    assert.deepEqual(violations(rule, `// 不得出现 level: "candidate"，升级只经人工`), []);
  });
});
