/**
 * 「这一跳里有多少是排我们自己的队」的计量（M77 走查追修）。
 *
 * 为什么要有这个文件：轨迹上 `tool.spot_search` 写着 4770ms，
 * 而那 4.77 秒里有多少是高德在算、多少是它在我们的限速闸前干等，
 * 原先看不出来——两者的处置却相反：等上游只能等，排自己的队调得动。
 *
 * 这里钉四件事：
 *  1. 闸门上的等待能穿过四层接口回到 `invokeTool`（靠异步上下文，不靠传参）；
 *  2. 并发的等待**取并集**，不是累加（否则会得出比这一跳还长的等待）；
 *  3. 并发的两次工具调用各记各的，不串账；
 *  4. 失败路径也有数——被限流退避到超时的那一条最该看清等了多久。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openWaitMeter, recordWait } from "../src/wait-meter";

describe("排队计量", () => {
  it("**并发的等待取并集，不是累加**", async () => {
    // map-route 的两端地理编码是并发的，两次等待在时间上重叠。
    // 累加会得出 700ms——比这一跳的墙钟还长，画出来是一条溢出边界的条。
    const m = openWaitMeter();
    await m.run(async () => {
      recordWait(1000, 1350);
      recordWait(1100, 1350);
    });
    assert.equal(m.waitMs(), 350);
  });

  it("**不相交的等待相加**——一次调用打了三个高德请求，三次排队都算", async () => {
    const m = openWaitMeter();
    await m.run(async () => {
      recordWait(0, 350);
      recordWait(700, 1050);
      recordWait(1400, 1750);
    });
    assert.equal(m.waitMs(), 1050);
  });

  it("**穿得过 await 链**：等待发生在四层之下，不靠把 ctx 一路传下去", async () => {
    // 真实形状是 invokeTool → defineExternalTool → 工具的 real() → 后端 → AmapClient.get()，
    // 而中间那几个接口只收 signal。异步上下文是这里唯一不用改接口的办法。
    const deep = async (): Promise<void> => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      recordWait(0, 42);
    };
    const m = openWaitMeter();
    await m.run(async () => {
      await (async () => deep())();
    });
    assert.equal(m.waitMs(), 42);
  });

  it("**两次并发调用各记各的**——fan-out 里四条分支同时在打高德", async () => {
    const a = openWaitMeter();
    const b = openWaitMeter();
    await Promise.all([
      a.run(async () => {
        await new Promise((r) => setTimeout(r, 2));
        recordWait(0, 100);
      }),
      b.run(async () => {
        recordWait(0, 900);
        await new Promise((r) => setTimeout(r, 1));
      }),
    ]);
    assert.equal(a.waitMs(), 100);
    assert.equal(b.waitMs(), 900);
  });

  it("**失败路径也拿得到数**——被限流退避到超时那条最该看清等了多久", async () => {
    const m = openWaitMeter();
    await assert.rejects(
      m.run(async () => {
        recordWait(0, 1200);
        throw new Error("upstream boom");
      }),
      /boom/,
    );
    assert.equal(m.waitMs(), 1200);
  });

  it("**没人计量时静默丢弃**——计量不该让被计量的代码多一条分支", () => {
    // 探针脚本、单测、worker 里的直调都不经 invokeTool。
    assert.doesNotThrow(() => recordWait(0, 500));
  });

  it("**零长与倒挂的区间不进账**", async () => {
    const m = openWaitMeter();
    await m.run(async () => {
      recordWait(500, 500);
      recordWait(900, 800);
    });
    assert.equal(m.waitMs(), 0);
  });
});
