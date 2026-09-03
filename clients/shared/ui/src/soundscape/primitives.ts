/**
 * 六个发声原语（施工单 M64-01）。
 *
 * # 为什么 ctx 是参数而不是模块单例
 *
 * 两个理由，都很硬：
 *   ① 本包的测试没有 WebAudio，注入一个记录调用的假 ctx 是**唯一**能把
 *      "起了几个节点、频率多少、什么时候 stop" 钉住的办法；
 *   ② `@carlife/ui` 会被 cockpit 的 node 单测 import，模块顶层 `new AudioContext()`
 *      会让那 139 个用例一 import 就炸。
 *
 * # 这里的 `ctx.currentTime` 不是"排期"
 *
 * `AudioParam` 的每个拐点都必须给绝对时刻，所以单个 cue 自己的包络离不开它。
 * M64-02 的红线禁止的是**另一回事**：把六个 cue 一次性 `start(ctx.currentTime + delay)`
 * 排出去。那条时钟在页面进后台时不冻结，而 WAAPI 的文档时钟会冻结——排好的音
 * 会在画面停在第一帧时一路放完。cue 什么时候响由 rAF 逐帧决定，本文件不参与。
 *
 * # 谁负责清理
 *
 * 除 `bed()` 外每个原语都自排 `stop()`、自己了结，**不返回需要调用方清理的东西**。
 * 一个装饰性音效如果需要调用方记得关，那它迟早会有一次没关掉。
 */

import { GAIN_FLOOR, PEAK_BED, PEAK_CUE, clampPeak } from "./gain";

/** 造一段白噪声。长度按秒给，采样率跟 ctx 走。 */
function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * 布朗噪声归一到的目标 RMS。
 *
 * **按 RMS 归一不按峰值。** 布朗噪声是随机游走，峰值由偶发的一个尖峰决定：
 * 按峰值归一的话，同一段代码每次启动的**实际响度能差十倍**
 * （0902 实测两次离线渲染，同一区间峰值 0.0092 与 0.0003）。
 * 响度是要被人听的东西，不能是随机的。
 */
const WIND_RMS = 0.22;

/**
 * 造一段**可无缝循环的布朗噪声**（白噪声积分，−6 dB/oct）。
 *
 * # 为什么铺底不能用白噪声
 *
 * 铺底要压到 320 Hz 以下（见 `BED_LOWPASS_HZ`），而白噪声的能量在 20 Hz–20 kHz 里
 * 是平铺的：两级低通过完只剩下百分之几，`PEAK_BED` 这个"峰值"于是名不副实
 * ——0902 实测把它设成 0.020，滤完输出峰值只有 **0.0006（−64 dBFS）**，等于没有声音。
 * 布朗噪声天然是低频重的，过完低通还剩得下东西；听感上它本来就更像
 * "车里听到的风与路噪"，而不是嘶嘶的底噪。
 *
 * # 归一化，让常量说话算数
 *
 * 生成完除以最大绝对值，于是 `PEAK_BED` 就是滤波前的真实峰值，
 * 调它的人不必先去算滤波器吃掉了多少。
 *
 * # 循环点要交叉淡化
 *
 * 布朗噪声会游走，首尾对不上；直接 `loop` 每 4 秒会有一次台阶，
 * 而台阶经过低通就是一记闷响。所以多生成一段用来和开头交叉。
 */
function windBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const frames = Math.max(2, Math.floor(sr * seconds));
  const xf = Math.min(Math.floor(sr * 0.5), Math.floor(frames / 4));
  const raw = new Float32Array(frames + xf);
  let last = 0;
  for (let i = 0; i < raw.length; i += 1) {
    // 一阶泄漏积分器：白噪声进去，−6 dB/oct 出来。
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    raw[i] = last;
  }
  const buf = ctx.createBuffer(1, frames, sr);
  const data = buf.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < frames; i += 1) {
    const w = i < xf ? i / xf : 1;
    const v = i < xf ? raw[i]! * w + raw[frames + i]! * (1 - w) : raw[i]!;
    data[i] = v;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / frames);
  if (rms > 0) {
    const k = WIND_RMS / rms;
    // 归一之后夹一下：随机游走偶尔会冲出 ±1，留着就是一次削顶的爆音。
    for (let i = 0; i < frames; i += 1) data[i] = Math.max(-1, Math.min(1, data[i]! * k));
  }
  return buf;
}

