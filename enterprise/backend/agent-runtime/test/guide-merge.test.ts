/**
 * 景区导游子图的汇聚与排序（施工单 M36-01）。
 *
 * 内容可以吵（普陀山哪个点排第一），但这几条不能松：
 * **出处与搜索结果全等才展示**（M32 不变量在 guide 场景的延续）、
 * 平台按校验后出处的域名归类而不是信模型嘴上说的、来源时间抽不到不编、
 * 无出处的避雷条目不上页、坐标齐全才做 geo 排序且**去交叉后总路程不升**、
 * 分支缺席以 caveat 明示而不是静默少一栏。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  guidePathLength,
  hasCrossing,
  mergeGuide,
  orderSpots,
  platformOf,
  runGuideBrief,
  type GuideSpotItem,
} from "../src/graph/subgraphs/guide";
import type { BranchResult } from "../src/graph/fanout";
import { setEnvCache, type SearchResultRef } from "@carlife/tools";

const XHS = "https://www.xiaohongshu.com/explore/putuoshan-2026";
const DY = "https://www.douyin.com/video/74123";
const TRIP = "https://www.trip.com/moments/detail/zhoushan-479/";

const SEARCH_RESULTS: SearchResultRef[] = [
  { url: XHS, title: "普陀山必打卡" },
  { url: DY, title: "普陀山vlog" },
  { url: TRIP, title: "普陀山两日游" },
];

function ok(agent: string, submission: unknown): BranchResult {
  return { agent: `${agent}-task`, status: "ok", text: "", submission, startedAt: 0, endedAt: 1 };
}
function missing(agent: string): BranchResult {
  return { agent: `${agent}-task`, status: "failed", text: "", startedAt: 0, endedAt: 1 };
}

type Branches = ReadonlyMap<
  "guide-access" | "guide-spots" | "guide-comfort",
  BranchResult | undefined
>;

function branches(over: Partial<Record<"guide-access" | "guide-spots" | "guide-comfort", BranchResult>>): Branches {
  return new Map([
    ["guide-access", over["guide-access"]],
    ["guide-spots", over["guide-spots"]],
    ["guide-comfort", over["guide-comfort"]],
  ]) as Branches;
}

const INPUT = { spotName: "普陀山", city: "舟山" };

// ── 出处校验与平台归类 ─────────────────────────────────────

test("出处全等才保留；被截断的 URL 置空出处、平台、来源时间，其余字段照常", () => {
  const brief = mergeGuide(
    branches({
      "guide-spots": ok("guide-spots", {
        spots: [
          { name: "南海观音", reason: "地标", sourceUrl: XHS, platform: "小红书", sourceDate: "2026-05", mustSee: "露天大佛" },
          // 截断版：与真实 URL 只差尾巴——前缀匹配恰好会放行它，所以只认全等。
          { name: "紫竹林", reason: "禅意", sourceUrl: XHS.slice(0, 30), platform: "小红书", sourceDate: "2026-04" },
        ],
      }),
    }),
    INPUT,
    SEARCH_RESULTS,
  );
  const [a, b] = brief.spots;
  assert.equal(a!.source?.url, XHS);
  assert.equal(a!.platform, "小红书");
  assert.equal(a!.sourceDate, "2026-05");
  assert.equal(b!.name, "紫竹林", "条目本身保留——丢的是出处，不是内容");
  assert.equal(b!.source, undefined, "截断的 URL 不能当出处");
  assert.equal(b!.platform, undefined, "没有出处就没有平台——不得声称'据小红书'");
  assert.equal(b!.sourceDate, undefined, "来源时间跟着出处走，出处没了它也不算数");
  assert.deepEqual(brief.sourcesVerified, { matched: 1, claimed: 2 });
});

test("平台以校验后出处的域名为准：模型说'小红书'而出处是携程时，信域名", () => {
  const brief = mergeGuide(
    branches({
      "guide-spots": ok("guide-spots", {
        spots: [{ name: "普济寺", sourceUrl: TRIP, platform: "小红书" }],
      }),
    }),
    INPUT,
    SEARCH_RESULTS,
  );
  assert.equal(brief.spots[0]!.platform, "携程");
});

test("platformOf：认得出的给中文名，认不出的如实给域名", () => {
  assert.equal(platformOf(XHS), "小红书");
  assert.equal(platformOf(DY), "抖音");
  assert.equal(platformOf("https://www.toutiao.com/article/1"), "toutiao.com");
  assert.equal(platformOf("not-a-url"), undefined);
});

test("避雷条目（pitfall）没有可验证出处就不上页；其余 comfort 条目无出处照常", () => {
  const brief = mergeGuide(
    branches({
      "guide-comfort": ok("guide-comfort", {
        entries: [
          { kind: "pitfall", note: "某店宰客", sourceUrl: "https://编的.example/1" },
          { kind: "pitfall", name: "山顶餐厅", note: "旺季排队久", sourceUrl: DY },
          { kind: "toilet", note: "普济寺西侧有公厕" },
        ],
      }),
    }),
    INPUT,
    SEARCH_RESULTS,
  );
  assert.equal(brief.comfort.length, 2);
  assert.equal(brief.comfort.find((c) => c.note === "某店宰客"), undefined, "一条编的宰客比漏十条真避雷严重");
  assert.equal(brief.comfort.find((c) => c.kind === "toilet")?.note, "普济寺西侧有公厕");
});

// ── 单向顺路排序 ───────────────────────────────────────────

/** 对角线交叉的病例：按 A-C-D-B 走，AC 与 DB 交叉（todo 1.a 描述的正是这种）。 */
const CROSSED: GuideSpotItem[] = [
  { name: "A", lat: 30.0, lon: 122.38 },
  { name: "C", lat: 30.01, lon: 122.4 },
  { name: "D", lat: 30.0, lon: 122.4 },
  { name: "B", lat: 30.01, lon: 122.38 },
];

