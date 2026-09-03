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
import { createCalendarTool, createMockBackend } from "../src/calendar";
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
    for (const forbidden of ["vehicle_profile", "usage_profile", "memory", "appointment", "calendar"]) {
      assert.ok(!exposable.some((t) => t.name === forbidden), `${forbidden} 不得出现在 MCP 暴露面`);
    }
  });

  it("敏感工具一律不进 MCP 暴露面（M5-04 引入 calendar 后这条才有实际约束力）", () => {
    const sensitive = TOOL_REGISTRY.filter((t) => t.sensitive);
    assert.ok(sensitive.length > 0, "M5-04 起注册表应含敏感工具");
    assert.ok(
      sensitive.every((t) => !t.mcpExposable),
      "敏感工具不得对外暴露——有副作用的能力不能给第三方（F-34-09）",
    );
  });

  it("calendar 按 §5 只挂出行规划与用车助手，**不挂购车/售后**", () => {
    const cal = TOOL_REGISTRY.find((t) => t.name === "calendar")!;
    assert.deepEqual([...cal.agents].sort(), ["ownership", "trip"]);
    assert.ok(!cal.agents.includes("buying"), "试驾预约不该重复写日历（§5）");
    assert.ok(!cal.agents.includes("service"), "维修预约不该重复写日历（§5）");
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

describe("calendar 工具（M5-04）", () => {
  it("**读的返回类型里没有标题字段**——隐私靠结构保证，不靠脱敏（F-31-12）", async () => {
    const tool = createCalendarTool(createMockBackend(true));
    const r = await tool.call({ op: "read", from: "2026-08-15", to: "2026-08-15" }, ctx());
    const data = r.data as { op: string; slots: Array<Record<string, unknown>> };
    assert.equal(data.op, "read");
    for (const slot of data.slots) {
      assert.deepEqual(Object.keys(slot).sort(), ["end", "start", "status"], "只允许忙闲三元组");
      assert.equal("title" in slot, false, "日程标题绝不能出现在返回里");
      assert.equal("summary" in slot, false);
    }
  });

  it("未绑定时**读直接跳过，不阻塞规划**（§5 授权前提）", async () => {
    const tool = createCalendarTool(createMockBackend(false));
    const r = await tool.call({ op: "read", from: "2026-08-15", to: "2026-08-15" }, ctx());
    const data = r.data as { skipped: boolean; slots: unknown[] };
    assert.equal(data.skipped, true);
    assert.deepEqual(data.slots, []);
  });

  it("未绑定时**写明确报错**，不静默失败让用户以为写进去了", async () => {
    const tool = createCalendarTool(createMockBackend(false));
    await assert.rejects(
      () =>
        tool.call(
          { op: "write", events: [{ title: "出发", start: "2026-08-15T07:00", end: "2026-08-15T08:00" }] },
          ctx(),
        ),
      (e: unknown) => e instanceof ToolError && e.category === "unconfigured",
    );
  });

  it("写入返回事件 id，供幂等对账（F-31-10）", async () => {
    const tool = createCalendarTool(createMockBackend(true));
    const r = await tool.call(
      {
        op: "write",
        events: [
          { title: "出发", start: "2026-08-15T07:00", end: "2026-08-15T08:00" },
          { title: "充电停靠", start: "2026-08-15T11:00", end: "2026-08-15T11:40" },
        ],
      },
      ctx(),
    );
    const data = r.data as { written: number; eventIds: string[] };
    assert.equal(data.written, 2);
    assert.equal(data.eventIds.length, 2);
  });

  it("有副作用故不重试——重试一次写入就是两条重复日程", () => {
    const tool = createCalendarTool(createMockBackend(true));
    assert.equal(tool.sensitive, true);
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
        return [{ content: "x", source: { document: "d" }, score: 1 }];
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
        return [{ content: "x", source: { document: "d" }, score: 1 }];
      },
    });
    await ragflowTool.call({ query: "q", topK: 3 }, { sessionId: "s", agent: "ownership", mode: "real" });
    assert.equal(seen, 3);
  });
});
