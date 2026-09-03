/**
 * 工具的提示词元数据（施工单 M23-03）。
 *
 * 守三件事：
 * 1. **31 个工具 promptSnippet 全非空**——pi 的规则是不填就不进系统提示词的
 *    `Available tools` 节，漏一个的症状是"模型不知道自己有这个工具"，零报错。
 * 2. **guidelines 每条以 `` `真实工具名` `` 开头**——pi 把 bullets 平铺进
 *    Guidelines 节、无分组前缀，"此工具"三个字模型分不清指谁（pi 文档明确警告）。
 * 3. **describeForPi 原样透传**——registry 写了、pi 收不到，等于没写。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TOOL_REGISTRY, describeForPi, getTool } from "../src/registry";

describe("promptSnippet：31 个工具全必填", () => {
  for (const t of TOOL_REGISTRY) {
    it(`${t.name}`, () => {
      assert.ok(t.promptSnippet.trim().length > 0, `${t.name} 的 promptSnippet 为空——它不会出现在 Available tools 节`);
      assert.ok(t.promptSnippet.length <= 60, `${t.name} 的 snippet 过长（${t.promptSnippet.length} 字）——一行简介，纪律归 guidelines`);
      assert.ok(!t.promptSnippet.includes("\n"), `${t.name} 的 snippet 含换行`);
    });
  }
});

describe("promptGuidelines：每条点名真实工具", () => {
  const KNOWN = new Set(TOOL_REGISTRY.map((t) => t.name));

  it("每条 guideline 以 `<注册表内真实工具名>` 开头", () => {
    for (const t of TOOL_REGISTRY) {
      for (const g of t.promptGuidelines ?? []) {
        const m = g.match(/^`([a-z][a-z0-9_]*)`/);
        assert.ok(m, `${t.name} 的 guideline 不以 \`tool_name\` 开头：${g.slice(0, 40)}`);
        assert.ok(KNOWN.has(m![1]), `${t.name} 的 guideline 点名了不存在的工具 ${m![1]}`);
      }
    }
  });

  it("工单最小集都有纪律（从各 Agent prompt 换家过来的那批）", () => {
    for (const n of [
      "weather", "refuel", "charging", "poi_search", "transit_route",
      "ragflow_retrieve", "insurance_quote", "loan_calc", "cost_calc",
    ]) {
      assert.ok((getTool(n)?.promptGuidelines?.length ?? 0) > 0, `${n} 缺 promptGuidelines`);
    }
  });

  // 换家断言：这些红线原先靠 prompt 文件的正则测试守着（agent-prompt.test.ts），
  // M23-03 搬进 registry 后由这里接手——**内容一条不许消失，只许换家**。
  it("transit_route：禁止编造具体航班号（原 transit.md 红线）", () => {
    assert.match((getTool("transit_route")!.promptGuidelines ?? []).join("\n"), /禁止编造具体航班号/);
  });
  it("poi_search：无价格数据 + 估算标注（原 hotel.md 红线）", () => {
    const g = (getTool("poi_search")!.promptGuidelines ?? []).join("\n");
    assert.match(g, /不含任何价格数据/);
    assert.match(g, /估算/);
  });
  it("weather：预报窗口外不预报（原 drive.md/tour.md 红线）", () => {
    assert.match((getTool("weather")!.promptGuidelines ?? []).join("\n"), /窗口外的日期不要预报/);
  });
  it("refuel：不给剩余可行驶里程（原 drive.md/trip.md 红线）", () => {
    assert.match((getTool("refuel")!.promptGuidelines ?? []).join("\n"), /不给剩余可行驶里程/);
  });
  it("charging：能源类型二选一（原 drive.md/trip.md 红线）", () => {
    assert.match((getTool("charging")!.promptGuidelines ?? []).join("\n"), /能源类型二选一/);
  });
});

describe("describeForPi 透传", () => {
  it("snippet 与 guidelines 原样到达 descriptor", () => {
    const d = describeForPi("drive").find((t) => t.name === "weather")!;
    assert.equal(d.promptSnippet, getTool("weather")!.promptSnippet);
    assert.deepEqual(d.promptGuidelines, getTool("weather")!.promptGuidelines);
  });

  it("无 guidelines 的工具不带该字段（不传 undefined 占位）", () => {
    const d = describeForPi("buying").find((t) => t.name === "car_catalog")!;
    assert.ok(!("promptGuidelines" in d));
    assert.ok(d.promptSnippet.length > 0);
  });
});
