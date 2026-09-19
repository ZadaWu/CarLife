/**
 * 高德客户端出口上的发车闸门。
 *
 * 为什么要有这个文件：限速原来写在**调用点**——坐标回填一份 `sleep(350)`、
 * 逐日车程一份，而 `map-route` 找服务区是 `Promise.all` 一把打出去、一份也没有。
 * 三处互相不知道对方此刻在不在发，同一秒叠起来就超限，而且哪几个被拒是随机的，
 * 复现不了。闸门收到唯一出口 `get()` 上之后，这里钉三件事：
 *
 *  1. 每个请求都过闸（不是只有某几个 API 过）；
 *  2. 持续速率压得住，脉冲放得过（令牌桶，不是定速）；
 *  3. **闸门跟着真 fetch 走**——注入 fetchImpl 的客户端（单测）不设闸，
 *     用全局 fetch 的客户端（生产、探针）必须设闸。第 3 条最容易在重构里丢掉，
 *     丢了之后单测全绿而线上随机少坐标。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import {
  AMAP_ALL_LANES_RETIRED_CODE,
  AMAP_KEY_ENV_NAMES,
  AMAP_KEY_MAX,
  AMAP_LEDGER_REFRESH_MS,
  AMAP_LOCAL_QUEUE_CODE,
  createAmapClient,
  createAmapRateGate,
  isDailyQuotaExhausted,
  isRateLimited,
  resolveAmapKeys,
} from "../src/amap";
import {
  amapKeyFingerprint,
  createMemoryAmapLedger,
  type AmapApiFamily,
  type AmapUsageLedger,
} from "../src/amap-ledger";
import { ToolError } from "../src/external";

/** 假时钟：不靠墙钟，否则这组用例在 CI 上会飘。 */
function fakeClock() {
  let t = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createAmapRateGate：令牌桶", () => {
  it("桶满时脉冲直接放过——map-route 的「3 个服务区一把查」本来是安全的，别把它拖慢", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(1, 350, 6, c);
    await Promise.all(Array.from({ length: 6 }, () => gate.take()));
    assert.deepEqual(c.waits, [], "6 张票在桶里，一次都不该等");
  });

  it("桶空之后按持续速率放——第 7 个开始等，每张票隔 350ms", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(1, 350, 6, c);
    for (let i = 0; i < 9; i += 1) await gate.take();
    assert.equal(c.waits.length, 3, "前 6 个不等，后 3 个各等一次");
    for (const w of c.waits) assert.ok(w >= 349 && w <= 350, `等了 ${w}ms，该是 ~350ms`);
  });

  it("等待期间桶会回血：闲久了回满（按间隔补，不超过容量）", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(1, 350, 6, c);
    for (let i = 0; i < 6; i += 1) await gate.take();
    c.advance(10_000); // 闲很久
    c.waits.length = 0;
    for (let i = 0; i < 6 ; i += 1) await gate.take();
    assert.deepEqual(c.waits, [], "回血到满，6 个又都不等");
    await gate.take();
    assert.equal(c.waits.length, 1, "第 7 个才等——容量封顶在 6，不会攒出无限张");
  });

  it("**同时进来的请求依次取票**——各读余量再各扣会让十个一起放过", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(1, 350, 2, c);
    await Promise.all(Array.from({ length: 5 }, () => gate.take()));
    assert.equal(c.waits.length, 3, "容量 2，5 个里有 3 个必须排队");
  });

  it("minGapMs<=0 表示不设闸（注入 fetch 的单测走这条）", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(1, 0, 6, c);
    for (let i = 0; i < 50; i += 1) await gate.take();
    assert.deepEqual(c.waits, []);
  });

  it("排队时被取消：只失败自己，后面的照发", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(1, 350, 1, c);
    await gate.take(); // 取空
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => gate.take(ac.signal));
    await gate.take(); // 链没被那次失败带走
    assert.ok(c.waits.length >= 1);
  });
});

