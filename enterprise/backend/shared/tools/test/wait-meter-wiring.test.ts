/**
 * 排队计量的**接线**：闸门上的等待要一路回到 `invokeTool` 的观察者（M77 走查追修）。
 *
 * 为什么单独一个文件：`wait-meter.test.ts` 测的是账本本身，它全绿也说明不了
 * 真链路上的那一段被记下来了——中间隔着 `defineExternalTool` → 工具的 `real()`
 * → `PoiSearchBackend` → `AmapClient.get()` 四层，而这几层接口都只收 signal。
 * 漏接线不报错，症状只是页面上每条工具的"等待"恒为 0，
 * 看起来像"我们的闸门没造成排队"——正好是要查的那件事的反面。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createAmapClient, setAmapClient } from "../src/amap";
import { invokeTool, setToolObserver, type ToolInvocationObservation } from "../src/registry";

/** 高德的 place/text 成功响应，最小形状。 */
const OK_PLACE = {
  status: "1",
  infocode: "10000",
  pois: [
    {
      id: "B1",
      name: "南通博物苑",
      address: "濠南路19号",
      location: "120.869839,32.011296",
      adcode: "320602",
      cityname: "南通市",
    },
  ],
};

const OK_DISTRICT = {
  status: "1",
  infocode: "10000",
  districts: [{ adcode: "320600", name: "南通市", level: "city" }],
};

function stubFetch(): typeof fetch {
  return (async (url: URL | string) => {
    const path = String(url);
    const body = path.includes("/config/district") ? OK_DISTRICT : OK_PLACE;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  setAmapClient(undefined);
  setToolObserver(undefined);
});

describe("排队计量接线：闸门 → invokeTool 的观察者", () => {
  it("**闸门造成的等待出现在这一跳的 waitMs 上**", async () => {
    /*
     * 桶给 2、间隔 300ms。注入了 fetchImpl 的客户端默认不设闸（单测不打真网络），
     * 所以这里显式把 minGapMs 传进去——要测的就是闸门那一段。
     *
     * 第一跳打两个请求（先查行政区、再查 POI），正好用掉两张票，一次都不等；
     * 第二跳行政区已缓存、只打一个请求，桶空了，于是在门口等一轮。
     * **一次工具调用打几个高德请求是它自己的事**，计量按跳记，不按请求记。
     */
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubFetch(), minGapMs: 300, burst: 2 }));
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));

    const ctx = { sessionId: "s", turnId: "t", agent: "tour", mode: "real" } as never;
    const args = { city: "南通", keywords: "博物苑", limit: 5 } as never;
    await invokeTool("spot_search", args, ctx);
    await invokeTool("spot_search", args, ctx);

    assert.equal(seen.length, 2);
    /*
     * 首跳桶里有票，不该等到下一轮。但也别断言恰好 0：取票本身要过一次
     * promise 链（闸门把并发取票排成一条链，见 `createAmapRateGate`），
     * 于是量到 0~2ms 的一跳——那是调度，不是排队。
     */
    assert.ok(seen[0]!.waitMs < 50, `首跳不该等一轮，实际 ${seen[0]!.waitMs}ms`);
    /*
     * 只断言"等了，且不超过一轮"，不钉具体毫秒数：闸门是**按发车时刻**计时的，
     * 它会把首跳已经花掉的时间算进间隔里——于是次跳实际等的是 `300 − 首跳耗时`。
     * 机器一忙首跳就可能花掉几十毫秒，钉死 250 这类下界必然随机红。
     */
    assert.ok(seen[1]!.waitMs > 0, "次跳该在门口排队，实际没等");
    // 上界留出定时器的过冲（实测 301ms）：这里要否掉的是"等了两轮"，不是几毫秒的抖动。
    assert.ok(seen[1]!.waitMs < 600, `等的不该超过一轮，实际 ${seen[1]!.waitMs}ms`);
    // 排队是这一跳时长的一部分，不是额外加上去的。
    assert.ok(seen[1]!.waitMs <= seen[1]!.endedAt - seen[1]!.startedAt);
  });

  it("**没经过闸门的工具是 0，不是 undefined**", async () => {
    // 0 的意思是"这一跳没排队"，字段缺失的意思是"这一轮跑在埋点之前"。
    // 两者在页面上要分得开，所以这里恒为数字。
    const seen: ToolInvocationObservation[] = [];
    setToolObserver((o) => seen.push(o));
    await invokeTool(
      "cost_calc",
      { vehiclePrice: 260000, energy: "bev" } as never,
      { sessionId: "s", agent: "buying" } as never,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.waitMs, 0);
  });
});
