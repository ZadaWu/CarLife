/**
 * [F-20-15][AC-20-1] 带照片的轮还在跑时，紧跟着的纯文字追问先等它，再沿用它的照片观察
 * （2026-09-18 真机走查，turn-b77d694b / turn-6f2bf4b1）。
 *
 * 那一次：车主发完照片 8 秒又补了一句「帮我看看什么灯亮了」，两轮并发；第二轮没有照片、
 * 观察被清空，检索词只剩一句白话三次超时，还把手册第 14 页的图示说成「您发的这张图是后雾灯」。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { PhotoTurnRegistry, PHOTO_TURN_WAIT_MAX_MS } from "../src/photo-turns";
import { observeAttachmentsNode, photoSection, PHOTO_INHERIT_WINDOW_MS, type PhotoObservationState } from "../src/graph/vision";

describe("[F-20-15][AC-20-1] 登记表：纯文字轮等带照片的轮收口", () => {
  it("没有带照片的轮在跑 → 不等", async () => {
    const r = await new PhotoTurnRegistry().waitFor("s1");
    assert.deepEqual(r, { waited: false, ms: 0, timedOut: false });
  });

  it("带照片的轮收口了才放行，并报出等的是哪一轮", async () => {
    const reg = new PhotoTurnRegistry();
    const end = reg.begin("s1", "turn-photo");
    assert.equal(reg.pending("s1"), "turn-photo");
    let released = false;
    const waiting = reg.waitFor("s1").then((r) => {
      released = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(released, false, "那一轮还没收口，不能放行");
    end();
    const r = await waiting;
    assert.equal(r.waited, true);
    assert.equal(r.turnId, "turn-photo");
    assert.equal(r.timedOut, false);
    assert.equal(reg.pending("s1"), undefined, "收口后登记要清掉");
  });

  it("到上限还没收口 → 照常放行并标 timedOut（最坏回到改之前的行为，不会卡死）", async () => {
    const reg = new PhotoTurnRegistry();
    reg.begin("s1", "turn-photo");
    const r = await reg.waitFor("s1", 30);
    assert.equal(r.waited, true);
    assert.equal(r.timedOut, true);
    assert.ok(r.ms >= 25);
  });

  it("别的会话不受影响；收口函数重复调用无害", async () => {
    const reg = new PhotoTurnRegistry();
    const end = reg.begin("s1", "t1");
    assert.equal((await reg.waitFor("s2")).waited, false);
    end();
    end();
    assert.equal((await reg.waitFor("s1")).waited, false);
  });

  it("连发两张照片：后一轮覆盖前一轮，前一轮收口时不能把后一轮的登记清掉", () => {
    const reg = new PhotoTurnRegistry();
    const end1 = reg.begin("s1", "t1");
    reg.begin("s1", "t2");
    end1();
    assert.equal(reg.pending("s1"), "t2");
  });

  it("上限 45 秒：第一轮典型 20~30 秒，留了余量又不至于让人干等", () => {
    assert.equal(PHOTO_TURN_WAIT_MAX_MS, 45_000);
  });
});

const prevObs = (over: Partial<PhotoObservationState> = {}): PhotoObservationState => ({
  handle: "h-prev",
  observedAt: Date.now() - 8_000,
  unreadable: false,
  frame: { cut_off_sides: [], cutOffSource: "none", quality: {} },
  items: [
    {
      category: "warning_light",
      shape: "lamp",
      color: "green",
      state: "lit",
      elements: ["straight_lines"],
      text: [],
      confidence: 0.9,
      colorAgreement: "agree" as never,
      undeterminable: [],
      match: { symbolId: "parking_lights", name: "驻车灯已开", class: "status", severity: "info", manualAnchor: "Model 3 车主手册 › 指示灯 › 驻车灯", verified: true, evidence: "e" },
    },
  ],
  notes: [],
  caveats: [],
  retakeHints: [],
  timings: {} as PhotoObservationState["timings"],
  model: {} as PhotoObservationState["model"],
  alerts: [],
  noActiveAlerts: false,
  ...over,
});

describe("[F-20-15][AC-20-1] 观察节点：这一轮没照片时沿用上一份新鲜的观察", () => {
  it("走查那一轮：8 秒前的观察 → 沿用并标 inherited，不再清空", async () => {
    const out = await observeAttachmentsNode({ photoInput: undefined, photoObservation: prevObs() } as never);
    assert.equal(out.photoObservation?.inherited, true);
    assert.equal(out.photoObservation?.items[0].match?.name, "驻车灯已开");
  });

  it("超过 5 分钟的观察不沿用：灯会灭、人会开走，过期的观察比没有更误导", async () => {
    const stale = prevObs({ observedAt: Date.now() - PHOTO_INHERIT_WINDOW_MS - 1_000 });
    const out = await observeAttachmentsNode({ photoInput: undefined, photoObservation: stale } as never);
    assert.equal(out.photoObservation, undefined);
  });

  it("老检查点里的观察没有时间戳 → 视为过期", async () => {
    const out = await observeAttachmentsNode({ photoInput: undefined, photoObservation: prevObs({ observedAt: undefined }) } as never);
    assert.equal(out.photoObservation, undefined);
  });

  it("之前没发过照片 → 照旧是空", async () => {
    const out = await observeAttachmentsNode({ photoInput: undefined, photoObservation: undefined } as never);
    assert.equal(out.photoObservation, undefined);
  });

  it("沿用的观察在【图片观察】段里说清来历：这一条没有图，别说成「您这条发的图」", () => {
    const text = photoSection(prevObs({ inherited: true }));
    assert.match(text, /没有附照片.*沿用他上一条消息里那张照片/);
    assert.ok(text.includes("驻车灯已开"));
    assert.equal(photoSection(prevObs()).includes("沿用"), false, "自己带照片的轮不该有这句");
  });
});

describe("接线：turn-runner 先等、后 invoke，收口在 finally", () => {
  const SRC = readFileSync(new URL("../src/turn-runner.ts", import.meta.url), "utf8");

  it("带照片的轮登记，纯文字轮等；都发生在 graph.invoke 之前", () => {
    const beginAt = SRC.indexOf("this.photoTurns.begin(input.sessionId, input.turnId)");
    const waitAt = SRC.indexOf("await this.photoTurns.waitFor(input.sessionId)");
    const invokeAt = SRC.indexOf("photoInput: photos.length ? photos : undefined");
    assert.ok(beginAt > 0 && waitAt > beginAt && invokeAt > waitAt, "等完再 invoke，读到的检查点里才有那一轮的照片观察");
  });

  it("放行写在 finally 里：跑挂了、被打断了也要放行，否则后一轮白等 45 秒", () => {
    const endAt = SRC.indexOf("endPhotoTurn?.();");
    // 文件里 turn_end 不止一处（更早还有「输入被拦」的早退出口，那条在登记之前、与这里无关）：取放行之后的第一处。
    const turnEndAt = SRC.indexOf('"turn_end"', endAt);
    const finallyAt = SRC.lastIndexOf("finally {", endAt);
    // 与 turn_end 同一个 finally：夹在「finally {」与 turn_end 之间，且中间没有再开别的 try。
    assert.ok(finallyAt > 0 && finallyAt < endAt && endAt < turnEndAt, "放行要在发 turn_end 的那个 finally 里");
    assert.equal(SRC.slice(finallyAt, turnEndAt).includes("try {"), false, "finally 与 turn_end 之间不该隔着另一个 try");
  });

  it("等了就进轨迹：turn.wait_photo_turn 这条 span 说得清等了谁、等了多久", () => {
    assert.match(SRC, /"turn\.wait_photo_turn"/);
  });
});
