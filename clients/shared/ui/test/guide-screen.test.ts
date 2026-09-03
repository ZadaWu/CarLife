/**
 * 景点导览信息页（施工单 M36-03）。
 *
 * 盯的不变量：三态不越界（collecting 有占位、failed 明说"没查到"不出空壳、
 * ready 两栏齐）；缺席栏目整栏不渲染而 caveat 上屏；editorial 排序必须带
 * "顺序来自攻略整理"标注（如实标注是本仓红线，不是文案偏好）；
 * 小地图 geo/editorial 两种画法与单向箭头。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GuideBrief } from "@carlife/shared";

import { GuideScreen, type GuideScreenState } from "../src/guide/GuideScreen";
import {
  GuideMiniMap,
  clampMiniMapView,
  fallbackReasonOf,
  routeChevrons,
  smoothPathD,
  spreadClusteredPoints,
} from "../src/guide/GuideMiniMap";
import { locatedWithSeq } from "../src/guide/GuideMiniMapAmap";
import { configureAmap } from "../src/map/amap-loader";

const BRIEF: GuideBrief = {
  spot: "普陀山",
  city: "舟山",
  selfDrive: true,
  access: {
    parking: [{ name: "码头停车场", toGate: "步行5分钟乘轮渡", lat: 29.94, lon: 122.37 }],
    charging: [{ name: "国网充电站" }],
    refuel: [],
    arrivalAdvice: "车停码头，乘轮渡上岛",
  },
  spots: [
    { name: "普济寺", mustSee: "全山最大古刹", kind: "spot", lat: 29.985, lon: 122.387 },
    { name: "南海观音", mustSee: "33米金身立像", kind: "spot", lat: 29.977, lon: 122.398 },
    { name: "百步沙", reason: "看海拍照", kind: "photo", lat: 29.984, lon: 122.391 },
  ],
  routeOrderSource: "geo",
  transportAdvice: "佛顶山有索道",
  comfort: [
    { kind: "food", name: "普济寺斋堂", note: "11:30 开餐" },
    { kind: "toilet", note: "到处有开水" },
    { kind: "pitfall", note: "码头兜售勿理", source: { url: "https://x.example/1" } },
  ],
  caveats: [],
  findings: [],
  branchSources: { access: "submission", spots: "submission", comfort: "submission" },
  sourcesVerified: { matched: 1, claimed: 1 },
  generatedAt: "2026-08-28T00:00:00Z",
};

const render = (state: GuideScreenState, spotName = "普陀山") =>
  renderToStaticMarkup(
    createElement(GuideScreen, { spotName, state, onBack: () => {} }),
  );

describe("导览页三态", () => {
  it("collecting：有'采集中'占位与骨架，不出任何编造内容", () => {
    const html = render({ status: "collecting" });
    assert.ok(html.includes("正在为你采集"));
    assert.ok(html.includes("guide-screen__skeleton-row"));
    assert.equal(html.includes("游玩时间轴"), false, "数据没到不该出真栏目");
  });

  it("failed：明说'没查到'，不出空壳；给了 onRetry 才有重试钮", () => {
    const html = render({ status: "failed" });
    assert.ok(html.includes("没有查到"));
    assert.equal(html.includes("再试一次"), false, "没给 onRetry 不该渲染一个点了没反应的钮");
    const withRetry = renderToStaticMarkup(
      createElement(GuideScreen, {
        spotName: "普陀山",
        state: { status: "failed" },
        onBack: () => {},
        onRetry: () => {},
      }),
    );
    assert.ok(withRetry.includes("再试一次"));
  });

  it("ready：左时间轴右小地图两栏齐，时间轴含停车/游玩/打卡/餐饮/充电", () => {
    const html = render({ status: "ready", brief: BRIEF });
    assert.ok(html.includes("游玩时间轴"));
    assert.ok(html.includes("单向游玩路线"));
    for (const label of ["停车场", "游玩点", "打卡点", "餐饮", "充电"]) {
      assert.ok(html.includes(label), `时间轴缺 ${label} 标记`);
    }
    assert.ok(html.includes("码头停车场"));
    assert.ok(html.includes("全山最大古刹"));
    assert.ok(html.includes("佛顶山有索道"));
    // 无名字的泛提示进休憩栏目、避雷单列
    assert.ok(html.includes("到处有开水"));
    assert.ok(html.includes("避雷提醒"));
  });
});

describe("如实标注", () => {
  it("editorial 排序：页面必须带'顺序来自攻略整理'；geo 不带", () => {
    const geo = render({ status: "ready", brief: BRIEF });
    assert.equal(geo.includes("顺序来自攻略整理"), false);
    const editorial = render({
      status: "ready",
      brief: {
        ...BRIEF,
        routeOrderSource: "editorial",
        caveats: ["游玩顺序来自攻略整理（未经坐标校验）"],
      },
    });
    assert.ok(editorial.includes("顺序来自攻略整理"));
  });

  it("access 缺席：到达提示条不渲染，caveat 原样上屏", () => {
    const html = render({
      status: "ready",
      brief: { ...BRIEF, access: undefined, caveats: ["到达与补能信息本次未查到"] },
    });
    assert.equal(html.includes("车停码头"), false);
    assert.ok(html.includes("到达与补能信息本次未查到"));
  });
});

describe("竖屏变体（M36-04）", () => {
  const renderPortrait = (brief: GuideBrief) =>
    renderToStaticMarkup(
      createElement(GuideScreen, {
        spotName: "普陀山",
        state: { status: "ready", brief },
        onBack: () => {},
        layout: "portrait",
      }),
    );

  it("单列流：小地图在时间轴之前；到达段折叠成 details 不占首屏", () => {
    const html = renderPortrait(BRIEF);
    assert.ok(html.includes("guide-screen--portrait"));
    assert.ok(
      html.indexOf("单向游玩路线") < html.indexOf("游玩时间轴"),
      "竖屏是上图下轴——顺序反了就是车机布局漏进了手机",
    );
    assert.ok(html.includes("<details"), "到达建议要折叠");
    assert.ok(html.includes("车停码头，乘轮渡上岛"));
    // 头部副标不再重复到达建议（折叠区是唯一出处）
    assert.equal((html.match(/车停码头，乘轮渡上岛/g) ?? []).length, 1);
  });

  it("缺省 layout 仍是车机两栏：既有调用方一行不改", () => {
    const html = render({ status: "ready", brief: BRIEF });
    assert.equal(html.includes("guide-screen--portrait"), false);
    assert.ok(
      html.indexOf("游玩时间轴") < html.indexOf("单向游玩路线"),
      "wide 布局左轴右图的 DOM 顺序不该被竖屏改动波及",
    );
  });
});

describe("小地图", () => {
  const mini = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(GuideMiniMap, { spots: BRIEF.spots, ...props } as never));

  it("geo：平滑曲线路线（贝塞尔）+ 长段方向 chevron，序号 1..n 与起点'停'方块都在", () => {
    const html = mini({ orderSource: "geo", origin: { name: "码头停车场", lat: 29.94, lon: 122.37 } });
    assert.ok(html.includes("guide-minimap__route"));
    assert.ok(/ C [\d.]+ [\d.]+,/.test(html), "≥3 点的路线应是 Catmull-Rom 曲线，不是折线");
    assert.ok(html.includes("guide-minimap__chevron"), "长段要有方向标");
    assert.ok(html.includes(">1</text>") && html.includes(">3</text>"));
    assert.ok(html.includes(">停</text>"), "起点停车场要在图上");
  });

  it("同簇散开：坐标几乎重合的点不再叠在一处（观音法界走查病例）", () => {
    // 三个点同一坐标（综合体内多点位）：渲染后的 translate 必须两两不同
    const same = [
      { name: "圣坛", lat: 29.9, lon: 122.38, kind: "spot" },
      { name: "圆通大厅", lat: 29.9, lon: 122.38, kind: "spot" },
      { name: "抄经室", lat: 29.90001, lon: 122.38001, kind: "spot" },
    ];
    const html = renderToStaticMarkup(
      createElement(GuideMiniMap, { spots: same, orderSource: "geo" } as never),
    );
    const translates = [...html.matchAll(/class="guide-minimap__stop" transform="(translate\([^)]+\))"/g)].map(
      (m) => m[1],
    );
    assert.equal(translates.length, 3);
    assert.equal(new Set(translates).size, 3, "同簇点必须散开，叠在一起就读不出序号");
  });

  it("editorial：坐标不齐照样布点连线（示意），不因缺坐标炸掉", () => {
    const noCoords = BRIEF.spots.map(({ lat: _a, lon: _b, ...rest }) => rest);
    const html = renderToStaticMarkup(
      createElement(GuideMiniMap, { spots: noCoords, orderSource: "editorial" } as never),
    );
    assert.ok(html.includes("guide-minimap__route"));
    assert.ok(html.includes(">3</text>"));
  });

  it("空点位：整图不渲染（返回 null），不出一张空底图", () => {
    const html = renderToStaticMarkup(createElement(GuideMiniMap, { spots: [] } as never));
    assert.equal(html, "");
  });

  it("spreadClusteredPoints：簇心不动、成员绕环、簇外点原样；散开半径有界", () => {
    const pts = [
      { x: 100, y: 100 },
      { x: 102, y: 101 },
      { x: 99, y: 103 },
      { x: 300, y: 300 }, // 簇外
    ];
    const placed = spreadClusteredPoints(pts);
    assert.deepEqual({ x: placed[3]!.x, y: placed[3]!.y }, pts[3], "簇外点一动不动");
    const cx = placed.slice(0, 3).reduce((a, p) => a + p.x, 0) / 3;
    const cy = placed.slice(0, 3).reduce((a, p) => a + p.y, 0) / 3;
    assert.ok(Math.hypot(cx - 100.33, cy - 101.33) < 2, "散开的质心停在簇心附近——位置真相不漂移");
    for (const p of placed.slice(0, 3)) {
      assert.ok(p.spreadAngle !== undefined);
      assert.ok(Math.hypot(p.x - cx, p.y - cy) <= 35, "散开半径有界，不能飞出簇太远");
    }
    const keys = new Set(placed.slice(0, 3).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
    assert.equal(keys.size, 3, "成员两两分开");
  });

  it("缩放控件：＋／－按钮在，初始（k=1）缩小不可点、复位不出现", () => {
    const html = mini({ orderSource: "geo" });
    assert.ok(html.includes('aria-label="放大"'));
    assert.match(html, /aria-label="缩小" disabled/, "k=1 时不能再缩，缩小钮该置灰");
    assert.equal(html.includes('aria-label="复位"'), false, "没放大过不该出复位钮");
    assert.ok(html.includes("guide-minimap-wrap"), "缩放按钮要有定位锚容器");
  });

  it("clampMiniMapView：k 钳 [1,6]；k=1 时平移钳成原位，放大后平移不出画布", () => {
    assert.deepEqual(clampMiniMapView({ k: 0.3, tx: -50, ty: 20 }), { k: 1, tx: 0, ty: 0 });
    assert.equal(clampMiniMapView({ k: 99, tx: 0, ty: 0 }).k, 6);
    const v = clampMiniMapView({ k: 2, tx: -9999, ty: 5 });
    assert.equal(v.tx, 400 * (1 - 2), "左边界：内容右缘不许离开画布右缘");
    assert.equal(v.ty, 0, "上边界：内容上缘不许低于画布上缘");
    // 自适应画布宽（挂载后 ResizeObserver 重算）：钳制随宽度走
    assert.equal(clampMiniMapView({ k: 2, tx: -9999, ty: 0 }, 800).tx, 800 * (1 - 2));
  });

  it("自适应画布宽：SSR 首帧是默认 400 viewBox；散开钳制吃传入的宽", () => {
    const html = mini({ orderSource: "geo" });
    assert.ok(html.includes('viewBox="0 0 400 430"'), "无 ResizeObserver 的 SSR 用默认宽");
    // 宽画布下，右缘簇的散开点允许越过 400-26（旧画布的钳位），钳在新宽度内
    const placed = spreadClusteredPoints(
      [
        { x: 700, y: 100 },
        { x: 701, y: 101 },
      ],
      760,
    );
    for (const p of placed) {
      assert.ok(p.x <= 760 - 26, "散开点钳在传入画布宽内");
      assert.ok(p.x >= 400 - 26, "宽画布的右缘点不该被旧 400 宽度拉回来");
    }
  });

  it("smoothPathD：两点直线、三点起曲线（C 指令），首点为 M 起笔", () => {
    assert.match(smoothPathD([{ x: 0, y: 0 }, { x: 10, y: 0 }]), /^M 0\.0 0\.0 L 10\.0 0\.0$/);
    const d = smoothPathD([{ x: 0, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 0 }]);
    assert.ok(d.startsWith("M 0.0 0.0"));
    assert.ok(d.includes(" C "), "≥3 点必须是贝塞尔曲线");
  });

  /*
   * 箭头脱线（0902 走查）。取样打在**真产物上**：解析 smoothPathD 吐出的 `d`
   * 串，在那条曲线上求点，而不是拿组件内部的曲线公式自己跟自己比——后者
   * 就算画线与箭头各画各的也照样全绿。
   */
  const bezierOnPathD = (d: string, seg: number, t: number) => {
    const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const cursor = 2 + seg * 6; // M 的两个数 + 每段 C 的六个数
    const pts = [
      { x: nums[cursor - 2]!, y: nums[cursor - 1]! },
      { x: nums[cursor]!, y: nums[cursor + 1]! },
      { x: nums[cursor + 2]!, y: nums[cursor + 3]! },
      { x: nums[cursor + 4]!, y: nums[cursor + 5]! },
    ];
    const u = 1 - t;
    return {
      x: u ** 3 * pts[0]!.x + 3 * u * u * t * pts[1]!.x + 3 * u * t * t * pts[2]!.x + t ** 3 * pts[3]!.x,
      y: u ** 3 * pts[0]!.y + 3 * u * u * t * pts[1]!.y + 3 * u * t * t * pts[2]!.y + t ** 3 * pts[3]!.y,
    };
  };

  it("routeChevrons：箭头落在画出来的曲线上，不在两端点的弦上", () => {
    // 一条拐得很狠的折线：弦与曲线在弯段上差得开，脱线才看得出来
    const pts = [
      { x: 20, y: 200 },
      { x: 180, y: 40 },
      { x: 340, y: 200 },
      { x: 40, y: 260 },
    ];
    const d = smoothPathD(pts);
    const chevrons = routeChevrons(pts);
    assert.equal(chevrons.length, 3, "三段都够长，三个箭头");

    let maxChordGap = 0;
    chevrons.forEach((c, i) => {
      const on = bezierOnPathD(d, i, 0.55);
      assert.ok(
        Math.hypot(c.x - on.x, c.y - on.y) < 0.2,
        `第 ${i} 段箭头必须钉在路线上（差 ${Math.hypot(c.x - on.x, c.y - on.y).toFixed(1)}）`,
      );
      const a = pts[i]!;
      const b = pts[i + 1]!;
      maxChordGap = Math.max(
        maxChordGap,
        Math.hypot(c.x - (a.x + (b.x - a.x) * 0.55), c.y - (a.y + (b.y - a.y) * 0.55)),
      );
    });
    assert.ok(maxChordGap > 5, "这组点上弦中点确实离曲线很远，用例本身才有鉴别力");
  });

  it("routeChevrons：朝向取的是路线在该处的切向，不是弦的角度", () => {
    // 折返形：中段两端被前后点拽弯，切向与弦向差得开
    const pts = [
      { x: 20, y: 120 },
      { x: 200, y: 120 },
      { x: 210, y: 280 },
      { x: 380, y: 120 },
    ];
    const d = smoothPathD(pts);
    const chevrons = routeChevrons(pts);

    const degOf = (dx: number, dy: number) => (Math.atan2(dy, dx) * 180) / Math.PI;
    let maxChordDev = 0;
    chevrons.forEach((c, i) => {
      // 真产物上的数值切向：在 d 串画出的那条曲线上取 t=0.55 前后两点
      const before = bezierOnPathD(d, i, 0.549);
      const after = bezierOnPathD(d, i, 0.551);
      const want = degOf(after.x - before.x, after.y - before.y);
      assert.ok(Math.abs(c.deg - want) < 0.5, `第 ${i} 段朝向要贴合曲线切向（差 ${(c.deg - want).toFixed(1)}°）`);
      const a = pts[i]!;
      const b = pts[i + 1]!;
      maxChordDev = Math.max(maxChordDev, Math.abs(c.deg - degOf(b.x - a.x, b.y - a.y)));
    });
    assert.ok(maxChordDev > 5, "这组点上切向确实不等于弦向，用例本身才有鉴别力");
  });

  it("routeChevrons：短段不配箭头，两点直线段的箭头就在直线上", () => {
    assert.deepEqual(routeChevrons([{ x: 0, y: 0 }, { x: 30, y: 0 }]), [], "弦短于门槛就不画");
    const [c] = routeChevrons([{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    assert.ok(c, "够长的直线段要有箭头");
    assert.ok(Math.abs(c!.x - 110) < 0.01 && Math.abs(c!.y) < 0.01, "直线段落点就是 55% 处");
    assert.ok(Math.abs(c!.deg) < 0.01, "直线段朝向就是直线方向");
  });
});

describe("小地图·真实底图形态（2026-08-29 走查）", () => {
  it("分派：高德已配且坐标够 → 真实底图容器；未配（默认）→ 手绘 SVG", async () => {
    const { configureAmap } = await import("../src/map/amap-loader");
    // 默认未配：现有全部小地图断言都在验这条路
    const sketch = renderToStaticMarkup(
      createElement(GuideMiniMap, { spots: BRIEF.spots, orderSource: "geo" } as never),
    );
    assert.ok(sketch.includes("guide-minimap__bg"), "未配 key 走手绘 SVG");
    try {
      configureAmap({ jsKey: "test-key" });
      const amap = renderToStaticMarkup(
        createElement(GuideMiniMap, { spots: BRIEF.spots, orderSource: "geo" } as never),
      );
      assert.ok(amap.includes("guide-minimap-amap"), "配了 key 的 geo 页走真实底图");
      assert.equal(amap.includes("guide-minimap__controls"), false, "真实底图自带缩放，不渲染自制按钮");
      const editorial = renderToStaticMarkup(
        createElement(GuideMiniMap, {
          spots: BRIEF.spots.map(({ lat: _a, lon: _b, ...r }) => r),
          orderSource: "editorial",
        } as never),
      );
      // 一个坐标都没有 → 手绘图。**判据是坐标数不是 orderSource**（0830 走查放宽），
      // 但"不在真地图上标猜的位置"这条原则没变：这里连真坐标都没有一个。
      assert.equal(
        editorial.includes("guide-minimap-amap"),
        false,
        "一个真坐标都没有时不进真实底图——真地图上标猜的位置比示意图更糟",
      );
    } finally {
      configureAmap(undefined); // 别把配置漏给后面的用例
    }
  });

  it("spreadPixelOffsets：簇外 [0,0] 不动，同簇成员环形散开且两两不同", async () => {
    const { spreadPixelOffsets } = await import("../src/guide/GuideMiniMapAmap");
    const offs = spreadPixelOffsets([
      { lat: 29.9, lon: 122.38 },
      { lat: 29.9, lon: 122.38 },
      { lat: 29.90005, lon: 122.38005 }, // 仍在 40m 簇内
      { lat: 29.95, lon: 122.5 }, // 簇外
    ]);
    assert.deepEqual(offs[3], [0, 0], "簇外点不偏移——真实位置就是它的位置");
    const keys = new Set(offs.slice(0, 3).map(([x, y]) => `${x},${y}`));
    assert.equal(keys.size, 3, "簇内成员两两错开");
    for (const [x, y] of offs.slice(0, 3)) {
      assert.ok(Math.hypot(x, y) <= 31, "散开半径有界（30px 环）");
      assert.ok(Math.hypot(x, y) >= 29, "簇内成员都在环上");
    }
  });
});

describe("重新采集（2026-08-29：简报持久化后只采一次）", () => {
  it("给了 onRegenerate 才渲染按钮；collecting/failed 态不渲染", () => {
    const withBtn = renderToStaticMarkup(
      createElement(GuideScreen, {
        spotName: "普陀山",
        state: { status: "ready", brief: BRIEF },
        onBack: () => {},
        onRegenerate: () => {},
      }),
    );
    assert.ok(withBtn.includes("重新采集"));
    const without = render({ status: "ready", brief: BRIEF });
    assert.equal(without.includes("重新采集"), false, "没给回调不该出点了没反应的钮");
    const collecting = renderToStaticMarkup(
      createElement(GuideScreen, {
        spotName: "普陀山",
        state: { status: "collecting" },
        onBack: () => {},
        onRegenerate: () => {},
      }),
    );
    assert.equal(collecting.includes("重新采集"), false, "采集中重采没有意义");
  });
});

// ── 真实底图的门槛（0830 走查）────────────────────────────────
//
// 原判据是 `routeOrderSource === "geo"`，而 orderSpots 只要有一个点没坐标
// 就判 editorial。实测：库里 12 份导览简报 **12 份全是 editorial**，
// GuideMiniMapAmap 一次都没渲染过——写好的真实底图形态是死代码。
// 而「上来就好」大石这类寺内非正式地标本来就没有高德 POI 词条，
// 坐标永远补不齐，"全齐才算 geo"对多数景区是个达不到的条件。

describe("小地图底图分派：门槛看带坐标的点位数，不看是不是全齐", () => {
  const withSpots = (spots: GuideBrief["spots"]): GuideBrief => ({
    ...BRIEF,
    // 顺序仍来自攻略整理——**排序来源与位置真伪是两件事**，
    // 放宽的是后者：图上画出来的每个点都是真坐标。
    routeOrderSource: "editorial",
    spots,
  });
  /** 慧济禅寺真实病例：5 个点位，3 个没坐标。 */
  const HUIJI = withSpots([
    { name: "慧济禅寺", kind: "spot", lat: 30.010926, lon: 122.390087 },
    { name: "普陀鹅耳枥", kind: "spot", lat: 30.009925, lon: 122.390575 },
    { name: "佛顶顶佛墙/宝顶佛顶", kind: "photo" },
    { name: "莲花池", kind: "photo" },
    { name: "「上来就好」大石", kind: "photo" },
  ]);

  it("部分点位有坐标就上真实底图，并如实说清哪几个没标出来", () => {
    configureAmap({ jsKey: "test-key" });
    try {
      const html = render({ status: "ready", brief: HUIJI });
      assert.ok(html.includes("guide-minimap-amap"), "够两个真坐标就该是高德底图");
      assert.equal(html.includes("guide-minimap__bg"), false, "不该再回落手绘 SVG");
      // 缺席必须点名。少两个序号而一句话没有，车主只会当成"地图画漏了"。
      assert.ok(html.includes("未在图上标出"));
      for (const s of ["3 佛顶顶佛墙/宝顶佛顶", "4 莲花池", "5 「上来就好」大石"]) {
        assert.ok(html.includes(s), `缺席点位要带原序号列出：${s}`);
      }
      // 连线只经过图上那几个点，这一点不能含糊——否则它看起来就是完整游玩顺序。
      assert.ok(html.includes("路线连线也不经过它们"));
    } finally {
      configureAmap(undefined);
    }
  });

  it("坐标全齐时不多说一句「未在图上标出」——本来就没有缺席的", () => {
    configureAmap({ jsKey: "test-key" });
    try {
      const html = render({ status: "ready", brief: BRIEF });
      assert.ok(html.includes("guide-minimap-amap"));
      assert.equal(html.includes("未在图上标出"), false);
    } finally {
      configureAmap(undefined);
    }
  });

  it("只有一个点带坐标：回落手绘图——一个点连不成「单向游玩路线」", () => {
    configureAmap({ jsKey: "test-key" });
    try {
      const html = render({
        status: "ready",
        brief: withSpots([
          { name: "慧济禅寺", kind: "spot", lat: 30.010926, lon: 122.390087 },
          { name: "莲花池", kind: "photo" },
          { name: "「上来就好」大石", kind: "photo" },
        ]),
      });
      assert.equal(html.includes("guide-minimap-amap"), false);
      assert.ok(html.includes("guide-minimap__bg"), "回退是默认路径");
      // 换了张图却不说为什么，示意布点就会被当成真实方位读。
      assert.ok(html.includes("景点太小无法加载地图"), "回退原因要标在图上");
      assert.ok(html.includes("不表示真实方位与距离"), "还要说清这张图能读出什么");
    } finally {
      configureAmap(undefined);
    }
  });

  it("没配 key 时照旧手绘图：回退是默认路径，不因为放宽门槛而改变", () => {
    const html = render({ status: "ready", brief: HUIJI });
    assert.equal(html.includes("guide-minimap-amap"), false);
    assert.ok(html.includes("guide-minimap__bg"));
    // 这一档的原因是部署侧没配 key，跟景点大小无关——说"景点太小"是编造原因。
    assert.equal(html.includes("景点太小"), false);
  });

  it("走真实底图时不出回退说明——没有回退，就没有要解释的事", () => {
    configureAmap({ jsKey: "test-key" });
    try {
      const html = render({ status: "ready", brief: HUIJI });
      assert.ok(html.includes("guide-minimap-amap"));
      assert.equal(html.includes("景点太小"), false);
      assert.equal(html.includes("guide-minimap__fallback-note"), false);
    } finally {
      configureAmap(undefined);
    }
  });

  /*
   * 原因判定钉成纯函数：三个原因可以同时成立，而文案只能有一句。
   * 排序判据是"哪个原因单独成立就已经画不出真实底图"——点位不够两个时，
   * 配没配 key、加载成不成功都改变不了结果。
   */
  it("fallbackReasonOf：点位不够排在未配 key 与加载失败之前", () => {
    assert.equal(fallbackReasonOf(1, false, true), "few-located");
    assert.equal(fallbackReasonOf(0, true, false), "few-located", "点位不够时不甩锅给 key 或加载");
    assert.equal(fallbackReasonOf(5, true, true), "amap-failed");
    assert.equal(fallbackReasonOf(5, false, false), "unconfigured");
  });

  /*
   * 覆盖物建在 effect 里、SSR 测不到，而序号错了页面照常渲染——
   * 图上标「3」而时间轴那条是「5」，两处都言之凿凿。所以判据抽成纯函数钉在这。
   */
  it("图上的序号是它在 spots 里的位置，不是落图的第几个", () => {
    const seqs = locatedWithSeq(HUIJI.spots).map((x) => x.seq);
    assert.deepEqual(seqs, [1, 2], "跳过的三个点不许让后面的序号往前挤");
    const tail = locatedWithSeq([
      { name: "无坐标", kind: "photo" },
      { name: "有坐标", kind: "spot", lat: 30, lon: 122 },
    ]);
    assert.deepEqual(tail.map((x) => x.seq), [2], "首个点缺席时后面的序号仍从 2 起");
  });
});