describe("闸门装在客户端唯一出口上", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const OK = {
    status: "1",
    infocode: "10000",
    pois: [{ name: "甲", location: "120.1,31.2", cityname: "苏州", type: "风景名胜" }],
    districts: [{ level: "city", adcode: "320500", name: "苏州市" }],
    regeocode: { formatted_address: "某处", addressComponent: { adcode: "320500", city: "苏州市" } },
  };

  function stub() {
    const at: number[] = [];
    const impl = (async () => {
      at.push(Date.now());
      return { ok: true, status: 200, json: async () => OK } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, at };
  }

  it("**用全局 fetch 建的客户端必须被限**——生产与探针走的是这条", async () => {
    const { impl, at } = stub();
    globalThis.fetch = impl;
    // 容量 1、间隔 50ms → 第二个请求必须等 ~50ms，够断言又不拖慢用例。
    const amap = createAmapClient({ key: "k", minGapMs: 50, burst: 1 });
    await amap.textSearch({ keywords: "甲", region: "苏州", limit: 1 });
    await amap.textSearch({ keywords: "乙", region: "苏州", limit: 1 });
    assert.equal(at.length, 2);
    assert.ok(at[1]! - at[0]! >= 40, `两次发车间隔 ${at[1]! - at[0]!}ms，闸门没生效`);
  });

  it("注入 fetchImpl 的客户端缺省不设闸——不然 700 多条用例每条白等 300ms", async () => {
    const { impl, at } = stub();
    const amap = createAmapClient({ key: "k", fetchImpl: impl });
    const t0 = Date.now();
    for (let i = 0; i < 12; i += 1) await amap.textSearch({ keywords: `p${i}`, region: "苏州", limit: 1 });
    assert.equal(at.length, 12);
    assert.ok(Date.now() - t0 < 200, "缺省该是不设闸");
  });

  it("过闸的不止某一个 API——district / regeo 也走同一条出口", async () => {
    const { impl, at } = stub();
    const amap = createAmapClient({ key: "k", fetchImpl: impl, minGapMs: 50, burst: 1 });
    await amap.resolveRegion("苏州");
    await amap.regeo({ lat: 31.2, lon: 120.1 });
    assert.equal(at.length, 2);
    assert.ok(at[1]! - at[0]! >= 40, "regeo 绕过了闸门");
  });
});

/**
 * 标定值本身也要钉一条：这两个数是拿真实工作负载试出来的（容量 3 起就报限，
 * 而报限要退避 1 秒重试，赔的比抢来的多）。改它必须带着新的实测回来改这条断言。
 */
describe("缺省参数就是标定值", () => {
  const SRC = readFileSync(new URL("../src/amap.ts", import.meta.url), "utf8");

  it("间隔 350ms、容量 2", () => {
    assert.match(SRC, /const AMAP_MIN_GAP_MS = 350;/);
    assert.match(SRC, /const AMAP_BURST = 2;/);
  });

  it("标定过程留在注释里——不写就会被当成拍的数去调大", () => {
    const doc = SRC.slice(0, SRC.indexOf("const AMAP_MIN_GAP_MS"));
    assert.match(doc, /报限/);
    assert.match(doc, /容量给大反而更慢/);
    assert.match(doc, /进程内/, "跨进程管不到这件事必须写明");
  });
});

/**
 * 多账号 key 池：每把 key 一条车道。
 *
 * 判断依据不是"多几把 key 就快几倍"，而是**高德按什么维度限流**——
 * `10021` 的原文是「账号使用某个服务接口 QPS 超出限制」，`10029`/`10020` 才是按 Key 的，
 * 而我们实测撞的一直是 10021。所以同账号加 key 一点用没有，另一个账号才是另一份额度。
 */
describe("多车道：一个账号一条", () => {
  it("两条车道的脉冲容量是两倍，同时来 4 个都不等", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(2, 350, 2, c);
    const lanes = await Promise.all(Array.from({ length: 4 }, () => gate.take()));
    assert.deepEqual(c.waits, [], "两条车道各 2 张票，4 个正好不用等");
    assert.deepEqual([...lanes].sort(), [0, 0, 1, 1], "两条车道均摊，不是全压在 0 号上");
  });

  it("持续速率是车道数除以间隔——两条车道的第 5、6 个各等一半的时间", async () => {
    const c = fakeClock();
    const one = createAmapRateGate(1, 350, 2, c);
    for (let i = 0; i < 6; i += 1) await one.take();
    const single = c.waits.reduce((a, b) => a + b, 0);

    const c2 = fakeClock();
    const two = createAmapRateGate(2, 350, 2, c2);
    for (let i = 0; i < 6; i += 1) await two.take();
    const dual = c2.waits.reduce((a, b) => a + b, 0);
    assert.ok(dual * 2 <= single + 1, `单车道共等 ${single}ms、双车道共等 ${dual}ms，没有减半`);
  });

  it("挑当下最空的那条——余量少的车道不会被继续压", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(2, 350, 2, c);
    const lanes: number[] = [];
    for (let i = 0; i < 4; i += 1) lanes.push(await gate.take());
    assert.deepEqual(lanes, [0, 1, 0, 1], "取完一张就换到余量更多的那条，不是把 0 号抽干再换");
  });

  it("排队仍是一条 FIFO：先到的先拿到票", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(2, 350, 1, c);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        gate.take().then(() => {
          order.push(i);
        }),
      ),
    );
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5], "后到的插了队");
  });
});

/**
 * 排队封顶：**闷头等到工具超时是最差的结果**。
 * 打高德那几个工具的预算是 8 秒，等满之后抛的是一句笼统的「超时」，
 * 看起来像高德慢，而真相是我们自己的闸门排不过来（实跑：map_route 5.3 秒里 5.0 秒在排队）。
 */
