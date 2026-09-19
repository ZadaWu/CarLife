/**
 * [F-18-15][AC-18-11] 行程详情抽屉的当天派生（M83-03）。
 *
 * 这一组守的全是"没有就别编"：按天的里程与电量没有数据源、三类沿途服务没有数据源、
 * `legs` 缺省时不许写 0、没有 `estStart/estEnd` 时不许按 09:00+90min 拍一个。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TripPlanSnapshot } from "@carlife/shared";

import { applyStructureEdits } from "@carlife/shared";

import {
  PENDING,
  chargeCellValue,
  chargeStopName,
  chargeStopNames,
  dayArriveHotelTime,
  dayDepartTime,
  dayMetrics,
  dayReturnRow,
  dayServices,
  dayTimeline,
  driveLabel,
  returnLegs,
  rowChangeLabel,
  rowChanges,
  serviceAreasFor,
  serviceCountLabel,
  serviceOverride,
  servicePoisFor,
  serviceCellTitle,
  selectedServicePois,
  stayLabel,
} from "../src/hud/trip-detail";
import { tripServicesKey } from "@carlife/shared";

const spot = (name: string, estStart?: string, estEnd?: string) => ({
  name,
  ...(estStart ? { estStart } : {}),
  ...(estEnd ? { estEnd } : {}),
});

function plan(over: Partial<TripPlanSnapshot> = {}): TripPlanSnapshot {
  return {
    status: "confirmed",
    destination: "徐州",
    origin: "杭州",
    days: 3,
    skeleton: [
      { day: 1, date: "2026-09-09", theme: "汉文化与纪念地", spots: [spot("徐州汉文化景区", "09:00", "11:30"), spot("水下兵马俑博物馆", "11:45", "13:30")], hotel: { name: "徐州开元名都大酒店" } },
      { day: 2, theme: "云龙山水", spots: [spot("云龙山索滑道", "09:00", "11:30"), spot("云龙湖旅游景区", "13:00", "16:30")], hotel: { name: "徐州开元名都大酒店" } },
      { day: 3, theme: "古城与夜市", spots: [spot("户部山古民居"), spot("戏马台", "12:00", "14:30")] },
    ],
    caveats: [],
    updatedTurnId: "t",
    ...over,
  };
}

const withLegs = () =>
  plan({
    legs: [
      { day: 1, driveMinutes: 40, reason: "charge" },
      { day: 1, driveMinutes: 60 },
      { day: 2, driveMinutes: 55 },
    ],
  });

describe("[F-18-15][AC-18-11] dayMetrics：按天里程与电量没有数据源", () => {
  it("legs 缺省时行车与充电站都是 undefined——调用方据此整行不画，不回落成 0", () => {
    const m = dayMetrics(plan(), 1);
    assert.equal(m.spots, 2);
    assert.equal(m.driveMinutes, undefined);
    assert.equal(m.chargeStops, undefined);
  });

  it("有 legs 时按天求和、按 reason 计充电站", () => {
    assert.deepEqual(dayMetrics(withLegs(), 1), { spots: 2, driveMinutes: 100, chargeStops: 1 });
    assert.deepEqual(dayMetrics(withLegs(), 2), { spots: 2, driveMinutes: 55, chargeStops: 0 });
  });

  it("day 缺省的 leg 不算进任何一天（宁可不显示也不猜它属于哪天）", () => {
    const p = plan({ legs: [{ driveMinutes: 99 }, { day: 3, driveMinutes: 10 }] });
    assert.equal(dayMetrics(p, 3).driveMinutes, 10);
  });

  it("driveLabel：小时与分钟分档，不出现「0 小时」", () => {
    assert.equal(driveLabel(100), "1 小时 40 分");
    assert.equal(driveLabel(55), "55 分钟");
    assert.equal(driveLabel(120), "2 小时");
  });
});

describe("[F-18-04][F-18-08] 三格接上快照里的 services（沿途服务数据源交接，待执行事项 4）", () => {
  const withServices = (over: Partial<TripPlanSnapshot> = {}) => {
    const base = plan(over);
    return plan({
      ...over,
      services: {
        computedAt: "2026-09-15T08:00:00.000Z",
        radiusM: 3000,
        skeletonKey: tripServicesKey(base),
        days: [
          { day: 1, food: 12, restroom: 0, parking: 61, serviceAreas: ["长安服务区", "乳源服务区"] },
          // 第 2 天：停车场那一类没查成（缺省）
          { day: 2, food: 3, restroom: 1 },
        ],
      },
    });
  };

  it("查过的类目念真数，0 照写「0 个」——不再有「25+」这个封顶", () => {
    const by = Object.fromEntries(dayServices(withServices(), 1).map((c) => [c.key, c.value]));
    assert.equal(by.food, "12 个");
    assert.equal(by.restroom, "0 个", "0 是查过了没有，不是待查");
    assert.equal(by.parking, "61 个", "真跑并集实测 43~99，封顶成 25+ 等于把这一格作废");
    assert.equal(serviceCountLabel(24), "24 个");
    // 走查第四轮：61 / 90 / 99 一律显示「25+ 个」，三个差着一倍的数长得一模一样
    for (const n of [25, 61, 99]) assert.equal(serviceCountLabel(n), `${n} 个`);
  });

  it("没查成的类目保持「待查」；没算过的天四格都是「待查」", () => {
    const p = withServices();
    const d2 = Object.fromEntries(dayServices(p, 2).map((c) => [c.key, c.value]));
    assert.equal(d2.food, "3 个");
    assert.equal(d2.parking, PENDING, "停车场那一类没查成");
    assert.equal(serviceOverride(p, 3), undefined);
    const d3 = Object.fromEntries(dayServices(p, 3).map((c) => [c.key, c.value]));
    assert.equal(d3.food, PENDING);
  });

  it("骨架变了（编辑预览挪了景点）：指纹对不上，四格如实退回「待查」", () => {
    const p = withServices();
    const edited = { ...p, skeleton: [{ ...p.skeleton[0]!, spots: [p.skeleton[0]!.spots[0]!] }, ...p.skeleton.slice(1)] };
    assert.equal(serviceOverride(edited, 1), undefined);
    assert.deepEqual(serviceAreasFor(edited, 1), []);
  });

  it("高速服务区按名字列在第 1 天", () => {
    const p = withServices();
    assert.deepEqual(serviceAreasFor(p, 1), ["长安服务区", "乳源服务区"]);
    assert.deepEqual(serviceAreasFor(p, 2), []);
  });

  it("出处与口径挪进格子的 title：屏幕上那段说明删了，信息不能跟着删", () => {
    const p = withServices();
    const t = serviceCellTitle(p, "12 个");
    assert.match(t, /周边 3 公里/, "半径念快照里的数，不写死");
    assert.match(t, /「0 个」是查过没有/);
    assert.match(t, /点一下可以把这一类的点位显示在地图上/);
    // 「待查」那一格先回答"为什么没有数"——一排待查不解释就是看起来坏了
    assert.match(serviceCellTitle(p, PENDING), /还没查成，不是「没有」/);
    assert.doesNotMatch(serviceCellTitle(p, PENDING), /查高德所得/);
    // 没有 services 的行程：不编半径
    assert.doesNotMatch(serviceCellTitle(plan(), PENDING), /公里/);
    // M93-05：「景区」那一格去掉了，口径里也不该再提它
    for (const v of ["12 个", PENDING]) assert.ok(!serviceCellTitle(p, v).includes("景区"));
  });
});

/**
 * [F-18-15][AC-18-11] 点位明细（M93-05）：格子与图上的点是同一个开关的两端。
 *
 * 明细与计数**同一份数据、同一道指纹闸门**：计数对得上而点位对不上，
 * 就会出现"格子说有 12 个、图上画的是上一版骨架的点"——比不画糟得多。
 */
