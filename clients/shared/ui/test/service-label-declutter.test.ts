/**
 * [F-18-15] 服务点名字的摆放与消隐（2026-09-16 走查第五、六轮）。
 *
 * 第五轮：「很多沿途服务的地点集中在一个区域」——名字互相压，两家店名都读不全。
 * 第六轮（两张图）：名字压住了**旁边那个点的图标**，叉子认不出是哪一类。
 * 判定本体是纯函数 `placeLabels`，逐条验算；接线上的纪律（先撤旧状态再量、
 * 可见区减掉抽屉、不碰覆盖物）由源码断言守——与 `trip-map-day-focus.test.ts` 同一手法。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { placeLabels, type LabelBox, type LabelScene } from "../src/map/label-declutter";
import { SERVICE_NAME_GAP, SERVICE_NAME_MAX, SERVICE_NAME_OFFSET } from "../src/map/service-marker";

const LAYER = readFileSync(new URL("../src/map/AmapTripLayer.tsx", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");

/** 一屏 1024×768 的地图，抽屉没开。 */
const VIEW: LabelBox = { left: 0, top: 0, right: 1024, bottom: 768 };
const OPTS = { gap: 4, max: 12 };
/** 实测尺寸：图标 26×26、名字约 132×20、间距 4。 */
const ICON = 26;
const NAME_W = 132;
const NAME_H = 20;

/** 圆心落在 (x, y) 的一个服务点：它的图标盒子，以及名字的上下两个候选位。 */
function point(x: number, y: number) {
  const icon: LabelBox = { left: x - ICON / 2, top: y - ICON / 2, right: x + ICON / 2, bottom: y + ICON / 2 };
  const half = NAME_W / 2;
  return {
    icon,
    cand: {
      below: { left: x - half, top: icon.bottom + 4, right: x + half, bottom: icon.bottom + 4 + NAME_H },
      above: { left: x - half, top: icon.top - 4 - NAME_H, right: x + half, bottom: icon.top - 4 },
    },
  };
}

/** 把若干个点拼成一幕；`blockers` 缺省为空（没有行程胶囊）。 */
function scene(pts: ReturnType<typeof point>[], blockers: LabelBox[] = [], bounds = VIEW): LabelScene {
  return { cands: pts.map((p) => p.cand), icons: pts.map((p) => p.icon), blockers, bounds };
}

/** `declutterServiceNames` 的函数体（从签名到它的结束大括号）。 */
function declutterBody(): string {
  const at = LAYER.indexOf("function declutterServiceNames");
  assert.notEqual(at, -1, "找不到碰撞消隐那个函数");
  const end = LAYER.indexOf("\n}", at);
  assert.notEqual(end, -1);
  return LAYER.slice(at, end);
}

describe("摆得下就摆，摆不下不摆", () => {
  it("互不相干 → 都摆在默认的下方", () => {
    const pts = [point(100, 100), point(400, 100), point(100, 400)];
    assert.deepEqual(placeLabels(scene(pts), OPTS), ["below", "below", "below"]);
  });

  it("名字压上别人的名字 → **先来的留在下方，后来的翻上去**", () => {
    // 左右挨着 120px：两块名字（各 132 宽）在下方必然互相压，但图标离得开。
    const pts = [point(200, 200), point(320, 206), point(600, 200)];
    assert.deepEqual(placeLabels(scene(pts), OPTS), ["below", "above", "below"]);
  });

  it("**名字压上旁边那个点的图标 → 改摆上方**（走查第六轮那两张图）", () => {
    // 第二个点在第一个点的正下方 34px：第一块名字正好盖住第二个点的叉子。
    const pts = [point(300, 300), point(300, 334)];
    const out = placeLabels(scene(pts), OPTS);
    assert.equal(out[0], "above", "下方压着别人的图标，该翻到上方去");
    assert.equal(out[1], "below");
  });

  it("上下都摆不下才不摆——不是一压就藏", () => {
    // 上下各有一个点把两个候选位都占了。
    const pts = [point(300, 300), point(300, 266), point(300, 334)];
    const out = placeLabels(scene(pts), OPTS);
    assert.equal(out[0], null);
  });

  it("名字绕开行程胶囊——图标可以盖在胶囊上，**文字盖文字不行**", () => {
    const pts = [point(300, 300)];
    const capsule: LabelBox = { left: 200, top: 320, right: 420, bottom: 380 }; // 正压在下方那块上
    const out = placeLabels(scene(pts, [capsule]), OPTS);
    assert.equal(out[0], "above", "下方被胶囊占着，该翻到上方");
    // 上方也被占的话就不摆了
    const both: LabelBox = { left: 200, top: 240, right: 420, bottom: 300 };
    assert.equal(placeLabels(scene(pts, [capsule, both]), OPTS)[0], null);
  });

  it("贴着也算压上——中间不留空隙，读起来就是一长条", () => {
    const a = point(100, 100);
    // 右边紧挨着：两块名字之间只剩 2px < gap(4)
    const b = point(100 + NAME_W + 2, 100);
    assert.notEqual(placeLabels(scene([a, b]), OPTS)[1], "below");
    // 留够空隙就摆得下
    const c = point(100 + NAME_W + 8, 100);
    assert.equal(placeLabels(scene([a, c]), OPTS)[1], "below");
  });

  it("露在可见区外的不摆，**而且不占名额**——半块名字读不全", () => {
    const out = point(1000, 100); // 名字右边越界
    const ok = point(200, 100);
    assert.deepEqual(placeLabels(scene([out, ok]), OPTS), [null, "below"]);
  });

  it("抽屉盖住的那半屏一样算「可见区外」——把名额让给真看得见的那些", () => {
    const bounds: LabelBox = { ...VIEW, right: 624 };
    const out = placeLabels(scene([point(700, 200), point(200, 200)], [], bounds), OPTS);
    assert.deepEqual(out, [null, "below"]);
  });

  it("名额封顶：散开但铺满一屏同样不是信息", () => {
    const pts = Array.from({ length: 20 }, (_, i) => point(80 + (i % 5) * 180, 60 + Math.floor(i / 5) * 90));
    const out = placeLabels(scene(pts), { gap: 4, max: 12 });
    assert.equal(out.filter(Boolean).length, 12);
    assert.ok(out.slice(0, 12).every(Boolean), "封顶按顺序取前 12 块");
    assert.ok(!out.slice(12).some(Boolean));
  });

  it("量不到尺寸的（还没上图 / 被祖先藏着）跳过，也不占名额", () => {
    const zero: LabelBox = { left: 10, top: 10, right: 10, bottom: 10 };
    const good = point(200, 200);
    const s: LabelScene = {
      cands: [{ below: null, above: null }, { below: zero, above: null }, good.cand],
      icons: [null, zero, good.icon],
      blockers: [],
      bounds: VIEW,
    };
    assert.deepEqual(placeLabels(s, { gap: 4, max: 1 }), [null, null, "below"]);
  });

  it("**平移不换幸存者**：优先级看加入顺序，不看离屏幕中心多远", () => {
    // 车机上每拖一下就换一批名字出来 = 满屏闪烁。整体平移，结果必须逐位相同。
    const at = (dx: number) => scene([point(200 + dx, 200), point(210 + dx, 206), point(600 + dx, 200)]);
    assert.deepEqual(placeLabels(at(0), OPTS), placeLabels(at(-40), OPTS));
  });
});

