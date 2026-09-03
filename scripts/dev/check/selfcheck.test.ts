/**
 * 部署自检单测（施工单 M9-04）。零依赖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatReport, isSelfcheckArtifact, runSelfcheck, type CheckDef } from "./selfcheck";

const check = (layer: CheckDef["layer"], name: string, ok: boolean): CheckDef => ({
  layer,
  name,
  remedy: `修 ${name}`,
  async run() {
    return { ok };
  },
});

describe("分层执行", () => {
  it("全通过时逐层执行", async () => {
    const r = await runSelfcheck([check("L0", "进程", true), check("L1", "PG", true), check("L3", "端到端", true)]);
    assert.deepEqual(r.map((x) => x.status), ["pass", "pass", "pass"]);
  });

  it("**前一层失败则后续层跳过**——派生失败会掩盖真正的原因", async () => {
    const r = await runSelfcheck([
      check("L0", "进程", true),
      check("L1", "PG", false),
      check("L2", "RAGFlow", true),
      check("L3", "端到端", true),
    ]);
    assert.equal(r.find((x) => x.name === "PG")?.status, "fail");
    assert.equal(r.find((x) => x.name === "RAGFlow")?.status, "skipped");
    assert.equal(r.find((x) => x.name === "端到端")?.status, "skipped");
  });

  it("同层内其余检查仍会跑完——一层内的问题要一次看全", async () => {
    const r = await runSelfcheck([check("L1", "PG", false), check("L1", "Redis", true)]);
    assert.equal(r.find((x) => x.name === "Redis")?.status, "pass");
  });

  it("检查抛错等同失败，且错误信息进 detail", async () => {
    const r = await runSelfcheck([
      { layer: "L1", name: "炸了", remedy: "看日志", async run(): Promise<never> { throw new Error("ECONNREFUSED"); } },
    ]);
    assert.equal(r[0].status, "fail");
    assert.match(r[0].detail ?? "", /ECONNREFUSED/);
  });
});

describe("报告", () => {
  it("**失败项带修复指引**——「检查配置」这种话等于没说", async () => {
    const r = await runSelfcheck([check("L1", "PG", false)]);
    const text = formatReport(r);
    assert.match(text, /修复：修 PG/);
  });

  it("通过项不带修复指引，避免噪声", async () => {
    const text = formatReport(await runSelfcheck([check("L0", "进程", true)]));
    assert.ok(!text.includes("修复："));
  });

  it("统计行区分失败与跳过", async () => {
    const text = formatReport(await runSelfcheck([check("L1", "PG", false), check("L3", "e2e", true)]));
    assert.match(text, /1 失败/);
    assert.match(text, /1 跳过/);
  });
});

describe("非必需项：显示但不阻断", () => {
  it("非必需项失败不让后续层跳过——否则对象存储没接线就把端到端整段藏起来了", async () => {
    const r = await runSelfcheck([
      { ...check("L2", "对象存储", false), required: false },
      check("L3", "端到端", true),
    ]);
    assert.equal(r.find((x) => x.name === "对象存储")?.status, "fail");
    assert.equal(r.find((x) => x.name === "端到端")?.status, "pass");
  });

  it("**仍然计入失败**——不降级成警告，不隐藏", async () => {
    const r = await runSelfcheck([{ ...check("L2", "对象存储", false), required: false }]);
    assert.match(formatReport(r), /1 失败/);
  });

  it("必需项失败照旧阻断", async () => {
    const r = await runSelfcheck([check("L2", "LLM", false), check("L3", "端到端", true)]);
    assert.equal(r.find((x) => x.name === "端到端")?.status, "skipped");
  });

  it("非必需项抛错同样不阻断", async () => {
    const r = await runSelfcheck([
      { layer: "L2", name: "可选", remedy: "x", required: false, async run(): Promise<never> { throw new Error("boom"); } },
      check("L3", "端到端", true),
    ]);
    assert.equal(r.find((x) => x.name === "端到端")?.status, "pass");
  });
});

describe("零检查项不是「全部通过」", () => {
  it("空清单产出空结果——入口据此退出码 2，不能报成功", async () => {
    // 走查时 `pnpm selfcheck` 就是这个状态：零输出、exit=0。
    // 一个什么都不查却报成功的自检比没有自检更糟——后者至少不会让人放心。
    const r = await runSelfcheck([]);
    assert.equal(r.length, 0);
    assert.doesNotMatch(formatReport(r), /通过 \/ 1/);
  });
});

describe("自检数据隔离（F-43-10）", () => {
  it("自检产物可被识别——否则演示时会看到一堆自检会话", () => {
    assert.equal(isSelfcheckArtifact("selfcheck-sess-1"), true);
    assert.equal(isSelfcheckArtifact("sess-real-1"), false);
  });
});
