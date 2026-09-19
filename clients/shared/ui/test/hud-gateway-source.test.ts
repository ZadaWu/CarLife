/**
 * HUD 网关数据源的取数节奏（施工单 M20-06；M65-01 随源码从 cockpit 搬到 @carlife/ui，用例同名同断言）。
 *
 * 这里只守一件事：**重算是"打开时"的动作，不是轮询的动作**。
 * 60 秒一轮都带上 `refreshPretrip`，等于把天气接口按分钟打；
 * 而首帧不带，用户开门看到的就还是上次确认时的天气。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isHighlightsPage, paginateTipItems, WEATHER_LABELS, type HudSnapshot } from "@carlife/shared";

import { createGatewayHudSource } from "../src/hud/gateway-source";

/** 与车机 mock 基线同形的最小快照（本包没有各端的 mock 源，测试自带一份基线）。 */
function makeSnapshot(_weather: "sunny"): HudSnapshot {
  return {
    trip: {
      origin: { anchor: "home", name: "家", kind: "home" },
      nodes: [
        { anchor: "park", name: "亲子乐园", kind: "leisure" },
        { anchor: "charge", name: "充电站", kind: "charging" },
      ],
      activeSegment: 1,
    },
    energy: { distanceKm: 36, batteryPercent: 68, requiredPercent: 21 },
    tips: { headline: "行前温馨提示", pages: paginateTipItems([{ key: "hat", label: "遮阳帽" }]) },
    weather: { kind: "sunny", label: WEATHER_LABELS.sunny },
    assistantState: "idle",
    freshness: { stale: false, updatedAt: "刚刚" },
  };
}

const PLAN_JSON = JSON.stringify({ plan: null });

test("首帧带 refreshPretrip，其后的轮询不带", async () => {
  const asked: Array<boolean | undefined> = [];
  const src = createGatewayHudSource({
    intervalMs: 10,
    base: () => makeSnapshot("sunny"),
    fetchPlanJson: async (refresh) => {
      asked.push(refresh);
      return PLAN_JSON;
    },
  });

  const stop = src.subscribe(
    () => {},
    () => {},
  );
  // 等两轮轮询过去
  await new Promise((r) => setTimeout(r, 35));
  stop();

  assert.equal(asked[0], true, "首帧必须重算——那就是「打开 App」的那一次");
  assert.ok(asked.length >= 2, "轮询应至少跑过一轮");
  assert.ok(
    asked.slice(1).every((x) => x === false),
    `常规轮询不得再要求重算，实际：${JSON.stringify(asked)}`,
  );
});

test("手动 refresh() 也不重算——它是数据刷新，不是「又打开了一次」", async () => {
  const asked: Array<boolean | undefined> = [];
  const src = createGatewayHudSource({
    intervalMs: 10_000,
    base: () => makeSnapshot("sunny"),
    fetchPlanJson: async (refresh) => {
      asked.push(refresh);
      return PLAN_JSON;
    },
  });
  const stop = src.subscribe(
    () => {},
    () => {},
  );
  await new Promise((r) => setTimeout(r, 5));
  src.refresh();
  await new Promise((r) => setTimeout(r, 5));
  stop();

  assert.deepEqual(asked, [true, false]);
});

/*
 * 首拉失败时 opt-in 要还回去（2026-09-02 iPad 走查）。
 *
 * 车机冷启动的首拉恒 401——上车声明还没落地，请求没有身份。原来的写法在
 * `await` 之前就把 `refreshNext` 清了，于是"打开时重算"随那次 401 一起丢失：
 * 声明之后的重拉与之后所有轮询都不带 opt-in，出门前那次天气更新就没了。
 */
