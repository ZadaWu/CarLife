/**
 * 小地图标签排布的**不变量**（0902 走查："不要见一个布局就改一次"）。
 *
 * 这一组用例刻意不针对任何一张具体布局：随机生成几百张（含刻意造的极端形态），
 * 断言的是与布局无关的三条——盒子两两不相交、不压图元、不出画布。见招拆招的
 * 规则过不了这种验法，因为它总有下一张布局没被它的 if 覆盖到。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GuideMiniMap,
  MINIMAP_H,
  labelVariants,
  placeLabels,
  spreadClusteredPoints,
  textWidth,
  type LabelBox,
} from "../src/guide/GuideMiniMap";

/** 图元避让半径（与实现里的 MARKER_R 同值）——判据要独立算，不从实现里借。 */
const MARKER_R = 12;

const hit = (a: LabelBox, b: LabelBox) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const markerBox = (m: { x: number; y: number }): LabelBox => ({
  x: m.x - MARKER_R,
  y: m.y - MARKER_R,
  w: MARKER_R * 2,
  h: MARKER_R * 2,
});

/** 可复现的伪随机（种子固定，失败能原样重跑）。 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  "月亮桥",
  "粤剧艺术博物馆",
  "永庆大街非遗街区",
  "陈添记祖传爽鱼皮",
  "月亮桥（广州西关）",
  "观音法界圣坛",
  "A",
  "普济寺",
  "南海观音三十三米金身立像",
  "李小龙祖居",
];

/** 一张随机布局：点数、画布宽、落位、名字都随机；再走一遍真实的同簇散开。 */
function randomLayout(r: () => number) {
  const w = 320 + Math.floor(r() * 500);
  const n = 2 + Math.floor(r() * 9);
  const raw = Array.from({ length: n }, () => ({
    x: 26 + r() * (w - 52),
    y: 26 + r() * (MINIMAP_H - 52),
  }));
  const placed = spreadClusteredPoints(raw, w);
  const items = placed.map((p, i) => ({ p, name: NAMES[Math.floor(r() * NAMES.length)]! }));
  return { w, items, markers: placed };
}

function assertInvariants(
  labels: ReturnType<typeof placeLabels>,
  markers: { x: number; y: number }[],
  w: number,
  where: string,
) {
  const boxes = labels.filter((l) => l !== null).map((l) => l!.box);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert.ok(!hit(boxes[i]!, boxes[j]!), `${where}：标签 ${i} 与 ${j} 压字`);
    }
    const b = boxes[i]!;
    assert.ok(
      b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= MINIMAP_H,
      `${where}：标签 ${i} 出画布`,
    );
    for (const [k, m] of markers.entries()) {
      assert.ok(!hit(markerBox(m), b), `${where}：标签 ${i} 压住图元 ${k}`);
    }
  }
}

