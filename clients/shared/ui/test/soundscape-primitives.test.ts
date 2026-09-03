/**
 * 六个原语的调度参数（施工单 M64-01，验收 §1 判定 4~9）。
 *
 * 真声音在 CI 里验不了，能钉住的只有：起了几个节点、频率多少、
 * 包络拐点在哪、什么时候 stop。夹具见 `soundscape-fake-ctx.ts`。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { PEAK_BED, PEAK_CUE } from "../src/soundscape/gain";
import { arpeggio, bed, chime, jingle, resolve, thud } from "../src/soundscape/primitives";
import { Soundscape } from "../src/soundscape/index";
import { fakeCtx, type FakeBiquad, type FakeBufferSource, type FakeGain, type FakeOsc } from "./soundscape-fake-ctx";

describe("chime：一声就绪音", () => {
  test("恰好 2 个 OscillatorNode——基频 + 一点三次谐波", () => {
    const { ctx, fake, dest } = fakeCtx();
    chime(ctx, dest as unknown as AudioNode);
    assert.equal(fake.count("osc"), 2, "两声短音是报警的语法，这里只能是一声；两个 osc 是同一声的两个分量");
  });

  test("每个 osc 都 start 也都 stop，且 stop 晚于 start", () => {
    const { ctx, fake, dest } = fakeCtx();
    chime(ctx, dest as unknown as AudioNode);
    for (const osc of fake.of<FakeOsc>("osc")) {
      assert.notEqual(osc.startedAt, null);
      assert.notEqual(osc.stoppedAt, null);
      assert.ok(osc.stoppedAt! > osc.startedAt!, "stop 不晚于 start 的 osc 会一声不响");
    }
  });

  test("包络最后一个拐点的目标值 > 0——给 0 会让真 WebAudio 抛", () => {
    const { ctx, fake, dest } = fakeCtx();
    chime(ctx, dest as unknown as AudioNode);
    for (const g of fake.of<FakeGain>("gain")) {
      const last = g.gain.calls.at(-1)!;
      assert.equal(last.method, "exponentialRampToValueAtTime");
      assert.ok(last.value > 0, "exponentialRampToValueAtTime(0, …) 在 WebAudio 规范下会抛");
    }
  });

  test("包络从 0 起，有 attack——直接给峰值会产生咔哒声", () => {
    const { ctx, fake, dest } = fakeCtx();
    chime(ctx, dest as unknown as AudioNode);
    const g = fake.of<FakeGain>("gain")[0]!;
    assert.equal(g.gain.calls[0]!.method, "setValueAtTime");
    assert.equal(g.gain.calls[0]!.value, 0);
    assert.equal(g.gain.calls[1]!.method, "linearRampToValueAtTime");
    assert.ok(g.gain.calls[1]!.time > g.gain.calls[0]!.time, "attack 时长必须 > 0");
  });

  test("峰值不超上限", () => {
    const { ctx, fake, dest } = fakeCtx();
    chime(ctx, dest as unknown as AudioNode);
    for (const g of fake.of<FakeGain>("gain")) {
      for (const c of g.gain.calls) assert.ok(c.value <= PEAK_CUE + 1e-9, `拐点 ${c.value} 超过上限 ${PEAK_CUE}`);
    }
  });
});

describe("arpeggio：上行三音", () => {
  test("三个音的 start 时刻严格递增——同时响就不是琶音了", () => {
    const { ctx, fake, dest } = fakeCtx();
    arpeggio(ctx, dest as unknown as AudioNode, [440, 554.37, 659.25]);
    const starts = fake.of<FakeOsc>("osc").map((o) => o.startedAt!);
    assert.equal(starts.length, 3);
    for (let i = 1; i < starts.length; i += 1) {
      assert.ok(starts[i]! > starts[i - 1]!, `第 ${i + 1} 个音没有晚于前一个：${starts.join(", ")}`);
    }
  });

  test("音高按参数给，本层不内置音阶", () => {
    const { ctx, fake, dest } = fakeCtx();
    arpeggio(ctx, dest as unknown as AudioNode, [100, 200]);
    assert.deepEqual(fake.of<FakeOsc>("osc").map((o) => o.frequency.value), [100, 200]);
  });

  test("空数组是合法输入：一个节点都不建，且不抛", () => {
    const { ctx, fake, dest } = fakeCtx();
    assert.doesNotThrow(() => arpeggio(ctx, dest as unknown as AudioNode, []));
    assert.equal(fake.count("osc"), 0);
  });
});

describe("jingle / thud / resolve", () => {
  test("jingle 是两次重击——一次听起来像敲桌子", () => {
    const { ctx, fake, dest } = fakeCtx();
    jingle(ctx, dest as unknown as AudioNode);
    const srcs = fake.of<FakeBufferSource>("bufferSource");
    assert.equal(srcs.length, 2);
    assert.ok(srcs[1]!.startedAt! > srcs[0]!.startedAt!, "第二击必须晚于第一击");
  });

  test("thud 的基频向下滑：停在原频听起来像门还开着", () => {
    const { ctx, fake, dest } = fakeCtx();
    thud(ctx, dest as unknown as AudioNode);
    const osc = fake.of<FakeOsc>("osc")[0]!;
    const first = osc.frequency.calls[0]!;
    const last = osc.frequency.calls.at(-1)!;
    assert.ok(last.value < first.value, `频率没有下滑：${first.value} → ${last.value}`);
    assert.ok(last.time > first.time);
  });

  test("resolve 的尾音明显长于前两个音", () => {
    const { ctx, fake, dest } = fakeCtx();
    resolve(ctx, dest as unknown as AudioNode);
    const oscs = fake.of<FakeOsc>("osc");
    assert.equal(oscs.length, 3);
    const durations = oscs.map((o) => o.stoppedAt! - o.startedAt!);
    assert.ok(durations[2]! > durations[0]! * 2, `尾音 ${durations[2]} 不够长（前两个 ${durations[0]} / ${durations[1]}）`);
  });

  test("所有 bufferSource 都自排 stop——不返回需要调用方清理的东西", () => {
    const { ctx, fake, dest } = fakeCtx();
    jingle(ctx, dest as unknown as AudioNode);
    thud(ctx, dest as unknown as AudioNode);
    for (const s of fake.of<FakeBufferSource>("bufferSource")) assert.notEqual(s.stoppedAt, null);
  });
});

describe("bed：唯一有生命周期的原语", () => {
  /** 包络那一级：唯一一个从 0 起、带 linearRamp 的 gain。 */
  const envGain = (fake: { of<T>(k: string): T[] }) =>
    fake
      .of<FakeGain>("gain")
      .find((g) => g.gain.calls[0]?.value === 0 && g.gain.calls[1]?.method === "linearRampToValueAtTime")!;

  test("渐入到铺底音量，并且是循环的", () => {
    const { ctx, fake, dest } = fakeCtx();
    bed(ctx, dest as unknown as AudioNode);
    const src = fake.of<FakeBufferSource>("bufferSource")[0]!;
    assert.equal(src.loop, true, "不循环的话 4 秒后风声就没了");
    const g = envGain(fake);
    assert.ok(g, "找不到包络那一级 gain");
    assert.equal(g.gain.calls[1]!.value, PEAK_BED);
  });

  /*
   * 下面两条是 0902 走查那次修改的判据（「太大了导致其他的听不见，
   * 而且人听起来像噪音」）。响度只是一半，另一半是频段：
   * 连续噪声压在乐音的临界带里，差 20 dB 也照样盖住。
   */
  test("整个压在最低 cue 基频（arpeggio 440Hz）之下：两级低通", () => {
    const { ctx, fake, dest } = fakeCtx();
    bed(ctx, dest as unknown as AudioNode);
    const lows = fake.of<FakeBiquad>("biquad").filter((f) => f.type === "lowpass");
    assert.equal(lows.length, 2, "一级 12 dB/oct 挡不住 440 Hz，必须两级级联");
    for (const f of lows) {
      assert.ok(f.frequency.value < 440, `低通拐点 ${f.frequency.value}Hz 不该够得着最低的 cue 基频 440Hz`);
    }
    assert.equal(fake.of<FakeBiquad>("biquad").filter((f) => f.type === "highpass").length, 1, "低频截断也要有");
    assert.equal(
      fake.of<FakeBiquad>("biquad").filter((f) => f.type === "bandpass").length,
      0,
      "带通那一版（520Hz/Q=0.5）就是「听起来像噪音」的来路——Q=0.5 不是滤波器，是一道很缓的倾斜",
    );
  });

  test("会呼吸：一条低频 LFO 调制着它，而不是一动不动的白噪", () => {
    const { ctx, fake, dest } = fakeCtx();
    bed(ctx, dest as unknown as AudioNode);
    const lfo = fake.of<FakeOsc>("osc")[0];
    assert.ok(lfo, "bed 里没有 LFO——静止的噪声人耳听到的就是底噪");
    assert.ok(lfo.frequency.value < 1, `LFO ${lfo.frequency.value}Hz 太快，那是颤音不是风`);
    assert.notEqual(lfo.startedAt, null);
  });

  test("响度：铺底峰值远低于单个 cue 的上限", () => {
    assert.ok(PEAK_BED <= PEAK_CUE / 8, `铺底 ${PEAK_BED} 相对 cue 上限 ${PEAK_CUE} 还是太响`);
  });

  test("fadeOut 幂等：调两次不抛，第二次不再排拐点也不新增节点", () => {
    const { ctx, fake, dest } = fakeCtx();
    const h = bed(ctx, dest as unknown as AudioNode);
    const nodesAfterStart = fake.nodes.length;
    h.fadeOut();
    const callsAfterFirst = envGain(fake).gain.calls.length;
    assert.doesNotThrow(() => h.fadeOut());
    assert.equal(fake.nodes.length, nodesAfterStart, "第二次 fadeOut 不该新建节点");
    assert.equal(
      envGain(fake).gain.calls.length,
      callsAfterFirst,
      "第二次再排一遍拐点会把已经淡下去的音量重新拉起来",
    );
  });

  /*
   * 回归（0902 离线渲染逮到的真 bug）：`fadeOut` 曾经写
   * `setValueAtTime(Math.max(g.gain.value, GAIN_FLOOR), t)`。
   * 而 `AudioParam.value` 在只排过自动化、从没赋过 `.value` 时返回的是**默认值 1**
   * ——真 AudioContext 跑满 400ms 之后也是 1。于是每次淡出先把增益顶到 1.0，
   * 铺底放大约 50 倍，而 `bedOut` 恰好落在「出发！」那一拍上：稳态 0.003 → 0.11。
   * 判据就写成"淡出不许排出任何高于 PEAK_BED 的值"。
   */
  test("淡出不许把音量顶上去——不能读 AudioParam.value", () => {
    const { ctx, fake, dest } = fakeCtx();
    const h = bed(ctx, dest as unknown as AudioNode);
    const g = envGain(fake);
    const before = g.gain.calls.length;
    h.fadeOut();
    const after = g.gain.calls.slice(before);
    assert.ok(after.length > 0, "fadeOut 没排任何拐点？");
    for (const c of after) {
      assert.ok(
        c.value <= PEAK_BED + 1e-9,
        `淡出排了一个 ${c.value} 的拐点（上限 ${PEAK_BED}）——读 .value 会拿到默认值 1，然后炸出一声`,
      );
    }
  });

  /*
   * 回归其二（同一次走查逮到的第二个坑）：换成 `cancelAndHoldAtTime` 之后爆音没了，
   * 但铺底改成**从第 2 秒起一路衰减**——`exponentialRamp` 的起点取的是上一个
   * 自动化事件，而 hold 没留下事件，于是起点回落到渐入终点，淡出被摊平到十几秒
   * （实测 t=6s 只剩 31%、t=11s 只剩 3%）。判据：淡出必须先显式 setValueAtTime 锚住。
   */
  test("指数淡出必须有锚点：先 setValueAtTime 再 ramp", () => {
    const { ctx, fake, dest } = fakeCtx();
    const h = bed(ctx, dest as unknown as AudioNode);
    const g = envGain(fake);
    const before = g.gain.calls.length;
    h.fadeOut();
    const after = g.gain.calls.slice(before);
    const anchor = after.findIndex((c) => c.method === "setValueAtTime");
    const ramp = after.findIndex((c) => c.method === "exponentialRampToValueAtTime");
    assert.ok(anchor >= 0, "没有锚点，指数淡出的起点会回落到上一个自动化事件");
    assert.ok(ramp > anchor, "锚点必须排在 ramp 之前");
    assert.equal(after[anchor]!.time, after[ramp]!.time - 1.6, "锚点就落在淡出开始那一刻");
  });

  test("渐入途中就淡出：锚点取的是那一刻真正的音量，不是满值", () => {
    const { ctx, fake, dest } = fakeCtx();
    const fadeIn = 1.6;
    const h = bed(ctx, dest as unknown as AudioNode, fadeIn);
    const g = envGain(fake);
    // 走到渐入的一半再淡出
    (ctx as unknown as { currentTime: number }).currentTime += fadeIn / 2;
    const before = g.gain.calls.length;
    h.fadeOut();
    const anchor = g.gain.calls.slice(before).find((c) => c.method === "setValueAtTime")!;
    assert.ok(
      Math.abs(anchor.value - PEAK_BED / 2) < 1e-6,
      `渐入走了一半，锚点该是 ${PEAK_BED / 2}，实际 ${anchor.value}——取满值会听到一次上跳`,
    );
  });

  test("fadeOut 之后 source 与 LFO 都会 stop——留着就是回收不掉的节点", () => {
    const { ctx, fake, dest } = fakeCtx();
    bed(ctx, dest as unknown as AudioNode).fadeOut();
    assert.notEqual(fake.of<FakeBufferSource>("bufferSource")[0]!.stoppedAt, null);
    assert.notEqual(fake.of<FakeOsc>("osc")[0]!.stoppedAt, null, "LFO 不出声，但留着就永远不会被回收");
  });
});

