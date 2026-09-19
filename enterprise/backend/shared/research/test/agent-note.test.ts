/**
 * `AgentNote` 的形状、轮数上界与会话键（施工单 M89-03）。
 *
 * 这里钉的是三件"错了也不报错"的事：
 *  ① schema 是 `.strict()` 的——模型多吐一个 `verdict` 时必须**失败**，
 *    不是被静默剥掉。剥掉之后越权那一次与正常那一次长得一模一样；
 *  ② `ASK_MAX_ROUNDS` 与 `FOLLOW_UP_MAX_ROUNDS` 是两笔账，值不共用；
 *  ③ 会话键的每一段都在：少 agent 就是三个角色共用一个 pi 会话，
 *    少 contractId 就是拿另一段窗口的上下文答这一次的问题。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASK_AGENT_OF,
  ASK_MAX_ROUNDS,
  agentNoteSchema,
  askScopeKey,
  askSessionKey,
  type AgentNote,
} from "../src/agent-note";
import type { SelectionScope } from "../src/capabilities";

const note = (over: Partial<AgentNote> = {}): Record<string, unknown> => ({
  answer: "这一格的 n 在全表里偏高。",
  citedUnitIds: ["unit-1"],
  citedThemeIds: ["th-1"],
  caveats: ["样本集中在两台车上"],
  nextQuestions: ["换个季度还成立吗"],
  ...over,
});

describe("[M89-03] agentNoteSchema：越权字段没有地方填", () => {
  it("正常的一份过得去", () => {
    const v = agentNoteSchema.safeParse(note());
    assert.equal(v.success, true);
  });

  it("**多吐 verdict / level / recommendation 一律失败**，不是静默剥掉", () => {
    for (const extra of [{ verdict: "holds" }, { level: "candidate" }, { recommendation: "改码表" }]) {
      const v = agentNoteSchema.safeParse({ ...note(), ...extra });
      assert.equal(v.success, false, `多余键 ${Object.keys(extra)[0]} 被放行了——strict 掉了`);
    }
  });

  it("空答案不算答案", () => {
    assert.equal(agentNoteSchema.safeParse(note({ answer: "" })).success, false);
  });

  it("引用与保留意见有上界——一份笔记不该是一整张表", () => {
    assert.equal(agentNoteSchema.safeParse(note({ citedUnitIds: Array(21).fill("u") })).success, false);
    assert.equal(agentNoteSchema.safeParse(note({ citedThemeIds: Array(11).fill("t") })).success, false);
    assert.equal(agentNoteSchema.safeParse(note({ caveats: Array(6).fill("c") })).success, false);
    assert.equal(agentNoteSchema.safeParse(note({ nextQuestions: Array(4).fill("q") })).success, false);
  });

  it("五个字段一个都不能少", () => {
    for (const k of ["answer", "citedUnitIds", "citedThemeIds", "caveats", "nextQuestions"]) {
      const body = note();
      delete body[k];
      assert.equal(agentNoteSchema.safeParse(body).success, false, `${k} 缺席被放行了`);
    }
  });
});

describe("[M89-03] 轮数上界与能力 → Agent 的映射", () => {
  it("**五轮**，且与追问那条（3 轮）不是同一个数", () => {
    assert.equal(ASK_MAX_ROUNDS, 5);
  });

  it("三条能力各自问谁，写成表不是拿字符串裁出来的", () => {
    assert.deepEqual(ASK_AGENT_OF, {
      "ask-analyst": "analyst",
      "ask-taxonomist": "taxonomist",
      "ask-archivist": "archivist",
    });
  });
});

describe("[M89-03] askScopeKey / askSessionKey", () => {
  const cell: SelectionScope = {
    kind: "cell",
    needPainCode: "cold-range-loss",
    sceneCode: "charging",
    suppressed: false,
    catchAll: false,
    hasDirection: false,
  };

  it("五种范围各有稳定形式", () => {
    assert.equal(askScopeKey(cell), "cell:cold-range-loss:charging");
    assert.equal(askScopeKey({ kind: "row", needPainCode: "other", catchAll: true, suppressed: false }), "row:other");
    assert.equal(askScopeKey({ kind: "col", sceneCode: "charging" }), "col:charging");
    assert.equal(askScopeKey({ kind: "card", insightId: "i-1" }), "card:i-1");
    assert.equal(askScopeKey({ kind: "page" }), "page");
  });

  it("会话键 = ask:<agent>:<范围>:<合同>", () => {
    assert.equal(askSessionKey("analyst", cell, "ct-1"), "ask:analyst:cell:cold-range-loss:charging:ct-1");
    assert.equal(askSessionKey("archivist", { kind: "card", insightId: "i-1" }, "ct-1"), "ask:archivist:card:i-1:ct-1");
  });

  it("**换 Agent、换合同都换键**——同键意味着复用同一个 pi 会话", () => {
    assert.notEqual(askSessionKey("analyst", cell, "ct-1"), askSessionKey("archivist", cell, "ct-1"));
    assert.notEqual(askSessionKey("analyst", cell, "ct-1"), askSessionKey("analyst", cell, "ct-2"));
    // 同一范围同一合同上的第二轮：键必须逐字相同，否则追问会开一个新会话。
    assert.equal(askSessionKey("analyst", { ...cell }, "ct-1"), askSessionKey("analyst", cell, "ct-1"));
  });

  it("抑制与否不进键——它是能力条的闸门，不是另一格", () => {
    assert.equal(askScopeKey({ ...cell, suppressed: true }), askScopeKey(cell));
  });
});