describe("排队封顶", () => {
  it("超过封顶就抛，且错误码是本地的那个，不冒充高德的 10021", async () => {
    const c = fakeClock();
    // 间隔 350ms 而封顶 200ms：第二个请求要等 350ms，一定越界。
    const gate = createAmapRateGate(1, 350, 1, { ...c, maxQueueMs: 200 });
    await gate.take(); // 取空
    const err = await gate.take().then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, AMAP_LOCAL_QUEUE_CODE);
    assert.equal(err.retryable, true, "值得重试——是我们排不过来，不是请求本身有问题");
    assert.match(err.message, /闸门排不过来/);
  });

  it("本地封顶也算「被限流」——处置一样：加额度或者少发", () => {
    assert.equal(isRateLimited(new ToolError("amap", "timeout", "x", true, AMAP_LOCAL_QUEUE_CODE)), true);
  });

  it("封顶内的等待照常放过，不是一律拒绝", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(1, 350, 1, { ...c, maxQueueMs: 5_000 });
    for (let i = 0; i < 6; i += 1) await gate.take();
    assert.equal(c.waits.length, 5, "都等到了，一个都没被拒");
  });

  it("**封顶算的是各自进闸门那一刻起的总时长**——排在后面的越界，排在前面的照常", async () => {
    /*
     * 这正是线上那个形状：fan-out 首波十几个请求几乎同时到，靠后的那几个
     * 要等好几秒。它们的 enteredAt 都是同一刻，所以越往后越先撞封顶。
     */
    const c = fakeClock();
    const gate = createAmapRateGate(1, 100, 1, { ...c, maxQueueMs: 250 });
    const out = await Promise.all(
      Array.from({ length: 8 }, () => gate.take().then(() => "ok" as const, () => "拒" as const)),
    );
    assert.deepEqual(out.slice(0, 3), ["ok", "ok", "ok"], "前 3 个在 250ms 内轮得到");
    assert.ok(out.slice(3).every((r) => r === "拒"), `第 4 个起该全拒，实际 ${out.join(",")}`);
  });

  it("maxQueueMs<=0 表示不封顶（老行为）", async () => {
    const c = fakeClock();
    const gate = createAmapRateGate(1, 350, 1, { ...c, maxQueueMs: 0 });
    for (let i = 0; i < 20; i += 1) await gate.take();
    assert.equal(c.waits.length, 19);
  });
});

