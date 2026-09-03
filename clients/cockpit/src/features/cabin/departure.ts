/**
 * 出发动画的时间轴与出发卡的纯逻辑（0830 走查重排）。
 *
 * # 为什么时间轴和关键帧都住在这一个文件里
 *
 * 上一版的字幕 cue 表写在 TSX 的 `setTimeout` 里，画面节奏写在 CSS `@keyframes`
 * 里——两处手写同一份时间，漂了没有任何报错：实测画面正到"暖暖坐进车里"的
 * 高光时刻，字幕已经写「演示完成」。所以这里把**字幕、每一层的关键帧 offset**
 * 全部从同一份 `DEPARTURE_TIMELINE` 推导，且导出成纯数据——单测可以断言
 * "车门打开的那一帧就落在「暖暖上车」相位里"，而不是靠肉眼对表。
 *
 * # 出发卡（设计决议 2026-08-30）
 *
 * 动画不再以「演示完成」的尬停收场：车驶离后滑入出发卡（目的地/今日路线/
 * 途径补能 + 「开始导航」）。钥匙从"演示按钮"升格为"出发入口"，
 * 不保留纯看动画的路——重播按钮留着就够了。
 * 卡本身与它的纯逻辑已上提到 `@carlife/ui`（`departure/`），两端共用；本文件只剩动画时间轴。
 */

// ── 时间轴（唯一真相源）─────────────────────────────────────

export interface DeparturePhase {
  /** 相位起点（ms，相对动画开始）。 */
  at: number;
  key: "arrive" | "climate" | "ambient" | "board" | "ready" | "depart";
  /** 字幕文案。 */
  status: string;
}

/**
 * ── 四段实拍片（0831 拆分版）────────────────────────────────
 *
 * 整条出发动画现在**全部由视频承担**，立绘那一套（车驶入、举手姿态、地面光晕、
 * 舞台背板）已经退休——它们的比例与地平线问题是重做素材才能修的，而片子里
 * 这些关系本来就是对的。
 *
 * 四段是**一条链**：每段的起始帧都取自上一段的末帧，所以切点处车位、尺寸、
 * 机位、背景全对得上。要替换其中任意一段，必须从它上一段的末帧重新生成，
 * 不能单独换，否则接缝立刻穿帮。
 *
 * 代价照旧要认：视频是黑盒、没有 alpha、也没法被本时间轴逐帧驱动。所以约定是
 * **时间轴迁就片子**——相位时刻由下面量到的片内节拍推导，播放由 rAF 从同一个
 * 动画时钟驱动（见 CabinArrivalDemo）。改片子就改这张表，别在别处手写第二份时间。
 *
 * `beats` 是逐帧看帧序图量出来的，单位 ms、相对各自片头。
 */
export const DEPARTURE_CLIPS = [
  { key: "arrive", duration: 3_417, beats: { parked: 2_920 } },
  { key: "wake", duration: 4_625, beats: { handUp: 2_000 } },
  { key: "board", duration: 6_042, beats: { doorOpen: 1_800, seated: 4_200, shutAndLit: 5_200 } },
  // 0831 二次延长：原片 3.5s 后车卡在半出画不动，尾巴是另生成一段续上的
  // （从半出画的末帧 i2v，模型会先把车"补"回画面里，所以只取它向左出画的那 1.4s，
  //  接点选在车位与原片末帧吻合处，运动中硬接看不出来）。现在车会完全驶出画面。
  { key: "driveoff", duration: 4_833, beats: { gone: 4_300 } },
] as const;

type ClipKey = (typeof DEPARTURE_CLIPS)[number]["key"];

/** 各段在总时间轴上的起点（由时长依次累加，不手写）。 */
export const CLIP_START: Record<ClipKey, number> = (() => {
  const out = {} as Record<ClipKey, number>;
  let t = 0;
  for (const c of DEPARTURE_CLIPS) {
    out[c.key] = t;
    t += c.duration;
  }
  return out;
})();