describe("[F-18-15][AC-18-11] servicePoisFor / selectedServicePois", () => {
  const poi = (name: string, lat: number, lon: number) => ({ name, lat, lon });
  const withPois = () => {
    const base = plan();
    return plan({
      services: {
        computedAt: "2026-09-15T08:00:00.000Z",
        radiusM: 3000,
        skeletonKey: tripServicesKey(base),
        days: [
          {
            day: 1,
            food: 2,
            charging: 1,
            // 停车场只有计数没有明细：M93-04 之前落的老快照就是这个形状。
            parking: 7,
            pois: {
              food: [poi("云龙湖食堂", 34.24, 117.16), poi("彭城饭庄", 34.25, 117.17)],
              charging: [poi("国网云龙湖充电站", 34.23, 117.15)],
            },
          },
        ],
      },
    });
  };

  it("对得上指纹：按存储顺序原样返回，不排序不去重", () => {
    assert.deepEqual(
      servicePoisFor(withPois(), 1, "food").map((p) => p.name),
      ["云龙湖食堂", "彭城饭庄"],
    );
  });

  it("有计数没明细（老快照）→ 空数组；调用方据此把格子置灰", () => {
    assert.deepEqual(servicePoisFor(withPois(), 1, "parking"), []);
    assert.deepEqual(servicePoisFor(withPois(), 1, "restroom"), []);
  });

  it("骨架指纹对不上 / 这一天没算过 → 空数组，宁可不画也不画错的", () => {
    const p = withPois();
    const edited = { ...p, skeleton: [{ ...p.skeleton[0]!, spots: [p.skeleton[0]!.spots[0]!] }, ...p.skeleton.slice(1)] };
    assert.deepEqual(servicePoisFor(edited, 1, "food"), []);
    assert.deepEqual(servicePoisFor(p, 2, "food"), []);
  });

  it("多选把几类摊平并带上类目——标记要按类目选图标与颜色", () => {
    const got = selectedServicePois(withPois(), 1, ["charge", "food"]);
    assert.deepEqual(
      got.map((p) => [p.category, p.name]),
      [
        ["charge", "国网云龙湖充电站"],
        ["food", "云龙湖食堂"],
        ["food", "彭城饭庄"],
      ],
    );
  });

  it("一类都没选、或全程视图（day 缺省）→ 空数组", () => {
    assert.deepEqual(selectedServicePois(withPois(), 1, []), []);
    assert.deepEqual(selectedServicePois(withPois(), undefined, ["food"]), []);
  });
});

