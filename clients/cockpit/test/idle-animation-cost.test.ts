/**
 * 待机动画开销的源码级不变量（2026-09-13 性能排查的回归闸门）。
 *
 * 守的是一个**改坏了不报错、只是变慢**的东西：把 `transform` 动画写回 SVG 子元素上，
 * 或者把间歇摆动改回常驻 `infinite`，界面看起来一模一样，只有 CPU 知道。
 * 实测（iPad Pro 13" 模拟器，整条渲染栈，见 `docs/perf/2026-09-13-idle-cpu-clients.md`）：
 *
 *   SVG 子元素上的 transform 动画   86.0%
 *   canvas 2D / WebGL 同一段动画    85.2% / 88.5%
 *   搬到 <svg> 元素（合成层）        32.1%
 *   再改成每 20 秒摆一轮             12.7%
 *   完全不动                          4.4%
 *
 * node:test 里渲染不了组件，但这几条恰好不需要渲染。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const trigger = stripComments(read("src/features/cabin/ArrivalTrigger.tsx"));
const cabinCss = stripComments(read("src/features/cabin/cabin-arrival.css"));
const dock = stripComments(read("../shared/ui/src/assistant-avatar/AssistantDock.tsx"));
const hudCss = stripComments(read("../shared/ui/src/hud/hud.css"));

describe("动画落在能被合成器接管的元素上", () => {
  test("摆钥匙的类挂在 <svg> 上，不在里面的 <g> 上", () => {
    const at = trigger.indexOf("cabin-arrival-trigger__swing");
    assert.ok(at > 0, "找不到摆动元素");
    const tagStart = trigger.lastIndexOf("<", at);
    assert.equal(
      trigger.slice(tagStart, tagStart + 5),
      "<svg\n".slice(0, 5),
      "摆动必须施加在 <svg> 元素上——WebKit 不给 SVG 子元素独立合成层",
    );
    assert.ok(!trigger.includes("<g className"), "钥匙组不该再包一层带类名的 <g>");
  });

  test("助手音波的竖杠是 HTML 元素，不是 SVG <rect>", () => {
    const at = dock.indexOf("hud-assistant__wave-icon");
    assert.ok(at > 0, "找不到音波图标");
    // 只看音波这一段：同文件里的麦克风图标是静态 <rect>，与本条无关。
    const wave = dock.slice(at, dock.indexOf("</span>", dock.indexOf("WAVE_BARS.map", at)));
    assert.ok(wave.includes('className="hud-assistant__wave-bar"'), "竖杠应为 .hud-assistant__wave-bar");
    assert.ok(!wave.includes("<rect"), "竖杠回到 <rect> 就等于把每帧重栅格化改回来了");
    assert.ok(!hudCss.includes(".hud-assistant__wave-icon rect"), "样式也不该再挂在 rect 上");
  });
});

describe("待机时不常驻动画", () => {
  const swingRules = cabinCss
    .split("}")
    .filter((block) => block.includes("cabin-arrival-trigger__swing") && block.includes("animation:"));

  test("常驻 infinite 只出现在 hover / focus 那条规则上", () => {
    assert.ok(swingRules.length > 0, "找不到摆动的 animation 声明");
    for (const rule of swingRules) {
      if (!rule.includes("infinite")) continue;
      assert.ok(
        rule.includes(":hover") || rule.includes(":focus-visible"),
        `待机态不许常驻摆动，只有指上去/聚焦才可以：\n${rule.trim()}`,
      );
    }
  });

  test("待机那一轮是单次播放，由 JS 加减 is-swinging 控制节拍", () => {
    const idle = swingRules.find((r) => r.includes(".is-swinging"));
    assert.ok(idle, "缺少 .is-swinging 这一档");
    assert.ok(/animation:[^;]*\s1\s*;/.test(idle!), "待机那一轮必须是 iteration-count 1");
    assert.ok(trigger.includes("SWING_PERIOD_MS"), "节拍常量应在 ArrivalTrigger.tsx");
    assert.ok(trigger.includes("onAnimationEnd"), "收尾靠 animationend，不许再起第二个定时器");
  });

  test("关键帧起止都在静止位——有起停就不能停在偏角上", () => {
    const kf = cabinCss.slice(cabinCss.indexOf("@keyframes cabin-key-swing"));
    const body = kf.slice(0, kf.indexOf("}", kf.indexOf("}") + 1) + 1);
    assert.match(body, /0%,\s*100%\s*\{\s*transform:\s*rotate\(0deg\)/);
  });
});

describe("ArrivalTrigger 与出发时序无关（M64 红线的边界）", () => {
  test("它不读墙钟", () => {
    for (const forbidden of ["Date.now", "performance.now"]) {
      assert.ok(!trigger.includes(forbidden), `${forbidden} 只允许在 useDepartureNav.ts 里`);
    }
  });
  test("它不碰出发流程的任何东西——定时器只用于装饰摆动", () => {
    for (const forbidden of ["DEPARTURE_TIMELINE", "useDepartureNav", "setStage", "nav."]) {
      assert.ok(!trigger.includes(forbidden), `${forbidden} 出现在这里就说明红线被绕过了`);
    }
  });
});