describe("接线上的纪律", () => {
  it("每轮先把上一轮的消隐与上移**都**撤掉再量——不撤的话状态会越积越歪", () => {
    const body = declutterBody();
    const undoHide = body.indexOf("classList.remove(SERVICE_NAME_HIDDEN_CLASS)");
    const undoUp = body.indexOf("classList.remove(SERVICE_NAME_UP_CLASS)");
    const measure = body.indexOf("getBoundingClientRect");
    assert.ok(undoHide !== -1 && undoUp !== -1, "两个状态类都要撤");
    assert.ok(Math.max(undoHide, undoUp) < measure, "撤销必须在量之前，否则量到的是上一轮的位置");
  });

  it("上方那块是**算**出来的，用的是与 CSS 同一个间距常量", () => {
    const body = declutterBody();
    assert.match(body, /top: icon\.top - SERVICE_NAME_OFFSET - h/);
    assert.match(body, /bottom: icon\.top - SERVICE_NAME_OFFSET/);
    assert.equal(SERVICE_NAME_OFFSET, 4);
    // CSS 那两条位移必须是同一个 4px，否则算出来的盒子与实际摆放对不上
    assert.match(CSS, /\.hud-tripsvc__name \{[^}]*transform: translate\(-50%, 4px\)/s);
    assert.match(CSS, /\.hud-tripsvc--nameup \.hud-tripsvc__name \{[^}]*transform: translate\(-50%, -4px\)/s);
  });

  it("行程胶囊进 blockers——文字盖文字，两行都读不成", () => {
    assert.match(declutterBody(), /querySelectorAll<HTMLElement>\(`\.\$\{TRIP_MARKER_CLASS\}`\)/);
  });

  it("可见区右边界减掉抽屉——被盖住的那半屏不占名额", () => {
    assert.match(declutterBody(), /right: Math\.min\(view\.right, drawerLeft\)/);
    assert.match(declutterBody(), /drawerWidth\(window\.innerWidth\)/);
  });

  it("**只动名字，不动图标**：图标回答「这附近有几个」，藏掉就是谎报密度", () => {
    assert.match(CSS, /\.hud-map--svcnames \.hud-tripsvc--noname \.hud-tripsvc__name \{ display: none; \}/);
    // 消隐类挂在标记根上，但没有任何一条规则藏整枚标记
    assert.ok(!/\.hud-tripsvc--noname \{[^}]*display:\s*none/.test(CSS));
  });

  it("**不碰覆盖物**：只读 DOM 挂类名，服务点的增删仍只在它自己那个 effect 里", () => {
    const body = declutterBody();
    for (const forbidden of ["serviceOverlaysRef", "overlaysRef", "map.add", "map.remove", "new MarkerCtor"]) {
      assert.ok(!body.includes(forbidden), `碰撞消隐碰了 ${forbidden} = 推一下缩放重画一层覆盖物`);
    }
  });

  it("缩放与平移都要重摆，且隔一帧再量（AMap 这一刻才刚把标记挪完）", () => {
    assert.match(LAYER, /ev\.on\?\.\("zoomend", sync\);\n\s*ev\.on\?\.\("moveend", sync\);/);
    assert.match(LAYER, /raf = requestAnimationFrame\(\(\) => declutterServiceNames\(host\)\);/);
    assert.match(LAYER, /ev\.off\?\.\("moveend", sync\);/, "监听要摘干净，地图重建后会重挂");
  });

  it("换类目 / 换天要按新的那批点重摆一次", () => {
    assert.match(LAYER, /\}, \[mapEpoch, servicePoisKey\]\);/);
  });
});

describe("两个常量", () => {
  it("名额与空隙是代码里那一份，测试不另抄一遍", () => {
    assert.equal(SERVICE_NAME_MAX, 12);
    assert.equal(SERVICE_NAME_GAP, 4);
    assert.match(LAYER, /\{ gap: SERVICE_NAME_GAP, max: SERVICE_NAME_MAX \}/);
  });
});