/**
 * 接一级滤波，**探测不到 `BiquadFilterNode` 时原样返回入参**。
 *
 * 车机 webview 的版本未知。缺了它只是音色变糙，不该让整个 cue 消失。
 */
function maybeFilter(
  ctx: BaseAudioContext,
  src: AudioNode,
  type: BiquadFilterType,
  freq: number,
  q: number,
): AudioNode {
  if (typeof ctx.createBiquadFilter !== "function") return src;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  src.connect(f);
  return f;
}

/** 带通。一次性的噪声脉冲用它定音色。 */
function maybeBandpass(ctx: BaseAudioContext, src: AudioNode, freq: number, q: number): AudioNode {
  return maybeFilter(ctx, src, "bandpass", freq, q);
}

/**
 * 打一条 attack → hold → 指数收尾的包络。
 *
 * attack 不能省：`setValueAtTime` 直接给峰值会产生咔哒声，在车机喇叭上尤其明显。
 * 收尾用指数是因为线性收尾听起来像被掐断。
 */
function envelope(
  g: GainNode,
  t0: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): void {
  const p = clampPeak(peak);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(p, t0 + attack);
  g.gain.setValueAtTime(p, t0 + attack + hold);
  g.gain.exponentialRampToValueAtTime(GAIN_FLOOR, t0 + attack + hold + release);
}

/** 一次性的噪声脉冲：噪声 → 带通 → 包络 → dest。 */
function noiseHit(
  ctx: BaseAudioContext,
  dest: AudioNode,
  at: number,
  opts: { seconds: number; freq: number; q: number; peak: number; attack: number; release: number },
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.seconds);
  const g = ctx.createGain();
  maybeBandpass(ctx, src, opts.freq, opts.q).connect(g);
  g.connect(dest);
  envelope(g, at, opts.peak, opts.attack, 0, opts.release);
  src.start(at);
  src.stop(at + opts.seconds);
}

/** 一个正弦音：osc → 包络 → dest。返回它的结束时刻，方便调用方接尾音。 */
function tone(
  ctx: BaseAudioContext,
  dest: AudioNode,
  at: number,
  opts: { freq: number; peak: number; attack: number; hold: number; release: number },
): number {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = opts.freq;
  const g = ctx.createGain();
  osc.connect(g);
  g.connect(dest);
  envelope(g, at, opts.peak, opts.attack, opts.hold, opts.release);
  const end = at + opts.attack + opts.hold + opts.release;
  osc.start(at);
  osc.stop(end);
  return end;
}

// ── 六个原语 ────────────────────────────────────────────────

/**
 * 钥匙串轻响。~150ms，两次微小重击——一次听起来像敲了下桌子，两次才像钥匙。
 *
 * 和 HUD 上那把钥匙的 SVG 摆动（`cabin-arrival-trigger__swing`）是同一个动作的
 * 两半：点下去手先动，声音跟上。
 */
export function jingle(ctx: BaseAudioContext, dest: AudioNode): void {
  const t0 = ctx.currentTime;
  const shape = { seconds: 0.08, freq: 3200, q: 2.5, peak: PEAK_CUE * 0.7, attack: 0.002, release: 0.07 };
  noiseHit(ctx, dest, t0, shape);
  noiseHit(ctx, dest, t0 + 0.06, { ...shape, freq: 4100, peak: PEAK_CUE * 0.45 });
}

/**
 * 「就绪」提示音。**只有一声**——两声短音是报警的语法，
 * 而 HUD 的助手状态机里 `alert` 是另一个语义，不能借用它的音色。
 */
export function chime(ctx: BaseAudioContext, dest: AudioNode): void {
  const t0 = ctx.currentTime;
  tone(ctx, dest, t0, { freq: 880, peak: PEAK_CUE * 0.55, attack: 0.01, hold: 0.04, release: 0.5 });
  // 三次谐波只给一点点：它负责"这是个电子提示音"的质感，给多了会发尖。
  tone(ctx, dest, t0, { freq: 2640, peak: PEAK_CUE * 0.08, attack: 0.01, hold: 0.02, release: 0.28 });
}