test("geo 排序：4 点对角线交叉被解开，相邻段无真相交且总路程不升", () => {
  const before = CROSSED.map((s) => ({ lat: s.lat!, lon: s.lon! }));
  const { spots, orderSource } = orderSpots(CROSSED);
  assert.equal(orderSource, "geo");
  const after = spots.map((s) => ({ lat: s.lat!, lon: s.lon! }));
  assert.equal(hasCrossing(after), false, "排完不允许再有对角线交叉");
  assert.ok(
    guidePathLength(after) <= guidePathLength(before) + 1e-12,
    "2-opt 翻转在平面上必缩短总路程——变长说明算法写错了",
  );
});

test("起点（停车场）参与排序：第一站是离停车场最近的点", () => {
  const { spots } = orderSpots(CROSSED, { lat: 30.011, lon: 122.379 });
  assert.equal(spots[0]!.name, "B");
});

test("坐标不齐（或点数<3）退回提交顺序并标 editorial，不做半真半假的顺路", () => {
  const partial: GuideSpotItem[] = [
    { name: "甲", lat: 30, lon: 122 },
    { name: "乙" },
    { name: "丙", lat: 30.1, lon: 122.1 },
  ];
  const r = orderSpots(partial);
  assert.equal(r.orderSource, "editorial");
  assert.deepEqual(r.spots.map((s) => s.name), ["甲", "乙", "丙"]);

  const two = orderSpots(CROSSED.slice(0, 2));
  assert.equal(two.orderSource, "editorial");
});

test("editorial 排序时 caveat 明示'顺序来自攻略整理'", () => {
  const brief = mergeGuide(
    branches({
      "guide-spots": ok("guide-spots", { spots: [{ name: "甲" }, { name: "乙" }, { name: "丙" }] }),
    }),
    INPUT,
    [],
  );
  assert.equal(brief.routeOrderSource, "editorial");
  assert.ok(brief.caveats.some((c) => c.includes("攻略整理")));
});

test("同名点去重（模型提交两遍是常态），坐标齐全时 routeOrderSource=geo", () => {
  const brief = mergeGuide(
    branches({
      "guide-spots": ok("guide-spots", { spots: [...CROSSED, { ...CROSSED[0]! }] }),
    }),
    INPUT,
    [],
  );
  assert.equal(brief.spots.length, 4);
  assert.equal(brief.routeOrderSource, "geo");
});

// ── 分支缺席与降级 ─────────────────────────────────────────

