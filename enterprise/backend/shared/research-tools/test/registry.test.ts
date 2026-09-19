/**
 * 注册表与 ACL（施工单 M88-02；M89-01 把"四个 / 四条"扩成 Agent × 工具矩阵）。
 *
 * 这一组守的都是"违反了也不报错"的事：
 *   - ACL 多给一个工具 → 那个 Agent 手里多出一件它不该有的东西，没人会发现；
 *   - JSON Schema 顶层不是 object → **持有它的 Agent 整个哑掉**，每次 prompt 回空串；
 *   - `invokeTool` 把入参错误抛出去 → 模型看到的是"工具坏了"，于是换个说法再试一遍。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RESEARCH_AGENT_NAMES,
  describeForPi,
  getTool,
  invokeTool,
  listAll,
  listForAgent,
  type ResearchAgentName,
} from "../src/index";
import { stubDeps } from "./fake-deps";

/**
 * **Agent × 工具矩阵，逐字对设计稿 §4 的表格**（M89-01 把原先的"四个 / 四条"扩成它）。
 *
 * 顺序也是钉的：它就是 `describeForPi` 的顺序，也是提示词里 `Available tools`
 * 节的顺序。新增工具或改 ACL 必须回来改这里——"悄悄多给一个工具出去"没有任何现象，
 * 而多出来的那一个正是模型会去调的。
 */
const MATRIX: Record<ResearchAgentName, string[]> = {
  analyst: ["lensQuery", "themeMembers", "evidenceByCode", "codebookLookup"],
  challenger: ["findCounterEvidence", "listSystemEvents", "sliceBySegment", "thresholdSensitivity"],
  taxonomist: ["codebookLookup", "themeMembers", "agreementReport"],
  archivist: ["evidenceByCode", "evidenceById", "sourcePassport"],
};

/** 全表 11 个：四个挑战 + 五个分析/码表 + 两个档案（三个工具挂在两个 Agent 名下）。 */
const ALL_TOOLS = [...new Set(Object.values(MATRIX).flat())];

const deps = () =>
  stubDeps({
    themeMembers: async () => ({ memberUnitIds: ["m1"], counterUnitIds: ["c1"] }),
  });

describe("[M89-01] ACL：listForAgent 是唯一读法", () => {
  for (const agent of RESEARCH_AGENT_NAMES) {
    it(`${agent} 恰好拿到设计稿 §4 给它的那几个工具`, () => {
      assert.deepEqual(listForAgent(agent).map((t) => t.name).sort(), [...MATRIX[agent]].sort());
    });
  }

  it("四个 Agent 名，与设计稿 §4 的四行一一对应", () => {
    assert.deepEqual([...RESEARCH_AGENT_NAMES].sort(), Object.keys(MATRIX).sort());
  });

  it("全表 11 个，无重名——工具表里也没有谁都拿不到的孤儿", () => {
    assert.equal(ALL_TOOLS.length, 11);
    assert.deepEqual(listAll().map((t) => t.name).sort(), [...ALL_TOOLS].sort());
    assert.equal(new Set(listAll().map((t) => t.name)).size, 11, "有重名工具——按名反查会取到先注册的那个");
    for (const t of listAll()) {
      assert.ok(t.agents.length > 0, `${t.name} 的 agents 为空——它永远不会被任何 Agent 看到`);
    }
  });

  it("getTool 按名取得到，取不到时回 undefined 不抛", () => {
    for (const n of ALL_TOOLS) assert.equal(getTool(n)?.name, n);
    assert.equal(getTool("dropTable"), undefined);
  });
});