describe("[F-18-15][AC-18-11] dayServices：查不到就写待查，不写 0", () => {
  it("[M93-05] 快照里没有 services 时四格全「待查」，且不含「景区」", () => {
    const cells = dayServices(withLegs(), 1);
    const by = Object.fromEntries(cells.map((c) => [c.key, c.value]));
    assert.equal(by.food, PENDING);
    assert.equal(by.restroom, PENDING);
    assert.equal(by.parking, PENDING);
    // 充电站从前读 energyStops（求解结果），M93-05 起与其余三格同源：没查成就是「待查」。
    assert.equal(by.charge, PENDING);
    assert.deepEqual(cells.map((c) => c.key), ["charge", "food", "restroom", "parking"]);
  });

  it("[M93-05] 一格都不写 0——0 的意思是查过了没有", () => {
    const by = Object.fromEntries(dayServices(plan(), 1).map((c) => [c.key, c.value]));
    for (const v of Object.values(by)) assert.ok(!String(v).includes("0"), `「${v}」不该出现 0`);
  });

  it("[M93-05] 补能点单独成行，不再挤进充电站那一格", () => {
    // 有 legs、有 energyStops，但周边充电站没查过 → 格子「待查」，补能点走自己那一行。
    const withStops = { ...withLegs(), energyStops: ["嘉兴服务区充电站", "无锡东服务区充电站"] };
    const by = Object.fromEntries(dayServices(withStops, 1).map((c) => [c.key, c.value]));
    assert.equal(by.charge, PENDING, "格子说的是周边有多少桩，那是查出来的");
    assert.deepEqual(chargeStopNames(withStops), ["嘉兴服务区充电站", "无锡东服务区充电站"]);
    assert.deepEqual(chargeStopNames(plan()), [], "没有补能点就整行不画");
  });
});

describe("[F-18-15][AC-18-11] dayTimeline：首末行是推导出来的", () => {
  it("Day 1 首行是出发地，末行是当晚酒店", () => {
    const rows = dayTimeline(plan(), 1);
    assert.equal(rows[0]!.kind, "origin");
    assert.equal(rows[0]!.name, "杭州");
    assert.equal(rows.at(-1)!.kind, "hotel");
    assert.equal(rows.at(-1)!.note, "入住");
  });

  it("没有 origin 时首行只写「出发」，不猜城市名", () => {
    const rows = dayTimeline(plan({ origin: undefined }), 1);
    assert.equal(rows[0]!.name, "出发");
    assert.ok(!rows[0]!.name.includes("州"));
  });

  it("Day 2 首行是前一晚的酒店", () => {
    const rows = dayTimeline(plan(), 2);
    assert.equal(rows[0]!.kind, "origin");
    assert.equal(rows[0]!.name, "徐州开元名都大酒店");
  });

  it("没有酒店的那天，末行是最后一站并标「预计到达」", () => {
    const rows = dayTimeline(plan(), 3);
    assert.equal(rows.at(-1)!.kind, "spot");
    assert.equal(rows.at(-1)!.name, "戏马台");
    assert.equal(rows.at(-1)!.note, "预计到达");
  });

  it("没有时段的站：时间列留空、写「时间待定」，不按 09:00+90min 拍一个", () => {
    const rows = dayTimeline(plan(), 3);
    const row = rows.find((r) => r.name === "户部山古民居")!;
    assert.equal(row.time, undefined);
    assert.equal(row.note, "时间待定");
  });

  it("有时段的站写「建议停留 N」", () => {
    const rows = dayTimeline(plan(), 1);
    const row = rows.find((r) => r.name === "徐州汉文化景区")!;
    assert.equal(row.time, "09:00 – 11:30");
    assert.equal(row.note, "建议停留 2.5 小时");
  });

  it("stayLabel：不足一小时按分钟；结束早于开始（脏数据）不给负数", () => {
    assert.equal(stayLabel("09:00", "09:40"), "40 分钟");
    assert.equal(stayLabel("14:00", "15:00"), "1 小时");
    assert.equal(stayLabel("16:00", "09:00"), undefined);
  });

  it("不存在的那一天返回空数组，不抛错", () => {
    assert.deepEqual(dayTimeline(plan(), 9), []);
  });
});

/**
 * 中午落脚那一行（2026-09-16 走查第九轮）。
 *
 * 走查原话：「行程提醒里已经说了第一站是中午到酒店办入住登记…希望能在行程时间轴
 * 显示出目的地第一站落脚点，不然会很奇怪，到底直接去玩还是先办理入住登记」。
 * 数据（`day.lodging`，M34-01）一直在，只是没进时间轴。
 */