test("任一分支缺席：对应栏目缺席 + caveat 明示，其余栏目照常", () => {
  const brief = mergeGuide(
    branches({
      "guide-access": missing("guide-access"),
      "guide-spots": ok("guide-spots", { spots: [{ name: "南海观音" }] }),
      "guide-comfort": missing("guide-comfort"),
    }),
    INPUT,
    [],
  );
  assert.equal(brief.access, undefined);
  assert.ok(brief.caveats.some((c) => c.includes("到达与补能")));
  assert.ok(brief.caveats.some((c) => c.includes("休息与餐饮")));
  assert.equal(brief.spots.length, 1);
  assert.deepEqual(brief.branchSources, { access: "missing", spots: "submission", comfort: "missing" });
});

test("正文 JSON 回落：没有提交时从分支文本抠 JSON，branchSources 记 text", () => {
  const brief = mergeGuide(
    branches({
      "guide-spots": {
        agent: "guide-spots-task",
        status: "ok",
        text: '好的，结论如下：\n{"spots":[{"name":"法雨寺"}]}',
        startedAt: 0,
        endedAt: 1,
      },
    }),
    INPUT,
    [],
  );
  assert.equal(brief.spots[0]!.name, "法雨寺");
  assert.equal(brief.branchSources.spots, "text");
});

test("access 分支：距离/到达方式/补能照单收，起点喂给排序", () => {
  const brief = mergeGuide(
    branches({
      "guide-access": ok("guide-access", {
        parking: [
          { name: "普陀山停车场", address: "梅芩路115号", distanceToGateMeters: 800, toGate: "步行约10分钟", lat: 30.011, lon: 122.379 },
        ],
        charging: [{ name: "国网充电站(梅锦阁停车场)", address: "梅岑路85号" }],
        arrivalAdvice: "车停码头停车场，摆渡进岛",
        findings: ["旺季 9 点后一位难求"],
      }),
      "guide-spots": ok("guide-spots", { spots: CROSSED }),
    }),
    INPUT,
    [],
  );
  assert.equal(brief.access?.parking[0]?.distanceToGateMeters, 800);
  assert.equal(brief.access?.charging[0]?.name, "国网充电站(梅锦阁停车场)");
  assert.ok(brief.findings.includes("旺季 9 点后一位难求"));
  assert.equal(brief.spots[0]!.name, "B", "geo 排序的起点是停车场");
});

// ── 缓存 ───────────────────────────────────────────────────

test("runGuideBrief：同键第二次命中⑤缓存，不再起 fanout", async () => {
  const store = new Map<string, string>();
  setEnvCache({
    async get(k) {
      return store.get(k) ?? null;
    },
    async set(k, v) {
      store.set(k, v);
    },
  });
  let calls = 0;
  // stub streamer：三个分支各回一段正文 JSON（提交通道在纯测试环境不接，走回落路径）。
  const streamer = (_m: unknown, hooks?: { agent?: string }) => {
    calls += 1;
    const agent = hooks?.agent ?? "";
    const payload = agent.startsWith("guide-access")
      ? { parking: [{ name: "南门停车场" }] }
      : agent.startsWith("guide-spots")
        ? { spots: [{ name: "南海观音" }] }
        : { entries: [{ kind: "rest", note: "索道站旁有休息亭" }] };
    return (async function* () {
      yield JSON.stringify(payload);
    })();
  };

  const first = await runGuideBrief(streamer as never, { spotName: "普陀山缓存例", city: "舟山" });
  assert.equal(first.cached, false);
  assert.equal(calls, 3);
  assert.equal(first.brief.spots[0]!.name, "南海观音");

  const second = await runGuideBrief(streamer as never, { spotName: "普陀山缓存例", city: "舟山" });
  assert.equal(second.cached, true);
  assert.equal(calls, 3, "缓存命中不许再起任何分支会话");
  assert.equal(second.brief.spots[0]!.name, "南海观音");
  setEnvCache(undefined);
});

