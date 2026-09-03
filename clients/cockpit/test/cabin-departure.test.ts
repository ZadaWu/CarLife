/**
 * 出发动画时间轴与出发卡逻辑（0830 重排）。
 *
 * 盯的不变量：
 *  - 字幕 cue 与画面关键帧同出一份 DEPARTURE_TIMELINE——上一版两处手写时间
 *    漂掉（画面在高光时刻、字幕已写"演示完成"），这里断言"开门那一帧
 *    落在「暖暖上车」相位里"之类的同步关系，不靠肉眼对表；
 *  - 高德 URI 的 to 参数是 lon,lat（经度在前，与领域模型 lat/lon 相反）；
 *  - 导航目标：今日优先、缺坐标退全程、全无坐标如实 undefined。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TripPlanSnapshot } from "@carlife/shared";

import {
  amapAppNavUri,
  amapNavUri,
  departureLayers,
  DEPARTURE_TIMELINE,
  DEPARTURE_CLIPS,
  CLIP_START,
  statusAt,
  pickNavTarget,
  todayStopNames,
} from "../src/features/cabin/departure";

const T = (ms: number) => ms / DEPARTURE_TIMELINE.total;
const phaseAt = (key: string) => DEPARTURE_TIMELINE.phases.find((p) => p.key === key)!.at;
/** 某层在某时刻的可见度（关键帧是硬切，所以取"最后一个已到达的帧"）。 */
const visAt = (frames: Keyframe[], ms: number) => {
  const off = ms / DEPARTURE_TIMELINE.total;
  let v = 0;
  for (const f of frames) if ((f.offset as number) <= off) v = f.opacity as number;
  return v;
};

test("时间轴：相位严格递增且都落在总时长内，字幕非空", () => {
  const { total, phases } = DEPARTURE_TIMELINE;
  assert.ok(phases.length >= 4);
  for (let i = 0; i < phases.length; i += 1) {
    const p = phases[i]!;
    assert.ok(p.at >= 0 && p.at < total, `${p.key} 越界`);
    if (i > 0) assert.ok(p.at > phases[i - 1]!.at, `${p.key} 没有递增`);
    assert.ok(p.status.length > 0);
  }
});

/**
 * 0831：改时间轴时被浏览器当场抓到的一类错——WAAPI 的
 * `Failed to execute 'animate': Offsets must be monotonically non-decreasing`。
 * 病灶是"有的层用相位偏移、有的层写死毫秒"，两者混排；相位一挪就乱序，
 * animate() 抛错、整个 overlay 崩成白屏，而所有只看"某帧在不在某相位里"的用例照过。
 */
test("关键帧合法性：每层 offset 单调非递减且落在 [0,1]", () => {
  for (const [key, frames] of Object.entries(departureLayers())) {
    assert.ok(frames.length > 0, `${key} 是空层`);
    let prev = -Infinity;
    frames.forEach((f, i) => {
      const off = f.offset as number;
      assert.ok(typeof off === "number" && Number.isFinite(off), `${key} 第 ${i} 帧 offset 不是数`);
      assert.ok(off >= 0 && off <= 1, `${key} 第 ${i} 帧 offset=${off} 越出 [0,1]`);
      assert.ok(off >= prev, `${key} 第 ${i} 帧 offset=${off} 小于前一帧 ${prev}（WAAPI 会直接抛错）`);
      prev = off;
    });
  }
});

/**
 * 四段片子是一条链：首尾相接、不重叠也不留缝、合起来覆盖全程。
 *
 * 留缝会露出底下的 HUD 地图，重叠会两段片子半透明同框（重影）。
 * 这条同时钉死"相位必须由片内节拍推导"——有人回头去手写某个相位的裸毫秒就会红。
 */