describe("[F-18-15][AC-18-11] dayTimeline：中午落脚那一行", () => {
  /** 到达日：上午一站、下午两站，住宿策略是「中午入住」。 */
  const midday = (over: Record<string, unknown> = {}) =>
    plan({
      skeleton: [
        {
          day: 1,
          theme: "到达日",
          spots: [spot("海洋公园", "09:00", "12:30"), spot("航海博物馆", "13:00", "15:00"), spot("庆典广场", "19:00", "21:00")],
          hotel: { name: "奥特曼主题酒店" },
          lodging: { strategy: "checkin-midday", note: "自驾行李放车上" },
          ...over,
        },
      ],
    } as Partial<TripPlanSnapshot>);

  it("落脚行排在**第一个下午的点之前**——策略名里那个 midday 就是这个意思", () => {
    const rows = dayTimeline(midday(), 1);
    const names = rows.map((r) => r.name);
    assert.deepEqual(names, ["杭州", "海洋公园", "奥特曼主题酒店", "航海博物馆", "庆典广场", "奥特曼主题酒店"]);
    const row = rows[2]!;
    assert.equal(row.kind, "checkin");
    assert.equal(row.note, "中午先办入住");
  });

  it("时刻是前后两站之间的窗口——两头都是骨架里的数，不拍一个到店时刻", () => {
    // 走查第十轮：「check in 在规划时没有给时间，是几点钟到酒店办理入住」
    assert.equal(dayTimeline(midday(), 1)[2]!.time, "12:30 – 13:00");
  });

  it("排在最前（一头没有站）就不写时间——窗口缺一头不是窗口", () => {
    const allMorning = midday({ spots: [spot("海洋公园", "09:00", "11:30"), spot("航海博物馆")] });
    assert.equal(dayTimeline(allMorning, 1)[1]!.time, undefined);
    const noTimes = midday({ spots: [spot("海洋公园"), spot("航海博物馆")] });
    assert.equal(dayTimeline(noTimes, 1)[1]!.time, undefined);
    // 后一站没有开始时刻：同样缺一头
    const noNext = midday({ spots: [spot("海洋公园", "09:00", "12:30"), spot("航海博物馆", "13:30")] });
    assert.equal(dayTimeline(noNext, 1)[2]!.time, "12:30 – 13:30");
    const noPrevEnd = midday({ spots: [spot("海洋公园", "09:00"), spot("航海博物馆", "13:00", "15:00")] });
    assert.equal(dayTimeline(noPrevEnd, 1)[2]!.time, undefined);
  });

  it("同一天末行改说「回酒店」——两行都写「入住」就成了入住两回", () => {
    const rows = dayTimeline(midday(), 1);
    assert.equal(rows.at(-1)!.kind, "hotel");
    assert.equal(rows.at(-1)!.note, "回酒店");
  });

  it("一天全是上午的点 / 干脆没有时间 → 落脚排在最前：契约说到达日先落脚再开始", () => {
    const allMorning = midday({
      spots: [spot("海洋公园", "09:00", "11:30"), spot("航海博物馆")],
    });
    assert.equal(dayTimeline(allMorning, 1)[1]!.kind, "checkin");
    const noTimes = midday({ spots: [spot("海洋公园"), spot("航海博物馆")] });
    assert.equal(dayTimeline(noTimes, 1)[1]!.kind, "checkin");
  });

  it("`checkin-evening` 不画这一行——白天全程玩、晚上入住，末行已经逐字说了", () => {
    const evening = midday({ lodging: { strategy: "checkin-evening" } });
    const rows = dayTimeline(evening, 1);
    assert.ok(!rows.some((r) => r.kind === "checkin"));
    assert.equal(rows.at(-1)!.note, "入住");
  });

  it("没有住宿策略的那天一行不多（连住日、老快照）", () => {
    assert.ok(!dayTimeline(plan(), 1).some((r) => r.kind === "checkin"));
    assert.equal(dayTimeline(plan(), 1).at(-1)!.note, "入住");
  });

  it("没有酒店就不画——不编一家店出来", () => {
    const noHotel = midday({ hotel: undefined });
    assert.ok(!dayTimeline(noHotel, 1).some((r) => r.kind === "checkin"));
  });
});

/**
 * 到达日的办入住窗口（turn-ced08ea1 走查：「到如家商旅酒店的时间页没说」）。
 *
 * 上面那组的间隙窗口在**第 1 天几乎永远算不出来**：到达日的第一个景点本来就在下午，
 * 落脚行插在最前面，"前一站"不存在。而到店那一刻代码也算不出来——第 1 天只有一个自由量
 * （几点出发），它本身就是从景点时段倒推的，两头相等 = 没有窗口。所以向排这一天的模型要
 * （`TripPlanLodging.estStart/estEnd`），这一组守它进来之后的两件事：窗口怎么显示、
 * 出发时刻改锚到哪里。
 */
describe("[F-18-15][AC-18-11] dayTimeline：模型给的办入住窗口", () => {
  const arrival = (lodging: Record<string, unknown>) =>
    plan({
      origin: "上海",
      legs: [
        { day: 1, fromStop: "上海", toStop: "阳澄湖服务区", driveMinutes: 91, reason: "rest" },
        { day: 1, fromStop: "阳澄湖服务区", driveMinutes: 110 },
      ],
      skeleton: [
        {
          day: 1,
          theme: "到达日",
          spots: [spot("渡江战役纪念馆", "13:30", "15:30"), spot("包公园", "16:00", "18:00")],
          hotel: { name: "如家商旅酒店" },
          lodging,
        },
      ],
    } as Partial<TripPlanSnapshot>);

  it("**给了就用它**——这正是间隙那一档算不出来的那一格", () => {
    const rows = dayTimeline(arrival({ strategy: "checkin-midday", estStart: "12:00", estEnd: "12:40" }), 1);
    const row = rows.find((r) => r.kind === "checkin")!;
    assert.equal(row.time, "12:00 – 12:40");
    assert.equal(row.note, "中午先办入住");
  });

  it("没给就照旧退回间隙——第 1 天缺一头，仍然不写时刻，**不编**", () => {
    const rows = dayTimeline(arrival({ strategy: "checkin-midday" }), 1);
    assert.equal(rows.find((r) => r.kind === "checkin")!.time, undefined);
  });

  it("只给一头当没给：窗口缺一头不是窗口", () => {
    const rows = dayTimeline(arrival({ strategy: "checkin-midday", estStart: "12:00" }), 1);
    assert.equal(rows.find((r) => r.kind === "checkin")!.time, undefined);
  });

  it("**出发时刻改锚到办入住**：原来拿第一个景点当锚，等于把办入住算成 0 分钟", () => {
    const withWindow = arrival({ strategy: "checkin-midday", estStart: "12:00", estEnd: "12:40" });
    // 12:00 − (91 + 110) = 08:39；拿 13:30 当锚会得到 10:09，晚了整整 90 分钟。
    assert.equal(dayDepartTime(withWindow, 1), "08:39");
    assert.equal(dayTimeline(withWindow, 1)[0]!.time, "08:39");
  });

  it("没有窗口时出发时刻与改动前逐字一致——老快照零差异", () => {
    assert.equal(dayDepartTime(arrival({ strategy: "checkin-midday" }), 1), "10:09");
  });

  it("窗口晚于第一个景点时不改锚——那种数据是错的，倒推只会更错", () => {
    const late = arrival({ strategy: "checkin-midday", estStart: "14:00", estEnd: "14:30" });
    assert.equal(dayDepartTime(late, 1), "10:09", "退回第一个景点那一档");
  });

  it("第 2 天起不改锚：那一天的出发靠 startLeg，办入住排在白天中间，不是当天的起点", () => {
    const twoDays = plan({
      origin: "上海",
      legs: [{ day: 1, fromStop: "上海", driveMinutes: 60 }],
      skeleton: [
        { day: 1, theme: "a", spots: [spot("A", "13:00", "15:00")], hotel: { name: "H1" } },
        {
          day: 2,
          theme: "b",
          spots: [spot("B", "09:00", "11:30"), spot("C", "14:00", "16:00")],
          hotel: { name: "H2" },
          lodging: { strategy: "checkin-midday", estStart: "12:00", estEnd: "12:30" },
          startLeg: { fromName: "H1", driveMinutes: 30, computedAt: "t" },
        },
      ],
    } as Partial<TripPlanSnapshot>);
    assert.equal(dayDepartTime(twoDays, 2), "08:30", "09:00 − 30 分钟，与办入住窗口无关");
    assert.equal(dayTimeline(twoDays, 2).find((r) => r.kind === "checkin")!.time, "12:00 – 12:30");
  });
});

