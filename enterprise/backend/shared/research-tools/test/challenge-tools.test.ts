/**
 * 四个只读工具的行为（施工单 M82-06 首版；M88-02 从
 * `research-runtime/test/challenge.test.ts` 随工具一起搬来，**断言逐字不改**）。
 *
 * 搬家的红线是"入参与返回形状逐字不变"——所以这里刻意不"顺手改好"任何一条：
 * 断言变了就证明不了形状没变。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHALLENGE_MAX_STEPS,
  TOOL_LIMIT_MAX,
  getTool,
  invokeTool,
  type ResearchToolDeps,
} from "../src/index";
import { stubDeps } from "./fake-deps";

// M89-01：四个挑战工具要的那几项照旧逐字写在这里，其余五个取数口取自共用桩。
const toolDeps = (): ResearchToolDeps =>
  stubDeps({
    repo: {
      units: { byId: async (id: string) => ({ id, textRedacted: `反例 ${id}` }) },
      systemEvents: {
        inWindow: async () => [
          { id: "e1", kind: "config-change", at: 1, key: "ASR_ENGINE", summary: "ark → aliyun", sourceRef: "r:1" },
        ],
      },
    } as never,
    codebookVersion: "0.1.0",
    themeMembers: async () => ({ memberUnitIds: ["m1", "m2"], counterUnitIds: ["c1", "c2", "c3"] }),
    thresholdSensitivity: async (code, delta) => ({ flips: Math.abs(delta) > 0.05, detail: `${code} @ ${delta}` }),
    sliceBySegment: async () => [{ segment: "seg-1", n: 30, share: 0.6 }],
  });

/** 走注册表的执行口，与 tools-endpoint 走的是同一段代码。 */
const run = async (name: string, args: unknown): Promise<unknown> => {
  const out = await invokeTool(name, args, toolDeps());
  assert.equal(out.ok, true, out.ok === false ? out.error : "");
  return out.ok === true ? out.data : null;
};

describe("[M88-02] Challenger 的四个工具", () => {
  it("四个工具齐，且都声明了只读", () => {
    for (const name of ["findCounterEvidence", "listSystemEvents", "sliceBySegment", "thresholdSensitivity"]) {
      const t = getTool(name);
      assert.ok(t, `${name} 不在注册表里`);
      assert.match(t!.description, /只读/, `${name} 没声明只读`);
    }
  });

  it("findCounterEvidence 受 limit 上界约束", async () => {
    const out = (await run("findCounterEvidence", { themeId: "t1", limit: 2 })) as { count: number };
    assert.equal(out.count, 2);
    // schema 上界：超过 20 直接被 zod 拒。
    assert.throws(() => getTool("findCounterEvidence")!.schema.parse({ themeId: "t", limit: TOOL_LIMIT_MAX + 1 }));
  });

  it("findCounterEvidence 只回 textRedacted，且空的那些不回", async () => {
    // 未脱敏原文不进返回值：这些字节要穿过 pi 的会话 jsonl 落到磁盘上。
    const deps: ResearchToolDeps = {
      ...toolDeps(),
      repo: {
        units: {
          byId: async (id: string) => ({ id, textRedacted: id === "c2" ? null : `反例 ${id}` }),
        },
      } as never,
    };
    const out = await invokeTool("findCounterEvidence", { themeId: "t1", limit: 10 }, deps);
    assert.equal(out.ok, true);
    const data = out.ok === true ? (out.data as { count: number; units: Array<Record<string, unknown>> }) : null;
    assert.equal(data!.count, 2, "textRedacted 为空的单元应当被跳过");
    assert.deepEqual(data!.units.map((u) => u.unitId), ["c1", "c3"]);
    for (const u of data!.units) {
      assert.deepEqual(Object.keys(u).sort(), ["text", "unitId"], "返回里出现了 textRedacted 之外的字段");
    }
  });

  it("listSystemEvents 取得到我们自己的变更", async () => {
    const out = (await run("listSystemEvents", { from: 0, to: 9 })) as {
      count: number;
      events: Array<Record<string, unknown>>;
    };
    assert.equal(out.count, 1);
    // 只回派生的三个字段——id / key / sourceRef 是我们自己的内部标识，不给模型。
    assert.deepEqual(Object.keys(out.events[0]).sort(), ["at", "kind", "summary"]);
  });

  it("sliceBySegment 原样透出注入的分布", async () => {
    const out = (await run("sliceBySegment", { themeId: "t1" })) as { slices: unknown[] };
    assert.deepEqual(out.slices, [{ segment: "seg-1", n: 30, share: 0.6 }]);
  });

  it("thresholdSensitivity 的 delta 有范围", () => {
    const schema = getTool("thresholdSensitivity")!.schema;
    assert.throws(() => schema.parse({ code: "x", delta: 0.9 }));
    assert.doesNotThrow(() => schema.parse({ code: "x", delta: 0.1 }));
  });

  it("thresholdSensitivity 把注入的判定原样回出去", async () => {
    const out = (await run("thresholdSensitivity", { code: "c_range_anxiety", delta: 0.1 })) as {
      flips: boolean;
      detail: string;
    };
    assert.equal(out.flips, true);
    assert.match(out.detail, /c_range_anxiety/);
  });
});

describe("[M88-02] 两个上界的数值不变", () => {
  it("TOOL_LIMIT_MAX = 20", () => {
    assert.equal(TOOL_LIMIT_MAX, 20);
  });

  /*
   * 这个数在两条路径上的**落点**不同：直连路径是 AI SDK 的 `maxSteps`，
   * ACP 路径上 pi 没有这个参数，由 tools-endpoint 按 pi 会话计 invoke 次数（M88-04）。
   * 落点不同、数必须同——否则同一张卡在两条路上"查得深浅不一样"，而记录长得一模一样。
   */
  it("CHALLENGE_MAX_STEPS = 8", () => {
    assert.equal(CHALLENGE_MAX_STEPS, 8);
  });
});