test("首拉失败 → 下一次拉仍带 refreshPretrip；成功之后才算「打开」过了", async () => {
  const asked: Array<boolean | undefined> = [];
  let call = 0;
  const src = createGatewayHudSource({
    intervalMs: 10_000,
    base: () => makeSnapshot("sunny"),
    fetchPlanJson: async (refresh) => {
      asked.push(refresh);
      call += 1;
      if (call === 1) throw new Error("401 unauthorized");
      return PLAN_JSON;
    },
  });
  const errors: Error[] = [];
  const stop = src.subscribe(
    () => {},
    (e) => errors.push(e),
  );
  await new Promise((r) => setTimeout(r, 5));
  src.refresh(); // 声明落地后的那一次重拉
  await new Promise((r) => setTimeout(r, 5));
  src.refresh(); // 再之后的普通刷新
  await new Promise((r) => setTimeout(r, 5));
  stop();

  assert.equal(errors.length, 1, "首拉的失败要照常上报（App 据此置 stale）");
  assert.deepEqual(asked, [true, true, false], "失败那次的 opt-in 必须还给下一次，且只还一次");
});

/*
 * 推荐卡的**跨轮询保持**（M32-02 的缺口，用户走查："有时候只能看到推荐物品"）。
 *
 * `destinationHighlights` 不落库、只在带 opt-in 的那一跳补齐，而这里每轮都从
 * 新拿到的 plan 重算整份快照——于是这张卡的寿命是「首帧 → 下一次轮询」，
 * 最长 60 秒后自己消失，切走切回来又冒出来。下面两条把这个行为钉住。
 */

const HIGHLIGHTS = {
  destination: "舟山普陀山",
  foods: [{ name: "海鲜面", note: "码头边的老店" }],
  spots: [{ name: "南海观音", note: "地标" }],
  photoTips: [{ spot: "南海观音", tip: "傍晚斜阳" }],
  computedAt: new Date().toISOString(),
};

function planJson(opts: { highlights?: unknown; destination?: string } = {}): string {
  return JSON.stringify({
    plan: {
      status: "confirmed",
      destination: opts.destination ?? "舟山普陀山",
      startDate: "2026-08-29",
      days: 2,
      skeleton: [
        { day: 1, theme: "上岛", spots: [{ name: "普济寺", lat: 30.0, lon: 122.3 }] },
        { day: 2, theme: "环岛", spots: [{ name: "千步沙", lat: 30.01, lon: 122.31 }] },
      ],
      caveats: [],
      updatedTurnId: "t1",
      ...(opts.highlights === undefined ? {} : { destinationHighlights: opts.highlights }),
    },
  });
}

/** 快照里有没有那一页推荐。 */
function hasHighlightsPage(s: HudSnapshot): boolean {
  return s.tips.pages.some((p) => isHighlightsPage(p));
}

test("推荐页在不带重算的轮询里不消失——它只在 opt-in 那一跳回来", async () => {
  const seen: HudSnapshot[] = [];
  const src = createGatewayHudSource({
    intervalMs: 10,
    base: () => makeSnapshot("sunny"),
    today: () => "2026-08-29",
    // 首帧（带重算）有推荐，之后的轮询（不带）没有——真实网关就是这个行为。
    fetchPlanJson: async (refresh) => planJson(refresh ? { highlights: HIGHLIGHTS } : {}),
  });
  const stop = src.subscribe(
    (s) => seen.push(s),
    () => {},
  );
  await new Promise((r) => setTimeout(r, 35));
  stop();

  assert.ok(seen.length >= 2, `应至少推过两帧，实际 ${seen.length}`);
  assert.ok(hasHighlightsPage(seen[0]), "首帧就该有推荐页");
  assert.ok(
    seen.every(hasHighlightsPage),
    "轮询不得把推荐页擦掉——那正是「卡片时有时无」的成因",
  );
});