/**
 * [F-18-15][AC-18-11] 真实行程的 `legs` 形状（2026-09-14 走查实测才发现）。
 *
 * `TripPlanLeg.day` 是可选的，而真实数据里**基本不填**——`legs` 描述的是大交通那一段
 * （上海 → 徐州的高速与服务区），段尾站名对不到 `skeleton` 的 spot 就缺省。
 * 早先按 `l.day === day` 过滤后直接求和，于是每一天都算出「行车约 0 分钟」「无补能停靠」，
 * **看起来像查过了，其实一段都没对上**。演示数据没有 `legs`、走另一条分支，照不出来。
 */
describe("[F-18-15][AC-18-11] legs 没有 day 时不许编出 0", () => {
  /** 逐字照抄库里那份徐州行程的形状（`legs` 三段无 day，充电点在 energyStops）。 */
  const real = (): TripPlanSnapshot => ({
    status: "confirmed",
    destination: "徐州",
    days: 2,
    legs: [
      { reason: "rest", fromStop: "上海", toStop: "S122常州服务区", driveMinutes: 136 },
      { reason: "rest", fromStop: "S122常州服务区", driveMinutes: 116 },
      { driveMinutes: 119 },
    ],
    energyStops: ["淮安六洞服务区国家电网电动汽车充电站"],
    skeleton: [
      { day: 1, theme: "一", spots: [spot("云龙湖")] },
      { day: 2, theme: "二", spots: [spot("汉文化"), spot("纪念馆")] },
    ],
    caveats: [],
    updatedTurnId: "t",
  });

  it("`legs` 在、但这一天一段都没对上 → 两项都是 undefined，不是 0", () => {
    const m = dayMetrics(real(), 1);
    assert.equal(m.spots, 1);
    assert.equal(m.driveMinutes, undefined, "「行车约 0 分钟」是编的");
    assert.equal(m.chargeStops, undefined, "「无补能停靠」同样是编的");
  });

  it("[M93-05] 补能点走自己那一行，四格里没有「景区」，充电站不冒充当天的数", () => {
    const cells = dayServices(real(), 1);
    assert.deepEqual(cells.map((c) => c.key), ["charge", "food", "restroom", "parking"]);
    // 从前这一格写「整程 1 个」、旁边还有一格「景区 1 个」数的是本行程自己的站——
    // 三个来源并排，读到的却是"这一排都是周边有什么"。现在四格同源，整程的话另起一行。
    assert.equal(cells.find((c) => c.key === "charge")!.value, PENDING);
    assert.deepEqual(chargeStopNames(real()), ["淮安六洞服务区国家电网电动汽车充电站"]);
  });

  it("[M93-05] 整程也没有补能点 → 那一行整个不画，格子仍是「待查」而不是 0", () => {
    const p = real();
    delete p.energyStops;
    assert.deepEqual(chargeStopNames(p), []);
    const by = Object.fromEntries(dayServices(p, 1).map((c) => [c.key, c.value]));
    assert.equal(by.charge, PENDING, "周边有多少桩没查过，不能拿「无需补能」顶替");
  });

  it("legs 带 day 时照旧按天算（既有行为不回归）", () => {
    const p = real();
    p.legs = [
      { day: 1, driveMinutes: 40, reason: "charge" },
      { day: 1, driveMinutes: 20 },
    ];
    assert.deepEqual(dayMetrics(p, 1), { spots: 1, driveMinutes: 60, chargeStops: 1 });
  });
});

/**
 * [F-18-15][AC-18-11] 行上的变化标（M83 走查追修）：改了几位就写几位。
 */
