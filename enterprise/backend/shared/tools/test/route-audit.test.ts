/**
 * route_audit 的三层测试：
 *   1. 几何纯函数——距离、交叉、寻优（含真实事故夹具 sess-47998d69-18d 广州第 2 天）；
 *   2. 工具行为——地理编码回退、unresolved 不猜、点太少不硬造建议；
 *   3. 审计落库——记录形状、落库失败不打断主业。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  auditDay,
  auditJourney,
  createRouteAuditTool,
  findCrossings,
  haversineKm,
  optimizeOrder,
  pathKm,
  setRouteAuditStore,
  type JourneyDayInput,
  type RouteAuditRecordPayload,
  type RouteGeocodeBackend,
  type RoutePoint,
} from "../src/route-audit";
import { getTool, invokeTool, listForAgent } from "../src/registry";

/** 真实事故数据：sess-47998d69-18d 已确认行程的第 2 天（坐标出自落库快照）。 */
const GZ_DAY2 = {
  startHotel: { name: "桔子广州荔湾永庆坊陈家祠店", lat: 23.125425, lon: 113.240251 },
  spots: [
    { name: "广州塔", lat: 23.106428, lon: 113.324521 },
    { name: "珠江夜游(海心沙西区码头)", lat: 23.110444, lon: 113.323314 },
    { name: "南越王宫御苑", lat: 23.126139, lon: 113.270478 },
  ],
  endHotel: { name: "喜运服务公寓(广州塔珠江新城店)", lat: 23.115731, lon: 113.329625 },
};

describe("几何纯函数", () => {
  it("haversine：广州塔到海心沙码头 ≈ 0.46km（数量级与相对关系是对的）", () => {
    const d = haversineKm(GZ_DAY2.spots[0], GZ_DAY2.spots[1]);
    assert.ok(d > 0.3 && d < 0.7, `实际 ${d}`);
  });

  it("pathKm 是各段之和", () => {
    const pts = [GZ_DAY2.startHotel, ...GZ_DAY2.spots];
    let sum = 0;
    for (let i = 1; i < pts.length; i += 1) sum += haversineKm(pts[i - 1], pts[i]);
    assert.ok(Math.abs(pathKm(pts) - sum) < 1e-9);
  });

  it("交叉检测：对角线走法有交叉，环线走法没有", () => {
    const sq = (lat: number, lon: number, name: string): RoutePoint => ({ name, lat, lon });
    const a = sq(0, 0, "A");
    const b = sq(0, 1, "B");
    const c = sq(1, 1, "C");
    const d = sq(1, 0, "D");
    // A→C→B→D：两条对角线交叉——正是"二环三环游成麻花"的形态
    assert.equal(findCrossings([a, c, b, d]).length, 1);
    // A→B→C→D：环线，无交叉
    assert.equal(findCrossings([a, b, c, d]).length, 0);
  });

  it("**真实事故回归**：广州第 2 天原顺序 21.2km，寻优后 ≈10.4km，省约一半", () => {
    const r = auditDay([GZ_DAY2.startHotel], GZ_DAY2.spots, [GZ_DAY2.endHotel]);
    assert.ok(Math.abs(r.given.km - 21.17) < 0.1, `原顺序 ${r.given.km}`);
    assert.ok(r.suggested, "这条路线必须给出建议——它就是本工具立项的那个病例");
    assert.ok(Math.abs(r.suggested!.km - 10.37) < 0.1, `建议 ${r.suggested!.km}`);
    assert.ok(r.suggested!.savedPct >= 45, `省 ${r.suggested!.savedPct}%`);
    // 建议顺序：先进市中心的南越王宫，再回江边——夜游天然落在尾段
    assert.deepEqual(
      r.suggested!.order.slice(1, 4),
      ["南越王宫御苑", "广州塔", "珠江夜游(海心沙西区码头)"],
    );
  });

  it("已经顺了的路线要说'已最优'，不瞎建议（同会话第 1 天）", () => {
    const day1 = [
      { name: "陈家祠堂", lat: 23.126692, lon: 113.245158 },
      { name: "永庆坊吉祥广场", lat: 23.114517, lon: 113.240286 },
      { name: "荔枝湾游船", lat: 23.121419, lon: 113.237496 },
    ];
    const hotel = { name: "桔子广州荔湾永庆坊陈家祠店", lat: 23.125425, lon: 113.240251 };
    const r = auditDay([hotel], day1, [hotel]);
    assert.equal(r.alreadyOptimal, true);
    assert.equal(r.suggested, undefined);
  });

  it("锚点不参与重排：head/tail 恒在首尾", () => {
    const { order } = optimizeOrder(
      [GZ_DAY2.startHotel],
      GZ_DAY2.spots,
      [GZ_DAY2.endHotel],
    );
    assert.equal(order.length, GZ_DAY2.spots.length);
    assert.ok(!order.some((p) => p.name.includes("桔子") || p.name.includes("喜运")));
  });

  it("超过穷举上限走 2-opt：12 个环上点从最差顺序恢复到接近环线", () => {
    // 圆上 12 点，最优路径是沿圆走；打乱成跳跃顺序后寻优应显著变短
    const ring: RoutePoint[] = Array.from({ length: 12 }, (_, i) => ({
      name: `P${i}`,
      lat: Math.sin((i / 12) * 2 * Math.PI) * 0.05,
      lon: Math.cos((i / 12) * 2 * Math.PI) * 0.05,
    }));
    const shuffled = [0, 6, 1, 7, 2, 8, 3, 9, 4, 10, 5, 11].map((i) => ring[i]);
    const before = pathKm(shuffled);
    const { order, km } = optimizeOrder([], shuffled, []);
    assert.equal(order.length, 12);
    assert.ok(km < before * 0.5, `2-opt 后 ${km} 应远小于打乱的 ${before}`);
    assert.equal(findCrossings(order).length, 0, "2-opt 收敛后不应残留交叉");
  });
});

