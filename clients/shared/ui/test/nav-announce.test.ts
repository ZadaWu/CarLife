/**
 * 到站播报的两道闸（M31-03；M65-01 抽成纯函数上提）。
 * 文案开头「已到达」是服务端 ARRIVE_PATTERNS 的判据，改了两边要一起改。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { arrivalNote, createArrivalAnnouncer } from "../src/hud/nav-announce";

describe("arrivalNote", () => {
  it("有下一站 / 没有下一站两种文案，都以「已到达」开头", () => {
    assert.equal(arrivalNote("广州塔", "海心沙"), "已到达广州塔，下一站海心沙");
    assert.equal(arrivalNote("长隆酒店", undefined), "已到达长隆酒店，今天的行程走完了");
  });
});

describe("createArrivalAnnouncer", () => {
  it("同一站第二帧不再发；没有 arrivedStopName 的帧什么都不发", async () => {
    const sent: string[] = [];
    const a = createArrivalAnnouncer(async (n) => {
      sent.push(n);
    });
    a.onProgress({});
    a.onProgress({ arrivedStopName: "A", nextStopName: "B" });
    await Promise.resolve();
    a.onProgress({ arrivedStopName: "A", nextStopName: "B" });
    assert.deepEqual(sent, ["已到达A，下一站B"]);
  });

  it("上一句还没回完时到了下一站 → 宁可少播一站", async () => {
    let release!: () => void;
    const sent: string[] = [];
    const a = createArrivalAnnouncer((n) => {
      sent.push(n);
      return new Promise<void>((r) => {
        release = r;
      });
    });
    a.onProgress({ arrivedStopName: "A", nextStopName: "B" });
    a.onProgress({ arrivedStopName: "B", nextStopName: "C" });
    assert.deepEqual(sent, ["已到达A，下一站B"]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    a.onProgress({ arrivedStopName: "C", nextStopName: undefined });
    assert.deepEqual(sent, ["已到达A，下一站B", "已到达C，今天的行程走完了"]);
  });

  it("reset 之后同一站可以再播（换一次导航）", async () => {
    const sent: string[] = [];
    const a = createArrivalAnnouncer(async (n) => {
      sent.push(n);
    });
    a.onProgress({ arrivedStopName: "A" });
    await new Promise((r) => setTimeout(r, 0));
    a.reset();
    a.onProgress({ arrivedStopName: "A" });
    assert.equal(sent.length, 2);
  });
});
