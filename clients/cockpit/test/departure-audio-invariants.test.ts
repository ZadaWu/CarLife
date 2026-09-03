/**
 * 音景接线的源码级不变量（施工单 M64-02，验收 §1 判定 7~10）。
 *
 * # 为什么读源码而不是跑组件
 *
 * 本包的测试跑在 `node --import tsx --test` 下，没有 DOM、没有 WAAPI、没有 WebAudio，
 * 渲染不了 `CabinArrivalDemo`。而这四条恰好都不需要真的渲染：
 *   ① 有没有引入第二个时钟——那是本单最大的风险，且**错了不报错**；
 *   ② 减少动态那条早退路径有没有被绕过；
 *   ③ 铺底的收尾在不在 cleanup 里（漏了会一直响到重启客户端）；
 *   ④ 音景建不起来时会不会把动画拖下水。
 * 与 `item-sprites.test.ts` 读源码对账贴纸是同一类做法。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");

const demo = read("src/features/cabin/CabinArrivalDemo.tsx");
const cues = read("src/features/cabin/departure-audio.ts");

/** 注释里当然可以提到这些名字（本单的注释就在讲它们），所以先把注释剥掉。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("没有引入第二个时钟", () => {
  const codeOnly = [stripComments(demo), stripComments(cues)].join("\n");

  for (const forbidden of ["setTimeout", "setInterval", "Date.now", "performance.now"]) {
    test(`不出现 ${forbidden}`, () => {
      assert.ok(
        !codeOnly.includes(forbidden),
        `${forbidden} 是第二个时钟。字幕、片子、cue 必须全部由 WAAPI 主动画的 currentTime 驱动——` +
          "页面进后台时 Chrome 冻结 WAAPI 文档时钟，而这些不冻结，两者会永久错开",
      );
    });
  }

  test("不用 AudioContext.currentTime 排期", () => {
    assert.ok(
      !/ctx\.currentTime|audioCtx\.currentTime|context\.currentTime/.test(codeOnly),
      "预排六个 cue 会在画面停在第一帧时一路放完——AudioContext 的时钟在后台不冻结",
    );
  });

  /*
   * 判据不是"两行挨得近"——中间迟早会插进别的东西（M64-03 的三个闸就插进来了，
   * 一度把这条按字符距离写的断言弄红）。真正的不变量是**只有一个 ms 来源**：
   * tick 里读一次主时钟，字幕和 cue 都用那一个。
   */
  test("cue 触发点与字幕取的是同一个 ms：主时钟在 tick 里只读一次", () => {
    const reads = demo.match(/Number\(master\?\.currentTime \?\? 0\)/g) ?? [];
    assert.equal(reads.length, 1, `主时钟被读了 ${reads.length} 次——分开取两次就是两份时间的开端`);

    const tick = demo.slice(demo.indexOf("const tick = () => {"), demo.indexOf("raf = requestAnimationFrame(tick);"));
    const msDecl = tick.indexOf("const ms = Number(master");
    assert.ok(msDecl >= 0, "tick 里没有那一行 const ms = …");
    assert.ok(tick.indexOf("statusAt(ms)") > msDecl, "字幕必须用这一个 ms");
    assert.ok(tick.indexOf("cuesBetween(prevMs, ms)") > msDecl, "cue 必须用同一个 ms");
  });
});

describe("减少动态那条早退路径没有被绕过", () => {
  test("prefers-reduced-motion 的 return 仍在 effect 开头，且在任何 cue 逻辑之前", () => {
    const guard = demo.indexOf('matchMedia("(prefers-reduced-motion: reduce)")');
    const firstCue = demo.indexOf("cuesBetween(prevMs");
    assert.ok(guard > 0, "早退判断不见了");
    assert.ok(firstCue > guard, "cue 逻辑必须在早退判断之后——减少动态时整条动画不播，也就不该出声");
  });

  test("早退分支仍然是 setStage(\"card\") 后直接 return", () => {
    assert.ok(
      /\(\s*"\(prefers-reduced-motion: reduce\)"\s*\)\.matches\s*\)\s*\{\s*setStage\("card"\);\s*return;/.test(demo),
      "这段逐字不变是本单的红线",
    );
  });
});

describe("铺底的收尾覆盖三条退出路径", () => {
  test("sound?.stop() 在 effect 的 cleanup 里", () => {
    const cleanup = demo.slice(demo.indexOf("return () => {"), demo.indexOf("}, [runId]);"));
    assert.ok(cleanup.includes("cancelAnimationFrame(raf)"), "取到的不是那个 cleanup");
    assert.ok(
      cleanup.includes("sound?.stop()"),
      "自然结束 / 用户点关闭 / 组件卸载三条路都会走 cleanup，也只有它能同时覆盖三条；" +
        "漏了的表现是风声一直响到重启客户端，且不报错",
    );
  });
});

