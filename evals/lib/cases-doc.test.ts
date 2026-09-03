/**
 * 题库文档与中文标注的守卫（施工单 M56-01）。
 *
 * drift 守卫是重点：CASES.md 是生成物，改了数据集不重跑 `eval:cases-doc` 的话，
 * 文档会安静地讲一套旧题——那份文档存在的意义（让人不读 JSONL 也知道测什么）
 * 就反过来变成误导源。这里重新生成与磁盘逐字节比对，漂了即红。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { generateRiskDoc, generateScenariosDoc } from "./cases-doc";
import { agentLabel, layerLabel } from "./labels";

const ROOT = new URL("../..", import.meta.url).pathname;

describe("agent / 层级中文标注", () => {
  it("表内值带中文括号", () => {
    assert.equal(agentLabel("ownership"), "ownership（用车助手）");
    assert.equal(agentLabel("cabin"), "cabin（座舱陪伴）");
    assert.equal(layerLabel("action_gate"), "action_gate（动作权限门）");
  });
  it("表外值原样返回不报错——路由目标将来会增，评测不该先红在标注上", () => {
    assert.equal(agentLabel("someNewAgent"), "someNewAgent");
    assert.equal(layerLabel("someNewLayer"), "someNewLayer");
  });
});

describe("题库文档 drift 守卫", () => {
  it("evals/scenarios/CASES.md 与数据集同步（重新生成 == 磁盘）", () => {
    assert.equal(
      readFileSync(`${ROOT}evals/scenarios/CASES.md`, "utf8"),
      generateScenariosDoc(),
      "CASES.md 落后于数据集——跑 corepack pnpm eval:cases-doc 重新生成",
    );
  });
  it("evals/risk/CASES.md 与数据集同步", () => {
    assert.equal(
      readFileSync(`${ROOT}evals/risk/CASES.md`, "utf8"),
      generateRiskDoc(),
      "CASES.md 落后于数据集——跑 corepack pnpm eval:cases-doc 重新生成",
    );
  });
  it("文档回答得了「怎么判」：任一题都带判定展开", () => {
    const md = generateScenariosDoc();
    assert.ok(md.includes("**怎么判**："));
    // 抽查一条边界题：路由期望带中文标注
    assert.ok(md.includes("ownership（用车助手）"));
  });
});
