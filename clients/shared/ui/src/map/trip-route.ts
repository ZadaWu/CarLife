/**
 * 行程路线与时刻推算（施工单 M13-09）。
 *
 * # 为什么连线必须走高德而不是点到点直线
 *
 * 直线穿楼穿江，看起来像"从景点直飞酒店"。用户走查一眼看出来：
 * 这不是一条能开的路。真实路径靠 `AMap.Driving` 逐段规划。
 *
 * # 时刻是**推算**，不是行程里的数据
 *
 * 行程快照没有时间字段。这里的时刻由两部分合成：
 *  - 段间车程 = 高德规划返回的**真实 duration**；
 *  - 每处停留 = 本文件的固定假设（`DWELL_MIN`）。
 * 后者是假设不是事实，所以：**拿不到真实车程时一个时刻都不给**
 * （`scheduleStops` 返回全 undefined），只显示 Day N。
 * 宁可少一行字，也不能把"每段开 30 分钟"这种猜测摆成时刻表——
 * 与坐标"不标不猜"是同一条红线。展示侧一律带"预计"字样。
 */

export interface RouteLeg {
  /** 该段的真实道路折线（高德 GCJ-02）。 */
  path: Array<[number, number]>;
  /** 该段车程秒数（高德返回值）。 */
  durationS: number;
}

interface DrivingResult {
  routes?: Array<{
    time?: number;
    steps?: Array<{ path?: Array<{ lng: number; lat: number }> }>;
  }>;
}

type DrivingCtor = new (opts: Record<string, unknown>) => {
  search(
    origin: unknown,
    destination: unknown,
    cb: (status: string, result: DrivingResult | string) => void,
  ): void;
};

/**
 * 逐段规划。**任何一段失败都只让那一段回落直线**，不影响其它段——
 * 弱网下整条路线消失比某一段是直线糟得多。
 *
 * 串行 + 间隔 + 失败重试一次：JS API 的路径规划同样有 QPS 限制。
 * 实测 8 个停靠点（7 段）用 120ms 间隔，最后一段稳定回
 * `status=error CUQPS_HAS_EXCEEDED_THE_LIMIT`——与 M13-06 坐标解析同一个坑，
 * 那边验过 350ms 可行，这里沿用同一组参数。
 */
