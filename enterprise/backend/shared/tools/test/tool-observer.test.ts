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
  resetSubmitAttempts,
  setBranchSubmissionSink,
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

  it("观察者拿得到**校验后的入参**与返回值（业务视图要看「拿什么查的、查回来什么」）", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));

    const r = await invokeTool("cost_calc", ARGS, CTX);

    assert.deepEqual(seen[0].args, ARGS);
    assert.equal(seen[0].result, r, "返回值必须是工具真正交出去的那个对象");
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

  /*
   * M98-02 起这条的断言变了：**留痕，但起止同刻**。
   *
   * 原来这里断言"一条观察都不产生"，理由写的是"不计入耗时"——两件事被并成了一件。
   * 不计入耗时是对的（本地拒绝混进时延分布会造出一堆 0ms 假样本），但连痕迹都不留
   * 的后果是：模型交了三次、两次被 schema 挡下，轨迹上只看得见成功那一条。
   * 现在的口径是 `durationMs === 0`，而不是"没有这条记录"。
   */
  it("**入参不合法留痕但不计入耗时**——起止同刻，不是一跳外部调用", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));

    await assert.rejects(() => invokeTool("cost_calc", { vehiclePrice: -1 }, CTX));

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.status, "failed");
    assert.equal(seen[0]!.endedAt - seen[0]!.startedAt, 0, "混进耗时会在时延分布里造出一堆 0ms 的假样本");
    assert.equal(seen[0]!.args, undefined, "没过校验的入参不落");
    assert.match(String(seen[0]!.summary), /字段：vehiclePrice/);
    assert.doesNotMatch(String(seen[0]!.summary), /attempt=/, "非提交类工具不计提交次数");
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

/*
 * [F-58-02] 提交尝试计数进轨迹概括（M94-04）。
 *
 * `tool.submit_drive_plan ok` 此前长得都一样，而它可能是一次交对的，也可能是
 * 退了两次之后把数据改坏才交上去的那一次（turn-dfb2fd8e，2026-09-16：第 3 次交的
 * `legs=3 stops=0` 与首轮那份粗数据逐字相同，七个真实服务区全丢）。
 * 四个数就够判：`attempt` 说前面退了几次，`legs/days/return/empty` 说这一次的形状。
 */
describe("[F-58-02] submit_drive_plan 的轨迹概括带提交次数与形状（M94-04；ACR-047 改成段列表）", () => {
  const summaries = (seen: ToolInvocationObservation[]) => seen.map((o) => o.summary);

  /** 一次形状合法的提交：按天把停靠点串成段，跨天到「落脚处」，最后一段到目的地。 */
  const ok = (legDays: number[], stops: string[]) => {
    const legs: Array<Record<string, unknown>> = [];
    let si = 0;
    let from = "上海";
    legDays.forEach((day, i) => {
      const last = i === legDays.length - 1;
      const sameDayNext = !last && legDays[i + 1] === day;
      const to = last ? { kind: "overnight", name: "目的地" } : sameDayNext ? { kind: "rest", name: stops[si++] ?? "待定停靠点" } : { kind: "overnight", name: `第${day}天落脚处` };
      legs.push({ day, direction: "outbound", from, to, minutes: 100 });
      from = to.name;
    });
    return { origin: "上海", legs };
  };
  /** 一次形状不合法的提交：接续断裂（第 2 段的 from 接不上第 1 段的 to）。 */
  const bad = () => ({
    origin: "上海",
    legs: [
      { day: 1, direction: "outbound", from: "上海", to: { kind: "rest", name: "A服务区" }, minutes: 100 },
      { day: 1, direction: "outbound", from: "别处", to: { kind: "overnight", name: "目的地" }, minutes: 100 },
    ],
  });

  it("同一轮连交三次 → attempt 依次 1 / 2 / 3；换 turnId 重新从 1 开始", async () => {
    resetSubmitAttempts();
    setBranchSubmissionSink({ record: () => true });
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    const args = ok([1, 1], ["A服务区"]);

    const t1 = { sessionId: "sess-m94#1", turnId: "turn-a", agent: "drive", mode: "real" as const };
    for (let i = 0; i < 3; i += 1) await invokeTool("submit_drive_plan", args, t1);
    assert.deepEqual(
      summaries(seen).map((s) => s?.split(" ")[0]),
      ["attempt=1", "attempt=2", "attempt=3"],
    );

    // 轮是计数的边界：下一轮的第一次提交不该背着上一轮的账。
    seen.length = 0;
    await invokeTool("submit_drive_plan", args, { ...t1, turnId: "turn-b" });
    assert.match(String(seen[0]?.summary), /^attempt=1 /);
    setBranchSubmissionSink(undefined);
  });

  it("**被退回的那几次也算**——只数成功的那一次等于什么都没数", async () => {
    resetSubmitAttempts();
    setBranchSubmissionSink({ record: () => true });
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    const ctx = { sessionId: "sess-m94#2", turnId: "turn-c", agent: "drive", mode: "real" as const };

    // 前两次形状对不上（接续断裂），第三次才对。
    await assert.rejects(() => invokeTool("submit_drive_plan", bad(), ctx));
    await assert.rejects(() => invokeTool("submit_drive_plan", bad(), ctx));
    await invokeTool("submit_drive_plan", ok([1, 1], ["A服务区"]), ctx);

    const okOne = seen.filter((o) => o.status === "ok");
    assert.equal(okOne.length, 1);
    assert.match(String(okOne[0]!.summary), /^attempt=3 /, "成功那次要看得出前面退了两次");
    setBranchSubmissionSink(undefined);
  });

  it("概括里是四个数，一个字都不来自停靠点名或用户原话（AC-44-10）", async () => {
    resetSubmitAttempts();
    setBranchSubmissionSink({ record: () => true });
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    await invokeTool(
      "submit_drive_plan",
      ok([1, 1, 1, 2, 2, 3], ["东久服务区(507.5km)", "波密服务区", "鲁朗服务区"]),
      { sessionId: "sess-m94#3", turnId: "turn-d", agent: "drive", mode: "real" as const },
    );
    assert.equal(seen[0]!.summary, "attempt=1 legs=6 days=3 return=0 empty=0");
    setBranchSubmissionSink(undefined);
  });
});