describe("[F-18-15][AC-18-11] rowChanges", () => {
  const base = (): TripPlanSnapshot => ({
    status: "confirmed",
    destination: "X",
    days: 3,
    skeleton: [
      { day: 1, theme: "1", spots: [spot("A"), spot("B"), spot("C")] },
      { day: 2, theme: "2", spots: [spot("D"), spot("E")] },
      { day: 3, theme: "3", spots: [spot("F")] },
    ],
    caveats: [],
    updatedTurnId: "t",
  });

  it("重排：每一行写出自己挪了几位、朝哪边", () => {
    const p = base();
    const after = applyStructureEdits(p, [{ kind: "reorder", day: 1, order: ["C", "A", "B"] }]);
    const m = rowChanges(p, after, 1);
    assert.deepEqual(m.get("C"), { kind: "up", steps: 2 });
    assert.deepEqual(m.get("A"), { kind: "down", steps: 1 });
    assert.deepEqual(m.get("B"), { kind: "down", steps: 1 });
  });

  it("换天：目标天那一行写「从 Day N 移来」", () => {
    const p = base();
    const after = applyStructureEdits(p, [{ kind: "move", day: 2, spot: "D", toDay: 1 }]);
    assert.deepEqual(rowChanges(p, after, 1).get("D"), { kind: "moved-in", fromDay: 2 });
  });

  it("**删一站不该让它后面的行都报「前移」**——那是删除的副作用，不是车主挪的", () => {
    const p = base();
    const after = applyStructureEdits(p, [{ kind: "remove", day: 1, spot: "A" }]);
    assert.equal(rowChanges(p, after, 1).size, 0);
  });

  it("没改过的天一个标都没有", () => {
    const p = base();
    const after = applyStructureEdits(p, [{ kind: "reorder", day: 1, order: ["C", "A", "B"] }]);
    assert.equal(rowChanges(p, after, 3).size, 0);
  });

  it("文案：方向词用前后不用上下——时间轴是顺序不是位置", () => {
    assert.equal(rowChangeLabel({ kind: "up", steps: 2 }), "↑ 前移 2 位");
    assert.equal(rowChangeLabel({ kind: "down", steps: 1 }), "↓ 后移 1 位");
    assert.equal(rowChangeLabel({ kind: "moved-in", fromDay: 2 }), "从 Day 2 移来");
  });
});

/**
 * [F-18-15][AC-18-11] 充电站那一格（M83 走查追修）。
 *
 * 口径全部来自 2026-09-14 对库里六份已确认行程的实测：
 * `energyStops` 是**整程**的自由文本，不带天；`transit.recommended` 与它**对不上**
 * （徐州、普陀山标 train 却带着补能点——大交通改过、补能点没跟着清）。
 */
describe("[F-18-15][AC-18-11] 充电站：整程补能点", () => {
  const mk = (over: Partial<TripPlanSnapshot>): TripPlanSnapshot => ({
    status: "confirmed",
    destination: "X",
    days: 2,
    skeleton: [{ day: 1, theme: "a", spots: [spot("S")] }],
    caveats: [],
    updatedTurnId: "t",
    ...over,
  });

  it("有补能点 → 「整程 N 个」，**整程二字不能省**（它没有按天归属）", () => {
    assert.equal(chargeCellValue(mk({ energyStops: ["A", "B"] })), "整程 2 个");
  });

  it("**不按 transit 判断有没有**：标 train 却带着补能点时，照样显示出来", () => {
    const p = mk({ energyStops: ["淮安六洞服务区国家电网电动汽车充电站"], transit: { recommended: "train", summary: "" } });
    assert.equal(chargeCellValue(p), "整程 1 个", "拿 transit 当闸门会把真实存在的数据判没了");
  });

  it("没有补能点 + 火车/飞机 → 「不适用」：这趟不开车", () => {
    assert.equal(chargeCellValue(mk({ transit: { recommended: "train", summary: "" } })), "不适用");
    assert.equal(chargeCellValue(mk({ transit: { recommended: "flight", summary: "" } })), "不适用");
  });

  it("没有补能点 + 自驾或大交通未定 → 「无需补能」，**不是「0 个」也不是「待查」**", () => {
    assert.equal(chargeCellValue(mk({ transit: { recommended: "drive", summary: "" } })), "无需补能");
    assert.equal(chargeCellValue(mk({})), "无需补能");
  });

  it("展示名去掉括号注解——里程与绕行量是噪音，且一行放不下", () => {
    assert.equal(chargeStopName("淮安六洞服务区国家电网电动汽车充电站"), "淮安六洞服务区国家电网电动汽车充电站");
    assert.equal(chargeStopName("江都服务区（沪陕高速上海方向，约181km处）— 国网快充×3 + 蔚来换电站"), "江都服务区");
    assert.equal(
      chargeStopName("永嘉县岩坦镇景泉村半岭村停车场充电站（沿线 375km 处，绕行约 767m）"),
      "永嘉县岩坦镇景泉村半岭村停车场充电站",
    );
  });

  it("只切不改：括号前那一段原样保留，不做任何加工", () => {
    assert.equal(chargeStopName("国网(杭州)充电站"), "国网");
    assert.deepEqual(chargeStopNames(mk({ energyStops: ["A站（x）", "B站"] })), ["A站", "B站"]);
    assert.deepEqual(chargeStopNames(mk({})), []);
  });

  it("[M93-05] 补能点只走格子下面那一行，不进那四格", () => {
    const withStops = mk({ energyStops: ["A"] });
    const cells = dayServices(withStops, 1);
    assert.equal(cells.length, 4);
    assert.equal(cells.find((c) => c.key === "charge")!.value, PENDING);
    assert.deepEqual(chargeStopNames(withStops), ["A"]);
  });
});

/**
 * [F-18-15][AC-18-11] 出发时刻与返程行（M83 走查追修，用户走查：
 * 「从上海出发没有时间点；第二天从酒店出发也没有；最后一天没有回到上海」）。
 *
 * 数据是 M77 走查追修刚加的：`submit_drive_draft` 的 `legDays` 让段有了天归属，
 * `returnMinutes` 让 `buildLegs` 的末段 `toStop = origin`。
 */