test("四段片子首尾相接，且相位落在它对应的片内节拍上", () => {
  const layers = departureLayers();
  const keys = DEPARTURE_CLIPS.map((c) => c.key);

  assert.equal(CLIP_START.arrive, 0, "第一段必须从 0 开始");
  assert.equal(
    DEPARTURE_TIMELINE.total,
    DEPARTURE_CLIPS.reduce((n, c) => n + c.duration, 0),
    "总时长必须正好等于四段之和，否则最后一段会被出发卡截断",
  );

  // 任意时刻**恰好一段**可见。
  for (let ms = 0; ms < DEPARTURE_TIMELINE.total; ms += 100) {
    const lit = keys.filter((k) => visAt(layers[`${k}Clip`]!, ms) > 0.5);
    assert.equal(lit.length, 1, `t=${ms}ms 有 ${lit.length} 段片子可见（应恰好 1 段）：${lit}`);
  }

  // 相位必须落在片内节拍上，不能是手写的裸毫秒。
  const board = DEPARTURE_CLIPS.find((c) => c.key === "board")!;
  assert.equal(phaseAt("ambient"), CLIP_START.wake + DEPARTURE_CLIPS[1]!.beats.handUp,
    "「点亮氛围」必须落在片里她举手那一刻");
  assert.equal(phaseAt("board"), CLIP_START.board + board.beats.doorOpen,
    "「暖暖上车」必须落在片里车门打开那一刻");
  assert.equal(phaseAt("ready"), CLIP_START.board + board.beats.shutAndLit,
    "「准备出发」必须落在片里关门点灯那一刻");
  assert.equal(phaseAt("depart"), CLIP_START.driveoff,
    "「出发！」必须正好是驶离片接手的那一刻");
});

/**
 * 暖暖只出现在第 2 段之后，所以第 1→2 切点处她会凭空冒出来。
 * 这一层是从第 2 段第 0 帧抠出来的她，必须在切点前淡满、切点后立刻退场
 * ——留着的话会和片子里的她叠成两个。
 */
test("切点前的暖暖：进片时已淡满，进片后立刻退场", () => {
  const intro = departureLayers().introNuannuan!;
  const onAt = T(CLIP_START.wake);
  // 这里断言关键帧结构而不是采样：淡入是插值出来的，而 visAt 是阶跃取值，
  // 拿它去量淡入中段只会得到上一个关键帧的值（0），量出来的"没淡满"是假的。
  const full = intro.filter((k) => k.opacity === 1);
  assert.equal(full.length, 1, "应当只有一帧是完全不透明的（淡入的终点）");
  assert.ok(Math.abs((full[0]!.offset as number) - onAt) < 1e-9,
    "淡入的终点必须正好落在第 2 段接手那一刻，早了会和片子重叠、晚了她会凭空出现");
  const after = intro.filter((k) => Math.abs((k.offset as number) - onAt) < 1e-9);
  assert.equal(after[after.length - 1]!.opacity, 0,
    "接手那一刻必须硬切退场，否则会和片子里的她叠成两个");
  assert.equal(visAt(intro, CLIP_START.wake + 1), 0, "第 2 段开始后她还在");
});

/**
 * 「唤醒」这一拍不许出现"选择了某个功能"的语义。
 *
 * 动画里的选择与前端真实的功能状态没有任何绑定——一旦对不上就是在骗人，
 * 功能增删时还会指错对象。所以只允许"举手 + 光带"这类不指向的表达。
 * 这条把它变成机器可判的：**五颗功能球的外环必须完全同构**。
 */
test("唤醒这一拍不许有「选择」语义：五颗功能球外环必须完全同构", () => {
  const layers = departureLayers();
  const rings = ["ringClimate", "ringLight", "ringSeat", "ringMedia", "ringFamily"].map((k) => layers[k]!);
  rings.forEach((r, i) => assert.ok(r && r.length > 0, `第 ${i} 颗球没有外环关键帧`));
  const shape = (frames: Keyframe[]) => frames.map((f) => [f.opacity, f.transform]);
  const first = JSON.stringify(shape(rings[0]!));
  rings.slice(1).forEach((r, i) =>
    assert.equal(JSON.stringify(shape(r)), first,
      `第 ${i + 1} 颗球的外环与其它几颗不同构 = 它被单独加戏了`));
  const firstOn = rings.map((r) => r.find((k) => (k.opacity as number) > 0.5)!.offset as number);
  for (let i = 1; i < firstOn.length; i += 1) {
    assert.ok(firstOn[i]! > firstOn[i - 1]!, `第 ${i} 颗球没有按顺序递延`);
  }
  // 光带必须在上车段接手前收干净——片子里没有它，留着切一下就消失。
  const band = layers.wakeBand!;
  assert.equal(band[band.length - 1]!.opacity, 0, "唤醒光带没在上车段之前收掉");
  assert.equal(visAt(band, CLIP_START.board + 100), 0, "上车段里还亮着光带");
});