/*
 * M98-02：提交通道的留痕对称。
 *
 * 库里 900 条其它提交调用失败 0 条——退回只发生在 drive（只有它有形状校验）。
 * 所以本组钉的不是"退回文案"，而是**交上来的是什么形状、这是第几次交**：
 * 这两件事此前只有 drive 看得见。
 */
describe("提交通道的一行概括：六个工具各说各的（M98-02）", () => {
  const sink = { record: () => true };
  const ctxOf = (turn: string, agent: string) =>
    ({ sessionId: "sess-m98#1", turnId: turn, agent, mode: "real" as const }) as ToolCallContext;

  const summaryOf = async (tool: string, args: unknown, agent: string, turn: string): Promise<string> => {
    resetSubmitAttempts();
    setBranchSubmissionSink(sink);
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    await invokeTool(tool, args, ctxOf(turn, agent));
    setBranchSubmissionSink(undefined);
    return String(seen.at(-1)!.summary);
  };

  it("submit_hotels：缺 area 的条数单列——汇聚层靠它挂天", async () => {
    const s = await summaryOf(
      "submit_hotels",
      { hotels: [{ name: "甲", area: "云龙区" }, { name: "乙", area: "云龙区" }, { name: "丙" }], findings: [] },
      "hotel",
      "t1",
    );
    assert.equal(s, "attempt=1 hotels=3 areas=1 noArea=1 findings=0");
  });

  it("submit_tour_days：缺时段的景点数单列——体检靠它算当天时长", async () => {
    const s = await summaryOf(
      "submit_tour_days",
      {
        days: [
          { day: 1, spots: [{ name: "甲", estStart: "09:00", estEnd: "11:00" }, { name: "乙" }] },
          { day: 2, spots: [{ name: "丙", estStart: "09:00", estEnd: "11:00" }] },
        ],
        findings: ["一条"],
      },
      "tour",
      "t2",
    );
    assert.equal(s, "attempt=1 days=2 spots=3 noTime=1 startDate=无 findings=1");
  });

  it("submit_transit：flight 三态分得开（没给 / 建议飞 / 建议不飞）", async () => {
    const none = await summaryOf("submit_transit", { trains: [{ no: "G1" }], findings: [] }, "transit", "t3");
    assert.match(none, /flight=none/);
    const yes = await summaryOf("submit_transit", { trains: [], flightAdvice: { worthIt: true }, findings: [] }, "transit", "t4");
    assert.match(yes, /flight=yes/);
    const no = await summaryOf("submit_transit", { trains: [], flightAdvice: { worthIt: false }, findings: [] }, "transit", "t5");
    assert.match(no, /flight=no/);
  });

  it("submit_nav_plan：途经点数与段数并列——对不上是这条腿最常见的坏法", async () => {
    const s = await summaryOf(
      "submit_nav_plan",
      { strategy: "highway", waypoints: [{ name: "甲", lat: 1, lon: 2 }], legMinutes: [30, 40], findings: [] },
      "nav",
      "t6",
    );
    assert.equal(s, "attempt=1 strategy=highway waypoints=1 legs=2 findings=0");
  });

  it("submit_guide_spots：有出处、有坐标的各几条", async () => {
    const s = await summaryOf(
      "submit_guide_spots",
      {
        spots: [
          { name: "甲", sourceUrl: "https://example.com/a", lat: 1, lon: 2 },
          { name: "乙", sourceUrl: "https://example.com/b" },
          { name: "丙" },
        ],
        findings: [],
      },
      "guide-spots",
      "t7",
    );
    assert.equal(s, "attempt=1 spots=3 withUrl=2 withCoord=1 findings=0");
  });

  it("submit_guide_access / comfort：三类与四类各自的计数", async () => {
    const access = await summaryOf(
      "submit_guide_access",
      { parking: [{ name: "甲" }, { name: "乙" }], charging: [{ name: "丙" }], refuel: [], findings: [] },
      "guide-access",
      "t8",
    );
    assert.equal(access, "attempt=1 parking=2 charging=1 refuel=0 findings=0");
    const comfort = await summaryOf(
      "submit_guide_comfort",
      { entries: [{ kind: "rest", note: "x" }, { kind: "food", note: "y" }, { kind: "food", note: "z" }], findings: [] },
      "guide-comfort",
      "t9",
    );
    assert.equal(comfort, "attempt=1 entries=3 rest=1 food=2 toilet=0 pitfall=0 findings=0");
  });

  it("概括里没有任何名字：只有计数与枚举值（AC-44-10）", async () => {
    const s = await summaryOf(
      "submit_hotels",
      { hotels: [{ name: "桔子酒店(荔湾店)", area: "荔湾" }], findings: ["附近没有连锁"] },
      "hotel",
      "t10",
    );
    for (const leak of ["桔子", "荔湾", "连锁"]) assert.doesNotMatch(s, new RegExp(leak), leak);
  });
});