test("runGuideBrief：同键并发合流——两路同时请求只起一轮 fanout，结果同享（M36-04 走查病例）", async () => {
  const store = new Map<string, string>();
  setEnvCache({
    async get(k) {
      return store.get(k) ?? null;
    },
    async set(k, v) {
      store.set(k, v);
    },
  });
  let calls = 0;
  const slowStreamer = (_m: unknown, hooks?: { agent?: string }) => {
    calls += 1;
    const agent = hooks?.agent ?? "";
    const payload = agent.startsWith("guide-spots")
      ? { spots: [{ name: "南海观音" }] }
      : agent.startsWith("guide-access")
        ? { parking: [{ name: "P1" }] }
        : { entries: [{ kind: "rest", note: "有休息亭" }] };
    return (async function* () {
      await new Promise((r) => setTimeout(r, 20)); // 拉开时间窗，让第二路真的赶上在途
      yield JSON.stringify(payload);
    })();
  };
  const input = { spotName: "普陀山并发例", city: "舟山" };
  const [a, b] = await Promise.all([
    runGuideBrief(slowStreamer as never, input),
    runGuideBrief(slowStreamer as never, input),
  ]);
  assert.equal(calls, 3, "并发两路只允许一轮 fanout（3 个分支）——各起一轮就是 6");
  assert.deepEqual(a.brief, b.brief, "后到的一路搭在途那趟，拿同一份结果");
  setEnvCache(undefined);
});

test("runGuideBrief：三支全空的产物如实返回但不占 24 小时缓存", async () => {
  const store = new Map<string, string>();
  setEnvCache({
    async get(k) {
      return store.get(k) ?? null;
    },
    async set(k, v) {
      store.set(k, v);
    },
  });
  let calls = 0;
  const emptyStreamer = () => {
    calls += 1;
    return (async function* () {
      yield "这次什么都没查到";
    })();
  };
  const r1 = await runGuideBrief(emptyStreamer as never, { spotName: "空景区例" });
  assert.deepEqual(r1.brief.branchSources, { access: "missing", spots: "missing", comfort: "missing" });
  assert.equal(r1.cached, false);
  const before = calls;
  const r2 = await runGuideBrief(emptyStreamer as never, { spotName: "空景区例" });
  assert.equal(r2.cached, false, "空产物不该被缓存——下次还有机会真查");
  assert.ok(calls > before, "第二次要真的再试，而不是端出缓存的空盘子");
  setEnvCache(undefined);
});

// ── 小景点不拆：兄弟景点剔除与 0 坐标（2026-08-29 走查） ─────────

test("兄弟景点兜底剔除：撞行程其他景点名的'点位'不上页并以 caveat 明示；自己不误伤", () => {
  const brief = mergeGuide(
    branches({
      "guide-spots": ok("guide-spots", {
        spots: [
          { name: "紫竹林", mustSee: "禅意庭院" }, // 自己（剥「景区」后缀后同名）——必须保留
          { name: "南海观音大佛", mustSee: "33米金身" }, // 行程兄弟 → 剔
          { name: "千步沙", mustSee: "沙滩" }, // 「千步沙景区」剥后缀全等 → 剔
          { name: "潮音洞", mustSee: "听潮" }, // 本景区内部 → 留
        ],
      }),
    }),
    { spotName: "紫竹林景区", city: "舟山", siblingSpots: ["南海观音大佛", "千步沙景区"] },
    [],
  );
  assert.deepEqual(
    brief.spots.map((s) => s.name),
    ["紫竹林", "潮音洞"],
    "兄弟景点各有自己的导览页，不该混进本景区点位",
  );
  assert.ok(
    brief.caveats.some((c) => c.includes("已剔除") && c.includes("南海观音大佛") && c.includes("千步沙")),
    "剔除必须明示，静默少两条与编造同罪",
  );
});

test("0 坐标是占位不是坐标：lat/lon 为 0 一律丢弃（紫竹茶寮病例，0,0 在几内亚湾）", () => {
  const brief = mergeGuide(
    branches({
      "guide-spots": ok("guide-spots", {
        spots: [
          { name: "紫竹茶寮", mustSee: "茶歇", lat: 0, lon: 0 },
          { name: "潮音洞", mustSee: "听潮", lat: 29.9779, lon: 122.3946 },
          { name: "紫竹林庵", mustSee: "礼佛", lat: 29.9767, lon: 122.3936 },
        ],
      }),
    }),
    INPUT,
    [],
  );
  const tea = brief.spots.find((s) => s.name === "紫竹茶寮")!;
  assert.equal(tea.lat, undefined, "0 纬度必须当'没有坐标'处理");
  assert.equal(tea.lon, undefined);
  assert.equal(brief.routeOrderSource, "editorial", "混着无坐标点就不许声称 geo 顺路");
});
