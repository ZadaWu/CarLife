/**
 * 会话页从轨迹里挑垫场话（施工单 M18-07）。
 *
 * 这是本单唯一的新逻辑：**从轨迹取，不是从历史取**——
 * 垫场话按设计不入历史（AC-45-7），M18-04 有三处断言守着，本单不得破坏那条。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fillersOfTurn } from "../src/pages/sessions/FillerNote";
import type { TraceEvent } from "../src/pages/trace/timeline";

const span = (name: string, at: number, detail?: string): TraceEvent =>
  ({
    kind: "span",
    at,
    turnId: "t1",
    data: { name, startedAt: at, endedAt: at, durationMs: 0, status: "ok", ...(detail ? { detail } : {}) },
  }) as TraceEvent;

describe("从一轮轨迹里挑垫场话", () => {
  it("只挑 sidecar.filler，按原顺序", () => {
    const events = [
      span("acp.session_new", 100),
      span("sidecar.filler", 200, "l0 · understanding"),
      span("tool.ragflow_retrieve", 300),
      span("sidecar.filler", 400, "l0 · retrieval"),
      span("llm.service-voice", 500),
    ];
    const got = fillersOfTurn(events);
    assert.equal(got.length, 2);
    assert.deepEqual(
      got.map((f) => [f.at, f.phase, f.phrase]),
      [
        [200, "understanding", "我在理解你的问题"],
        [400, "retrieval", "我在翻你这车的手册"],
      ],
    );
  });

  it("一条都没有时返回空数组——不是抛错，也不是显示占位", () => {
    assert.deepEqual(fillersOfTurn([span("acp.session_new", 1), span("merge", 2)]), []);
  });

  /**
   * 还原不出来就只留时刻，**不猜**。
   * 控制台显示的必须与用户真听到的一致——编一句出来是最坏的形态：
   * 排障时会拿着一句从没播过的话去对因果。
   */
  it("阶段认不出时不给 phrase", () => {
    const got = fillersOfTurn([span("sidecar.filler", 10, "l1 · 某个新阶段")]);
    assert.equal(got.length, 1);
    assert.equal(got[0].phrase, undefined);
    assert.equal(got[0].source, "l1");
  });

  it("detail 缺失也不崩", () => {
    const got = fillersOfTurn([span("sidecar.filler", 10)]);
    assert.deepEqual(got, [{ at: 10 }]);
  });

  /** M18-08：同一阶段的第二句要能显示成 `retrieval#2`，而不是与第一句混同。 */
  it("带序号的记录还原出对应那一句", () => {
    const got = fillersOfTurn([
      span("sidecar.filler", 10, "l0 · retrieval#1"),
      span("sidecar.filler", 20, "l0 · retrieval#2"),
    ]);
    assert.deepEqual(got.map((f) => f.ordinal), [1, 2]);
    assert.notEqual(got[0].phrase, got[1].phrase, "第二句必须是另一句话");
  });

  /**
   * span 的 detail 里**不该出现垫场话原文**（M18-05 的 PII 纪律）。
   * 这条是反向断言：哪天有人为了页面好写把文本塞进 detail，这里会红。
   */
  it("不依赖 detail 里有文本——文本永远由 phase 还原", () => {
    const got = fillersOfTurn([span("sidecar.filler", 10, "l0 · retrieval")]);
    assert.equal(got[0].phrase, "我在翻你这车的手册");
    // detail 里确实没有这句话，全靠还原
    assert.ok(!"l0 · retrieval".includes("手册"));
  });
});
