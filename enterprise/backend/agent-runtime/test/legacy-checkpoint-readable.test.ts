/**
 * [F-21-06][AC-21-6] 停写旧通道之后，旧检查点仍然读得出来（M84-05，ACR-036）。
 *
 * `tasks` 档下 `itineraryNode` 不再写 `tripPlan` / `pendingCancel`，但**通道的声明与 reducer
 * 一律保留**——库里躺着一批切档前的检查点，`itineraryNode` 要读它们当迁入种子。
 * 删通道会让那些检查点一读就抛，而那种失败是整轮对话直接挂掉。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { GraphState } from "../src/graph/state";
import type { TripPlanState } from "../src/graph/state";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const SUP = src("../src/graph/supervisor.ts");
const STATE = src("../src/graph/state.ts");

const legacyPlan: TripPlanState = {
  status: "confirmed",
  destination: "青岛",
  days: 3,
  committedPlanId: "plan-legacy01",
  skeleton: [{ day: 1, theme: "第 1 天", spots: [{ name: "栈桥" }] }],
  caveats: [],
  updatedTurnId: "turn-legacy",
};

describe("[F-21-06][AC-21-6] 旧检查点仍可读", () => {
  it("两个通道的声明还在——删了旧检查点一读就抛", () => {
    const channels = Object.keys(GraphState.spec);
    assert.ok(channels.includes("tripPlan"), "tripPlan 通道不许删");
    assert.ok(channels.includes("pendingCancel"), "pendingCancel 通道不许删");
  });

  it("reducer 仍是右值覆盖，旧值读得回来", () => {
    /*
     * LangGraph 1.x 的 channel 规格里 reducer 挂在 `operator`、缺省工厂挂在
     * `initialValueFactory`（`value` 是类型标记，不是函数——第一版照 `value` 写当场 TypeError）。
     */
    const spec = GraphState.spec as unknown as Record<
      string,
      { operator: (a: unknown, b: unknown) => unknown; initialValueFactory?: () => unknown }
    >;
    const ch = spec.tripPlan!;
    assert.equal(typeof ch.operator, "function", "reducer 不见了——旧检查点会读不回来");
    assert.equal(ch.initialValueFactory?.(), undefined, "缺省是 undefined——老检查点没有这一栏时不该炸");
    assert.deepStrictEqual(ch.operator(undefined, legacyPlan), legacyPlan, "右值覆盖：读得回旧值");
  });

  it("`tasks` 档下出口把这两个通道剥掉，且只剥这两个", () => {
    assert.ok(
      SUP.includes("const { tripPlan: _tripPlan, pendingCancel: _pendingCancel, ...rest } = patch"),
      "停写要在出口剥一次——九处 return 各判一次是「漏一处就分家」的形状",
    );
    assert.ok(
      SUP.includes('if (configurable?.turnContext?.mode !== "tasks") return patch;'),
      "只在 tasks 档剥；off / inject 两档必须逐字照旧",
    );
  });

  it("迁入种子读的就是这两个通道里的旧值", () => {
    assert.ok(SUP.includes("state.tripPlan && state.tripPlan.status !== \"cancelled\""), "种子要读旧通道");
    assert.ok(SUP.includes('op: "task_seed"'), "种进去了要留痕");
  });

  it("state.ts 里写明了这两个通道的现状", () => {
    assert.ok(
      /停止写入|只读旧检查点/.test(STATE),
      "通道注释里要说清「本 Sprint 起停止写入、只读旧检查点作迁入种子」，否则下一个人会以为它还活着",
    );
  });
});
