/**
 * 思考时长分段（施工单 TD-08 追加，F-44-04）。零依赖纯函数直测。
 *
 * 分段判据是本模块唯一会算错的地方，而算错在页面上看不出来：
 * 合成一段会横跨中间的工具调用，读起来像"思考和工具在并行"，
 * 而实际是交替的——那正好把"模型想了两次"这件事抹掉。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitThinkBursts, THINK_GAP_MS, type ThoughtTick } from "../src/acp-client/think";

const tick = (at: number, chars = 10): ThoughtTick => ({ at, chars });

describe("思考分段", () => {
  it("连续到达的片合成一段", () => {
    const b = splitThinkBursts([tick(0), tick(20), tick(45), tick(70)]);
    assert.equal(b.length, 1);
    assert.deepEqual(
      { startedAt: b[0].startedAt, endedAt: b[0].endedAt, chunks: b[0].chunks },
      { startedAt: 0, endedAt: 70, chunks: 4 },
    );
  });

  it("**中间隔着一次工具往返就分成两段**——模型想了两次，不是一次", () => {
    // 实测形状：想 → 调工具（约 680ms）→ 拿到结果再想。
    const b = splitThinkBursts([tick(0), tick(30), tick(60), tick(740), tick(770)]);
    assert.equal(b.length, 2, "合成一段会横跨工具调用，读起来像并行");
    assert.equal(b[0].endedAt, 60);
    assert.equal(b[1].startedAt, 740);
  });

  it("阈值落在两个数量级之间：片间隔毫秒级，工具往返数百毫秒", () => {
    // 刚好等于阈值仍算同一段（<=），确保边界不来回抖
    assert.equal(splitThinkBursts([tick(0), tick(THINK_GAP_MS)]).length, 1);
    assert.equal(splitThinkBursts([tick(0), tick(THINK_GAP_MS + 1)]).length, 2);
  });

  it("**单片也算一段**——「只想了一下」与「完全没想」不能长得一样", () => {
    const b = splitThinkBursts([tick(500)]);
    assert.equal(b.length, 1);
    assert.equal(b[0].startedAt, b[0].endedAt, "时长 0，但它确实发生过");
    assert.equal(b[0].chunks, 1);
  });

  it("没有思考片时返回空——不伪造一段 0ms", () => {
    assert.deepEqual(splitThinkBursts([]), []);
  });

  it("字数累加，用于区分「想得久」与「想得多」", () => {
    const b = splitThinkBursts([tick(0, 120), tick(50, 80)]);
    assert.equal(b[0].chars, 200);
  });

  it("阈值可调——不同模型的流式节奏不同，不该把 400 焊死在逻辑里", () => {
    const ticks = [tick(0), tick(200)];
    assert.equal(splitThinkBursts(ticks, 100).length, 2);
    assert.equal(splitThinkBursts(ticks, 300).length, 1);
  });
});
