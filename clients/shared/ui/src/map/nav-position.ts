/**
 * 跟车位置源（施工单 M31-02）。
 *
 * # 这一层存在的理由：把「车在哪」从地图里抽出来
 *
 * 一期只有地图层订阅它（车标 + 镜头）。二期要让 HUD 的时间轴、能耗、到站播报
 * 都跟着走，那时换的只是**实现**——接口不变，地图层零改动。
 * 所以哪怕现在只有一个消费者，位置也不写死在动画里。
 *
 * # 一期的实现是模拟的，而这件事必须说出来
 *
 * `createSimulatedNavSource` 按真实路径与真实车程推进一个点，**车并没有真的在那**。
 * 界面上恒显「演示车速 ×N」角标不是可选项，是「不标不猜」那条红线的直接推论：
 * 一个看起来在跟车的界面，比一个空白的界面更容易让人相信它是真的。
 *
 * # 匀速靠 resampleEven，不是靠 setInterval
 *
 * 真实道路折线的点是按转弯密度给的——弯道几米一个点、直路几百米一个点。
 * 按点索引推进会让车在弯道里挪不动、在直路上瞬移。先等分弧长再让每步吃相同
 * 时长，速度才是匀的（`trip-route.ts` 的 `resampleEven` 文件头有完整论证）。
 */

import { resampleEven } from "./trip-route";

/** 每段重采样成多少个点。120 在车机屏上足够顺，且一段 5 公里时点距 ~40m。 */
const SAMPLES_PER_LEG = 120;

/**
 * 车程未知的段，动画上按这个秒数走（默认 3 分钟）。
 *
 * **它只用于动画节奏，不对外冒充车程**——`etaToNextStop` 遇到这样的段一律
 * 不给时间（返回 undefined）。把它当 ETA 播出去，就是拿一个常数冒充路况。
 */
const FALLBACK_LEG_S = 180;

/** 默认推进间隔（毫秒）。5Hz，够顺且不烧车机 CPU。 */
const DEFAULT_TICK_MS = 200;

const M_PER_DEG = 111_320;

/** 一段可跟车的路。`durationS` 缺省 = 这一段车程没查到（地图上是直线回落）。 */
export interface NavLeg {
  /** 道路折线（GCJ-02，[lng, lat]），与 `RouteLeg.path` 同形。 */
  path: Array<[number, number]>;
  /** 真实车程秒数；**缺省就是没查到**，不要填一个估的进来。 */
  durationS?: number;
}

export interface NavPosition {
  /** 当前坐标（GCJ-02，[lng, lat]）。 */
  at: [number, number];
  /** 在第几段（0 起）。 */
  legIndex: number;
  /** 该段已走完的比例，0..1。 */
  progressInLeg: number;
  /** 车头朝向（度，正北为 0，顺时针）；算不出来时缺省。 */
  headingDeg?: number;
  /** 整程是否已走完。 */
  finished: boolean;
}

export interface NavPositionSource {
  /** 订阅位置。**订阅即回一帧**——车标不该等第一个 tick 才出现。 */
  subscribe(cb: (p: NavPosition) => void): () => void;
}

export interface SimulatedNavOptions {
  /**
   * 演示倍速：只压缩时间，**不改变路径与段序**。
   * 它是演示旋钮，不是"更快的车"——4 小时车程压进 90 秒演完靠的就是它。
   */
  speedup?: number;
  tickMs?: number;
  /**
   * 定时器注入（单测用）。返回取消函数。
   * 默认 `setInterval`/`clearInterval`。
   */
  schedule?: (cb: () => void, ms: number) => () => void;
  /** 时钟注入（单测用）。默认 `Date.now`。 */
  now?: () => number;
}

/** 两点间的近似米数（等距圆柱投影，按纬度校正）。「剩 3.2 公里」这个量级足够。 */
function meters(a: [number, number], b: [number, number]): number {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * M_PER_DEG * Math.cos(lat);
  const dy = (b[1] - a[1]) * M_PER_DEG;
  return Math.hypot(dx, dy);
}

/** 由两点求朝向（度，正北 0、顺时针）。两点重合时返回 undefined，不硬给一个 0。 */
function heading(a: [number, number], b: [number, number]): number | undefined {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * Math.cos(lat);
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return undefined;
  return (Math.atan2(dx, dy) * (180 / Math.PI) + 360) % 360;
}

/** 一段预处理好的路：等弧长点列 + 动画时长 + 总长。 */
interface PreparedLeg {
  even: Array<[number, number]>;
  /** 动画用的时长（秒）；未知车程的段用 `FALLBACK_LEG_S`。 */
  animS: number;
  /** 沿路总米数。 */
  lengthM: number;
  /** 车程是不是真的（false = 这一段不参与 ETA）。 */
  realDuration: boolean;
}

/**
 * 预处理结果按**入参数组的身份**缓存。
 *
 * `etaToNextStop` 每一帧都被调一次（5Hz），而 `prepare` 里是逐段重采样 120 个点。
 * 不缓存就是每秒把整条路线重算五遍——车机上这不是理论开销。
 * 调用方每帧传的是同一个数组（AmapTripLayer 的 `navLegs` 建一次用到底），
 * WeakMap 因此命中，且数组被丢弃时缓存自动释放。
 */
const preparedCache = new WeakMap<readonly NavLeg[], PreparedLeg[]>();

