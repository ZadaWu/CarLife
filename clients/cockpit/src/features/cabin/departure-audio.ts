/**
 * 出发动画的 cue 表（施工单 M64-02）。
 *
 * # 每个时刻都从 DEPARTURE_TIMELINE 推导，一个裸毫秒都不写
 *
 * `departure.ts` 文件头与 `CabinArrivalDemo.tsx` 的 rAF 那段注释已经把
 * "两处各走一份时间、漂了没有任何报错" 这条教训写过两遍。本文件是第三处
 * 会用到那批时刻的地方，所以它只**读** `DEPARTURE_TIMELINE.phases`：
 * 改片子就改 `DEPARTURE_CLIPS`，这张表跟着自动挪，不需要有人记得回来同步。
 * 单测里有一条专门断言这件事（cue 的 `at` 逐条等于对应相位的 `at`）。
 *
 * # 为什么是"这一帧跨过了哪些时刻"而不是"当前时刻等于"
 *
 * rAF 一帧约 16ms，相位时刻不会正好落在帧上；车机 webview 掉帧时一帧可能跨过
 * 100ms 以上。按相等触发的结果是**大部分 cue 永远不响**，而且不报错。
 * 所以判据是区间 `prev < at <= now`，返回值是**数组**——一帧跨过两个就一帧放两个。
 *
 * # 这里没有第三个时钟
 *
 * `at` 是 WAAPI 主动画 `currentTime` 坐标系里的毫秒，调用方每帧把它喂进来。
 * 本文件不碰 `setTimeout`、不碰 `AudioContext.currentTime`：后者在页面进后台时
 * **不冻结**，而 WAAPI 的文档时钟会冻结，用它排期就是让音一路放完而画面停在第一帧。
 */

import type { CueName } from "@carlife/ui";

import { CLIP_START, DEPARTURE_CLIPS, DEPARTURE_TIMELINE } from "./departure";

type PhaseKey = (typeof DEPARTURE_TIMELINE.phases)[number]["key"];

/** 相位起点的毫秒值。与 `departure.ts` 里那个同名私有函数是同一套坐标。 */
const phaseAt = (key: PhaseKey): number =>
  DEPARTURE_TIMELINE.phases.find((p) => p.key === key)!.at;

export interface DepartureCue {
  /** 主动画时钟上的时刻（ms）。 */
  readonly at: number;
  readonly cue: CueName;
}

/**
 * 六个 cue 与六个相位的对应关系。
 *
 * | 相位 | 画面上发生了什么 | cue |
 * |---|---|---|
 * | `arrive`  | 车驶来 | `bedIn` 风声渐入 |
 * | `climate` | 空调预热 | `chime` 一声就绪音（**只有一声**，两声是报警的语法） |
 * | `ambient` | 点亮氛围 | `arpeggio` 上行三音 |
 * | `board`   | 开门上车 | **无** —— 见下方「关门声为什么不在这里」 |
 * | `ready`   | 准备出发 | `thud` 关门闷响 |
 * | `depart`  | 出发！ | `resolve` 解决音 + `bedOut` 铺底渐出 |
 *
 * 「钥匙串轻响」不在这张表里：它响在**点击那一刻**，那时动画还没开始，
 * 由点击处理器直接 fire（也正好是 `AudioContext.resume()` 必须发生的地方）。
 *
 * # 关门声为什么不在 `board` 上
 *
 * 因为 `board` 是**开门**那一拍，不是关门。第一版把 `thud` 挂在这里，
 * 0902 走查把片子逐帧抽出来和音频包络对齐才看出来：`board` = 9842ms 时
 * 暖暖**还在沿着车身走**，门根本没开（实测门开在片内 ~2700ms、总 ~10742ms），
 * 而门**关上**是片内 ~5400ms、总 ~13442ms——那正是 `ready` 这一拍
 * （`CLIP_START.board + shutAndLit` = 13242ms，比画面早约 200ms，落在关门动作里）。
 *
 * 这类错误单测抓不到：`thud` 照样在"某个相位的起点"上响，
 * 每一条"cue 的 at 等于相位的 at"都是绿的。**判据只能是把画面和声音摆在一起看。**
 */
export const DEPARTURE_CUES: readonly DepartureCue[] = [
  { at: phaseAt("arrive"), cue: "bedIn" },
  { at: phaseAt("climate"), cue: "chime" },
  { at: phaseAt("ambient"), cue: "arpeggio" },
  // 等价于 CLIP_START.board + DEPARTURE_CLIPS[2].beats.shutAndLit——门关上、车灯亮的那一拍。
  { at: phaseAt("ready"), cue: "thud" },
  { at: phaseAt("depart"), cue: "resolve" },
  { at: phaseAt("depart"), cue: "bedOut" },
];

/**
 * 首帧用的 `prev`。
 *
 * **必须是负数**：`arrive` 相位的 `at` 是 0，而判据是 `prev < at`，
 * 用 0 当首帧的 prev 会把风声那一条漏掉——漏了不报错，只是没有铺底。
 */
export const CUE_START = -1;

/**
 * 这一帧该放哪些 cue。
 *
 * 边界归属与 `statusAt` 的 `ms >= at` 一致：相位起点那一帧**算它**。
 * 连续帧之间不会重复触发，因为上一帧的 `now` 就是这一帧的 `prev`。
 */
export function cuesBetween(prev: number, now: number): CueName[] {
  return DEPARTURE_CUES.filter((c) => prev < c.at && c.at <= now).map((c) => c.cue);
}

/** 只在测试里用：确认这张表确实盖住了整条时间轴。 */
export const DEPARTURE_CUE_SPAN = {
  first: DEPARTURE_CUES[0]!.at,
  last: DEPARTURE_CUES.at(-1)!.at,
  total: DEPARTURE_TIMELINE.total,
  boardDoorOpen: CLIP_START.board + DEPARTURE_CLIPS[2].beats.doorOpen,
  boardShutAndLit: CLIP_START.board + DEPARTURE_CLIPS[2].beats.shutAndLit,
  driveoffStart: CLIP_START.driveoff,
} as const;