describe("小地图·标签排布不变量", () => {
  it("400 张随机布局：标签两两不压、不压图元、不出画布", () => {
    const r = rng(20260902);
    for (let t = 0; t < 400; t += 1) {
      const { w, items, markers } = randomLayout(r);
      assertInvariants(placeLabels(items, markers, w), markers, w, `随机布局 #${t}`);
    }
  });

  it("极端形态照样守住：全叠一处、贴四角、挤成一行、长名字撑满", () => {
    const cases: Array<[string, { x: number; y: number }[], number]> = [
      ["全叠一处", Array.from({ length: 6 }, () => ({ x: 200, y: 215 })), 400],
      [
        "贴四角",
        [
          { x: 26, y: 26 },
          { x: 374, y: 26 },
          { x: 26, y: 404 },
          { x: 374, y: 404 },
        ],
        400,
      ],
      ["挤成一行", Array.from({ length: 8 }, (_, i) => ({ x: 30 + i * 45, y: 215 })), 400],
      ["最窄画布", Array.from({ length: 5 }, (_, i) => ({ x: 40 + i * 60, y: 100 + i * 60 })), 320],
    ];
    for (const [name, raw, w] of cases) {
      const placed = spreadClusteredPoints(raw, w);
      // 全都用最长的名字：撑不住的话这一条最先炸
      const items = placed.map((p) => ({ p, name: "南海观音三十三米金身立像" }));
      assertInvariants(placeLabels(items, placed, w), placed, w, name);
    }
  });

  it("确定性：同样的输入排出同样的位置（缩放平移后不会跳字）", () => {
    const r = rng(7);
    const { w, items, markers } = randomLayout(r);
    assert.deepEqual(placeLabels(items, markers, w), placeLabels(items, markers, w));
  });

  it("鉴别力：这些布局下「一律朝右 15px」的老做法确实会压字", () => {
    // 用例本身得有分辨力——否则一条恒真的断言也能全绿
    const r = rng(20260902);
    let naiveBad = 0;
    for (let t = 0; t < 400; t += 1) {
      const { w, items, markers } = randomLayout(r);
      const naive: LabelBox[] = items.map(({ p, name }) => ({
        x: p.x + 15,
        y: p.y - 7,
        w: textWidth(name) + 2,
        h: 14,
      }));
      const bad =
        naive.some((a, i) => naive.slice(i + 1).some((b) => hit(a, b))) ||
        naive.some((a) => markers.some((m) => hit(markerBox(m), a))) ||
        naive.some((a) => a.x + a.w > w);
      if (bad) naiveBad += 1;
    }
    assert.ok(naiveBad > 200, `老做法应在多数随机布局上压字，实测只有 ${naiveBad}/400`);
  });

  it("常见密度下一个标签都不该被舍弃（舍弃是兜底，不是常态）", () => {
    const r = rng(1234);
    let dropped = 0;
    let total = 0;
    for (let t = 0; t < 200; t += 1) {
      const w = 380 + Math.floor(r() * 120);
      const n = 3 + Math.floor(r() * 4); // 3~6 个点是导览简报的常见规模
      const raw = Array.from({ length: n }, (_, i) => ({
        x: 40 + r() * (w - 80),
        y: 40 + ((MINIMAP_H - 80) * i) / Math.max(1, n - 1),
      }));
      const placed = spreadClusteredPoints(raw, w);
      const items = placed.map((p, i) => ({ p, name: NAMES[i % NAMES.length]! }));
      const labels = placeLabels(items, placed, w);
      total += labels.length;
      dropped += labels.filter((l) => l === null).length;
    }
    assert.equal(dropped, 0, `常见密度下舍弃了 ${dropped}/${total} 个标签`);
  });

  it("排不下时舍弃整条，而不是叠上去；全名仍在 title 里", () => {
    // 二十个点全挤在一小块，且都是长名字——这是排不下的场面
    const raw = Array.from({ length: 20 }, (_, i) => ({ x: 150 + (i % 5) * 14, y: 200 + i * 3 }));
    const placed = spreadClusteredPoints(raw, 400);
    const items = placed.map((p) => ({ p, name: "南海观音三十三米金身立像" }));
    const labels = placeLabels(items, placed, 400);
    assert.ok(
      labels.some((l) => l === null),
      "这种密度下必然有排不下的",
    );
    assertInvariants(labels, placed, 400, "超密");
  });

  it("textWidth：全角按一个字宽、半角按 0.55；labelVariants 逐级缩短且首选全名", () => {
    assert.equal(textWidth("月亮桥", 10), 30);
    assert.ok(Math.abs(textWidth("abc", 10) - 16.5) < 1e-9);
    assert.equal(labelVariants("月亮桥")[0], "月亮桥");
    assert.deepEqual(labelVariants("永庆大街非遗街区"), ["永庆大街非遗街区", "永庆大街非遗…", "永庆大街…"]);
    assert.deepEqual(labelVariants("月亮桥"), ["月亮桥"], "短名字没有缩写档");
  });
});

describe("小地图·标签渲染", () => {
  it("渲染出的名字条数 = 排布结果里非空的条数，且每个点位都带全名 title", () => {
    const spots = [
      { name: "月亮桥", kind: "spot" },
      { name: "粤剧艺术博物馆", kind: "spot" },
      { name: "永庆大街非遗街区", kind: "spot" },
      { name: "陈添记祖传爽鱼皮", kind: "food" },
      { name: "月亮桥（广州西关）", kind: "spot" },
    ];
    const html = renderToStaticMarkup(
      createElement(GuideMiniMap, { spots, orderSource: "editorial" } as never),
    );
    const names = html.match(/guide-minimap__name/g) ?? [];
    assert.equal(names.length, spots.length, "这一组密度下五个名字都该排得下");
    for (const [i, s] of spots.entries()) {
      assert.ok(html.includes(`<title>${i + 1} ${s.name}</title>`), `${s.name} 的全名要在 title 里`);
    }
  });
});
