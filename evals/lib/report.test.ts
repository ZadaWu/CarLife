/**
 * 测评报告渲染的守卫（施工单 M55-01）。
 *
 * 最要紧的一条在最后：报告正文不得出现 ✅/❌——「报告是测评口径不是测试日志」
 * 是用户定的性，措辞守不住就会在下一次改 runner 时静默回潮，所以交给机器盯。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import {
  NA,
  NOT_RUN,
  UNCOMPUTABLE,
  failureSection,
  latencyPercentiles,
  limitationsSection,
  metricsTable,
  provenanceSection,
  replayCommand,
  runMeta,
  scoreBlock,
} from "./report";

const BASE = {
  name: "核心场景评估（eval:scenarios）",
  tier: "fake（确定性）",
  model: "fake",
  total: 86,
  at: "2026-08-31T00:00:00.000Z",
  command: "corepack pnpm eval:scenarios",
};

describe("runMeta：运行元数据头", () => {
  it("全量运行（n=N）：不出现抽样声明，选中列标「全量」", () => {
    const md = runMeta({ ...BASE, selected: 86 });
    assert.ok(!md.includes("抽样运行"), "全量不该有抽样横幅");
    assert.ok(md.includes("86 条（全量）"));
  });

  it("抽样运行（n<N）：显眼的范围声明 + n/N 两处呈现", () => {
    const md = runMeta({ ...BASE, selected: 5 });
    assert.ok(md.includes("抽样运行（5/86）"), "头部横幅必须点名 n/N");
    assert.ok(md.includes("5 条（抽样 5/86）"));
    // 声明必须讲清适用范围，不是只贴个标签
    assert.ok(md.includes("只覆盖本次选中的条目"));
  });

  it("六要素齐全：档位/模型/数据集/选中/时间/复跑", () => {
    const md = runMeta({ ...BASE, selected: 86 });
    for (const key of ["档位", "模型", "数据集", "本次选中", "运行时间", "复跑"]) {
      assert.ok(md.includes(`| ${key} |`), `缺 ${key}`);
    }
  });
});

describe("failureSection：失败 case 明细", () => {
  it("逐条含 id、归属、原话与原因", () => {
    const md = failureSection([
      { id: "o-30", group: "ownership / sub:seasonal", input: "冬天出发前想先暖车", reasons: ["route：期望 ownership，实际 itinerary"] },
    ]);
    assert.ok(md.includes("`o-30`"));
    assert.ok(md.includes("ownership / sub:seasonal"));
    assert.ok(md.includes("「冬天出发前想先暖车」"));
    assert.ok(md.includes("- route：期望 ownership，实际 itinerary"));
  });

  it("无失败输出明确陈述，不是空白", () => {
    assert.ok(failureSection([]).includes("本次运行无失败 case"));
  });
});

describe("replayCommand：复跑命令忠实还原", () => {
  it("含全部过滤参数原文", () => {
    assert.equal(
      replayCommand("eval:risk", ["--real", "--id", "r-27,r-164", "--dump"]),
      "corepack pnpm eval:risk -- --real --id r-27,r-164 --dump",
    );
  });
  it("无参数时不带 --", () => {
    assert.equal(replayCommand("eval:scenarios", []), "corepack pnpm eval:scenarios");
  });
  it("argv 里混进的裸 -- 被滤掉——复跑命令的价值全在能逐字复制（M61-02）", () => {
    assert.equal(
      replayCommand("eval:scenarios", ["--", "--resume", "--json", "out.json"]),
      "corepack pnpm eval:scenarios -- --resume --json out.json",
    );
  });
});

describe("机器守卫：报告不是测试日志", () => {
  it("**全部导出**拼成的串不含 ✅/❌ 进度行符号", () => {
    // 断言输入从「runMeta + failureSection」扩到全部导出（M61-01）：
    // 此前只覆盖两个函数，新加的渲染函数天然在守卫之外——守卫在，红线却守不住。
    const md = [
      runMeta({ ...BASE, selected: 5 }),
      metricsTable([{ id: "M-P1", name: "场景通过率", value: "79%", denom: "72/(72+19)" }]),
      failureSection([{ id: "r-70", group: "hard-block", input: "帮我把车门打开", reasons: ["一层都没拦住"] }]),
      limitationsSection(SAMPLE_LIMITS),
      provenanceSection([{ figure: "M-P1 79%", source: "`evals/runs/scenario-real.json` 的 `outcomes`" }]),
      scoreBlock([{ name: "核心场景 · real 档", got: 85, max: 91 }], { total: true }),
    ].join("\n");
    assert.ok(!md.includes("✅") && !md.includes("❌"), "报告正文出现了进度行符号——测评口径被测试日志污染");
  });
});

const SAMPLE_LIMITS = {
  defects: [{ what: "s-45 编造了行程上下文", impact: "澄清能力被高估", next: "M62 修子图" }],
  notApplicable: ["不能回答跨运行稳定性——本档只跑了 1 轮"],
  uncertainty: [{ what: "裁判判定跨运行方差未量化", basis: "n=12 条裁判参与" }],
};

describe("limitationsSection（M61-01）：必填节，不给「无」这个出口", () => {
  it("三部分齐全，缺陷行含是什么/影响/去向", () => {
    const md = limitationsSection(SAMPLE_LIMITS);
    assert.ok(md.includes("## 局限性与不适用场景"));
    assert.ok(md.includes("**已知缺陷**") && md.includes("**这批数字不适用于回答**") && md.includes("**不确定性**"));
    assert.ok(md.includes("s-45 编造了行程上下文") && md.includes("澄清能力被高估") && md.includes("M62 修子图"));
    assert.ok(md.includes("（依据：n=12 条裁判参与）"), "不确定性必须带依据——没有依据的是猜测，不是限制");
  });

  it("已知缺陷为空则抛错，错误信息问出「专家会批评什么」", () => {
    assert.throws(
      () => limitationsSection({ ...SAMPLE_LIMITS, defects: [] }),
      (e: Error) => e.message.includes("专家"),
    );
  });

  it("不适用场景为空同样抛错——空着等于声称数字放之四海而皆准", () => {
    assert.throws(
      () => limitationsSection({ ...SAMPLE_LIMITS, notApplicable: [] }),
      (e: Error) => e.message.includes("专家"),
    );
  });

  it("不确定性可以为空，但输出一句明确陈述而不是空白", () => {
    const md = limitationsSection({ ...SAMPLE_LIMITS, uncertainty: [] });
    assert.ok(md.includes("本轮未量化跨运行方差"));
  });
});

describe("provenanceSection（M61-01）：数字出处", () => {
  it("渲染「数字 | 出处」两列", () => {
    const md = provenanceSection([{ figure: "M-R1 99%（97/98）", source: "`evals/runs/risk-full.json` 的 `outcomes`" }]);
    assert.ok(md.includes("## 数字出处") && md.includes("| 数字 | 出处 |"));
    assert.ok(md.includes("M-R1 99%（97/98）") && md.includes("risk-full.json"));
  });

  it("空数组给明确陈述，不是空表", () => {
    assert.ok(provenanceSection([]).includes("未引用需要外部核对的数字"));
  });
});

describe("scoreBlock（2026-09-03）：总分 / 满分一眼可读", () => {
  it("每行 总分 / 满分 + 得分率；备注缺省为 —", () => {
    const md = scoreBlock([{ name: "核心场景 · real 档", got: 85, max: 91 }]);
    assert.ok(md.includes("## 总分"));
    assert.ok(md.includes("| 核心场景 · real 档 | **85 / 91** | 93% | — |"));
  });
  it("total: true 追加合计行——分子分母各自相加，不是比率平均", () => {
    const md = scoreBlock([{ name: "a", got: 1, max: 2 }, { name: "b", got: 9, max: 10 }], { total: true });
    assert.ok(md.includes("| **合计** | **10 / 12** | 83% |"), md);
  });
  it("满分 0（未跑 / 本档判不了）写 — 而不是 0 / 0 与 NaN", () => {
    const md = scoreBlock([{ name: "x", got: 0, max: 0, note: "未跑" }]);
    assert.ok(md.includes("| x | — | — | 未跑 |"));
    assert.ok(!md.includes("NaN"));
  });
});

describe("latencyPercentiles（§14 M-L1）", () => {
  it("n<10 退化为 null——抽样运行逐条列，不报分位", () => {
    assert.equal(latencyPercentiles([1, 2, 3]), null);
  });
  it("n≥10 报最近秩 P50/P95", () => {
    const xs = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    const r = latencyPercentiles(xs)!;
    assert.equal(r.p50, 1000);
    assert.equal(r.p95, 1900);
  });
});

describe("metricsTable（M59-01）：报告与流水账的分界线", () => {
  it("渲染指标编号、名称、取值与分母四列", () => {
    const md = metricsTable([{ id: "M-P1", name: "场景通过率", value: "79%", denom: "72/(72+19)" }]);
    assert.ok(md.includes("## 指标结果"));
    assert.ok(md.includes("`M-P1`") && md.includes("**79%**") && md.includes("72/(72+19)"));
  });

  it("三种缺席各自成句，不合并成「—」——含义不同：无需行动 / 去跑一次 / 重跑并查产物来源", () => {
    const md = metricsTable([
      { id: "M-R4", name: "硬禁稳定拦截率", value: NA },
      { id: "M-R4", name: "pass^k", value: NOT_RUN },
      { id: "M-J1", name: "裁判一致率", value: UNCOMPUTABLE },
    ]);
    assert.ok(md.includes("本档位不适用") && md.includes("未跑") && md.includes("无法计算"));
    assert.notEqual(NA, NOT_RUN);
    assert.notEqual(NOT_RUN, UNCOMPUTABLE);
  });

  it("指标表不含进度符号（M55-01 红线不因新增总表而回潮）", () => {
    const md = metricsTable([{ id: "M-S1", name: "端侧白名单", value: "通过" }]);
    assert.ok(!md.includes("✅") && !md.includes("❌"));
  });
});


/*
 * 真实报告文件的守卫（M62-07，M61-03 §7 债 2）：上面那条只守 report.ts 的导出，
 * runner 用 console.log / w() 直接拼的表绕得过去——memory-decay 的 48 行与 ownership-service 的覆盖表
 * 就是这么进来的。六份报告提交在仓库里，直接读文件断言；与纯函数守卫分开成两个 describe。
 */
describe("机器守卫：仓库里的真实报告零进度符号", () => {
  const dir = new URL("../runs/reports/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  it("目录里至少有六份报告（少了说明产物被误删）", () => {
    assert.ok(files.length >= 6, `只有 ${files.length} 份：${files.join(", ")}`);
  });
  for (const f of files) {
    it(`${f} 不含 ✅/❌`, () => {
      const md = readFileSync(new URL(f, dir), "utf8");
      const n = (md.match(/[✅❌]/g) ?? []).length;
      assert.equal(n, 0, `${f} 里有 ${n} 处进度符号——报告是测评口径不是测试日志`);
    });
  }
});
