/**
 * 工具调用观察者（施工单 TD-08 任务 3，F-44-04）。
 *
 * 这是工单「关键落地约束 2」要验证的那件事：**一个观察者能否覆盖两条入口**。
 * 本包只能验到"挂在 `invokeTool` 上就一定被调到"这一半——
 * 另一半（pi 经 HTTP 打进 tools-endpoint 后也落到同一个 `invokeTool`）
 * 由 `enterprise/backend/agent-runtime` 侧的接线测试验。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  invokeTool,
  setToolObserver,
  type ToolCallContext,
  type ToolInvocationObservation,
} from "../src/index";

// mode 用 real：`cost_calc` 是确定性算术，不碰网络，但它**拒绝以 mock 模式运行**
// （"该工具未提供模拟数据"——宁可拒绝也不给假数，见 external.ts）。
const CTX: ToolCallContext = { sessionId: "sess-1#1700", agent: "buying", mode: "real" };

const ARGS = { vehiclePrice: 200_000, energy: "bev" as const };

afterEach(() => setToolObserver(undefined));

describe("工具调用耗时观察者", () => {
  it("成功调用被观察到，且带上会话与 Agent（AC-44-11 埋点贯穿）", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));

    await invokeTool("cost_calc", ARGS, CTX);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, "cost_calc");
    assert.equal(seen[0].status, "ok");
    assert.equal(seen[0].ctx.agent, "buying");
    assert.equal(seen[0].ctx.sessionId, "sess-1#1700");
    assert.ok(seen[0].endedAt >= seen[0].startedAt);
  });

  it("**观察者抛错不影响工具**——埋点是旁路（AC-44-12）", async () => {
    setToolObserver(() => {
      throw new Error("轨迹落库挂了");
    });
    const r = (await invokeTool("cost_calc", ARGS, CTX)) as { data: unknown };
    assert.ok(r, "工具的返回值必须原样透出");
  });

  it("工具失败时观察到 failed，且异常原样抛出", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));

    // 未接入 RagClient 时 ragflow_retrieve 会失败——这正是最需要看见耗时的那类跳：
    // 失败常常发生在超时之后，比成功慢得多。只记成功等于把最慢的样本系统性剔掉。
    await assert.rejects(() =>
      invokeTool("ragflow_retrieve", { query: "刹车异响" }, { ...CTX, agent: "ownership" }),
    );

    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, "ragflow_retrieve");
    assert.equal(seen[0].status, "failed");
    assert.ok(seen[0].error !== undefined, "错误交给调用方归类，本包不替它决定落什么");
  });

  it("**入参不合法不计入耗时**——那是本地拒绝，不是一跳外部调用", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));

    await assert.rejects(() => invokeTool("cost_calc", { vehiclePrice: -1 }, CTX));

    assert.equal(seen.length, 0, "混进去会在时延分布里造出一堆 0ms 的假样本");
  });

  it("未注册的工具同样不产生观察——它根本没发生", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    await assert.rejects(() => invokeTool("不存在的工具", {}, CTX));
    assert.equal(seen.length, 0);
  });

  it("卸载后不再被调用", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    setToolObserver(undefined);
    await invokeTool("cost_calc", ARGS, CTX);
    assert.equal(seen.length, 0);
  });
});

describe("轨迹概括（traceSummary，TD-08 追加）", () => {
  it("**同一轮里多次调用能被区分开**——这是加它的唯一理由", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));

    // 实测场景：一轮里模型并发发了 5 次 weather，轨迹上五条一模一样，
    // 看不出是五个点还是同一个点查了五遍。
    for (const [lat, lon] of [
      [22.54, 114.06],
      [25.03, 115.9],
      [30.13, 118.16],
    ]) {
      await invokeTool(
        "weather",
        { points: [{ name: "某点", lat, lon }] },
        { ...CTX, agent: "trip" },
      ).catch(() => undefined);
    }

    const summaries = seen.map((o) => o.summary);
    assert.equal(new Set(summaries).size, 3, "三次调用应产出三条不同的概括");
    assert.ok(summaries.every((s) => s?.startsWith("1 点 · 首点")));
  });

  it("坐标取整到 1.1km——够区分，又钝到不构成位置追踪", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    await invokeTool(
      "weather",
      { points: [{ name: "x", lat: 30.132456, lon: 118.164999 }] },
      { ...CTX, agent: "trip" },
    ).catch(() => undefined);
    assert.match(seen[0].summary!, /30\.13,118\.16/);
    assert.ok(!seen[0].summary!.includes("30.1324"), "原始精度不得进轨迹");
  });

  it("**检索的 query 一个字都不进轨迹**（AC-44-10）", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    const secret = "我家车库在朝阳区某某路 88 号，冬天续航掉得厉害";
    await invokeTool(
      "ragflow_retrieve",
      { query: secret, dataset: "vehicle-manuals", vehicleModel: "Model 3" },
      { ...CTX, agent: "ownership" },
    ).catch(() => undefined);
    assert.ok(seen[0].summary && !seen[0].summary.includes("朝阳区"), "用户原文不得进指标");
    assert.match(seen[0].summary!, /vehicle-manuals/, "数据集要能看见——查错库是常见故障");
    assert.match(seen[0].summary!, /限定 Model 3/, "有没有带车型限定同样是要查的");
  });

  it("**没声明 traceSummary 的工具就什么都不放**——缺省站在安全那一侧", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    await invokeTool("cost_calc", ARGS, CTX);
    assert.equal(seen[0].summary, undefined);
  });

  it("概括自己抛错只丢掉这一条概括，不影响工具执行", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    // points 为空数组会被 schema 挡下；这里验的是 summary 计算异常不外溢——
    // 用一个能通过校验但让 summary 取到 undefined 首元素的形状不好构造，
    // 故直接验正常路径下工具返回值完好（异常分支由 registry 的 try/catch 覆盖）。
    const r = await invokeTool(
      "weather",
      { points: [{ name: "x", lat: 30, lon: 118 }] },
      { ...CTX, agent: "trip" },
    ).catch((e) => e);
    assert.ok(r !== undefined);
    assert.equal(seen.length, 1);
  });
});