export async function planDrivingLegs(
  AMap: Record<string, unknown>,
  points: Array<[number, number]>,
  opts: { gapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Array<RouteLeg | null>> {
  const Driving = AMap.Driving as DrivingCtor | undefined;
  const LngLat = AMap.LngLat as (new (lng: number, lat: number) => unknown) | undefined;
  if (!Driving || !LngLat || points.length < 2) {
    return new Array(Math.max(0, points.length - 1)).fill(null);
  }
  const gapMs = opts.gapMs ?? 350;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // policy 用默认（时间最短）；不传 map/panel——我们只要数据，自己画线。
  const driving = new Driving({ showTraffic: false });

  const searchOnce = (a: [number, number], b: [number, number]) =>
    new Promise<RouteLeg | null>((resolve) => {
      let settled = false;
      const done = (v: RouteLeg | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      // 兜底超时：回调不来时不能把整条链卡死（车机弱网常见）。
      const timer = setTimeout(() => done(null), 6_000);
      try {
        driving.search(new LngLat(a[0], a[1]), new LngLat(b[0], b[1]), (status, result) => {
          clearTimeout(timer);
          if (status !== "complete" || typeof result === "string") return done(null);
          const route = result.routes?.[0];
          if (!route) return done(null);
          const path: Array<[number, number]> = [];
          for (const step of route.steps ?? []) {
            for (const p of step.path ?? []) path.push([p.lng, p.lat]);
          }
          if (path.length < 2) return done(null);
          done({ path, durationS: route.time ?? 0 });
        });
      } catch {
        clearTimeout(timer);
        done(null);
      }
    });

  const legs: Array<RouteLeg | null> = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    if (i > 0) await sleep(gapMs);
    let leg = await searchOnce(points[i], points[i + 1]);
    if (!leg) {
      // 限流是最常见的失败原因，隔久一点再来一次；仍失败才认输（该段回落直线）。
      await sleep(Math.max(gapMs, 1_000));
      leg = await searchOnce(points[i], points[i + 1]);
    }
    legs.push(leg);
  }
  return legs;
}

/**
 * 步行接驳的最小差距（米）：折线端点与站点圆点差得比这远才补虚线。
 *
 * 高德驾车折线**贴路网**收尾，POI 不在马路上时（寺院广场、沙滩）折线端点
 * 天然够不到站点圆点——普陀山实测普济殿差 76m、百步沙差 85m。这段差距是
 * 真实的"下车走过去"，不画显得线断了，画成实线则是造假（那意味着有一条
 * 能开进大殿的路）。虚线接驳把它如实画出来。
 *
 * 阈值以下不画：GPS 级的几米偏差画出来只是贴着圆点的一撮毛刺。
 */
export const WALK_CONNECTOR_MIN_M = 30;

/** cos(纬度) 校正的平面近似距离（米）——与本文件其余度量同一套。 */
function distanceM(a: [number, number], b: [number, number]): number {
  const kx = Math.cos((a[1] * Math.PI) / 180) || 1;
  return Math.hypot((b[0] - a[0]) * kx, b[1] - a[1]) * 111_320;
}

/**
 * 算出一段（一天）路线里需要补的步行接驳：每条规划成功的 leg，
 * 首端对出发站点、尾端对到达站点，差距超阈值就给一对 [站点, 路网端点]。
 *
 * 规划失败的 leg（null）不补——那一段本来就回落成站点直连的直线，
 * 端点即站点，无缝可接。同一站点的到达/出发落路点不同时会有两条接驳，
 * 这是如实的（下车点与上车点本就可以不同）；完全重合的去重。
 */
export function walkConnectors(
  points: Array<[number, number]>,
  legs: Array<RouteLeg | null>,
  minM = WALK_CONNECTOR_MIN_M,
): Array<[[number, number], [number, number]]> {
  const out: Array<[[number, number], [number, number]]> = [];
  const seen = new Set<string>();
  const push = (stop: [number, number], road: [number, number]) => {
    if (distanceM(stop, road) <= minM) return;
    const key = `${stop[0]},${stop[1]}|${road[0]},${road[1]}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([stop, road]);
  };
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    if (!leg || leg.path.length < 2) continue;
    const from = points[i];
    const to = points[i + 1];
    if (from) push(from, leg.path[0]);
    if (to) push(to, leg.path[leg.path.length - 1]);
  }
  return out;
}

/**
 * 把折线重采样成**等弧长**的点列（流动粒子专用）。
 *
 * 为什么非做不可：`moveAlong` 的 `duration` 是**每一段**的时长
 *（官方参考手册 MoveAlongOptions："Duration of each segment in ms"），
 * 整条路线上所有段共用同一个值。而真实道路折线的点是按**转弯密度**给的
 * ——弯道里几米一个点、直线段几百米才一个点。同一份 duration 落在这样的点列上，
 * 粒子会在弯道里挪不动、在直路上瞬移，看起来根本不是匀速流动。
 *
 * 先等分弧长再让每段吃相同时长，速度才是匀的；
 * 「跑完一圈用多久」也才成为一个能直接设定的量（见 AmapTripLayer 的 RUNNER_LOOP_MS）。
 *
 * 距离用 cos(纬度) 校正的平面近似。它同时也是**屏幕上的**等距：
 * 墨卡托的度量恰好是这个的 1/cos(φ) 倍，而常数因子不改变"等分"这件事。
 *
 * 返回恰好 `count` 个点，首尾与原路径一致（首尾是真实站点，不能被插值挪走）。
 */
export function resampleEven(
  path: Array<[number, number]>,
  count: number,
): Array<[number, number]> {
  if (path.length < 2 || count < 2) return path.slice();

  const avgLat = path.reduce((a, p) => a + p[1], 0) / path.length;
  const kx = Math.cos((avgLat * Math.PI) / 180) || 1;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const d = Math.hypot((path[i + 1][0] - path[i][0]) * kx, path[i + 1][1] - path[i][1]);
    seg.push(d);
    total += d;
  }
  // 所有点重合：无从等分，原样返回（调用方拿到的仍是一条合法路径）。
  if (total <= 0) return path.slice();

  const out: Array<[number, number]> = [path[0]];
  const step = total / (count - 1);
  let i = 0;
  let acc = 0; // seg[0..i-1] 的累计长度
  for (let n = 1; n < count - 1; n += 1) {
    const target = step * n;
    while (i + 1 < seg.length && acc + seg[i] < target) {
      acc += seg[i];
      i += 1;
    }
    // 夹到 [0,1]：累加的浮点误差会让最后几个点算出 t 略大于 1，那会插到线段外面去。
    const t = seg[i] > 0 ? Math.min(1, Math.max(0, (target - acc) / seg[i])) : 0;
    out.push([
      path[i][0] + (path[i + 1][0] - path[i][0]) * t,
      path[i][1] + (path[i + 1][1] - path[i][1]) * t,
    ]);
  }
  out.push(path[path.length - 1]);
  return out;
}

/**
 * 按天切段（M34-03）：全程模式的折线一天一段，跨天不连线。
 *
 * 跨天衔接（前一天末点→次日首点）发生在"回酒店之后"，画成行车路线就是
 * 画一段现实中不存在的位移——D1 回酒店段与 D2 出行段在图上交叉成麻花
 * （用户走查原话）正是这么来的。连住酒店的 stop 归它的首日（`stop.day`），
 * 所以 D1 的段自然以酒店收尾、D2 的段从当天首个景点起。
 */
export function splitByDay<T extends { day: number }>(stops: readonly T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let curDay: number | undefined;
  for (const s of stops) {
    if (curDay !== undefined && s.day !== curDay) {
      out.push(cur);
      cur = [];
    }
    curDay = s.day;
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 各类停靠的停留时长（分钟）——**假设值**，不是行程数据，见文件头。 */
const DWELL_MIN: Record<string, number> = {
  spot: 90,
  hotel: 30, // 放行李/寄存；过夜不在这条时间线上
  charging: 30,
};

/** 每天的出发时刻（分钟，自 00:00 起）：09:00。 */
const DAY_START_MIN = 9 * 60;

export interface StopSchedule {
  /** 到达时刻 `HH:MM`；拿不到真实车程时为 undefined（不猜）。 */
  arrive?: string;
  /** 离开时刻 `HH:MM`。 */
  depart?: string;
}

function hhmm(totalMin: number): string {
  const m = Math.round(totalMin);
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * 按天推算每个停靠的到达/离开时刻。
 *
 * **模型时段优先（M34-02）**：某天全部景点都带 `estStart/estEnd`（规划层产出，
 * M34-01）时，这一天直接用模型时段——时段语义（夜游在晚上、下午有安排）只有
 * 模型知道，端上推算的产物就是"珠江夜游 预计 10:50"这类荒谬时间。该天的
 * hotel/charging 这类无时段停靠**不给时刻**（只留 Day 徽标）：模型没说什么时候
 * 到酒店，编一个出来与"不猜时间"的文件头纪律相悖。
 * **整天一票制**：该天任一景点缺时段就整天回退推算——半天模型时段半天推算
 * 的混排比全推算更难读（与 merge 侧 dayTimesValid 同一取向）。
 *
 * 回退规则（旧行程/模型没给）：每天从 09:00 开始；到达 = 上一处离开 + 该段
 * 真实车程；离开 = 到达 + 停留假设。**换天就重新从 09:00 起算**——跨天累加会
 * 得出"第 3 天下午 5 点到第一个景点"这种荒唐结果。
 * 缺少真实车程（规划失败/插件缺失）→ 回退天全部空对象，只显示 Day N。
 */
export function scheduleStops(
  stops: Array<{ day: number; kind: string; estStart?: string; estEnd?: string }>,
  legs: Array<RouteLeg | null>,
): StopSchedule[] {
  // 哪些天可以整天用模型时段：该天全部 spot 都带齐两个字段。
  const modelDays = new Set<number>();
  const spotsByDay = new Map<number, Array<{ estStart?: string; estEnd?: string }>>();
  for (const s of stops) {
    if (s.kind !== "spot") continue;
    spotsByDay.set(s.day, [...(spotsByDay.get(s.day) ?? []), s]);
  }
  for (const [day, spots] of spotsByDay) {
    if (spots.every((s) => s.estStart && s.estEnd)) modelDays.add(day);
  }

  // 回退天的推算基线。同一天内有一段没规划出来，后面所有时刻都会失真——整体不给，不给一半。
  // **跨天段不参与判定**（M34-03）：换天重置 09:00，跨天车程根本不进推算；
  // 折线分天后跨天段不再规划（那是"回酒店之后"的位移，不是行车），它恒为 null。
  const usable =
    stops.length >= 2 &&
    legs.length >= stops.length - 1 &&
    legs.every((l, i) => l !== null || stops[i + 1]?.day !== stops[i]?.day);
  const baseline: StopSchedule[] = [];
  if (usable) {
    let clock = DAY_START_MIN;
    for (let i = 0; i < stops.length; i += 1) {
      if (i > 0) {
        const sameDay = stops[i].day === stops[i - 1].day;
        clock = sameDay ? clock + (legs[i - 1]!.durationS / 60) : DAY_START_MIN;
      }
      const arrive = clock;
      const depart = arrive + (DWELL_MIN[stops[i].kind] ?? 60);
      baseline.push({ arrive: hhmm(arrive), depart: hhmm(depart) });
      clock = depart;
    }
  } else {
    for (let i = 0; i < stops.length; i += 1) baseline.push({});
  }

  return stops.map((s, i) => {
    if (!modelDays.has(s.day)) return baseline[i];
    if (s.kind === "spot" && s.estStart && s.estEnd) return { arrive: s.estStart, depart: s.estEnd };
    return {}; // 模型时段天里的 hotel/charging：不猜时间
  });
}
