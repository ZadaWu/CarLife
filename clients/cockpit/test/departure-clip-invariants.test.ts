/**
 * 出发片子接线的源码级不变量。与 `departure-audio-invariants.test.ts` 同一做法：
 * node:test 里渲染不了组件，但这几条恰好不需要渲染——错了都不报错。
 *
 *  ① 舞台上恰好四个 `<video>`，与 `DEPARTURE_CLIPS` 一一对应。
 *     曾经是五个：driveoff 写了两遍、同一个 ref。ref 只认最后那个，前一个永远 opacity:0
 *     却照样把 430 KB 再拉一遍——走查网络面板数出 5 条 206 才看见。
 *  ② 每个 `src` 都经 `departureClipSrc`：绕过它就回到"每次「开始行程」都从 vite 拉一遍"。
 *  ③ 预热挂在**外层**组件（HUD 露面即取），不在 overlay 里——overlay 是点击后才 mount 的，
 *     挂那里等于点击那一刻才开始下载，第一帧照样要等。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DEPARTURE_CLIPS } from "../src/features/cabin/departure";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");
const strip = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const demo = strip(read("src/features/cabin/CabinArrivalDemo.tsx"));

describe("出发片子的 <video> 与缓存接线", () => {
  const videos = demo.match(/<video\b[\s\S]*?\/>/g) ?? [];

  test(`舞台上恰好 ${DEPARTURE_CLIPS.length} 个 <video>，每段一个`, () => {
    assert.equal(videos.length, DEPARTURE_CLIPS.length, `数出 ${videos.length} 个 <video>`);
  });

  test("每个 <video> 的 ref 各不相同，且与 DEPARTURE_CLIPS 的 key 一一对应", () => {
    const refs = videos.map((v) => /ref=\{refs\.(\w+)Clip\}/.exec(v)?.[1]);
    assert.deepEqual(
      refs,
      DEPARTURE_CLIPS.map((c) => c.key),
      "两个 <video> 共用一个 ref 时，前一个永远不会被动画驱动，却照样下载",
    );
  });

  test("每个 src 都经 departureClipSrc，没有裸的 departureXxxClip", () => {
    for (const v of videos) {
      assert.match(v, /src=\{departureClipSrc\(departure\w+Clip\)\}/, `裸 src：${v.slice(0, 80)}`);
    }
  });

  test("预热 warmDepartureClips 在外层组件的 effect 里，且在 overlay 定义之外", () => {
    const outer = demo.indexOf("export function CabinArrivalDemo(");
    const warm = demo.indexOf("warmDepartureClips()");
    assert.ok(outer >= 0 && warm > outer, "预热必须挂在 HUD 露面即 mount 的外层组件上");
    assert.match(
      demo.slice(warm - 60, warm + 40),
      /useEffect\(\(\) => \{\s*void warmDepartureClips\(\);\s*\}, \[\]\)/,
      "预热是一次性的 mount effect，永不 reject，所以不接错",
    );
  });
});
