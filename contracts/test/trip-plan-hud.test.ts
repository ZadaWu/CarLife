/**
 * tripPlan → HudSnapshot 映射（施工单 M13-04）。
 *
 * 盯三类"看起来正常"的错：过期/取消的行程还挂在 HUD 上；锚位撞了
 * （React key 重复、两个点叠在同一坐标）；数据不足时用假地点凑数。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasHighlights,
  isHighlightsPage,
  tripDayIndex,
  tripPlanToHud,
  validateHudSnapshot,
  type DestinationHighlights,
  type HudSnapshot,
  type TipPage,
  type TripPlanSnapshot,
} from "../src/index";

const BASE: HudSnapshot = {
  trip: {
    origin: { anchor: "home", name: "家", kind: "home" },
    nodes: [],
    activeSegment: 0,
  },
  energy: { distanceKm: 36, batteryPercent: 68, requiredPercent: 21 },
  tips: { headline: "行前温馨提示", pages: [{ items: [] }] },
  weather: { kind: "sunny", label: "晴热" },
  assistantState: "idle",
  freshness: { stale: false, updatedAt: "刚刚" },
};

const plan = (over: Partial<TripPlanSnapshot> = {}): TripPlanSnapshot => ({
  status: "confirmed",
  destination: "广州",
  startDate: "2026-08-12",
  days: 4,
  skeleton: [
    {
      day: 1,
      theme: "亲子动物园",
      spots: [{ name: "长隆野生动物世界" }, { name: "海珠湖公园" }, { name: "多余的第三个" }],
      hotel: { name: "长隆酒店", address: "汉溪大道东299号", estPrice: "约800/晚（估算）" },
    },
    { day: 2, theme: "城央地标", spots: [{ name: "广州塔" }] },
  ],
  energyStops: ["泌冲充电站"],
  caveats: ["酒店价格与机票为经验估算，须以实际预订平台为准"],
  updatedTurnId: "t",
  ...over,
});

test("未确认 / 已取消 / 已结束 → null（卡片收起，调用方回落默认快照）", () => {
  assert.equal(tripPlanToHud(plan({ status: "refining" }), "2026-08-12", BASE), null);
  assert.equal(tripPlanToHud(plan({ status: "cancelled" }), "2026-08-12", BASE), null);
  // 4 天行程 8/12 开始：8/16 起为过期。
  assert.equal(tripPlanToHud(plan(), "2026-08-16", BASE), null);
  assert.equal(tripDayIndex(plan(), "2026-08-16"), null);
});

test("按 startDate 定「今天」；未开始按第 1 天预览；无 startDate 按第 1 天", () => {
  assert.equal(tripDayIndex(plan(), "2026-08-13"), 1);
  assert.equal(tripDayIndex(plan(), "2026-08-10"), 0);
  assert.equal(tripDayIndex(plan({ startDate: undefined }), "2026-08-13"), 0);

  // 整程视图：换天不换站点（环是全程概览），换的是 tips 与进度段。
  const day2 = tripPlanToHud(plan(), "2026-08-13", BASE)!;
  // 标题固定不随天变（M19-05）：这张卡的职责是物品提醒，第几天由地图上的
  // Day N 承担。进度仍然按天走——下面的 activeSegment 才是「换天」的判据。
  assert.equal(day2.tips.headline, "行前温馨提示");
  assert.deepEqual(
    day2.trip.nodes.map((n) => n.name),
    tripPlanToHud(plan(), "2026-08-12", BASE)!.trip.nodes.map((n) => n.name),
  );
  assert.equal(day2.trip.activeSegment, 1, "第 2 天：已过 1 段（按天的行程进度，非定位）");
  assert.equal(tripPlanToHud(plan(), "2026-08-12", BASE)!.trip.activeSegment, 0);
});

test("站点=整程每天一个代表点，按环路径顺序落位；补能在前酒店终点在后；锚位唯一", () => {
  const hud = tripPlanToHud(plan(), "2026-08-12", BASE)!;
  // 2 天行程：D1 代表点 → D2 代表点 → 补能点 → 末日酒店（终点恒是落脚处）。
  assert.deepEqual(
    hud.trip.nodes.map((n) => [n.anchor, n.name]),
    [
      ["park", "长隆野生动物世界"],
      ["charge", "广州塔"],
      ["rest", "泌冲充电站"],
      ["wetland", "长隆酒店"],
    ],
  );
  assert.equal(hud.trip.nodes[2].kind, "charge", "补能点贴纸品类是 charge，与落位无关");
  // 落在 charge 位的是景点：没有品类数据时落通用景点贴纸，不能顶充电桩图。
  assert.equal(hud.trip.nodes[1].kind, "spot");
  const anchors = hud.trip.nodes.map((n) => n.anchor);
  assert.equal(new Set(anchors).size, anchors.length, "锚位必须唯一（React key + 落位坐标）");
  assert.equal(hud.trip.nodes.at(-1)?.kind, "hotel", "末日酒店是终点（收束光晕）");
  assert.ok(!JSON.stringify(hud).includes("汉溪大道"), "HUD 可视化边界：地址不得出现");
  assert.deepEqual(validateHudSnapshot(hud), [], "满配路径必须过 Brief 硬约束");
});

test("4 天行程：四个环位一天一个，末日无空位给酒店/补能也不超发", () => {
  const four = plan({
    days: 4,
    skeleton: [
      { day: 1, theme: "a", spots: [{ name: "长隆野生动物世界" }] },
      { day: 2, theme: "b", spots: [{ name: "广州塔" }] },
      { day: 3, theme: "c", spots: [{ name: "陈家祠堂", poiKind: "museum" }] },
      { day: 4, theme: "d", spots: [{ name: "越秀公园", poiKind: "park" }], hotel: { name: "长隆酒店" } },
    ],
  });
  const hud = tripPlanToHud(four, "2026-08-12", BASE)!;
  assert.deepEqual(
    hud.trip.nodes.map((n) => n.name),
    ["长隆野生动物世界", "广州塔", "陈家祠堂", "越秀公园"],
  );
  assert.deepEqual(
    hud.trip.nodes.map((n) => n.anchor),
    ["park", "charge", "rest", "wetland"],
    "天序 = 环路径顺序（家→park→charge→rest→wetland）",
  );
  // 贴纸品类（M13-07）：有 poiKind 用它，缺省落通用景点——不按名字猜。
  assert.deepEqual(
    hud.trip.nodes.map((n) => n.kind),
    ["spot", "spot", "museum", "park"],
    "品类来自确认路径的高德类目，缺省 spot",
  );
  // 某天没景点：用当天酒店当代表点，品类即身份 hotel。
  const hotelDay = plan({
    days: 2,
    skeleton: [
      { day: 1, theme: "a", spots: [{ name: "长隆野生动物世界" }] },
      { day: 2, theme: "b", spots: [], hotel: { name: "长隆酒店" } },
    ],
  });
  const h2 = tripPlanToHud(hotelDay, "2026-08-12", BASE)!;
  assert.equal(h2.trip.nodes[1].name, "长隆酒店");
  assert.equal(h2.trip.nodes[1].kind, "hotel");
});

test("tips 原样沿用 base 的物品清单：不掺行程文案、不吃掉分页（M20-01 用户走查）", () => {
  // 两页物品，第 2 页只有 1 件——沿用时必须页数、页内件数都不变。
  const withItems: HudSnapshot = {
    ...BASE,
    tips: {
      headline: "行前温馨提示",
      pages: [
        {
          items: [
            { key: "hat", label: "遮阳帽" },
            { key: "sunscreen", label: "防晒霜" },
            { key: "water", label: "水" },
          ],
        },
        { items: [{ key: "water", label: "冰镇饮品" }] },
      ],
    },
  };

  const day1 = tripPlanToHud(plan(), "2026-08-12", withItems)!;
  assert.deepEqual(day1.tips.pages, withItems.tips.pages, "物品清单与分页原样沿用");
  assert.equal(day1.tips.headline, "行前温馨提示");

  /*
   * 回归护栏（M20-01）：图标下的文字必须是这件物品的名字。
   * 曾经这里把「先到酒店放行李再出发」挂在 water 图标上、把当天天气备注挂在
   * hat 图标上，且去重保留先入者——真正的「水」「遮阳帽」反被顶掉。
   * 行李/天气/主题/酒店名/估算一律不进这张卡。
   */
  const lastWithHotel = plan({
    days: 2,
    skeleton: [
      { day: 1, theme: "亲子动物园", spots: [{ name: "长隆野生动物世界" }], notes: ["午后有雨，备雨具"] },
      { day: 2, theme: "b", spots: [{ name: "广州塔" }], hotel: { name: "长隆酒店" } },
    ],
  });
  for (const iso of ["2026-08-12", "2026-08-13"]) {
    const labels = tripPlanToHud(lastWithHotel, iso, withItems)!.tips.pages.flatMap((p) =>
      p.items.map((i) => i.label),
    );
    assert.deepEqual(labels, ["遮阳帽", "防晒霜", "水", "冰镇饮品"], `${iso}：卡上只有物品名`);
  }
});