/**
 * 全局层夹具一：sess-47998d69 已确认行程（坐标出自落库快照）。
 * 病灶：南越王宫（老城）被排进珠江新城日（D2），逐天怎么排都要横穿全城。
 */
const GZ_JOURNEY_MISGROUPED: JourneyDayInput[] = [
  {
    day: 1,
    head: [{ name: "桔子荔湾", lat: 23.125425, lon: 113.240251 }],
    tail: [{ name: "桔子荔湾", lat: 23.125425, lon: 113.240251 }],
    points: [
      { name: "陈家祠堂", lat: 23.126692, lon: 113.245158 },
      { name: "永庆坊吉祥广场", lat: 23.114517, lon: 113.240286 },
      { name: "荔枝湾游船", lat: 23.121419, lon: 113.237496 },
    ],
  },
  {
    day: 2,
    head: [{ name: "喜运公寓", lat: 23.115731, lon: 113.329625 }],
    tail: [{ name: "喜运公寓", lat: 23.115731, lon: 113.329625 }],
    points: [
      { name: "广州塔", lat: 23.106428, lon: 113.324521 },
      { name: "珠江夜游(海心沙西区码头)", lat: 23.110444, lon: 113.323314 },
      { name: "南越王宫御苑", lat: 23.126139, lon: 113.270478 },
    ],
  },
  {
    day: 3,
    head: [{ name: "桔子荔湾", lat: 23.125425, lon: 113.240251 }],
    tail: [{ name: "桔子荔湾", lat: 23.125425, lon: 113.240251 }],
    points: [{ name: "长隆野生动物世界", lat: 23.00266, lon: 113.315593 }],
  },
];

/**
 * 全局层夹具二：sess-a33e0a21 已确认行程。分组本身聚类良好（跨天换点无利可图——
 * 纯里程还想省就得拆节奏），但天序按 中→东南→西→东北 跳，推进链明显可缩。
 */
const GZ_JOURNEY_ZIGZAG_ORDER: JourneyDayInput[] = [
  {
    day: 1,
    head: [{ name: "康莱德", lat: 23.11544, lon: 113.332126 }],
    tail: [{ name: "康莱德", lat: 23.11544, lon: 113.332126 }],
    points: [
      { name: "南越王宫御苑", lat: 23.126139, lon: 113.270478 },
      { name: "千年古道遗址", lat: 23.124873, lon: 113.268844 },
      { name: "中山纪念堂", lat: 23.13286, lon: 113.264692 },
      { name: "越秀公园", lat: 23.140096, lon: 113.265561 },
    ],
  },
  {
    day: 2,
    head: [{ name: "康莱德", lat: 23.11544, lon: 113.332126 }],
    tail: [{ name: "康莱德", lat: 23.11544, lon: 113.332126 }],
    points: [
      { name: "广东省博物馆", lat: 23.114763, lon: 113.326369 },
      { name: "海心沙广场", lat: 23.113595, lon: 113.320795 },
      { name: "广州塔", lat: 23.106428, lon: 113.324521 },
      { name: "广州塔（珠江夜游）", lat: 23.107074, lon: 113.319313 },
    ],
  },
  {
    day: 3,
    head: [{ name: "康莱德", lat: 23.11544, lon: 113.332126 }],
    tail: [{ name: "康莱德", lat: 23.11544, lon: 113.332126 }],
    points: [
      { name: "陈家祠堂", lat: 23.126692, lon: 113.245158 },
      { name: "永庆坊", lat: 23.114821, lon: 113.237495 },
      { name: "沙面岛", lat: 23.10781, lon: 113.24445 },
    ],
  },
  {
    day: 4,
    head: [{ name: "康莱德", lat: 23.11544, lon: 113.332126 }],
    tail: [{ name: "康莱德", lat: 23.11544, lon: 113.332126 }],
    points: [
      { name: "广州动物园", lat: 23.140884, lon: 113.305342 },
      { name: "华南国家植物园", lat: 23.181902, lon: 113.367139 },
    ],
  },
];