/** 片内节拍 → 总时间轴时刻。相位一律用它推导，不写裸毫秒。 */
const at = (key: ClipKey, ms = 0) => CLIP_START[key] + ms;

export const DEPARTURE_TIMELINE: { total: number; phases: readonly DeparturePhase[] } = {
  total: DEPARTURE_CLIPS.reduce((n, c) => n + c.duration, 0),
  phases: [
    { at: 0, key: "arrive", status: "车辆驶来" },
    // 这两拍都落在「唤醒」那段片子里：她走过去、举手，车内透出暖光。
    { at: at("wake", 800), key: "climate", status: "空调预热" },
    { at: at("wake", DEPARTURE_CLIPS[1].beats.handUp), key: "ambient", status: "点亮氛围" },
    { at: at("board", DEPARTURE_CLIPS[2].beats.doorOpen), key: "board", status: "暖暖上车" },
    { at: at("board", DEPARTURE_CLIPS[2].beats.shutAndLit), key: "ready", status: "准备出发" },
    { at: at("driveoff"), key: "depart", status: "出发！" },
  ],
};

/** ms → WAAPI offset（0..1）。 */
const T = (ms: number) => ms / DEPARTURE_TIMELINE.total;

/** 相位起点的毫秒值。 */
const phaseMs = (key: DeparturePhase["key"]) =>
  DEPARTURE_TIMELINE.phases.find((p) => p.key === key)!.at;

/** 相位起点的 offset。 */
const P = (key: DeparturePhase["key"]) => T(phaseMs(key));

/**
 * 某一刻该显示哪句字幕。
 *
 * 抽出来是为了能单测：字幕由 rAF 每帧从动画时钟推导，而"每帧算一次"的逻辑
 * 最容易在边界上写错——相位起点那一帧到底算不算它。约定是**算**（`ms >= at`），
 * 与关键帧的硬切保持同一边界。
 */
export function statusAt(ms: number): string {
  let cur = DEPARTURE_TIMELINE.phases[0]!.status;
  for (const p of DEPARTURE_TIMELINE.phases) if (ms >= p.at) cur = p.status;
  return cur;
}

/**
 * 功能球外环的整组扫描：在 `climate` 与 `ambient` 两拍各扫一遍，第 `i` 颗按 60ms 递延。
 *
 * **不提供"只闪某一颗"的能力**——单颗闪＝"她选了它"，而动画里的选择与前端真实的
 * 功能状态没有任何绑定，一旦对不上就是在骗人，功能增删时还会指错对象。
 * 所以从接口上就堵掉这个口子。
 */
function groupSweep(i: number): Keyframe[] {
  const STAGGER = 60;
  const flash = (atMs: number): Keyframe[] => {
    const a0 = T(atMs + i * STAGGER);
    const b0 = T(atMs + i * STAGGER + 520);
    return [
      { offset: a0, opacity: 0, transform: "scale(0.86)" },
      { offset: Math.min(a0 + 0.006, 1), opacity: 0.94, transform: "scale(0.86)" },
      { offset: Math.min(b0, 1), opacity: 0, transform: "scale(1.24)" },
    ];
  };
  return [
    { offset: 0, opacity: 0, transform: "scale(0.86)" },
    ...flash(phaseMs("climate") + 150),
    ...flash(phaseMs("ambient") + 120),
    { offset: 1, opacity: 0, transform: "scale(1.24)" },
  ];
}

/** 某段片子的可见性：硬切进、硬切出。不做交叉淡化——两段片子半透明同框是重影不是运镜。 */
function clipVisibility(key: ClipKey): Keyframe[] {
  const idx = DEPARTURE_CLIPS.findIndex((c) => c.key === key);
  const on = T(CLIP_START[key]);
  const last = idx === DEPARTURE_CLIPS.length - 1;
  const off = last ? 1 : T(CLIP_START[DEPARTURE_CLIPS[idx + 1]!.key]);
  const frames: Keyframe[] = [{ offset: 0, opacity: 0 }];
  if (on > 0) frames.push({ offset: on, opacity: 0 });
  frames.push({ offset: on, opacity: 1 });
  if (!last) {
    frames.push({ offset: off, opacity: 1 }, { offset: off, opacity: 0 }, { offset: 1, opacity: 0 });
  } else {
    frames.push({ offset: 1, opacity: 1 });
  }
  return frames;
}