describe("客户端按车道换 key", () => {
  it("两把 key 轮着上，且请求串里带的是那一把", async () => {
    const used: string[] = [];
    const impl = (async (input: URL | RequestInfo) => {
      used.push(new URL(String(input)).searchParams.get("key") ?? "?");
      return { ok: true, status: 200, json: async () => ({ status: "1", infocode: "10000", pois: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const amap = createAmapClient({ key: ["k1", "k2"], fetchImpl: impl, minGapMs: 1, burst: 1 });
    for (let i = 0; i < 4; i += 1) await amap.textSearch({ keywords: `p${i}`, region: "苏州", limit: 1 });
    assert.equal(used.length, 4);
    assert.ok(used.includes("k1") && used.includes("k2"), `两把都该用上，实际 ${used.join(",")}`);
  });

  it("只给一把 key 时行为与从前逐字相同", async () => {
    const used: string[] = [];
    const impl = (async (input: URL | RequestInfo) => {
      used.push(new URL(String(input)).searchParams.get("key") ?? "?");
      return { ok: true, status: 200, json: async () => ({ status: "1", infocode: "10000", pois: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const amap = createAmapClient({ key: "solo", fetchImpl: impl });
    await amap.textSearch({ keywords: "甲", region: "苏州", limit: 1 });
    assert.deepEqual(used, ["solo"]);
  });

  it("空 key 直接报未接入，不要发一个必然被拒的请求", () => {
    assert.throws(() => createAmapClient({ key: [] }), /没有可用的高德 key/);
    assert.throws(() => createAmapClient({ key: ["  "] }), /没有可用的高德 key/);
  });
});

describe("同账号加 key 没用这件事要写在代码里", () => {
  const SRC = readFileSync(new URL("../src/amap.ts", import.meta.url), "utf8");

  it("注释点明 10021 是账号维度、10029/10020 才是 key 维度", () => {
    assert.match(SRC, /10021/);
    assert.match(SRC, /账号.*QPS|QPS.*账号/);
    assert.match(SRC, /同.*账号.*没有意义|同一个账号下的多把 key/);
  });

  it("封顶的缺省值与工具 8 秒预算的关系要写明——不然下个人会随手调大", () => {
    const doc = SRC.slice(0, SRC.indexOf("const AMAP_MAX_QUEUE_MS"));
    assert.match(doc, /8 秒/);
  });
});

/**
 * key 环境变量名只有一处定义。原先它散在三处（agent-runtime 装配、worker 装配、probe），
 * 加一把 key 漏改一处不报错——那个进程只是少一条车道，表现是"某个服务比别的慢"。
 */
describe("key 环境变量名收在一处", () => {
  const root = new URL("../../../../../", import.meta.url);
  const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");

  it("第一个必须是 AMAP_SERVER_KEY——顺序即车道顺序，也是单 key 时的那一把", () => {
    assert.equal(AMAP_KEY_ENV_NAMES[0], "AMAP_SERVER_KEY");
    assert.ok(AMAP_KEY_ENV_NAMES.length >= 2);
    assert.equal(new Set(AMAP_KEY_ENV_NAMES).size, AMAP_KEY_ENV_NAMES.length, "有重复的名字");
  });

  it("清单由 AMAP_KEY_MAX 生成：_2 … _10 逐个在，没有跳号", () => {
    assert.equal(AMAP_KEY_ENV_NAMES.length, AMAP_KEY_MAX);
    for (let i = 1; i < AMAP_KEY_MAX; i += 1) assert.equal(AMAP_KEY_ENV_NAMES[i], `AMAP_SERVER_KEY_${i + 1}`);
  });

  it("三个读 key 的地方都走 resolveAmapKeys，没有谁再写一份字面量或自己 map 清单（M100-01）", () => {
    for (const f of [
      "enterprise/backend/agent-runtime/src/index.ts",
      "enterprise/backend/worker/src/trip-plan-review.ts",
      "scripts/dev/probe/amap-probe.mts",
    ]) {
      const src = read(f);
      assert.match(src, /resolveAmapKeys\(/, `${f} 没用 resolveAmapKeys`);
      assert.ok(!/\["AMAP_SERVER_KEY", ?"AMAP_SERVER_KEY_2"/.test(src), `${f} 里还留着一份写死的名字数组`);
      assert.ok(!/AMAP_KEY_ENV_NAMES\s*\.map/.test(src), `${f} 自己在 map 清单——去重与指纹会漏`);
    }
  });

  it("配置注册表按同一个上限生成——不在注册表就读不到，而且不报错", () => {
    /*
     * `@carlife/db` 不依赖 `@carlife/tools`（方向反了会成环），所以那边另写了一个 `AMAP_SERVER_KEY_MAX`。
     * 这里钉两处相等，并钉生成器的形状：第一条手写、其余按 `_${n}` 生成。db 侧的 `config-model.test.ts`
     * 再从注册表对象上数一遍条目数。
     */
    const reg = read("enterprise/backend/shared/db/src/config/registry.ts");
    assert.match(reg, new RegExp(`export const AMAP_SERVER_KEY_MAX = ${AMAP_KEY_MAX};`), "两边的上限不相等");
    assert.match(reg, /envFallback: "AMAP_SERVER_KEY",/, "第一条手写的 AMAP_SERVER_KEY 不在了");
    assert.match(reg, /envFallback: `AMAP_SERVER_KEY_\$\{n\}`/, "生成器没有按 _${n} 生成 envFallback");
    assert.match(reg, /\.\.\.amapServerKeyDefs\(\)/, "生成的条目没有 spread 进 CONFIG_REGISTRY");
    assert.match(reg, /envFallback: "AMAP_DAILY_BUDGET"/, "日预算没登记，guardValues 读不到");
  });
});

/**
 * 日配额用尽的车道退役（2026-09-16）。
 *
 * 多把 key 原先只分摊 QPS：闸门按余量挑车道，不知道某把 key 已经 `10044`。
 * 第一把 key 头一天用光、次日上午仍在超限，评测三分之一的搜索照样落到它头上、
 * 照样失败——而且 `10044` 不可重试，整条 case 就没坐标了。
 * 这组用例钉：撞到日配额 → 那条车道退役 → 同一个请求换 key 立刻重发；
 * 全退役 → 抛一个说得清的不可重试错，不再发请求。
 */
describe("日配额用尽的车道退役", () => {
  const exhausted = { status: "0", infocode: "10044", info: "USER_DAILY_QUERY_OVER_LIMIT" };
  const fine = { status: "1", infocode: "10000", pois: [] };

  function fetchByKey(table: Record<string, object>, used: string[]): typeof fetch {
    return (async (input: URL | RequestInfo) => {
      const key = new URL(String(input)).searchParams.get("key") ?? "?";
      used.push(key);
      const body = table[key] ?? exhausted;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("第一把 key 用光：同一个请求换第二把重发，之后再也不碰第一把", async () => {
    const used: string[] = [];
    const amap = createAmapClient({
      key: ["dead", "live"],
      fetchImpl: fetchByKey({ dead: exhausted, live: fine }, used),
    });
    await amap.textSearch({ keywords: "甲", region: "苏州", limit: 1 });
    await amap.textSearch({ keywords: "乙", region: "苏州", limit: 1 });
    await amap.textSearch({ keywords: "丙", region: "苏州", limit: 1 });
    assert.deepEqual(used, ["dead", "live", "live", "live"]);
  });

  it("设闸时也一样：退役的车道不再被挑中，哪怕它余量最满", async () => {
    const used: string[] = [];
    const amap = createAmapClient({
      key: ["dead", "live"],
      fetchImpl: fetchByKey({ dead: exhausted, live: fine }, used),
      minGapMs: 1,
      burst: 2,
    });
    for (let i = 0; i < 5; i += 1) await amap.textSearch({ keywords: `p${i}`, region: "苏州", limit: 1 });
    assert.equal(used.filter((k) => k === "dead").length, 1, `第一把只该被撞一次，实际 ${used.join(",")}`);
    assert.equal(used.filter((k) => k === "live").length, 5);
  });

  it("全用光：抛不可重试的 all_lanes_retired，且不再发请求", async () => {
    const used: string[] = [];
    const amap = createAmapClient({ key: ["a", "b"], fetchImpl: fetchByKey({}, used) });
    await assert.rejects(
      amap.textSearch({ keywords: "甲", region: "苏州", limit: 1 }),
      (err: unknown) => err instanceof ToolError && err.code === "10044" && err.retryable === false,
    );
    assert.deepEqual(used, ["a", "b"]);
    await assert.rejects(
      amap.textSearch({ keywords: "乙", region: "苏州", limit: 1 }),
      (err: unknown) =>
        err instanceof ToolError && err.code === AMAP_ALL_LANES_RETIRED_CODE && err.retryable === false,
    );
    assert.equal(used.length, 2, "全退役后不该再发任何请求");
  });

  it("10003 / 10044 是日配额；10021 不是——限流走退避，不退役", async () => {
    assert.ok(isDailyQuotaExhausted(new ToolError("amap", "upstream", "x", false, "10044")));
    assert.ok(isDailyQuotaExhausted(new ToolError("amap", "upstream", "x", false, "10003")));
    assert.equal(isDailyQuotaExhausted(new ToolError("amap", "upstream", "x", true, "10021")), false);
    assert.equal(isDailyQuotaExhausted(new Error("10044")), false);
    const used: string[] = [];
    const limited = { status: "0", infocode: "10021", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT" };
    const amap = createAmapClient({ key: ["a", "b"], fetchImpl: fetchByKey({ a: limited, b: fine }, used) });
    await assert.rejects(amap.textSearch({ keywords: "甲", region: "苏州", limit: 1 }), isRateLimited);
    assert.deepEqual(used, ["a"], "限流不换 key、不退役，原样冒出去让上层退避");
  });
});

/*
 * key 池：记账与按预算挑车道（M100-01）。
 *
 * 此前多 key 只均衡 QPS：闸门按令牌余量挑车道，不知道各 key 今天用了多少，退役只在撞到 10044 之后。
 * 于是每把 key 用光的那一发必失败。这组钉三件事：每一发都记账；有预算的族到九成就换 key；
 * 无预算的族逐字走从前的挑法；取票不等台账。
 */
describe("key 池：记账与按预算挑车道（M100-01）", () => {
  const fine = { status: "1", infocode: "10000", pois: [] };
  const limited = { status: "0", infocode: "10021", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT" };
  const exhausted = { status: "0", infocode: "10044", info: "USER_DAILY_QUERY_OVER_LIMIT" };
  const bad = { status: "0", infocode: "20000", info: "INVALID_PARAMS" };

  function fetchByKey(table: Record<string, object | object[]>, used: string[]): typeof fetch {
    return (async (input: URL | RequestInfo) => {
      const key = new URL(String(input)).searchParams.get("key") ?? "?";
      used.push(key);
      const entry = table[key] ?? fine;
      const body = Array.isArray(entry) ? (entry.shift() ?? fine) : entry;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  /** 让台账的异步落地在断言前排空——两个微任务够了（record → then）。 */
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  it("resolveAmapKeys：空位可跳、按值去重并点名重复的变量", () => {
    const warns: string[] = [];
    const env: Record<string, string> = { AMAP_SERVER_KEY: "a", AMAP_SERVER_KEY_3: " c ", AMAP_SERVER_KEY_7: "a" };
    const keys = resolveAmapKeys((n) => env[n], (m) => warns.push(m));
    assert.deepEqual(keys.map((k) => [k.name, k.key]), [["AMAP_SERVER_KEY", "a"], ["AMAP_SERVER_KEY_3", "c"]]);
    assert.equal(keys[0]!.fp, amapKeyFingerprint("a"));
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /AMAP_SERVER_KEY_7/);
    assert.match(warns[0]!, /AMAP_SERVER_KEY /);
  });

  it("每一发都记账：ok / 限流 / 配额用尽 / 其它错各计一次，分列存", async () => {
    const ledger = createMemoryAmapLedger();
    const used: string[] = [];
    const amap = createAmapClient({
      key: ["k"],
      fetchImpl: fetchByKey({ k: [fine, limited, bad] }, used),
      ledger,
      budget: {},
      now: () => Date.UTC(2026, 8, 16, 4), // 北京 12:00
    });
    await amap.textSearch({ keywords: "甲", region: "苏州", limit: 1 });
    await assert.rejects(amap.textSearch({ keywords: "乙", region: "苏州", limit: 1 }), isRateLimited);
    await assert.rejects(amap.textSearch({ keywords: "丙", region: "苏州", limit: 1 }));
    // 配额用尽：单把 key 退役后 `retire` 返回 false → 原错冒出；照样记一次。
    const dead = createAmapClient({ key: ["d"], fetchImpl: fetchByKey({ d: exhausted }, used), ledger, budget: {}, now: () => Date.UTC(2026, 8, 16, 4) });
    await assert.rejects(dead.textSearch({ keywords: "丁", region: "苏州", limit: 1 }), isDailyQuotaExhausted);
    await settle();
    const snap = await ledger.snapshot("2026-09-16");
    assert.deepEqual(snap[amapKeyFingerprint("k")], { "place:ok": 1, "place:rate_limited": 1, "place:error": 1 });
    assert.deepEqual(snap[amapKeyFingerprint("d")], { "place:quota_exhausted": 1 });
  });

  it("接口族按路径分：textSearch 先 district 再 place，两族各自记", async () => {
    const ledger = createMemoryAmapLedger();
    const impl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...fine, districts: [{ level: "city", adcode: "320500", name: "苏州市" }] }),
    })) as unknown as typeof fetch;
    const amap = createAmapClient({ key: ["k"], fetchImpl: impl, ledger, budget: {}, now: () => Date.UTC(2026, 8, 16, 4) });
    await amap.textSearch({ keywords: "甲", region: "苏州", cityLimit: true, limit: 1 });
    await settle();
    const snap = await ledger.snapshot("2026-09-16");
    assert.deepEqual(snap[amapKeyFingerprint("k")], { "district:ok": 1, "place:ok": 1 });
  });

  it("有预算的族到九成就换 key；全到顶仍能发（占比最低）且 warn 恰一条", async () => {
    const used: string[] = [];
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    try {
      let t = Date.UTC(2026, 8, 16, 4);
      const amap = createAmapClient({
        key: ["a", "b"],
        fetchImpl: fetchByKey({}, used),
        budget: { place: 10 },
        now: () => t,
      });
      for (let i = 0; i < 20; i += 1) {
        t += 10;
        await amap.textSearch({ keywords: `p${i}`, region: "苏州", limit: 1 });
      }
      const first18 = used.slice(0, 18);
      assert.equal(first18.filter((k) => k === "a").length, 9, `软顶 ceil(10×0.9)=9：a 只该接 9 发，实际 ${first18.join("")}`);
      assert.equal(first18.filter((k) => k === "b").length, 9);
      assert.equal(used.length, 20, "全到顶的第 19、20 发照样发出去了——预算是偏好不是拒绝");
      const budgetWarns = warns.filter((w) => w.includes("都到今日预算"));
      assert.equal(budgetWarns.length, 1, `warn 该恰一条（一分钟内不重复），实际 ${budgetWarns.length}`);
    } finally {
      console.warn = realWarn;
    }
  });

  it("无预算的族逐字走从前的挑法：geocode 在 place 已偏心时仍按令牌均摊", async () => {
    const used: string[] = [];
    const geo = { status: "1", infocode: "10000", geocodes: [{ location: "120.1,31.2", formatted_address: "某处", adcode: "320500", city: "苏州市" }] };
    // 设闸时闸门也按注入的时钟回血。时钟不动、桶 2：两把各 2 张票，4 发正好不用等，
    // 且与「挑当下最空的那条」同形——取完一张就换到余量更多的那条。
    const amap = createAmapClient({
      key: ["a", "b"],
      fetchImpl: fetchByKey({ a: geo, b: geo }, used),
      budget: { place: 10 },
      minGapMs: 350,
      burst: 2,
      now: () => Date.UTC(2026, 8, 16, 4),
    });
    for (let i = 0; i < 4; i += 1) await amap.geocode(`地名${i}`);
    assert.deepEqual(used, ["a", "b", "a", "b"], "无预算的族按令牌均摊，与 M100 之前逐字相同");
  });

  it("取票不等台账：snapshot / record 永不 resolve，20 发照样出去", async () => {
    const never = new Promise<never>(() => {});
    const stuck: AmapUsageLedger = {
      record: () => never,
      snapshot: () => never,
      retire: () => never,
      retired: () => never,
      revive: () => never,
      observations: () => never,
    };
    const used: string[] = [];
    const amap = createAmapClient({ key: ["a", "b"], fetchImpl: fetchByKey({}, used), ledger: stuck, budget: { place: 10 }, now: () => Date.UTC(2026, 8, 16, 4) });
    for (let i = 0; i < 20; i += 1) await amap.textSearch({ keywords: `p${i}`, region: "苏州", limit: 1 });
    assert.equal(used.length, 20);
    // 镜像是发出前 +1 的，所以即便台账永不回来，软顶照样按本进程计数生效。
    assert.equal(used.slice(0, 18).filter((k) => k === "a").length, 9);
  });

  it("镜像按台账校正：别的进程记的账在下一次刷新后参与挑车道", async () => {
    const ledger = createMemoryAmapLedger();
    // "别的进程"已经把 a 用到 9 次。
    for (let i = 0; i < 9; i += 1) await ledger.record(amapKeyFingerprint("a"), "place" as AmapApiFamily, "ok", Date.UTC(2026, 8, 16, 4));
    const used: string[] = [];
    let t = Date.UTC(2026, 8, 16, 4);
    const amap = createAmapClient({ key: ["a", "b"], fetchImpl: fetchByKey({}, used), ledger, budget: { place: 10 }, now: () => t });
    // 第一发触发 refresh（异步）；等它回来后 a 已在软顶外。
    await amap.textSearch({ keywords: "p0", region: "苏州", limit: 1 });
    await settle();
    for (let i = 1; i < 6; i += 1) {
      t += 10;
      await amap.textSearch({ keywords: `p${i}`, region: "苏州", limit: 1 });
    }
    assert.ok(used.slice(1).every((k) => k === "b"), `刷新后 a 该出局，实际 ${used.join(",")}`);
  });
});

/**
 * [F-10-09] 退役的持久化与探活复活（M100-02）。
 *
 * 高德没有余量查询、重置点也不是 00:00，"这把 key 回来了没有"只能发一发看看。
 * 探活不是额外请求：到点了让退役车道当一次候选，被挑中的是一个本来就要发的请求。
 */
describe("退役持久化与探活复活（M100-02）", () => {
  const fine = { status: "1", infocode: "10000", pois: [] };
  const exhausted = { status: "0", infocode: "10044", info: "USER_DAILY_QUERY_OVER_LIMIT" };
  const H = 3_600_000;
  const T0 = Date.UTC(2026, 8, 16, 4); // 北京 12:00
  const fpA = amapKeyFingerprint("a");

  /** 按 key 给一份脚本：`script[key]` 是队列，取空后回 fine。 */
  function fetchScripted(script: Record<string, object[]>, used: string[]): typeof fetch {
    return (async (input: URL | RequestInfo) => {
      const key = new URL(String(input)).searchParams.get("key") ?? "?";
      used.push(key);
      const body = script[key]?.shift() ?? fine;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  const search = (amap: ReturnType<typeof createAmapClient>, i: number) =>
    amap.textSearch({ keywords: `p${i}`, region: "苏州", limit: 1 });

  it("闸门：退役车道每个探活周期恰被交出一次，其余时间不碰；再退役保留首次退役时刻", async () => {
    let t = T0;
    const gate = createAmapRateGate(2, 0, 0, { now: () => t, reviveProbeMs: H });
    assert.equal(gate.retire(0, t), true);
    for (let i = 0; i < 5; i += 1) {
      t += 10 * 60_000;
      assert.equal(await gate.take(), 1, `第 ${i} 发（退役后 ${(i + 1) * 10} 分钟）不碰退役车道`);
    }
    t = T0 + H;
    assert.equal(await gate.take(), 0, "到点：退役车道当一次候选");
    assert.equal(await gate.take(), 1, "只此一次");
    t = T0 + 2 * H - 1;
    assert.equal(await gate.take(), 1);
    gate.retire(0, t); // 探活又撞 10044：只推后下一次探活
    assert.equal(gate.retiredSince(0), T0, "退役时刻保留首次");
    t = T0 + 3 * H - 2;
    assert.equal(await gate.take(), 1, "距上次探活不足一个周期");
    t = T0 + 3 * H - 1;
    assert.equal(await gate.take(), 0);
    gate.revive(0);
    assert.equal(gate.retiredSince(0), undefined);
    assert.equal(await gate.take(), 0, "复活后无偏好时逐字回到从前：挑第一条");
  });

  it("探活成功 → 复活：闸门放回、台账 revive 留一条观测、之后两把 key 都在用", async () => {
    let t = T0;
    const ledger = createMemoryAmapLedger();
    const used: string[] = [];
    const amap = createAmapClient({
      key: ["a", "b"],
      fetchImpl: fetchScripted({ a: [exhausted] }, used),
      ledger,
      budget: { place: 100 },
      now: () => t,
      reviveProbeMs: H,
    });
    await search(amap, 0); // a 10044 → 退役 → 同一请求换 b
    assert.deepEqual(used, ["a", "b"]);
    await settle();
    assert.deepEqual(Object.keys(await ledger.retired()), [fpA], "退役写进台账");
    assert.equal((await ledger.retired())[fpA]!.infocode, "10044");
    for (let i = 1; i <= 3; i += 1) {
      t += 10 * 60_000;
      await search(amap, i);
    }
    assert.equal(used.filter((k) => k === "a").length, 1, "退役中不碰 a");
    t = T0 + 1.5 * H;
    await search(amap, 9); // 探活：a 回 fine → 复活
    assert.equal(used.at(-1), "a");
    await settle();
    assert.deepEqual(await ledger.retired(), {}, "台账里也复活了");
    const obs = await ledger.observations();
    assert.equal(obs.length, 1);
    assert.equal(obs[0]!.hours, 1.5);
    used.length = 0;
    for (let i = 0; i < 6; i += 1) await search(amap, 20 + i);
    assert.ok(used.includes("a") && used.includes("b"), `复活后两把都在用，实际 ${used.join(",")}`);
  });

  it("探活再撞 10044：请求照样换活车道成功，退役时刻不变，下一周期再探", async () => {
    let t = T0;
    const ledger = createMemoryAmapLedger();
    const used: string[] = [];
    const amap = createAmapClient({
      key: ["a", "b"],
      fetchImpl: fetchScripted({ a: [exhausted, exhausted] }, used),
      ledger,
      budget: {},
      now: () => t,
      reviveProbeMs: H,
    });
    await search(amap, 0);
    t = T0 + H;
    await search(amap, 1); // 探活仍 10044 → 继续退役 → 换 b
    assert.deepEqual(used, ["a", "b", "a", "b"]);
    await settle();
    assert.equal((await ledger.retired())[fpA]!.at, T0, "台账里的退役时刻保留首次");
    t = T0 + H + 30 * 60_000;
    await search(amap, 2);
    assert.equal(used.at(-1), "b", "距上次探活半小时：不探");
    t = T0 + 2 * H;
    await search(amap, 3); // 第三发脚本取空 → fine → 复活
    assert.equal(used.at(-1), "a");
    await settle();
    assert.equal((await ledger.observations())[0]!.hours, 2);
  });

  it("新建客户端读到台账里的退役：第一发不落到那把 key；台账里消失后按台账复活", async () => {
    let t = T0;
    const ledger = createMemoryAmapLedger();
    await ledger.retire(fpA, { at: T0 - 10 * 60_000, family: "place", infocode: "10044" });
    const used: string[] = [];
    const amap = createAmapClient({
      key: ["a", "b"],
      fetchImpl: fetchScripted({}, used),
      ledger,
      budget: {},
      now: () => t,
      reviveProbeMs: H,
    });
    await settle(); // 启动读一次台账（不阻塞取票，所以这里等它落地）
    await search(amap, 0);
    assert.deepEqual(used, ["b"], "别的进程退役的 key 本进程也不发");
    // 别的进程探活成功、台账里没了：退役已超宽限期，下一次镜像刷新跟着复活。
    await ledger.revive(fpA, t);
    t += AMAP_LEDGER_REFRESH_MS + 1;
    await search(amap, 1); // 这一发触发刷新（异步），取票在它之前
    await settle();
    await search(amap, 2);
    assert.equal(used.at(-1), "a", `按台账复活后 a 回来，实际 ${used.join(",")}`);
  });

  it("宽限期内台账里还没有本进程刚退的车道，不算别人复活了它", async () => {
    let t = T0;
    const never = new Promise<never>(() => {});
    // 台账：退役表永远为空（写不进去），别的都正常。
    const base = createMemoryAmapLedger();
    const ledger: AmapUsageLedger = { ...base, retire: () => never, retired: async () => ({}) };
    const used: string[] = [];
    const amap = createAmapClient({ key: ["a", "b"], fetchImpl: fetchScripted({ a: [exhausted] }, used), ledger, budget: {}, now: () => t, reviveProbeMs: H });
    await search(amap, 0);
    t += AMAP_LEDGER_REFRESH_MS + 1; // 刷新：台账里没有 a，但它 30 s 前才退役
    await search(amap, 1);
    await settle();
    await search(amap, 2);
    assert.ok(used.slice(1).every((k) => k === "b"), `宽限期内不复活，实际 ${used.join(",")}`);
  });
});