test("换了目的地就作废——不把上一程的推荐挂到这一程", async () => {
  const seen: HudSnapshot[] = [];
  let call = 0;
  const src = createGatewayHudSource({
    intervalMs: 10,
    base: () => makeSnapshot("sunny"),
    today: () => "2026-08-29",
    fetchPlanJson: async () => {
      call += 1;
      // 第 1 跳：普陀山 + 推荐；之后：换成另一程，且没有推荐。
      return call === 1
        ? planJson({ highlights: HIGHLIGHTS })
        : planJson({ destination: "杭州西湖" });
    },
  });
  const stop = src.subscribe(
    (s) => seen.push(s),
    () => {},
  );
  await new Promise((r) => setTimeout(r, 35));
  stop();

  assert.ok(hasHighlightsPage(seen[0]), "首帧该有推荐页");
  assert.ok(
    seen.slice(1).every((s) => !hasHighlightsPage(s)),
    "换了目的地之后不许沿用上一程的推荐",
  );
});

/*
 * 行程列表与选中（M72-04）。
 *
 * 老网关的回包没有 `plans`——那时列表回空数组，其余一字不变；
 * 选中的那程在下一轮列表里不见了（改掉 / 取消 / 结束）要回到当前行程，不挂着一份不存在的。
 */
function listJson(current: string | null, plans: string[]): string {
  const mk = (destination: string) => ({
    status: "confirmed",
    destination,
    startDate: "2099-01-01",
    days: 2,
    skeleton: [
      { day: 1, theme: "a", spots: [{ name: `${destination}-1` }] },
      { day: 2, theme: "b", spots: [{ name: `${destination}-2` }] },
    ],
    caveats: [],
    updatedTurnId: "t",
  });
  return JSON.stringify({
    plan: current ? mk(current) : null,
    plans: plans.map((d) => ({ planId: `p-${d}`, plan: mk(d), committedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" })),
  });
}

test("老回包（无 plans）→ onPlans 收到空数组，投影照旧", async () => {
  const got: unknown[] = [];
  const shown: string[] = [];
  const src = createGatewayHudSource({
    intervalMs: 10_000,
    base: () => makeSnapshot("sunny"),
    fetchPlanJson: async () => PLAN_JSON,
    onPlans: (p) => got.push(p),
    onPlan: (p) => shown.push(p ? p.destination : "-"),
  });
  const stop = src.subscribe(() => {}, () => {});
  await new Promise((r) => setTimeout(r, 5));
  stop();
  assert.deepEqual(got, [[]]);
  assert.deepEqual(shown, ["-"]);
});

test("select 换投影不发请求；选中的在下一轮不见了 → 回到当前行程", async () => {
  let pulls = 0;
  let round = 0;
  const shown: string[] = [];
  const src = createGatewayHudSource({
    intervalMs: 10_000,
    base: () => makeSnapshot("sunny"),
    fetchPlanJson: async () => {
      pulls += 1;
      round += 1;
      // 第 1 轮：当前广州，列表广州 + 青岛；第 2 轮：青岛没了。
      return round === 1 ? listJson("广州", ["广州", "青岛"]) : listJson("广州", ["广州"]);
    },
    onPlan: (p) => shown.push(p ? p.destination : "-"),
  });
  const stop = src.subscribe(() => {}, () => {});
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(shown, ["广州"]);

  src.select("p-青岛");
  assert.equal(pulls, 1, "select 不该发请求");
  assert.equal(shown.at(-1), "青岛");

  src.select(null);
  assert.equal(shown.at(-1), "广州");

  src.select("p-青岛");
  assert.equal(shown.at(-1), "青岛");
  src.refresh(); // 第 2 轮：青岛不在列表里了
  await new Promise((r) => setTimeout(r, 5));
  stop();
  assert.equal(shown.at(-1), "广州", "选中的行程消失后要回到当前行程");
});

/*
 * 投影口径（M73-02）：无选中 → **列表首条**（进行中 / 最近的未来），不是服务端「当前行程」（最新确认）；
 * 没有列表才回落当前。造一个「当前 = 上个月排的下月行程，首条 = 本周正在走的」的回包来钉住。
 */
test("无选中投影列表首条；无列表回落当前；清除选中回首条", async () => {
  const shown: string[] = [];
  let round = 0;
  const src = createGatewayHudSource({
    intervalMs: 10_000,
    base: () => makeSnapshot("sunny"),
    fetchPlanJson: async () => {
      round += 1;
      // 第 1 轮：当前=广州（最新确认），列表首条=青岛（本周）；第 2 轮：老网关无 plans
      return round === 1 ? listJson("广州", ["青岛", "广州"]) : JSON.stringify({ plan: JSON.parse(listJson("广州", [])).plan });
    },
    onPlan: (p) => shown.push(p ? p.destination : "-"),
  });
  const stop = src.subscribe(() => {}, () => {});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(shown.at(-1), "青岛", "无选中要画列表首条，不是最新确认的那份");
  src.select("p-广州");
  assert.equal(shown.at(-1), "广州");
  src.select(null);
  assert.equal(shown.at(-1), "青岛", "清除选中回首条");
  src.refresh();
  await new Promise((r) => setTimeout(r, 5));
  stop();
  assert.equal(shown.at(-1), "广州", "没有列表（老网关）才回落当前行程");
});

/*
 * 已结束的那程（2026-09-16 走查）。
 *
 * `endDate` 列还空着的老行程走完了也留在活动列表里，且出发日最早——于是"列表首条"
 * 恰好是一份已结束的行程，`tripPlanToHud` 判它"卡片收起"，主页地图整块收起，
 * 看起来像地图坏了（用户原话：「默认行程展示了一个已结束的行程，导致地图没有正确显示」）。
 * 下面三条钉住新口径：默认跳过走完的；点开的那程照样交出去；没点就不交。
 */
function datedListJson(plans: Array<{ id: string; startDate: string }>): string {
  const mk = (id: string, startDate: string) => ({
    status: "confirmed",
    destination: id,
    startDate,
    days: 2,
    skeleton: [{ day: 1, theme: "a", spots: [{ name: `${id}-1`, lat: 30, lon: 120 }] }],
    caveats: [],
    updatedTurnId: "t",
  });
  return JSON.stringify({
    plan: null,
    plans: plans.map((p) => ({
      planId: `p-${p.id}`,
      plan: mk(p.id, p.startDate),
      committedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    })),
  });
}

async function projectOnce(json: string, then?: (src: ReturnType<typeof createGatewayHudSource>) => void) {
  const shown: string[] = [];
  const src = createGatewayHudSource({
    intervalMs: 10_000,
    base: () => makeSnapshot("sunny"),
    today: () => "2026-09-16",
    fetchPlanJson: async () => json,
    onPlan: (p) => shown.push(p ? p.destination : "-"),
  });
  const stop = src.subscribe(() => {}, () => {});
  await new Promise((r) => setTimeout(r, 5));
  then?.(src);
  stop();
  return shown;
}

test("无选中时跳过已结束的那程——默认画第一条还没走完的", async () => {
  // 首条是 9/3 出发的两天行程（早就走完），第二条才是本周正在走的。
  const shown = await projectOnce(
    datedListJson([
      { id: "玉溪", startDate: "2026-09-03" },
      { id: "青岛", startDate: "2026-09-15" },
    ]),
  );
  assert.equal(shown.at(-1), "青岛", "默认那份必须是未结束的，不是排在首位的已结束行程");
});

test("车主点开已结束的那程 → 整份快照照样交出去（地图要画得出那一程）", async () => {
  const shown = await projectOnce(datedListJson([{ id: "玉溪", startDate: "2026-09-03" }]), (src) => {
    src.select("p-玉溪");
  });
  assert.equal(shown[0], "-", "没点它之前不交——不把走完的行程默认挂在地图上");
  assert.equal(shown.at(-1), "玉溪", "点开之后要交出去，否则选中态的地图恒是装饰概览");
});

test("全是已结束的且没点任何一程 → 不交（否则上个月那程一直挂在主页）", async () => {
  const shown = await projectOnce(
    datedListJson([
      { id: "玉溪", startDate: "2026-09-03" },
      { id: "舟山", startDate: "2026-07-01" },
    ]),
  );
  assert.deepEqual(shown, ["-"]);
});