/**
 * 每一层的关键帧。key 与组件里 ref 的挂点一一对应；
 * offset 全部由相位/片段起点推导，改节奏只改 DEPARTURE_CLIPS。
 */
export function departureLayers(): Record<string, Keyframe[]> {
  const wakeIn = T(CLIP_START.wake);
  return {
    arriveClip: clipVisibility("arrive"),
    wakeClip: clipVisibility("wake"),
    boardClip: clipVisibility("board"),
    driveoffClip: clipVisibility("driveoff"),

    /*
     * 暖暖只出现在第 2 段之后，所以第 1→2 切点处她会凭空冒出来。
     * 这一层是从第 2 段第 0 帧抠出来的她（`nuannuan-intro-plate.png`），
     * 在切点前 400ms 淡入到位——落点与片中一致，切过去时她纹丝不动。
     */
    introNuannuan: [
      { offset: 0, opacity: 0 },
      { offset: T(Math.max(0, CLIP_START.wake - 400)), opacity: 0 },
      { offset: wakeIn, opacity: 1 },
      { offset: wakeIn, opacity: 0 },
      { offset: 1, opacity: 0 },
    ],

    /*
     * 唤醒光带：她举手那一刻从手边漫开的柔光。
     *
     * **刻意不放进视频里**。第一版让模型渲染，它给出一个占掉 18.6% 画面的橙金光环，
     * 而且模型对"轻一点"这种要求基本不听。放在前端反而全都对：强度精确可控、
     * 调色板与 HUD 一致、更重要的是**它与真实功能状态的耦合关系由我们自己决定**，
     * 不被烘进视频里。两端渐隐、不落在任何一颗功能球上——只表达"唤醒"，不表达"选择"。
     */
    wakeBand: [
      { offset: 0, opacity: 0, transform: "scaleX(0)" },
      { offset: P("ambient"), opacity: 0, transform: "scaleX(0)" },
      { offset: T(phaseMs("ambient") + 140), opacity: 0.95, transform: "scaleX(0.12)" },
      { offset: T(phaseMs("ambient") + 700), opacity: 0.85, transform: "scaleX(1)" },
      { offset: T(CLIP_START.board), opacity: 0, transform: "scaleX(1)" },
      { offset: 1, opacity: 0, transform: "scaleX(1)" },
    ],

    /*
     * 功能球那一圈压在片子之上（CSS z=7）。它的戏份是"唤醒"这两拍，
     * 上车段开始后没有叙事任务了，淡到很弱——不淡的话底下两颗正骑在车轮上，
     * 读起来是杂乱不是 HUD 叠加。留 0.18 而不是归零：完全消失等于 HUD 身份被视频吃掉。
     */
    constellation: [
      { offset: 0, opacity: 1 },
      { offset: P("ambient"), opacity: 1 },
      { offset: T(CLIP_START.board), opacity: 0.18 },
      { offset: 1, opacity: 0.18 },
    ],

    ringClimate: groupSweep(0),
    ringLight: groupSweep(1),
    ringSeat: groupSweep(2),
    ringMedia: groupSweep(3),
    ringFamily: groupSweep(4),
  };
}

// ── 出发卡：导航目标与高德 URI ───────────────────────────────
//
// 2026-09-02 上提到 `clients/shared/ui/src/departure/amap.ts`（手机端也要出发卡）。
// 这里保留旧名转出，既有调用方与测试不改；经子路径 `@carlife/ui/departure` 引——
// 根入口带 png，本仓 cockpit 的 node:test 里 import 根入口会整文件 fail。
export {
  amapAppNavUri,
  amapNavUri,
  amapWebPolicy,
  navLaunchDegradation,
  pickNavTarget,
  stopsViewportHeight,
  todayStopNames,
  type NavLaunch,
  type NavTarget,
} from "@carlife/ui/departure";