/**
 * 上行三音。音阶由调用方给——**本层不内置音阶**，
 * 五声还是大调是设计决定，不该埋在合成器里。
 *
 * 空数组是合法输入且什么都不做：调用方在降级形态下会传空。
 */
export function arpeggio(
  ctx: BaseAudioContext,
  dest: AudioNode,
  notes: readonly number[],
  gapSeconds = 0.11,
): void {
  const t0 = ctx.currentTime;
  notes.forEach((freq, i) => {
    tone(ctx, dest, t0 + i * gapSeconds, {
      freq,
      peak: PEAK_CUE * 0.5,
      attack: 0.006,
      hold: 0.02,
      release: 0.45,
    });
  });
}

/** 关门的闷响：低频快速下滑 + 一层低通噪声给"厚度"。 */
export function thud(ctx: BaseAudioContext, dest: AudioNode): void {
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(160, t0);
  // 下滑到 40Hz 才有"关上了"的落定感；停在原频听起来像还开着。
  osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.18);
  const g = ctx.createGain();
  osc.connect(g);
  g.connect(dest);
  envelope(g, t0, PEAK_CUE * 0.75, 0.004, 0.02, 0.22);
  osc.start(t0);
  osc.stop(t0 + 0.3);
  noiseHit(ctx, dest, t0, {
    seconds: 0.12,
    freq: 220,
    q: 0.8,
    peak: PEAK_CUE * 0.3,
    attack: 0.002,
    release: 0.11,
  });
}

/** 出发的解决音：上行两音 + 一段 ~1.2s 的尾音，落在「出发！」那一拍。 */
export function resolve(ctx: BaseAudioContext, dest: AudioNode): void {
  const t0 = ctx.currentTime;
  tone(ctx, dest, t0, { freq: 587.33, peak: PEAK_CUE * 0.5, attack: 0.008, hold: 0.03, release: 0.3 });
  tone(ctx, dest, t0 + 0.13, { freq: 783.99, peak: PEAK_CUE * 0.55, attack: 0.008, hold: 0.03, release: 0.35 });
  tone(ctx, dest, t0 + 0.26, { freq: 1174.66, peak: PEAK_CUE * 0.4, attack: 0.012, hold: 0.1, release: 1.2 });
}

/** 铺底的句柄。它是唯一有生命周期的原语，所以唯一一个有返回值。 */
export interface BedHandle {
  /** 淡出并了结。**可以重复调用**——动画中途关闭与自然结束会各调一次。 */
  fadeOut(seconds?: number): void;
}

/**
 * 铺底的低通拐点。**这个数是本文件里最要紧的一个。**
 *
 * 六个 cue 的最低基频是 `arpeggio` 的 440 Hz。铺底必须整个待在它下面，
 * 否则就是"连续噪声压在乐音的临界带里"——0902 走查的原话是
 * 「太大了导致其他的听不见，而且人听起来像噪音」。
 * 320 Hz 两级级联（24 dB/oct）在 440 Hz 已经 −12 dB、880 Hz（`chime`）−36 dB。
 */
const BED_LOWPASS_HZ = 320;

/** 低频截断。低于这个的只是让喇叭白费力气，听不见但吃动态。 */
const BED_HIGHPASS_HZ = 45;

/** 铺底起伏的周期与深度。静止的噪声就是白噪；会呼吸的才像风。 */
const BED_LFO_HZ = 0.07;
const BED_LFO_DEPTH = 0.35;

/**
 * 风声铺底：白噪声压到 320 Hz 以下，缓慢起伏，渐入后一直在，直到 `fadeOut()`。
 *
 * # 为什么是低通不是带通
 *
 * 上一版用 520 Hz / Q=0.5 的**带通**。Q=0.5 不是滤波器，是一道很缓的倾斜——
 * 能量照样铺满 440–2600 Hz，正好压在三个音的音高上。两级 320 Hz 低通把它
 * 整个挪到 cue 的基频以下，`chime` 那一带衰减 36 dB，掩蔽才真的解除。
 * 顺带它也更像"车里听到的路噪/风噪"——那本来就是低频的东西。
 *
 * # 为什么要有 LFO
 *
 * 一动不动的噪声，人耳听到的就是"底噪"，会一直找它在哪儿。
 * 0.07 Hz（约 14 秒一个来回）± 35% 的起伏刚好在一条 19 秒的动画里走一个多来回，
 * 听起来是"外面有风"而不是"设备有杂音"。
 *
 * # 循环 4 秒而不是造 19 秒
 *
 * 后者要 19 × 采样率个浮点数，在车机上是一次没必要的几 MB 分配。
 */