describe("音景建不起来时不拖动画下水", () => {
  test("ensureSound 有 try/catch 且失败时给 null", () => {
    const fn = demo.slice(demo.indexOf("const ensureSound"), demo.indexOf("const play = ()"));
    assert.ok(fn.includes("try {") && fn.includes("catch"), "WebAudio 建不起来是不出声，不是故障");
    assert.ok(/soundRef\.current = null;/.test(fn));
  });

  /*
   * 回归（iPad 真机 2026-09-02）：用过语音 / 听过播报之后再点「开始行程」一声不响。
   * iOS 上 Rust 侧动过 AVAudioSession，WebKit 就把页面的 AudioContext 置成 interrupted
   * 且不自己恢复；旧版只要 soundRef 在就复用，cue 全排在不出声的上下文上，没有报错。
   */
  test("复用音景前必须看上下文 state；不在 running 就先 close 旧的再 new（都在手势栈里）", () => {
    const fn = demo.slice(demo.indexOf("const ensureSound"), demo.indexOf("const play = ()"));
    const reuse = fn.indexOf('state === "running"');
    assert.ok(reuse >= 0, "复用分支没有检查 ctx.state——iOS 上 interrupted 的上下文会被无条件复用");
    assert.ok(reuse < fn.indexOf("return soundRef.current"), "state 检查必须在第一次 return 复用之前");
    const close = fn.indexOf(".close?.()");
    const create = fn.indexOf("new Ctor()");
    assert.ok(close >= 0 && close < create, "旧上下文要先 close 再 new：iOS 对同时存在的 AudioContext 有上限");
  });

  test("resume 的 rejection 被吞掉——与旁边 video.play() 同一类平台闸门", () => {
    assert.ok(
      /ctx\.resume\?\.\(\)\.catch\(\(\) => \{\}\)/.test(demo),
      "AudioContext 出生即 suspended，resume 可能被拒；拒了要退化成「有画面没声音」而不是卡住",
    );
  });

  test("每一处 fire 都走可选链——sound 为 null 时整条链静默跳过", () => {
    const calls = demo.match(/\bsound(Ref\.current)?\??\.\s*fire\(/g) ?? [];
    const unguarded = demo.match(/(?<![?\w])sound\.fire\(/g) ?? [];
    assert.ok(calls.length > 0, "一处 fire 都没有？");
    assert.equal(unguarded.length, 0, "sound 可能是 null（开关关着 / WebAudio 不可用）");
  });

  /*
   * 判据是"开关那一支在 new 之前 return"，不是某一行的字面写法——
   * M64-03 把 `!soundOn` 换成 `!(soundOn ?? readSoundscapePref())` 时，
   * 按字面匹配的旧断言红了一次，而不变量本身一点没变。
   */
  /*
   * 回归：这条守的是一个**单测看不见**的 bug（0902 走查逐拍验出来的）。
   * 把缓存的 `soundRef.current` 直接传给 overlay 时，用户关掉开关后
   * `ensureSound()` 如实返回 null、点击那一下确实没响，而 overlay 拿到的是
   * 缓存里那个非 null 的实例，于是动画里六个 cue 照样全响。
   * 传的必须是**这一轮**的结果。
   */
  test("overlay 收到的是这一轮的音景，不是缓存的实例", () => {
    assert.ok(
      /sound=\{activeSound\}/.test(demo),
      "overlay 的 sound 必须是这一轮 ensureSound() 的结果；传 soundRef.current 会让关掉的开关只挡住点击那一下",
    );
    assert.ok(!/sound=\{soundRef\.current\}/.test(demo));
  });

  test("开关关掉时根本不建 AudioContext，而不是建了再静音", () => {
    const fn = demo.slice(demo.indexOf("const ensureSound"), demo.indexOf("const play = ()"));
    const sw = fn.indexOf("soundOn");
    assert.ok(sw >= 0, "ensureSound 里没有读开关");
    const guard = fn.indexOf("return null;", sw);
    assert.ok(guard >= 0, "读了开关却没有据此早退");
    assert.ok(
      guard < fn.indexOf("new Ctor()"),
      "车机是长时运行设备，一个用户已经关掉的功能不该常驻一个音频上下文——" +
        "早退必须在 new 之前，而不是建完再把主增益设成 0",
    );
  });
});

describe("cue 表不写裸毫秒", () => {
  test("departure-audio.ts 里没有四位数以上的字面量", () => {
    const codeOnly = stripComments(cues);
    const literals = codeOnly.match(/(?<![\w.])\d{4,}(?![\w.])/g) ?? [];
    assert.deepEqual(
      literals,
      [],
      `出现了裸毫秒 ${literals.join(", ")}——时刻必须从 DEPARTURE_TIMELINE 推导，` +
        "改片子时这张表要能自动跟着挪",
    );
  });
});