describe("[F-18-15][AC-18-11] 出发时刻与返程", () => {
  const p = (): TripPlanSnapshot => ({
    status: "confirmed",
    destination: "苏州",
    origin: "上海",
    days: 3,
    legs: [
      { day: 1, fromStop: "上海", toStop: "S122常州服务区", driveMinutes: 80, reason: "rest" },
      { day: 1, fromStop: "S122常州服务区", driveMinutes: 40 },
      { day: 3, fromStop: "苏州", toStop: "上海", driveMinutes: 110 },
    ],
    skeleton: [
      { day: 1, theme: "a", spots: [spot("苏州博物馆", "11:00", "13:00")], hotel: { name: "平江客栈" } },
      { day: 2, theme: "b", spots: [spot("虎丘", "09:00", "11:30")], hotel: { name: "平江客栈" } },
      { day: 3, theme: "c", spots: [spot("沧浪亭", "09:30", "11:30")] },
    ],
    caveats: [],
    updatedTurnId: "t",
  });

  it("Day 1 出发时刻 = 第一站 estStart 减去当天去程总时长", () => {
    assert.equal(dayDepartTime(p(), 1), "09:00", "11:00 − (80 + 40) 分钟");
    assert.equal(dayTimeline(p(), 1)[0]!.time, "09:00");
  });

  it("**第 2 天算不出**——市内从酒店到第一站的车程从没被提交过，不是显示问题", () => {
    assert.equal(dayDepartTime(p(), 2), undefined);
    const row = dayTimeline(p(), 2)[0]!;
    assert.equal(row.time, undefined, "算不出就不给时刻");
    assert.equal(row.name, "平江客栈");
    assert.equal(row.note, "出发", "出发这件事是确定的，几点出发不确定");
  });

  it("最后一天多一行「回到出发地」，时刻 = 最后一站 estEnd 加返程时长", () => {
    const rows = dayTimeline(p(), 3);
    const back = rows.at(-1)!;
    assert.equal(back.kind, "return");
    assert.equal(back.name, "上海");
    assert.equal(back.time, "13:20", "11:30 + 110 分钟");
    assert.equal(back.note, "返程 1 小时 50 分");
  });

  it("没有返程链就不编一行——坐火车回去、或本来就不闭环", () => {
    const noBack = p();
    noBack.legs = noBack.legs!.slice(0, 2);
    assert.equal(dayReturnRow(noBack, 3), undefined);
    assert.ok(!dayTimeline(noBack, 3).some((r) => r.kind === "return"));
  });

  it("最后一站没有 estEnd：**行还在**（回得去是事实），只是不给时刻", () => {
    const q = p();
    q.skeleton[2]!.spots = [{ name: "沧浪亭" }];
    const back = dayReturnRow(q, 3)!;
    assert.equal(back.name, "上海");
    assert.equal(back.time, undefined);
  });

  it("当天往返：返程链不把去程那一段吞进来", () => {
    const one: TripPlanSnapshot = {
      ...p(),
      days: 1,
      legs: [
        { day: 1, fromStop: "上海", toStop: "朱家角", driveMinutes: 60 },
        { day: 1, fromStop: "朱家角", toStop: "上海", driveMinutes: 65 },
      ],
      skeleton: [{ day: 1, theme: "a", spots: [spot("朱家角古镇", "10:00", "16:00")] }],
    };
    assert.deepEqual(returnLegs(one).map((l) => l.driveMinutes), [65]);
    assert.equal(dayDepartTime(one, 1), "09:00", "10:00 − 60 分钟，返程那段不算进去");
    assert.equal(dayReturnRow(one, 1)!.time, "17:05");
  });

  it("最后一天先换片区再返程：换片区那段是去程，不算进返程（turn-ced8b400）", () => {
    // 实测形态：第 3 天「嵊泗县→普陀区」是换片区的去程段，起点不是出发地，
    // 旧判据一路把它收进返程链——「返程 9 小时 10 分 · 21:10」，真实是 215 分、15:35。
    const island: TripPlanSnapshot = {
      ...p(),
      legs: [
        { day: 1, direction: "outbound", fromStop: "上海", toStop: "西湖区", driveMinutes: 175 },
        { day: 2, direction: "outbound", fromStop: "西湖区", toStop: "嵊泗县", driveMinutes: 485 },
        { day: 3, direction: "outbound", fromStop: "嵊泗县", toStop: "普陀区", driveMinutes: 335 },
        { day: 3, direction: "return", fromStop: "普陀区", toStop: "慈溪服务区", driveMinutes: 101, reason: "rest" },
        { day: 3, direction: "return", fromStop: "慈溪服务区", toStop: "上海", driveMinutes: 114 },
      ],
    };
    island.skeleton[2]!.spots = [spot("朱家尖南沙景区", "09:00", "12:00")];
    assert.deepEqual(returnLegs(island).map((l) => l.driveMinutes), [101, 114]);
    const row = dayReturnRow(island, 3)!;
    assert.equal(row.note, "返程 3 小时 35 分");
    assert.equal(row.time, "15:35");
  });

  it("倒推跨到前一天就不给时刻——那是可执行性的结论，该由体检说", () => {
    const far = p();
    far.legs = [{ day: 1, fromStop: "上海", driveMinutes: 700 }];
    far.skeleton[0]!.spots = [spot("远方", "09:00", "11:00")];
    assert.equal(dayDepartTime(far, 1), undefined);
  });

  it("没有 legs 时两样都没有（老快照不回归）", () => {
    const bare = p();
    delete bare.legs;
    assert.equal(dayDepartTime(bare, 1), undefined);
    assert.equal(dayReturnRow(bare, 3), undefined);
  });
});

/**
 * [F-18-15][AC-18-11] 第 2 天起的出发时刻走 `startLeg`（M83 走查追修）。
 *
 * 用户走查："第二天从酒店出发也没有出发时间点"。当时是数据缺口——市内段从没被提交过。
 * 现在由确认路径按坐标调高德算出来写进快照（`resolveDayStartLegs`），这里只管读。
 */
