/**
 * 工具层单测（施工单 M4-03 任务 6）。
 *
 * **本文件的存在本身就是一条验收**：它不起任何服务、不连数据库、不调 LLM、不打外部 API
 * （AC-34-4「工具可脱离 Agent 与 LLM 单测」）。跑它只需要 Node。
 *
 * 用 `node:test`（Node 内置）而不是引入测试框架——脚手架期不为一层断言拉一套依赖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calcCost } from "../src/cost-calc";
import { defineExternalTool, ToolError, type ToolCallContext } from "../src/external";
import { listExposableForMcp, listForAgent, TOOL_REGISTRY, invokeTool } from "../src/registry";
import { ragflowTool, setRagClient } from "../src/ragflow";

const ctx = (mode?: ToolCallContext["mode"]): ToolCallContext => ({
  sessionId: "sess-test",
  turnId: "turn-1",
  agent: "supervisor",
  mode,
});

describe("cost_calc —— 纯规则，零依赖", () => {
  it("分项相加等于总计，且残值计为负成本", () => {
    const r = calcCost({ vehiclePrice: 200_000, energy: "bev" });
    const sum =
      r.items.vehiclePrice + r.items.energy + r.items.insurance + r.items.maintenance + r.items.residualValue;
    assert.ok(Math.abs(sum - r.total) < 1, `分项和 ${sum} 应等于总计 ${r.total}`);
    assert.ok(r.items.residualValue < 0, "残值是回收的钱，应为负");
  });

  it("保险按逐年车值计，不是车价×费率×年数", () => {
    const r = calcCost({ vehiclePrice: 200_000, energy: "bev", years: 5 });
    const naive = 200_000 * r.assumptions.insuranceRate * 5;
    assert.ok(r.items.insurance < naive, `逐年折算应低于朴素算法（${r.items.insurance} < ${naive}）`);
  });

  it("返回**全部**假设——包括用户没给、系统补的（F-15-05）", () => {
    const r = calcCost({ vehiclePrice: 150_000, energy: "icev", assumptions: { annualKm: 40_000 } });
    assert.equal(r.assumptions.annualKm, 40_000, "用户给的假设应生效");
    assert.ok(r.assumptions.fuelPricePerLiter > 0, "未给的假设也必须出现在结果里");
    assert.ok(r.notes.length > 0, "每个数字怎么来的要能被质疑");
  });

  it("改假设能重算：年里程翻倍则能耗成本翻倍", () => {
    const base = calcCost({ vehiclePrice: 200_000, energy: "bev", assumptions: { annualKm: 10_000 } });
    const doubled = calcCost({ vehiclePrice: 200_000, energy: "bev", assumptions: { annualKm: 20_000 } });
    assert.ok(Math.abs(doubled.items.energy - base.items.energy * 2) < 1);
  });

  it("非法入参明确失败，不返回一个看起来正常的数", () => {
    assert.throws(() => calcCost({ vehiclePrice: 0, energy: "bev" }));
    assert.throws(() => calcCost({ vehiclePrice: 100, energy: "bev", years: 0 }));
  });
});

describe("四件套包装器", () => {
  it("超时按时触发并分类为 timeout（可重试）", async () => {
    const slow = defineExternalTool<void, string>({
      name: "slow",
      provider: "test",
      timeoutMs: 50,
      retries: 0,
      real: () => new Promise((r) => setTimeout(() => r("late"), 500)),
    });
    await assert.rejects(
      () => slow.call(undefined as never, ctx()),
      (e: unknown) => e instanceof ToolError && e.category === "timeout",
    );
  });

  it("可重试错误会重试，不可重试的立即放弃", async () => {
    let calls = 0;
    const flaky = defineExternalTool<void, string>({
      name: "flaky",
      provider: "test",
      timeoutMs: 500,
      retries: 2,
      real: async () => {
        calls += 1;
        if (calls < 3) throw new ToolError("flaky", "upstream", "503", true);
        return "ok";
      },
    });
    const r = await flaky.call(undefined as never, ctx());
    assert.equal(r.data, "ok");
    assert.equal(calls, 3, "应重试到第 3 次成功");

    let hardCalls = 0;
    const hard = defineExternalTool<void, string>({
      name: "hard",
      provider: "test",
      retries: 3,
      real: async () => {
        hardCalls += 1;
        throw new ToolError("hard", "invalid", "参数错", false);
      },
    });
    await assert.rejects(() => hard.call(undefined as never, ctx()));
    assert.equal(hardCalls, 1, "不可重试的错误不应重试");
  });

  it("有副作用的工具默认不重试（重试一次预约就是下两次单）", async () => {
    let calls = 0;
    const sensitive = defineExternalTool<void, string>({
      name: "book",
      provider: "test",
      sensitive: true,
      real: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    await assert.rejects(() => sensitive.call(undefined as never, ctx()));
    assert.equal(calls, 1);
  });

  it("Mock 三态：real/mock/off 各自的语义", async () => {
    const t = defineExternalTool<void, string>({
      name: "tri",
      provider: "test",
      real: async () => "real-data",
      mock: () => "mock-data",
    });

    const real = await t.call(undefined as never, ctx("real"));
    assert.equal(real.data, "real-data");
    assert.equal(real.source.kind, "real");

    const mock = await t.call(undefined as never, ctx("mock"));
    assert.equal(mock.data, "mock-data");
    assert.equal(mock.source.kind, "mock", "mock 结果必须被标注为模拟");

    // off 不是"静默返回空"，是明确的未接入
    await assert.rejects(
      () => t.call(undefined as never, ctx("off")),
      (e: unknown) => e instanceof ToolError && e.category === "unconfigured",
    );
  });

  it("没有 mock 数据的工具不能以 mock 模式运行", async () => {
    const t = defineExternalTool<void, string>({ name: "nomock", provider: "test", real: async () => "x" });
    assert.equal(t.supportsMock, false);
    await assert.rejects(() => t.call(undefined as never, ctx("mock")));
  });

  it("来源标注三个字段齐全（罗启明问「这数是真的还是编的」的唯一答案来源）", async () => {
    const t = defineExternalTool<void, string>({ name: "src", provider: "acme", real: async () => "x" });
    const r = await t.call(undefined as never, ctx());
    assert.equal(r.source.provider, "acme");
    assert.ok(Date.parse(r.source.fetchedAt) > 0);
  });
});

describe("注册表", () => {
  it("按 Agent 裁剪工具表，不是全给（§4.3 能力映射）", () => {
    const trip = listForAgent("trip").map((t) => t.name);
    const buying = listForAgent("buying").map((t) => t.name);
    assert.ok(trip.includes("weather"));
    assert.ok(!trip.includes("cost_calc"), "出行规划不需要购车成本测算");
    assert.ok(buying.includes("cost_calc"));
  });

  it("MCP 暴露面排除敏感与私有数据工具（F-34-09 规则写死在代码里）", () => {
    const exposable = listExposableForMcp();
    assert.ok(exposable.every((t) => !t.sensitive), "敏感工具不得对外暴露");
    for (const forbidden of ["vehicle_profile", "usage_profile", "memory", "appointment"]) {
      assert.ok(!exposable.some((t) => t.name === forbidden), `${forbidden} 不得出现在 MCP 暴露面`);
    }
  });

  it("敏感工具一律不进 MCP 暴露面", () => {
    const sensitive = TOOL_REGISTRY.filter((t) => t.sensitive);
    assert.ok(sensitive.length > 0, "注册表应含敏感工具");
    assert.ok(
      sensitive.every((t) => !t.mcpExposable),
      "敏感工具不得对外暴露——有副作用的能力不能给第三方（F-34-09）",
    );
  });

  it("统一执行入口做入参校验，非法入参不落到工具实现里", async () => {
    await assert.rejects(() => invokeTool("weather", { points: [] }, ctx("mock")));
    await assert.rejects(() => invokeTool("不存在的工具", {}, ctx("mock")));
  });

  it("mock 模式下 weather 走得通且被标注为模拟", async () => {
    const r = (await invokeTool(
      "weather",
      { points: [{ name: "黄山", lat: 30.13, lon: 118.16 }] },
      ctx("mock"),
    )) as { source: { kind: string }; data: unknown[] };
    assert.equal(r.source.kind, "mock");
    assert.equal(r.data.length, 1);
  });
});

describe("ragflow_retrieve 不在工具层给检索参数默认值", () => {
  it("**不传 topK 时原样传 undefined**——写死会把调参结论悄悄盖掉", async () => {
    // 这条护栏是补的：`enterprise/backend/shared/rag` 的调参把 DEFAULT_PAGE_SIZE 定为 8，
    // 而这里曾写着 `args.topK ?? 5`，于是那次调参在生产上**完全没落地**，
    // 且没有任何症状——检索照常返回，只是条数不是定下的那个。
    let seen: { topK?: number } | undefined;
    setRagClient({
      async retrieve(a) {
        seen = { topK: a.topK };
        return [{ content: "x", source: { document: "d", dataset: "vehicle-manuals" }, provenance: "public", score: 1 }];
      },
    });
    await ragflowTool.call({ query: "q" }, { sessionId: "s", agent: "ownership", mode: "real" });
    assert.equal(seen?.topK, undefined, "工具层不该替检索侧决定返回条数");
  });

  it("调用方显式指定时照传", async () => {
    let seen: number | undefined;
    setRagClient({
      async retrieve(a) {
        seen = a.topK;
        return [{ content: "x", source: { document: "d", dataset: "vehicle-manuals" }, provenance: "public", score: 1 }];
      },
    });
    await ragflowTool.call({ query: "q", topK: 3 }, { sessionId: "s", agent: "ownership", mode: "real" });
    assert.equal(seen, 3);
  });
});

describe("ragflow_retrieve 缺省查该 Agent 允许的全部集（ACR-042 / M101-02）", () => {
  /** 录下工具实际要 client 查了哪几个集——缺省范围只有在这里才看得见。 */
  const recording = () => {
    const seen: { datasets?: readonly string[] } = {};
    setRagClient({
      async retrieve(a) {
        seen.datasets = a.datasets ?? (a.dataset ? [a.dataset] : []);
        return [
          { content: "条款原文", source: { document: "示范条款.md", dataset: "insurance-kb" }, provenance: "public", score: 0.9 },
        ];
      },
    });
    return seen;
  };

  it("**售后缺省同查维修手册与车险条款**——M96 之前它只查得到前者", async () => {
    // 这条是这次改动的全部意义：数据集接上了、文档解析完了、隔离也对，
    // 但缺省取 `allowed[0]`，于是没有任何应答路径查得到 insurance-kb。
    const seen = recording();
    await ragflowTool.call({ query: "出险要什么材料" }, { sessionId: "s", agent: "service", mode: "real" });
    assert.deepEqual(seen.datasets, ["repair-kb", "insurance-kb"]);
  });

  it("购车缺省同查车型参数与车险条款——投保前看条款是购车的事", async () => {
    const seen = recording();
    await ragflowTool.call({ query: "这款车投保要多少" }, { sessionId: "s", agent: "buying", mode: "real" });
    assert.deepEqual(seen.datasets, ["car-catalog", "insurance-kb"]);
  });

  it("用车助手只有一个集，行为与改动前完全相同", async () => {
    const seen = recording();
    await ragflowTool.call({ query: "冬天续航" }, { sessionId: "s", agent: "ownership", mode: "real" });
    assert.deepEqual(seen.datasets, ["vehicle-manuals"]);
  });

  it("显式指定集时收窄到它一个", async () => {
    const seen = recording();
    await ragflowTool.call(
      { query: "报案时限", dataset: "insurance-kb" },
      { sessionId: "s", agent: "service", mode: "real" },
    );
    assert.deepEqual(seen.datasets, ["insurance-kb"]);
  });

  it("**越权入参被忽略并退回缺省，不报错**——报错等于给模型一次换说法再试的机会", async () => {
    const seen = recording();
    await ragflowTool.call(
      { query: "冬天续航", dataset: "vehicle-manuals" },
      { sessionId: "s", agent: "service", mode: "real" },
    );
    assert.deepEqual(seen.datasets, ["repair-kb", "insurance-kb"]);
  });

  it("出参给的是集**列表**与逐条带标注的 chunk，没有调用级来源标签", async () => {
    recording();
    const r = await ragflowTool.call({ query: "q" }, { sessionId: "s", agent: "service", mode: "real" });
    assert.deepEqual(r.data.datasets, ["repair-kb", "insurance-kb"]);
    assert.equal(r.data.chunks[0]!.source.dataset, "insurance-kb");
    assert.equal(r.data.chunks[0]!.provenance, "public");
    assert.ok(!("provenance" in (r.data as Record<string, unknown>)), "来源标注不该再留在调用级——跨集时它会张冠李戴");
  });

  it("mock 模式出参同形，否则 CARLIFE_LLM=fake 下的用例会整片红", async () => {
    const r = await ragflowTool.call({ query: "q" }, { sessionId: "s", agent: "ownership", mode: "mock" });
    assert.deepEqual(r.data.datasets, ["vehicle-manuals"]);
    assert.equal(r.data.chunks[0]!.source.dataset, "vehicle-manuals");
    assert.equal(r.data.chunks[0]!.provenance, "simulated");
  });

  it("未注入客户端仍报 unconfigured，不返回空结果", async () => {
    setRagClient(undefined);
    await assert.rejects(
      () => ragflowTool.call({ query: "q" }, { sessionId: "s", agent: "service", mode: "real" }),
      (e: unknown) => String(e).includes("未接入"),
    );
  });
});