test("字幕取值：相位起点那一帧算新相位，越界两端夹住", () => {
  const ps = DEPARTURE_TIMELINE.phases;
  assert.equal(statusAt(-100), ps[0]!.status, "开始前夹到第一句");
  for (const p of ps) assert.equal(statusAt(p.at), p.status, `${p.key} 的起点那一帧就该换句`);
  // 起点前一毫秒必须还是上一句——边界只差一毫秒，最容易写反。
  for (let i = 1; i < ps.length; i += 1) {
    assert.equal(statusAt(ps[i]!.at - 1), ps[i - 1]!.status, `${ps[i]!.key} 提前了一毫秒`);
  }
  assert.equal(statusAt(DEPARTURE_TIMELINE.total + 5_000), ps[ps.length - 1]!.status, "结束后夹到最后一句");
});

/*
 * 曾经这里还有一条「行驶方向：车头朝左的素材必须自右向左开进来」。
 * 0831 拆成四段实拍片之后，车的进出全部由片子承担，代码里不再有可断言的位移，
 * 这条随之删除——不是漏了。方向的把关移到了生成环节：每段出片后拉一行帧序图
 * 逐格核对，判据写在 内部技能模板
 */

test("高德 App scheme：lat/lon 分开传（与 web 入口的 lon,lat 约定不同）", () => {
  const uri = amapAppNavUri({ lat: 29.985, lon: 122.387, name: "普济寺" });
  assert.ok(uri.startsWith("iosamap://navi?"));
  assert.ok(uri.includes("lat=29.985") && uri.includes("lon=122.387"));
  assert.ok(uri.includes(`poiname=${encodeURIComponent("普济寺")}`));
});

test("高德 URI：lon 在前 lat 在后、名字转义、坐标系与唤起参数在", () => {
  const uri = amapNavUri({ lat: 29.985, lon: 122.387, name: "普济寺 停车场" });
  assert.ok(uri.startsWith("https://uri.amap.com/navigation?to=122.387,29.985,"), "to 必须是 lon,lat 序");
  assert.ok(uri.includes(encodeURIComponent("普济寺 停车场")));
  assert.ok(uri.includes("coordinate=gaode"), "行程坐标是 GCJ-02，必须明标");
  assert.ok(uri.includes("callnative=1"), "设备上要唤起高德 App");
});

const plan = (skeleton: TripPlanSnapshot["skeleton"], startDate?: string): TripPlanSnapshot =>
  ({
    status: "confirmed",
    destination: "舟山",
    days: skeleton.length,
    ...(startDate ? { startDate } : {}),
    skeleton,
    caveats: [],
    updatedTurnId: "t",
  }) as TripPlanSnapshot;

test("导航目标：今日第一个带坐标的落点优先；今日全无坐标退全程；全无 → undefined", () => {
  const p = plan(
    [
      { day: 1, theme: "a", spots: [{ name: "无坐标点" }, { name: "普济寺", lat: 29.985, lon: 122.387 }] },
      { day: 2, theme: "b", spots: [{ name: "慧济寺", lat: 30.01, lon: 122.39 }] },
    ],
    // 今天 = 第 2 天
    new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  );
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(pickNavTarget(p, today), { lat: 30.01, lon: 122.39, name: "慧济寺" });

  // 今日（第 1 天）无坐标 → 退到全程第一个带坐标的。
  const p2 = plan([
    { day: 1, theme: "a", spots: [{ name: "无坐标点" }] },
    { day: 2, theme: "b", spots: [{ name: "慧济寺", lat: 30.01, lon: 122.39 }] },
  ]);
  assert.equal(pickNavTarget(p2, today)?.name, "慧济寺");

  // 全程零坐标 → 如实 undefined，出发卡禁用按钮而不是编一个点。
  const p3 = plan([{ day: 1, theme: "a", spots: [{ name: "无坐标点" }] }]);
  assert.equal(pickNavTarget(p3, today), undefined);
});

test("今日路线名单：只取当日、按上限截断", () => {
  const p = plan([
    {
      day: 1,
      theme: "a",
      spots: Array.from({ length: 8 }, (_, i) => ({ name: `点${i + 1}` })),
    },
    { day: 2, theme: "b", spots: [{ name: "别天的点" }] },
  ]);
  const names = todayStopNames(p, new Date().toISOString().slice(0, 10));
  assert.equal(names.length, 5);
  assert.ok(!names.includes("别天的点"));
});