function prepare(legs: readonly NavLeg[]): PreparedLeg[] {
  const hit = preparedCache.get(legs);
  if (hit) return hit;
  const out = prepareUncached(legs);
  preparedCache.set(legs, out);
  return out;
}

function prepareUncached(legs: readonly NavLeg[]): PreparedLeg[] {
  return legs
    .filter((l) => l.path.length >= 2)
    .map((l) => {
      const even = resampleEven(l.path, SAMPLES_PER_LEG);
      let lengthM = 0;
      for (let i = 0; i + 1 < even.length; i += 1) lengthM += meters(even[i]!, even[i + 1]!);
      const real = typeof l.durationS === "number" && l.durationS > 0;
      return {
        even,
        animS: real ? l.durationS! : FALLBACK_LEG_S,
        lengthM,
        realDuration: real,
      };
    });
}

/** 在等弧长点列上按比例取点（含朝向）。 */
function sample(even: Array<[number, number]>, f: number): { at: [number, number]; headingDeg?: number } {
  const clamped = Math.min(1, Math.max(0, f));
  const span = even.length - 1;
  const x = clamped * span;
  const i = Math.min(span - 1, Math.floor(x));
  const t = x - i;
  const a = even[i]!;
  const b = even[i + 1]!;
  return {
    at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    headingDeg: heading(a, b),
  };
}

/**
 * 模拟位置源：沿真实路径按真实车程推进。
 *
 * 走完最后一段就停在终点并置 `finished`——**不循环**。
 * 循环的流动粒子是装饰（`AmapTripLayer` 的 runner），而车标是"我们说车在这"，
 * 让它到了终点又回到起点重开，等于每隔一会儿谎报一次位置。
 */
export function createSimulatedNavSource(
  legs: readonly NavLeg[],
  opts: SimulatedNavOptions = {},
): NavPositionSource {
  const prepared = prepare(legs);
  const speedup = Math.max(1, opts.speedup ?? 1);
  const tickMs = Math.max(16, opts.tickMs ?? DEFAULT_TICK_MS);
  const schedule =
    opts.schedule ??
    ((cb: () => void, ms: number) => {
      const id = setInterval(cb, ms);
      return () => clearInterval(id);
    });

  const now = opts.now ?? (() => Date.now());

  /** 已经走过的秒数（路上的时间，已按倍速折算过）。 */
  let elapsedS = 0;

  function positionAt(sec: number): NavPosition {
    if (prepared.length === 0) {
      // 没有可跟的路：不编一个位置出来，交给调用方回落行程模式。
      return { at: [0, 0], legIndex: 0, progressInLeg: 0, finished: true };
    }
    let rest = sec;
    for (let i = 0; i < prepared.length; i += 1) {
      const leg = prepared[i]!;
      if (rest < leg.animS || i === prepared.length - 1) {
        const f = leg.animS > 0 ? rest / leg.animS : 1;
        const done = f >= 1;
        const { at, headingDeg } = sample(leg.even, f);
        return {
          at,
          legIndex: i,
          progressInLeg: Math.min(1, Math.max(0, f)),
          ...(headingDeg === undefined ? {} : { headingDeg }),
          finished: done && i === prepared.length - 1,
        };
      }
      rest -= leg.animS;
    }
    /* 上面的循环必然返回（最后一段兜底），这里只为类型收敛。 */
    const last = prepared[prepared.length - 1]!;
    return { at: last.even[last.even.length - 1]!, legIndex: prepared.length - 1, progressInLeg: 1, finished: true };
  }

  return {
    subscribe(cb) {
      // 订阅即回一帧：等第一个 tick 才出现的车标，看起来像是没反应。
      cb(positionAt(elapsedS));
      /*
       * 推进量按**真实经过时间**算，不按"一个 tick = tickMs"。
       *
       * 实测踩到：浏览器把不可见标签页的 `setInterval` 降到 1Hz，而代码按
       * 5Hz × 每次 tickMs 累加，于是屏幕上写着「演示车速 ×60」，实际只跑到 ×12。
       * **角标是一句对用户的声明**，说 ×60 就得真是 ×60——定时器不准时，
       * 该补的是位移，不是让声明悄悄失真。车机上前台窗口不降频，但设备卡顿、
       * 系统休眠都会造成同样的偏差。
       */
      let lastAt = now();
      return schedule(() => {
        const t = now();
        elapsedS += ((t - lastAt) / 1000) * speedup;
        lastAt = t;
        cb(positionAt(elapsedS));
      }, tickMs);
    },
  };
}

export interface NavEta {
  /** 到下一站还有多少米（沿路，不是直线）。 */
  remainingM: number;
  /**
   * 到下一站还有多少秒；**当前这一段车程没查到时是 undefined**。
   *
   * 沿用 `scheduleStops` 的红线：拿不到真实车程就一个时刻都不给。
   * 少一行字，不能把 `FALLBACK_LEG_S` 这种常数摆成"预计还有 3 分钟"。
   */
  remainingSec?: number;
}

/** 距下一站还有多远/多久。`legs` 与建源时用的是同一份。 */
export function etaToNextStop(legs: readonly NavLeg[], pos: NavPosition): NavEta {
  const prepared = prepare(legs);
  const leg = prepared[pos.legIndex];
  if (!leg) return { remainingM: 0 };
  const left = 1 - Math.min(1, Math.max(0, pos.progressInLeg));
  return {
    remainingM: Math.round(leg.lengthM * left),
    ...(leg.realDuration ? { remainingSec: Math.round(leg.animS * left) } : {}),
  };
}
