/**
 * 音景门面（施工单 M64-01）。
 *
 * # 它不认识出发动画
 *
 * 这一层只回答"发出某个声音"。什么时候发、要不要发、和音乐/语音怎么互让，
 * 全在调用方（M64-02 的 cue 表、M64-03 的三个闸）。做成通用的是为了将来能复用，
 * **不是**现在就要铺开成一套全局界面音效——那不在 M64 的范围里。
 *
 * # 主增益是一个真节点，不是每个 cue 各乘一遍
 *
 * `bed` 是持续的：主音量或静音在它响着的时候变了，得当场生效。
 * 每个 cue 自己乘一遍主音量的话，已经在响的那一路就永远停在旧值上。
 */

import { PEAK_CUE, effectiveGain } from "./gain";
import { arpeggio, bed, chime, jingle, resolve, thud, type BedHandle } from "./primitives";

export { PEAK_BED, PEAK_CUE, clampPeak, effectiveGain } from "./gain";
export type { BedHandle } from "./primitives";

/** 一个可以被点名发出的声音。`bedIn`/`bedOut` 是同一条铺底的两端。 */
export type CueName = "jingle" | "chime" | "arpeggio" | "thud" | "resolve" | "bedIn" | "bedOut";

/**
 * 上行三音用的音高（A4 / C#5 / E5，A 大调三和弦）。
 *
 * 放在门面而不是 `arpeggio()` 里：音阶是设计决定，合成器不该有偏好。
 */
export const ARPEGGIO_NOTES = [440, 554.37, 659.25] as const;

export class Soundscape {
  private readonly ctx: BaseAudioContext;
  private readonly master: GainNode;
  private bedHandle: BedHandle | null = null;
  private masterLevel = 1;
  private muted = false;
  private unknown = 0;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = effectiveGain(PEAK_CUE, this.masterLevel, this.muted) / PEAK_CUE;
    this.master.connect(ctx.destination);
  }

  /**
   * ctx 此刻的状态。调用方据此决定 suspended 时干脆不发声——
   * **不要排队补放**，恢复的瞬间几个音一起炸出来比没有声音糟得多。
   */
  get state(): AudioContextState {
    return this.ctx.state;
  }

  /** 收到过几个不认识的 cue。与 `bridge/index.ts` 的未知事件计数同形。 */
  get unknownCueCount(): number {
    return this.unknown;
  }

  setMaster(v: number): void {
    this.masterLevel = v;
    this.applyMaster();
  }

  setMuted(on: boolean): void {
    this.muted = on;
    this.applyMaster();
  }

  private applyMaster(): void {
    // 归一化成 0..1 的系数：峰值上限已经由各个 cue 的包络负责，
    // 主增益只表达"整体多响 / 静不静音"这一件事。
    this.master.gain.value = effectiveGain(PEAK_CUE, this.masterLevel, this.muted) / PEAK_CUE;
  }

  /**
   * 发一个 cue。
   *
   * 未知 cue **忽略并计数，不抛**——与 `bridge/index.ts:5-6`「未注册处理器的事件
   * 被忽略，另有未知事件计数」同一条纪律。界面音效不该成为一条会中断动画的路径。
   */
  fire(cue: CueName): void {
    switch (cue) {
      case "jingle":
        return jingle(this.ctx, this.master);
      case "chime":
        return chime(this.ctx, this.master);
      case "arpeggio":
        return arpeggio(this.ctx, this.master, ARPEGGIO_NOTES);
      case "thud":
        return thud(this.ctx, this.master);
      case "resolve":
        return resolve(this.ctx, this.master);
      case "bedIn":
        // 已经有一条铺底就不再开第二条：重播时 effect 会重挂，但真机上
        // 两条噪声叠起来的音量正好翻倍，且第二条没人关得掉。
        if (!this.bedHandle) this.bedHandle = bed(this.ctx, this.master);
        return;
      case "bedOut":
        this.bedHandle?.fadeOut();
        this.bedHandle = null;
        return;
      default:
        this.unknown += 1;
        return;
    }
  }

  /** 收摊：停铺底。一次性 cue 自己会了结，不需要在这里管。 */
  stop(): void {
    this.bedHandle?.fadeOut();
    this.bedHandle = null;
  }
}