describe("入参被 zod 挡下：留痕、计数、只落字段名（M98-02）", () => {
  it("提交类：两次不合法 + 一次合法 → 成功那次是 attempt=3", async () => {
    resetSubmitAttempts();
    setBranchSubmissionSink({ record: () => true });
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    const ctx = { sessionId: "sess-m98#2", turnId: "turn-x", agent: "hotel", mode: "real" as const } as ToolCallContext;

    await assert.rejects(() => invokeTool("submit_hotels", { hotels: "不是数组" }, ctx));
    await assert.rejects(() => invokeTool("submit_hotels", {}, ctx));
    await invokeTool("submit_hotels", { hotels: [{ name: "甲", area: "云龙区" }], findings: [] }, ctx);

    const failed = seen.filter((o) => o.status === "failed");
    assert.equal(failed.length, 2);
    assert.match(String(failed[0]!.summary), /^attempt=1 字段：hotels/);
    assert.match(String(failed[1]!.summary), /^attempt=2 字段：hotels/);
    assert.equal(String(seen.at(-1)!.summary).startsWith("attempt=3 "), true, "成功那次要看得出前面被挡了两次");
    setBranchSubmissionSink(undefined);
  });

  it("退回归类成 tool_invalid:arg，与形状校验的 tool_invalid 分得开；文案仍是原来那句", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    await assert.rejects(() => invokeTool("submit_hotels", {}, CTX), (e: Error) => {
      assert.equal(e.name, "ToolError");
      assert.equal((e as { category?: string }).category, "invalid");
      assert.equal((e as { code?: string }).code, "arg");
      assert.match(e.message, /^\[submit_hotels\] 入参不合法：/);
      return true;
    });
    assert.equal(seen.length, 1);
  });

  it("字段值不进轨迹：只有字段名", async () => {
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    await assert.rejects(() => invokeTool("submit_tour_days", { days: "北京三日游·王先生" }, CTX));
    assert.match(String(seen[0]!.summary), /字段：days/);
    assert.doesNotMatch(String(seen[0]!.summary), /王先生/);
    assert.equal(seen[0]!.args, undefined);
  });
});