describe("[M89-01] describeForPi：pi 收到的形状", () => {
  /** 四个 Agent 的描述拼起来去重——同一个工具挂两个 Agent 时只形状检查一次。 */
  const descriptors = [
    ...new Map(
      RESEARCH_AGENT_NAMES.flatMap((a) => describeForPi(a)).map((d) => [d.name, d]),
    ).values(),
  ];

  for (const agent of RESEARCH_AGENT_NAMES) {
    it(`${agent} 的描述顺序与注册表一致`, () => {
      assert.deepEqual(
        describeForPi(agent).map((d) => d.name),
        listForAgent(agent).map((t) => t.name),
      );
    });
  }

  for (const d of descriptors) {
    it(`${d.name}：顶层 type === "object" 且 sensitive === false`, () => {
      // 顶层不是 object 的话，持有它的 Agent 每次 prompt 都回空串且零报错。
      assert.equal(d.parameters.type, "object", `${d.name} 的入参顶层不是 object`);
      // 研究工具全只读、不接权限门：true 会被静默忽略，看起来像加了一道门。
      assert.equal(d.sensitive, false);
      assert.ok(d.description.includes("只读"), `${d.name} 的描述没声明只读`);
      assert.ok(d.promptSnippet.trim().length > 0, `${d.name} 的 promptSnippet 为空——它不会进 Available tools 节`);
      assert.ok(!d.promptSnippet.includes("\n"), `${d.name} 的 promptSnippet 含换行`);
    });
  }

  it("每条 guideline 以 `<真实工具名>` 开头", () => {
    // pi 把 bullets 平铺进 Guidelines 节、没有分组前缀，"此工具"三个字模型分不清指谁。
    const known = new Set(listAll().map((t) => t.name));
    for (const t of listAll()) {
      assert.ok((t.promptGuidelines?.length ?? 0) > 0, `${t.name} 缺 promptGuidelines`);
      for (const g of t.promptGuidelines ?? []) {
        const m = g.match(/^`([A-Za-z][A-Za-z0-9_]*)`/);
        assert.ok(m, `${t.name} 的 guideline 不以 \`工具名\` 开头：${g.slice(0, 40)}`);
        assert.ok(known.has(m![1]), `${t.name} 的 guideline 点名了不存在的工具 ${m![1]}`);
      }
    }
  });
});

describe("[M88-02] invokeTool：入参不合法是返回值，不是异常", () => {
  it("参数不合法 → { ok: false }，不抛", async () => {
    const out = await invokeTool("findCounterEvidence", { themeId: 1 }, deps());
    assert.equal(out.ok, false);
    assert.match(out.ok === false ? out.error : "", /findCounterEvidence/);
  });

  it("超出上界 → { ok: false }", async () => {
    const out = await invokeTool("findCounterEvidence", { themeId: "t", limit: 21 }, deps());
    assert.equal(out.ok, false);
  });

  it("工具名不存在 → { ok: false }，不抛", async () => {
    const out = await invokeTool("dropTable", {}, deps());
    assert.equal(out.ok, false);
    assert.match(out.ok === false ? out.error : "", /未注册/);
  });

  it("合法入参 → { ok: true, data }", async () => {
    const out = await invokeTool("findCounterEvidence", { themeId: "t1", limit: 5 }, deps());
    assert.equal(out.ok, true);
    assert.deepEqual(out.ok === true ? out.data : null, {
      count: 1,
      units: [{ unitId: "c1", text: "反例 c1" }],
    });
  });

  it("**可选字段填 null 当作没填**——发出去的 schema 允许它，这一侧就得收下", async () => {
    // describeForPi 把非必填属性放宽成「原类型 或 null」，只放宽一边的话
    // pi 放行、我们自己的 safeParse 拒，报错点只是从上游挪到了下游。
    const d = describeForPi("challenger").find((x) => x.name === "findCounterEvidence")!;
    const limit = (d.parameters.properties as Record<string, { anyOf?: unknown[] }>).limit;
    assert.ok(JSON.stringify(limit?.anyOf ?? []).includes('"null"'), "limit 没被放宽成可为 null");

    const out = await invokeTool("findCounterEvidence", { themeId: "t1", limit: null }, deps());
    assert.equal(out.ok, true, "填了 null 的可选字段被拒了——两边只改了一边");
  });
});