test("pretripItems：按 key 查表出名字、3 件一页；没有这个字段的老快照回落 base（M20-04）", () => {
  const withItems: HudSnapshot = {
    ...BASE,
    tips: { headline: "行前温馨提示", pages: [{ items: [{ key: "hat", label: "遮阳帽" }] }] },
  };

  const withPretrip = plan({
    pretripItems: [
      { key: "umbrella", reason: "这一程有降雨" },
      { key: "water" },
      { key: "hat" },
      { key: "sunscreen" },
    ],
  });
  const hud = tripPlanToHud(withPretrip, "2026-08-12", withItems)!;
  assert.deepEqual(
    hud.tips.pages.map((p) => p.items.map((i) => i.label)),
    [["雨伞", "水", "遮阳帽"], ["防晒霜"]],
    "名字查表得到，每页最多 3 件",
  );

  // 老快照（确认于本次改动之前）没有这个字段——回落是兼容路径，不加任何标记。
  const legacy = tripPlanToHud(plan(), "2026-08-12", withItems)!;
  assert.deepEqual(legacy.tips.pages, withItems.tips.pages);

  // 全是契约表里没有的 key：一件都上不了卡 → 同样回落，而不是给一张空卡。
  const unknown = tripPlanToHud(
    plan({ pretripItems: [{ key: "rain-boots" as never }] }),
    "2026-08-12",
    withItems,
  )!;
  assert.deepEqual(unknown.tips.pages, withItems.tips.pages);
});