describe("缺 BiquadFilterNode 的降级", () => {
  test("bed 仍然出节点，只是不过滤", () => {
    const { ctx, fake, dest } = fakeCtx({ noBiquad: true });
    assert.doesNotThrow(() => bed(ctx, dest as unknown as AudioNode));
    assert.equal(fake.count("bufferSource"), 1);
    assert.equal(fake.count("biquad"), 0);
  });

  test("其余五个 cue 的行为不变", () => {
    const { ctx, fake, dest } = fakeCtx({ noBiquad: true });
    const d = dest as unknown as AudioNode;
    assert.doesNotThrow(() => { jingle(ctx, d); chime(ctx, d); arpeggio(ctx, d, [440]); thud(ctx, d); resolve(ctx, d); });
    assert.equal(fake.count("osc"), 2 + 1 + 1 + 3, "chime 2 + arpeggio 1 + thud 1 + resolve 3");
    assert.equal(fake.count("bufferSource"), 2 + 1, "jingle 2 + thud 1");
  });
});

describe("Soundscape 门面", () => {
  test("未知 cue 忽略并计数，不抛", () => {
    const { ctx } = fakeCtx();
    const s = new Soundscape(ctx);
    assert.equal(s.unknownCueCount, 0);
    assert.doesNotThrow(() => s.fire("nope" as never));
    assert.equal(s.unknownCueCount, 1);
  });

  test("muted 把主增益压到 0，且与 setMaster 的取值无关", () => {
    const { ctx, fake } = fakeCtx();
    const s = new Soundscape(ctx);
    const master = fake.of<FakeGain>("gain")[0]!;
    s.setMaster(0.5);
    assert.ok(master.gain.value > 0);
    s.setMuted(true);
    assert.equal(master.gain.value, 0);
    s.setMaster(1);
    assert.equal(master.gain.value, 0, "静音期间改主音量不该把声音放回来");
    s.setMuted(false);
    assert.ok(master.gain.value > 0);
  });

  test("bedIn 只开一条铺底：两条噪声叠起来音量正好翻倍，且第二条没人关得掉", () => {
    const { ctx, fake } = fakeCtx();
    const s = new Soundscape(ctx);
    s.fire("bedIn");
    const after1 = fake.count("bufferSource");
    s.fire("bedIn");
    assert.equal(fake.count("bufferSource"), after1, "第二次 bedIn 不该再开一条");
  });

  test("bedOut 与 stop 都能收摊，且重复调用不抛", () => {
    const { ctx } = fakeCtx();
    const s = new Soundscape(ctx);
    s.fire("bedIn");
    assert.doesNotThrow(() => { s.fire("bedOut"); s.fire("bedOut"); s.stop(); });
  });

  test("透传 ctx.state：调用方据此决定 suspended 时干脆不发声", () => {
    const { ctx, fake } = fakeCtx();
    const s = new Soundscape(ctx);
    assert.equal(s.state, "running");
    fake.state = "suspended";
    assert.equal(s.state, "suspended");
  });

  test("六个 cue 都能发出且都不抛", () => {
    const { ctx } = fakeCtx();
    const s = new Soundscape(ctx);
    for (const c of ["jingle", "chime", "arpeggio", "thud", "resolve", "bedIn", "bedOut"] as const) {
      assert.doesNotThrow(() => s.fire(c), `${c} 抛了`);
    }
    assert.equal(s.unknownCueCount, 0, "六个 cue 一个都不该走进未知分支");
  });
});