describe("全局层：跨天体检", () => {
  it("**真实病例回归**：南越王宫混进珠江新城日 → regroup 建议换出去，省 ≥20%", () => {
    const j = auditJourney(GZ_JOURNEY_MISGROUPED);
    assert.ok(j?.regroup, "这份行程必须给出跨天建议——它就是全局层立项的那个病例");
    assert.ok(j!.regroup!.savedPct >= 20, `实际省 ${j!.regroup!.savedPct}%`);
    assert.ok(
      j!.regroup!.moves.some((m) => m.includes("南越王宫御苑")),
      `动作里必须涉及南越王宫：${j!.regroup!.moves.join("; ")}`,
    );
    // 只交换：每天点数不变（节奏是模型定的语义，算法不许动）
    const sizes = j!.regroup!.days.map((d, i) => {
      const anchors = GZ_JOURNEY_MISGROUPED[i].head.length + GZ_JOURNEY_MISGROUPED[i].tail.length;
      return d.order.length - anchors;
    });
    assert.deepEqual(sizes, [3, 3, 1]);
  });

  it("分组已经聚类良好时不给 regroup——纯里程还想省就得拆节奏，那是噪音", () => {
    const j = auditJourney(GZ_JOURNEY_ZIGZAG_ORDER);
    assert.equal(j?.regroup, undefined);
  });

  it("天序按片区推进链给建议：中→东南→西→东北 的麻花走法必须被检出", () => {
    const j = auditJourney(GZ_JOURNEY_ZIGZAG_ORDER);
    assert.ok(j?.dayOrder, "四个片区来回跳，推进链明显可缩");
    assert.ok(j!.dayOrder!.savedPct >= 20, `实际省 ${j!.dayOrder!.savedPct}%`);
    assert.equal(j!.dayOrder!.order.length, 4);
    // 荔湾(D3)与老城(D1)必须相邻——它们地理上贴着，隔着别的片区走就是麻花
    const o = j!.dayOrder!.order;
    assert.equal(Math.abs(o.indexOf(3) - o.indexOf(1)), 1, `建议天序 ${o.join("→")}`);
    assert.match(j!.dayOrder!.note, /不改变总驾驶里程/);
  });

  it("单天或空输入不体检全局", () => {
    assert.equal(auditJourney([GZ_JOURNEY_MISGROUPED[0]]), undefined);
    assert.equal(auditJourney([]), undefined);
  });

  it("两层独立成立：regroup 病例的天序、天序病例的分组，各自不受对方影响", () => {
    // 病例一 3 天（含单点天）也可能有天序建议，但 regroup 的 savedKm 与 moves 必须自洽
    const j = auditJourney(GZ_JOURNEY_MISGROUPED)!;
    assert.ok(j.totalGivenKm > 0);
    if (j.regroup) {
      assert.ok(j.regroup.totalKm < j.totalGivenKm);
      assert.ok(Math.abs(j.totalGivenKm - j.regroup.totalKm - j.regroup.savedKm) < 0.05);
    }
  });
});