test("数据薄的一天：不足 3 个照常返回、不凑假地点；全空返回 null", () => {
  const thin = plan({
    skeleton: [{ day: 1, theme: "只有一个点", spots: [{ name: "广州塔" }] }],
    energyStops: undefined,
    days: 1,
  });
  const hud = tripPlanToHud(thin, "2026-08-12", BASE)!;
  assert.equal(hud.trip.nodes.length, 1, "不凑数——宁可少，不能编");

  const empty = plan({ skeleton: [{ day: 1, theme: "空", spots: [] }], energyStops: undefined, days: 1 });
  assert.equal(tripPlanToHud(empty, "2026-08-12", BASE), null);
});

test("energy/weather/assistant 原样取 base——它们不来自行程", () => {
  const hud = tripPlanToHud(plan(), "2026-08-12", BASE)!;
  assert.deepEqual(hud.energy, BASE.energy);
  assert.deepEqual(hud.weather, BASE.weather);
  assert.equal(hud.assistantState, "idle");
});

test("tripPlanStops：逐天有序、酒店殿后；全程连住同店只标一次；无坐标点仍在列表", async () => {
  const { tripPlanStops, tripPlanHasCoords } = await import("../src/index");
  const p = plan({
    days: 2,
    skeleton: [
      {
        day: 1,
        theme: "a",
        spots: [
          { name: "广州塔", lat: 23.1064, lon: 113.3245 },
          { name: "海心沙" },
        ],
        hotel: { name: "万豪", lat: 23.13, lon: 113.32 },
      },
      { day: 2, theme: "b", spots: [{ name: "陈家祠堂", lat: 23.1259, lon: 113.2467 }], hotel: { name: "万豪", lat: 23.13, lon: 113.32 } },
    ],
  });
  const all = tripPlanStops(p);
  assert.deepEqual(
    all.map((s) => [s.day, s.kind, s.name]),
    [
      [1, "spot", "广州塔"],
      [1, "spot", "海心沙"],
      [1, "hotel", "万豪"],
      [2, "spot", "陈家祠堂"],
    ],
    "连住同一家酒店全程只标一次，路线不在酒店打转",
  );
  assert.equal(all[1].lat, undefined, "没坐标的点留在列表（不上图但不消失）");
  // 单日 = 酒店闭环的起点：酒店在首位（放行李/寄存），景点随后；折返由地图层画。
  const day2 = tripPlanStops(p, 2);
  assert.deepEqual(day2.map((s) => s.name), ["万豪", "陈家祠堂"], "单日视图酒店居首");
  assert.equal(day2[0].kind, "hotel");
  assert.equal(tripPlanHasCoords(p), true);
  assert.equal(tripPlanHasCoords(plan()), false, "旧行程没坐标 → 回落装饰概览的判据");
});

test("快照带 weather 就用它，老快照回落 base（M20-05）", () => {
  const withWeather = plan({ weather: { kind: "rain", label: "有雨" } });
  const hud = tripPlanToHud(withWeather, "2026-08-12", BASE)!;
  assert.deepEqual(hud.weather, { kind: "rain", label: "有雨" });

  // 老快照（M20-05 之前确认的）没有这个字段——回落基线，不是空图标。
  const legacy = tripPlanToHud(plan(), "2026-08-12", BASE)!;
  assert.deepEqual(legacy.weather, BASE.weather);
});

