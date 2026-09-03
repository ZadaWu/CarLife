/**
 * 记录调用的假 `BaseAudioContext`（施工单 M64-01 的测试夹具）。
 *
 * # 为什么必须有它
 *
 * 本包的测试跑在 `node --import tsx --test` 下，没有 jsdom、更没有 WebAudio。
 * 真声音在 CI 里一个字节都验不了——能被机器钉住的只有**调度参数**：
 * 起了几个节点、频率多少、包络的拐点在哪、什么时候 `stop`。
 * 所以合成层把 ctx 做成参数，这里给它一个会记账的替身。
 *
 * 听感由 M64-02 的人工验收覆盖，本夹具不假装能验声音。
 */

export interface ParamCall {
  method:
    | "setValueAtTime"
    | "linearRampToValueAtTime"
    | "exponentialRampToValueAtTime"
    | "cancelScheduledValues"
    | "cancelAndHoldAtTime";
  value: number;
  time: number;
}

export class FakeParam {
  /** 刻意给成 1：真实的 `AudioParam.value` 在只排过自动化时就是返回默认值 1。 */
  value = 1;
  readonly calls: ParamCall[] = [];
  setValueAtTime(v: number, t: number) { this.calls.push({ method: "setValueAtTime", value: v, time: t }); this.value = v; return this; }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push({ method: "linearRampToValueAtTime", value: v, time: t }); return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.calls.push({ method: "exponentialRampToValueAtTime", value: v, time: t }); return this; }
  cancelScheduledValues(t: number) { this.calls.push({ method: "cancelScheduledValues", value: 0, time: t }); return this; }
  /**
   * 保持自动化此刻算出来的值。**淡出必须用它，不能读 `.value`**——
   * 那个 getter 在只排过自动化时返回默认值 1（0902 实测，真 ctx 与离线都是），
   * 于是"淡出"会先把增益顶到 1.0 再衰减。这里记一笔就够，假 ctx 不必真算出那个值。
   */
  cancelAndHoldAtTime(t: number) { this.calls.push({ method: "cancelAndHoldAtTime", value: 0, time: t }); return this; }
  /** 最后一个拐点的目标值。指数收尾给 0 会让真 WebAudio 抛，所以这条要被断言。 */
  get lastTarget(): number | undefined { return this.calls.at(-1)?.value; }
}

export class FakeNode {
  readonly connected: FakeNode[] = [];
  constructor(readonly kind: string) {}
  connect(dest: FakeNode) { this.connected.push(dest); return dest; }
  disconnect() {}
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
  constructor() { super("gain"); }
}

export class FakeOsc extends FakeNode {
  type = "sine";
  readonly frequency = new FakeParam();
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  constructor() { super("osc"); }
  start(t: number) { this.startedAt = t; }
  stop(t: number) { this.stoppedAt = t; }
}

export class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  constructor() { super("bufferSource"); }
  start(t: number) { this.startedAt = t; }
  stop(t: number) { this.stoppedAt = t; }
}

export class FakeBiquad extends FakeNode {
  type = "bandpass";
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  constructor() { super("biquad"); }
}

export interface FakeCtxOptions {
  /** 去掉 `createBiquadFilter`，模拟老 webview。用于验降级路径。 */
  noBiquad?: boolean;
}

export class FakeCtx {
  currentTime = 10;
  sampleRate = 48_000;
  state: "suspended" | "running" | "closed" = "running";
  readonly destination = new FakeNode("destination");
  readonly nodes: FakeNode[] = [];

  constructor(opts: FakeCtxOptions = {}) {
    if (opts.noBiquad) {
      // 真的删掉这个方法——合成层用 `typeof ctx.createBiquadFilter !== "function"` 探测。
      (this as { createBiquadFilter?: unknown }).createBiquadFilter = undefined;
    }
  }

  createGain() { const n = new FakeGain(); this.nodes.push(n); return n; }
  createOscillator() { const n = new FakeOsc(); this.nodes.push(n); return n; }
  createBufferSource() { const n = new FakeBufferSource(); this.nodes.push(n); return n; }
  createBiquadFilter() { const n = new FakeBiquad(); this.nodes.push(n); return n; }
  createBuffer(_ch: number, frames: number, _rate: number) {
    const data = new Float32Array(frames);
    return { getChannelData: () => data, length: frames };
  }

  /** 建了几个某类节点。断言用。 */
  count(kind: string): number { return this.nodes.filter((n) => n.kind === kind).length; }
  of<T extends FakeNode>(kind: string): T[] { return this.nodes.filter((n) => n.kind === kind) as T[]; }
}

/** 造一个能直接喂给合成层的 ctx（类型上按 `BaseAudioContext` 走）。 */
export function fakeCtx(opts: FakeCtxOptions = {}): { ctx: BaseAudioContext; fake: FakeCtx; dest: FakeNode } {
  const fake = new FakeCtx(opts);
  return { ctx: fake as unknown as BaseAudioContext, fake, dest: new FakeNode("dest") };
}