describe("[F-18-15][AC-18-11] startLeg 驱动的出发时刻", () => {
  const withStart = (): TripPlanSnapshot => ({
    status: "confirmed",
    destination: "苏州",
    origin: "上海",
    days: 3,
    legs: [{ day: 1, fromStop: "上海", driveMinutes: 120 }],
    skeleton: [
      { day: 1, theme: "a", spots: [spot("博物馆", "11:00", "13:00")], hotel: { name: "平江客栈" } },
      {
        day: 2,
        theme: "b",
        spots: [spot("虎丘", "09:00", "11:30")],
        hotel: { name: "平江客栈" },
        startLeg: { fromName: "平江客栈", driveMinutes: 25, computedAt: "2026-09-14T10:00:00.000Z" },
      },
      { day: 3, theme: "c", spots: [spot("沧浪亭", "09:30", "11:30")] },
    ],
    caveats: [],
    updatedTurnId: "t",
  });

  it("有 startLeg → 出发时刻 = 第一站 estStart 减去它", () => {
    assert.equal(dayDepartTime(withStart(), 2), "08:35", "09:00 − 25 分钟");
    const row = dayTimeline(withStart(), 2)[0]!;
    assert.equal(row.time, "08:35");
    assert.equal(row.note, "出发 · 车程 25 分钟", "把依据摆出来，才不像凭空给的时刻");
  });

  it("没有 startLeg → 照旧不给时刻、note 只写「出发」（第 3 天没算出来）", () => {
    assert.equal(dayDepartTime(withStart(), 3), undefined);
    const row = dayTimeline(withStart(), 3)[0]!;
    assert.equal(row.time, undefined);
    assert.equal(row.note, "出发");
  });

  it("**第 1 天不看 startLeg**：它走 legs 的去程段，两处口径不重叠", () => {
    const p = withStart();
    p.skeleton[0]!.startLeg = { fromName: "假的", driveMinutes: 5, computedAt: "x" };
    assert.equal(dayDepartTime(p, 1), "09:00", "11:00 − 120 分钟，与 startLeg 无关");
  });

  it("倒推跨到前一天仍然不给时刻", () => {
    const p = withStart();
    p.skeleton[1]!.startLeg = { fromName: "平江客栈", driveMinutes: 600, computedAt: "x" };
    assert.equal(dayDepartTime(p, 2), undefined);
  });

  it("老快照（没有 startLeg 字段）行为与从前一字不差", () => {
    const p = withStart();
    delete p.skeleton[1]!.startLeg;
    assert.equal(dayDepartTime(p, 2), undefined);
    assert.equal(dayTimeline(p, 2)[0]!.note, "出发");
  });
});

/**
 * [F-18-15][AC-18-11] 到店时刻（M83 走查追修，用户走查：
 * 「把最后一个景点到酒店的时间也给算出来，这样用户能方便地了解自己的时间安排」）。
 */
describe("[F-18-15][AC-18-11] endLeg 驱动的到店时刻", () => {
  const withEnd = (): TripPlanSnapshot => ({
    status: "confirmed",
    destination: "苏州",
    origin: "上海",
    days: 2,
    skeleton: [
      {
        day: 1,
        theme: "a",
        spots: [spot("博物馆", "12:30", "14:30"), spot("平江路", "18:00", "20:30")],
        hotel: { name: "拙逸泊悦酒店" },
        endLeg: { toName: "拙逸泊悦酒店", driveMinutes: 12, computedAt: "2026-09-15T10:00:00.000Z" },
      },
      { day: 2, theme: "b", spots: [spot("虎丘", "09:00", "11:30")], hotel: { name: "诚品行政酒店" } },
    ],
    caveats: [],
    updatedTurnId: "t",
  });

  it("到店时刻 = 当天**最后一站**的 estEnd 加车程", () => {
    assert.equal(dayArriveHotelTime(withEnd(), 1), "20:42", "20:30 + 12 分钟");
    const hotelRow = dayTimeline(withEnd(), 1).at(-1)!;
    assert.equal(hotelRow.kind, "hotel");
    assert.equal(hotelRow.time, "20:42");
    assert.equal(hotelRow.note, "入住 · 车程 12 分钟", "把依据摆出来");
  });

  it("没有 endLeg → 不给时刻，那一行仍然写「入住」", () => {
    assert.equal(dayArriveHotelTime(withEnd(), 2), undefined);
    const row = dayTimeline(withEnd(), 2).at(-1)!;
    assert.equal(row.time, undefined);
    assert.equal(row.note, "入住", "住这件事是确定的，几点到不确定");
  });

  it("最后一站没有 estEnd → 不给时刻（不拿前一站的时间顶替）", () => {
    const p = withEnd();
    p.skeleton[0]!.spots[1] = { name: "平江路" };
    assert.equal(dayArriveHotelTime(p, 1), undefined);
    assert.equal(dayTimeline(p, 1).at(-1)!.time, undefined);
  });

  it("跨零点不给——与出发时刻同一条：那是可执行性的结论", () => {
    const p = withEnd();
    p.skeleton[0]!.endLeg = { toName: "x", driveMinutes: 300, computedAt: "t" };
    assert.equal(dayArriveHotelTime(p, 1), undefined, "20:30 + 5 小时 = 次日 01:30");
  });

  it("老快照（没有 endLeg 字段）行为与从前一字不差", () => {
    const p = withEnd();
    delete p.skeleton[0]!.endLeg;
    assert.equal(dayTimeline(p, 1).at(-1)!.note, "入住");
  });
});