// ── 目的地推荐页（施工单 M32-02）─────────────────────────────────────

const HIGHLIGHTS: DestinationHighlights = {
  destination: "广州",
  foods: [
    { name: "陶陶居", note: "百年茶楼", sourceUrl: "https://a.com/x", sourceTitle: "老字号" },
    { name: "点都德", note: "全天早茶" },
    { name: "广州酒家", note: "烧鹅出名" },
  ],
  spots: [
    { name: "永庆坊", note: "骑楼老街" },
    { name: "沙面岛", note: "欧式建筑群" },
    { name: "小蛮腰", note: "夜景地标" },
  ],
  photoTips: [
    { spot: "永庆坊", tip: "入夜拍月亮桥倒影" },
    { spot: "沙面岛", tip: "清晨顺光拍白墙" },
    { spot: "小蛮腰", tip: "对岸长曝拍变色" },
  ],
  computedAt: "2026-08-28T02:00:00.000Z",
};

/** 只取物品页的名字——推荐页没有 items，直接取会炸。 */
const itemLabels = (pages: TipPage[]) =>
  pages.filter((p) => !isHighlightsPage(p)).map((p) => p.items.map((i) => i.label));

test("有推荐：物品页之后恰好多一页，且那一页是 highlights（M32-02）", () => {
  const withItems: HudSnapshot = {
    ...BASE,
    tips: { headline: "行前温馨提示", pages: [{ items: [{ key: "hat", label: "遮阳帽" }] }] },
  };
  const base = tripPlanToHud(plan({ pretripItems: [{ key: "hat" }] }), "2026-08-12", withItems)!;
  const withHl = tripPlanToHud(
    plan({ pretripItems: [{ key: "hat" }], destinationHighlights: HIGHLIGHTS }),
    "2026-08-12",
    withItems,
  )!;

  assert.equal(withHl.tips.pages.length, base.tips.pages.length + 1, "恰好多一页，不是替换");
  const last = withHl.tips.pages[withHl.tips.pages.length - 1];
  assert.ok(isHighlightsPage(last));
  assert.deepEqual(last.highlights, HIGHLIGHTS);
  // 物品页原封不动——推荐是追加，不是改写。
  assert.deepEqual(itemLabels(withHl.tips.pages), itemLabels(base.tips.pages));
  // 推荐页上没有 items 这个属性——渲染层据此分流，混着来就会画成一张空物品卡。
  assert.equal("items" in last, false);
});

test("三段全空 / 没有这个字段：`pages` 与今天**深相等**，不留占位页（M32-02）", () => {
  const withItems: HudSnapshot = {
    ...BASE,
    tips: { headline: "行前温馨提示", pages: [{ items: [{ key: "hat", label: "遮阳帽" }] }] },
  };
  const legacy = tripPlanToHud(plan({ pretripItems: [{ key: "hat" }] }), "2026-08-12", withItems)!;

  const empty = tripPlanToHud(
    plan({
      pretripItems: [{ key: "hat" }],
      destinationHighlights: { ...HIGHLIGHTS, foods: [], spots: [], photoTips: [] },
    }),
    "2026-08-12",
    withItems,
  )!;
  assert.deepEqual(empty.tips.pages, legacy.tips.pages, "空卡比没有卡糟——一页都不加");

  // 老快照（本次改动之前确认的）零影响。
  const old = tripPlanToHud(plan({ pretripItems: [{ key: "hat" }] }), "2026-08-12", withItems)!;
  assert.deepEqual(old.tips.pages, legacy.tips.pages);
  assert.equal(old.tips.headline, "行前温馨提示");
});

test("hasHighlights：只要有一段非空就算有；三段全空与 undefined 都算没有", () => {
  assert.equal(hasHighlights(undefined), false);
  assert.equal(hasHighlights({ ...HIGHLIGHTS, foods: [], spots: [], photoTips: [] }), false);
  assert.equal(hasHighlights({ ...HIGHLIGHTS, foods: [], spots: [] }), true, "只剩拍照建议也算有");
});

test("推荐页不触发「每页最多 3 件」这条校验（它没有物品）", () => {
  const snap: HudSnapshot = {
    ...BASE,
    trip: {
      ...BASE.trip,
      nodes: [
        { anchor: "a", name: "长隆", kind: "spot" },
        { anchor: "b", name: "沙面", kind: "spot" },
        { anchor: "c", name: "酒店", kind: "hotel" },
      ],
    },
    tips: {
      headline: "行前温馨提示",
      pages: [{ items: [] }, { kind: "highlights", highlights: HIGHLIGHTS }],
    },
  };
  assert.deepEqual(validateHudSnapshot(snap), []);
});