export function bed(ctx: BaseAudioContext, dest: AudioNode, fadeInSeconds = 1.6): BedHandle {
  const t0 = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = windBuffer(ctx, 4);
  src.loop = true;

  // 两级低通级联：一级 12 dB/oct 挡不住 440 Hz。
  let chain: AudioNode = maybeFilter(ctx, src, "lowpass", BED_LOWPASS_HZ, 0.7);
  chain = maybeFilter(ctx, chain, "lowpass", BED_LOWPASS_HZ, 0.7);
  chain = maybeFilter(ctx, chain, "highpass", BED_HIGHPASS_HZ, 0.7);

  // 起伏层与包络层分开：`fadeOut` 只动包络，起伏不必被打断。
  const swell = ctx.createGain();
  swell.gain.value = 1 - BED_LFO_DEPTH;
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = BED_LFO_HZ;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = BED_LFO_DEPTH;
  lfo.connect(lfoDepth);
  lfoDepth.connect(swell.gain);
  lfo.start(t0);

  const g = ctx.createGain();
  chain.connect(swell);
  swell.connect(g);
  g.connect(dest);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(PEAK_BED, t0 + fadeInSeconds);
  src.start(t0);

  let done = false;
  return {
    fadeOut(seconds = 1.6) {
      // 幂等：三条退出路径（自然结束 / 用户关闭 / 组件卸载）会重复触发，
      // 第二次再排一遍拐点会把已经淡下去的音量重新拉起来。
      if (done) return;
      done = true;
      const t = ctx.currentTime;
      /*
       * 淡出要过两道坎，两道都会**不报错地**毁掉这条铺底。0902 用离线渲染
       * 逐拍量出来的，两个现象都在「出发！」那一拍上。
       *
       * ── 坎一：绝对不要读 `g.gain.value` 当"此刻的音量" ──
       *
       * 只用 `setValueAtTime`/ramp 排过程、从没给 `.value` 赋过值时，这个 getter
       * 返回的是 AudioParam 的**默认值 1**，不是自动化算出来的当前值。实测
       * （Chromium）：真 AudioContext 跑满 400ms 之后 `.value` 仍是 `1`，离线也是 `1`。
       * 于是 `setValueAtTime(Math.max(g.gain.value, …), t)` 会把增益**顶到 1.0**
       * 再往下衰减——铺底那一瞬间放大约 50 倍，稳态 0.003 → 0.11，拖 1.6 秒。
       * 听感就是一声爆音，正压在 `resolve` 上。
       *
       * ── 坎二：指数淡出必须有锚点，`cancelAndHoldAtTime` 不算 ──
       *
       * 换成 `cancelAndHoldAtTime(t)` 之后爆音没了，但铺底变成**从第 2 秒起
       * 就一路衰减**：那条 `exponentialRamp` 的起点取的是**上一个自动化事件**，
       * 而 hold 并没有留下一个事件，于是起点回落到渐入终点（t0+fadeIn），
       * 淡出被摊平到整整十几秒。实测 t=6s 时只剩 31%、t=11s 只剩 3%。
       *
       * ── 所以：自己算出此刻该是多少，显式 `setValueAtTime` 锚住 ──
       *
       * 这条渐入的形状是我们自己排的，算得出来，不必去问任何 getter，
       * 也不依赖任何一个实现对 hold 的解释。
       */
      const elapsed = t - t0;
      const current =
        fadeInSeconds > 0 && elapsed < fadeInSeconds
          ? PEAK_BED * Math.max(elapsed / fadeInSeconds, 0)
          : PEAK_BED;
      g.gain.cancelScheduledValues?.(t);
      g.gain.setValueAtTime(Math.max(current, GAIN_FLOOR), t);
      g.gain.exponentialRampToValueAtTime(GAIN_FLOOR, t + seconds);
      src.stop(t + seconds);
      // LFO 也要停：它不出声，但留着就是一个永远不会被回收的节点。
      lfo.stop(t + seconds);
    },
  };
}