describe("工具行为（注入假地理编码，不打高德）", () => {
  const located: Record<string, RoutePoint> = {
    陈家祠堂: { name: "陈家祠堂", lat: 23.126692, lon: 113.245158 },
  };
  const backend: RouteGeocodeBackend = {
    async locate(name) {
      return located[name];
    },
  };

  beforeEach(() => setRouteAuditStore(undefined));

  it("缺坐标的点走编码；编不到进 unresolved 且不参与计算", async () => {
    const tool = createRouteAuditTool(backend);
    const r = await tool.call(
      {
        city: "广州",
        days: [
          {
            day: 1,
            points: [
              { name: "陈家祠堂" }, // 编码可得
              { name: "查无此地" }, // 编码不到
              ...GZ_DAY2.spots, // 自带坐标
            ],
          },
        ],
      },
      { sessionId: "s1" },
    );
    assert.deepEqual(r.data.days[0].unresolved, ["查无此地"]);
    assert.equal(r.data.days[0].given.order.length, 4);
    assert.ok(r.data.days[0].given.order.includes("陈家祠堂"));
  });

  it("可比较的点少于 2 个：不硬造建议，如实报 alreadyOptimal", async () => {
    const tool = createRouteAuditTool(backend);
    const r = await tool.call(
      { days: [{ day: 3, points: [{ name: "查无此地" }, { name: "也查不到" }] }] },
      { sessionId: "s1" },
    );
    assert.equal(r.data.days[0].alreadyOptimal, true);
    assert.equal(r.data.days[0].given.km, 0);
    assert.deepEqual(r.data.days[0].unresolved, ["查无此地", "也查不到"]);
  });

  it("legs 带累计里程——'开了多远该歇'的判断依据", async () => {
    const tool = createRouteAuditTool(backend);
    const r = await tool.call(
      { days: [{ start: GZ_DAY2.startHotel, points: GZ_DAY2.spots, end: GZ_DAY2.endHotel }] },
      { sessionId: "s1" },
    );
    const legs = r.data.days[0].given.legs;
    assert.equal(legs.length, 4);
    for (let i = 1; i < legs.length; i += 1) {
      assert.ok(legs[i].cumKm > legs[i - 1].cumKm, "累计里程必须单调递增");
    }
    assert.ok(Math.abs(legs[legs.length - 1].cumKm - r.data.days[0].given.km) < 0.05);
  });
});

describe("审计落库", () => {
  beforeEach(() => setRouteAuditStore(undefined));

  it("每次调用落一条：带坐标（后台画图用）、带建议与交叉", async () => {
    const recorded: Array<{ ctx: unknown; payload: RouteAuditRecordPayload }> = [];
    setRouteAuditStore({
      async record(ctx, payload) {
        recorded.push({ ctx, payload });
      },
    });
    const tool = createRouteAuditTool({ locate: async () => undefined });
    await tool.call(
      {
        city: "广州",
        days: [{ day: 2, start: GZ_DAY2.startHotel, points: GZ_DAY2.spots, end: GZ_DAY2.endHotel }],
      },
      { sessionId: "sess-x", turnId: "t1", agent: "tour" },
    );
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].ctx, { sessionId: "sess-x", turnId: "t1", agent: "tour" });
    const day = recorded[0].payload.days[0];
    assert.equal(day.day, 2);
    assert.equal(day.points.length, 5, "锚点 + 3 景点都要带坐标落库");
    assert.ok(day.points.every((p) => typeof p.lat === "number"));
    assert.ok(day.suggestedOrder && day.suggestedKm !== undefined);
    setRouteAuditStore(undefined);
  });

  it("落库抛错不打断工具返回（旁路观测不带走主业）", async () => {
    setRouteAuditStore({
      async record() {
        throw new Error("db down");
      },
    });
    const tool = createRouteAuditTool({ locate: async () => undefined });
    const r = await tool.call(
      { days: [{ points: GZ_DAY2.spots }] },
      { sessionId: "s1" },
    );
    assert.ok(r.data.days[0].given.km > 0);
    setRouteAuditStore(undefined);
  });
});

describe("注册表接线", () => {
  it("ACL：tour 与 trip 拿得到，其他 Agent 拿不到", () => {
    for (const agent of ["tour", "trip"] as const) {
      assert.ok(
        listForAgent(agent).some((t) => t.name === "route_audit"),
        `${agent} 应有 route_audit`,
      );
    }
    for (const agent of ["hotel", "drive", "transit", "buying", "cabin", "service"] as const) {
      assert.ok(
        !listForAgent(agent).some((t) => t.name === "route_audit"),
        `${agent} 不该有 route_audit`,
      );
    }
  });

  it("提示词元数据：snippet 与纪律齐全（提交前必须体检 + 时段自行把关）", () => {
    const reg = getTool("route_audit")!;
    const g = (reg.promptGuidelines ?? []).join("\n");
    assert.match(g, /提交.*前必须体检/);
    assert.match(g, /不懂时段/);
    assert.match(g, /直线估算/);
  });

  it("mock 模式可跑通（全 mock 走查不被它卡住）", async () => {
    const r = await invokeTool(
      "route_audit",
      { days: [{ day: 1, points: [{ name: "甲" }, { name: "乙" }] }] },
      { sessionId: "s1", mode: "mock" },
    );
    assert.equal((r as { source: { kind: string } }).source.kind, "mock");
  });
});
