/**
 * `route_audit` —— 行程顺序体检：距离、交叉、最短顺序建议（天内 + 跨天两层）。
 *
 * # 为它服务的问题
 *
 * LLM 排景点顺序靠语义邻近感，没有度量。真实事故（sess-47998d69-18d，广州 4 天）：
 * 第 2 天排成「荔湾酒店 → 广州塔 → 珠江夜游码头 → 南越王宫御苑 → 珠江新城酒店」，
 * 南越王宫在市中心，被夹在两个江边点之后，全天 21.2km；调顺成
 * 「南越王宫 → 广州塔 → 珠江夜游」只要 10.4km——**一半路程是折返浪费**。
 * 交叉对角线正是非最优路线的几何特征：平面上两段路一交叉，2-opt 交换必能变短。
 *
 * 天内治不了全局病：点放错天（还是它，南越王宫混进珠江新城日，换出去省全程 23%）
 * 与天序不顺（四天按 中→东南→西→东北 跳，地图上画成麻花）——见"全局层"一节。
 *
 * # 它是"体检报告"，不是"最终答案"
 *
 * 本工具只按直线距离算：给出各段距离、检出交叉、给最短顺序建议。
 * **采不采纳由模型定**——夜游要在傍晚、饭点要卡时段、加油要看累计里程，
 * 这些时段/类型语义距离算法不懂，也刻意不试图懂（那是模型的活，见 内部开发指引
 * A/B 型判据）。所以建议顺序与时段冲突时，模型应当保留时段、局部采纳。
 *
 * # 直线距离是刻意的
 *
 * 城市游里直线距离做**相对比较**误差互相抵消，足以消掉折返；
 * 而高德驾车距离矩阵要 n² 次调用，免费 key QPS=3，一天 6 个点就要 10 秒起。
 * 结果里恒带 `notice` 声明估算口径，表述层引用里程时必须带"直线估算"。
 *
 * # 每次调用落一条审计记录（管理后台的前后对比就吃这个）
 *
 * 模型第一次调它时传入的顺序，就是"LLM 产出的第一版"——落进
 * `trip_route_audits`（经 `setRouteAuditStore` 注入，与 trip-plan-commit 同形态），
 * 后台拿它与最终落库的行程对比。**落库失败不打断工具返回**：
 * 审计是旁路观测，它挂了不该把模型的优化回路一起带走（与主业工具的
 * "静默成功比报错糟"不同，这里的主业是算路，落库才是旁路）。
 */

import { getAmapClient } from "./amap";
// 距离口径复用补能工具那一份（同一个 haversine 只维护一处，与 roundCoord 的先例一致）。
import { haversineKm } from "./charging";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export { haversineKm };

/** 参与计算的点：坐标齐了才算数（GCJ-02，与高德全程一致，不做坐标系转换）。 */
export interface RoutePoint {
  name: string;
  lat: number;
  lon: number;
}

/** 入参里的点：坐标可缺（缺了走地理编码；编不到就进 unresolved，不猜）。 */
export interface RouteAuditPoint {
  name: string;
  lat?: number;
  lon?: number;
}

export interface RouteAuditDayArgs {
  /** 第几天（1 起）；后台对比按它对齐最终行程。 */
  day?: number;
  /** 当天出发锚点（酒店/当前位置），知道就给——锚点不参与重排，只定起点。 */
  start?: RouteAuditPoint;
  /** 当天收尾锚点（当晚酒店），同上。 */
  end?: RouteAuditPoint;
  /** 待检的点，按当前排的顺序传入。 */
  points: RouteAuditPoint[];
}

export interface RouteAuditArgs {
  /** 目的地城市（中文名）；缺坐标的点用它地理编码。 */
  city?: string;
  days: RouteAuditDayArgs[];
}

export interface RouteLeg {
  from: string;
  to: string;
  km: number;
  /** 从当天起点累计的公里数——"开了多远该歇/该吃/该补能"用它判断。 */
  cumKm: number;
}

export interface RouteAuditDayResult {
  day?: number;
  given: { order: string[]; km: number; legs: RouteLeg[] };
  /** 交叉的两段路，如 "A→B × C→D"。有交叉基本等于有折返浪费。 */
  crossings: string[];
  /** 明显更短的顺序（省 ≥5% 且 ≥0.2km 才给）；没有就是已经够顺。 */
  suggested?: { order: string[]; km: number; savedKm: number; savedPct: number };
  alreadyOptimal: boolean;
  /** 没有坐标也编码不到的点——未参与计算，**不是被排除出行程**。 */
  unresolved: string[];
}

export interface RouteAuditResult {
  days: RouteAuditDayResult[];
  /** 全局层（≥2 天时体检）：跨天换点与天序建议。没有此字段 = 全局没查出可省的。 */
  journey?: JourneyAudit;
  totalGivenKm: number;
  totalSuggestedKm: number;
  totalSavedKm: number;
  /** 恒定声明：估算口径与采纳边界。 */
  notice: string;
}

export const ROUTE_AUDIT_NOTICE =
  "距离为直线估算（非导航里程），只用于顺序比较；建议不懂语义——" +
  "夜游/演出/用餐/补能的时段、门票与开放日、到达/离开的半天，由你把关后再采纳；" +
  "跨天建议（journey）先于天内顺序处理：先定每天去哪些点，再排当天顺序。";

/** 建议阈值：低于它就报 alreadyOptimal——瞎建议会让模型来回倒腾已经顺了的路线。 */
const SUGGEST_MIN_SAVED_KM = 0.2;
const SUGGEST_MIN_SAVED_PCT = 5;
/** 穷举上限：9! ≈ 36 万条排列配距离矩阵毫秒级；再多切 2-opt。 */
const EXACT_MAX_POINTS = 9;

export function pathKm(points: readonly RoutePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1], points[i]);
  return total;
}

/**
 * 线段严格相交检测（不含共享端点——相邻两段永远共享一点，算它就全是误报）。
 * 经纬度当平面坐标用：城市尺度（<100km）下方向判断不受投影畸变影响。
 */
function segmentsCross(p1: RoutePoint, p2: RoutePoint, p3: RoutePoint, p4: RoutePoint): boolean {
  const side = (a: RoutePoint, b: RoutePoint, c: RoutePoint): number =>
    (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
  const d1 = side(p3, p4, p1);
  const d2 = side(p3, p4, p2);
  const d3 = side(p1, p2, p3);
  const d4 = side(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 找出路径里互相交叉的两段（跳过相邻段），返回 ["A→B × C→D", ...]。 */
export function findCrossings(points: readonly RoutePoint[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < points.length; i += 1) {
    for (let j = i + 2; j < points.length; j += 1) {
      if (segmentsCross(points[i - 1], points[i], points[j - 1], points[j])) {
        out.push(
          `${points[i - 1].name}→${points[i].name} × ${points[j - 1].name}→${points[j].name}`,
        );
      }
    }
  }
  return out;
}

/**
 * 求最短访问顺序：head/tail 是固定锚点（不重排），movable 是可重排的点。
 * ≤9 个可重排点走穷举（保证最优）；再多走最近邻起步 + 2-opt（消交叉够用——
 * 平面上 2-opt 收敛后不存在交叉边，这正是本工具要治的病）。
 */
export function optimizeOrder(
  head: readonly RoutePoint[],
  movable: readonly RoutePoint[],
  tail: readonly RoutePoint[],
): { order: RoutePoint[]; km: number } {
  if (movable.length <= 1) {
    return { order: [...movable], km: pathKm([...head, ...movable, ...tail]) };
  }
  const all = [...head, ...movable, ...tail];
  const n = all.length;
  const dist: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      dist[i][j] = dist[j][i] = haversineKm(all[i], all[j]);
    }
  }
  const h = head.length;
  const m = movable.length;
  const idx = Array.from({ length: m }, (_, i) => h + i);
  const seqLen = (seq: readonly number[]): number => {
    let total = 0;
    let prev = h > 0 ? h - 1 : -1;
    for (const k of seq) {
      if (prev >= 0) total += dist[prev][k];
      prev = k;
    }
    for (let t = h + m; t < n; t += 1) {
      total += dist[prev][t];
      prev = t;
    }
    return total;
  };

  let best = [...idx];
  let bestKm = seqLen(best);

  if (m <= EXACT_MAX_POINTS) {
    // Heap's algorithm：原地生成全排列，不 new 数组。
    const arr = [...idx];
    const c = new Array<number>(m).fill(0);
    let i = 0;
    while (i < m) {
      if (c[i] < i) {
        const swap = i % 2 === 0 ? 0 : c[i];
        [arr[swap], arr[i]] = [arr[i], arr[swap]];
        const len = seqLen(arr);
        if (len < bestKm) {
          bestKm = len;
          best = [...arr];
        }
        c[i] += 1;
        i = 0;
      } else {
        c[i] = 0;
        i += 1;
      }
    }
  } else {
    // 最近邻起步：有 head 锚点从它出发，没有从第一个点出发。
    const remaining = new Set(idx);
    const nn: number[] = [];
    let cur = h > 0 ? h - 1 : idx[0];
    if (h === 0) {
      nn.push(idx[0]);
      remaining.delete(idx[0]);
      cur = idx[0];
    }
    while (remaining.size > 0) {
      let nearest = -1;
      let nearestD = Infinity;
      for (const k of remaining) {
        if (dist[cur][k] < nearestD) {
          nearestD = dist[cur][k];
          nearest = k;
        }
      }
      nn.push(nearest);
      remaining.delete(nearest);
      cur = nearest;
    }
    best = nn;
    bestKm = seqLen(best);
    // 2-opt：反转一段能变短就反转，收敛为止。
    let improved = true;
    while (improved) {
      improved = false;
      for (let a = 0; a < best.length - 1; a += 1) {
        for (let b = a + 1; b < best.length; b += 1) {
          const candidate = [
            ...best.slice(0, a),
            ...best.slice(a, b + 1).reverse(),
            ...best.slice(b + 1),
          ];
          const len = seqLen(candidate);
          if (len < bestKm - 1e-9) {
            best = candidate;
            bestKm = len;
            improved = true;
          }
        }
      }
    }
  }

  return { order: best.map((k) => all[k]), km: bestKm };
}

/** 单天体检的纯函数——工具的算路主体，测试直接打它（不用碰地理编码）。 */
export function auditDay(
  head: readonly RoutePoint[],
  points: readonly RoutePoint[],
  tail: readonly RoutePoint[],
): Omit<RouteAuditDayResult, "day" | "unresolved"> {
  const given = [...head, ...points, ...tail];
  const round = (v: number): number => Math.round(v * 100) / 100;
  const legs: RouteLeg[] = [];
  let cum = 0;
  for (let i = 1; i < given.length; i += 1) {
    const km = haversineKm(given[i - 1], given[i]);
    cum += km;
    legs.push({ from: given[i - 1].name, to: given[i].name, km: round(km), cumKm: round(cum) });
  }
  const givenKm = pathKm(given);
  const crossings = findCrossings(given);
  const best = optimizeOrder(head, points, tail);
  const savedKm = givenKm - best.km;
  const savedPct = givenKm > 0 ? (savedKm / givenKm) * 100 : 0;
  const worthSuggesting = savedKm >= SUGGEST_MIN_SAVED_KM && savedPct >= SUGGEST_MIN_SAVED_PCT;
  return {
    given: { order: given.map((p) => p.name), km: round(givenKm), legs },
    crossings,
    ...(worthSuggesting
      ? {
          suggested: {
            order: [...head, ...best.order, ...tail].map((p) => p.name),
            km: round(best.km),
            savedKm: round(savedKm),
            savedPct: Math.round(savedPct),
          },
        }
      : {}),
    alreadyOptimal: !worthSuggesting,
  };
}

/* ────────────────────────── 全局层：跨天体检 ──────────────────────────
 *
 * 逐天体检只能治"当天顺序不顺"，治不了两类全局病（真实病例各一）：
 *  1. **点放错天**：sess-47998d69 的南越王宫（老城）被排进珠江新城日，
 *     逐天怎么排都要横穿全城——把它换去老城日一步省 11.7km（全程 23%）。
 *  2. **天序不顺**：sess-a33e0a21 的四天按 中→东南→西→东北 跳着走，
 *     每天各自最优、总里程也没浪费（单酒店辐射式），但整程画在地图上是麻花。
 *
 * 对应两个建议，各守各的约束：
 *  - 重分组 = **只交换，保持每天点数**。纯里程爬山会把一天塞成 5 个点、
 *    另一天剩 1 个（实测省 11% 全靠拆节奏换来）——节奏（带娃 ≤3 点/天）
 *    是模型定的语义，算法不许动它。
 *  - 天序 = 按每日片区质心串链。各天从各自酒店出发时它**不改变驾驶里程**，
 *    改的是"整体推进方向"的顺路感；酒店逐天不同时才影响真实里程。
 */

export interface JourneyDayInput {
  day?: number;
  head: RoutePoint[];
  tail: RoutePoint[];
  points: RoutePoint[];
}

export interface JourneyRegroupSuggestion {
  /** 重分组后各天的成员与天内最短顺序。 */
  days: Array<{ day?: number; order: string[]; km: number }>;
  /** 人话动作序列，如 "交换 南越王宫御苑(D2) ↔ 荔枝湾游船(D1)"。 */
  moves: string[];
  totalKm: number;
  savedKm: number;
  savedPct: number;
}

export interface JourneyDayOrderSuggestion {
  /** 建议的游玩天序（day 编号序列）。 */
  order: number[];
  chainKmBefore: number;
  chainKmAfter: number;
  savedPct: number;
  /** 口径声明：顺路感 vs 真里程。 */
  note: string;
}

export interface JourneyAudit {
  totalGivenKm: number;
  /** 跨天换点建议（省 ≥8% 且 ≥1km 才给）。 */
  regroup?: JourneyRegroupSuggestion;
  /** 天序建议（片区推进链缩短 ≥20% 才给）。 */
  dayOrder?: JourneyDayOrderSuggestion;
}

const REGROUP_MIN_SAVED_KM = 1;
const REGROUP_MIN_SAVED_PCT = 8;
const DAY_ORDER_MIN_SAVED_PCT = 20;
/** 爬山上限：每步至少省 0.05km、总量有界，理论收敛；这只是防御性护栏。 */
const REGROUP_MAX_STEPS = 300;

function centroidOf(points: readonly RoutePoint[]): RoutePoint {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  return { name: "质心", lat, lon };
}

export function auditJourney(days: readonly JourneyDayInput[]): JourneyAudit | undefined {
  const usable = days.filter((d) => d.points.length > 0);
  if (usable.length < 2) return undefined;

  // 天成本记忆化：爬山会反复评估同一批成员组合，key = 天下标 + 成员名集合。
  const memo = new Map<string, { km: number; order: RoutePoint[] }>();
  const dayCost = (idx: number, pts: readonly RoutePoint[]): { km: number; order: RoutePoint[] } => {
    const key = `${idx}:${pts.map((p) => p.name).sort().join("|")}`;
    let hit = memo.get(key);
    if (!hit) {
      const best = optimizeOrder(usable[idx].head, pts, usable[idx].tail);
      hit = { km: best.km, order: best.order };
      memo.set(key, hit);
    }
    return hit;
  };

  const groups: RoutePoint[][] = usable.map((d) => [...d.points]);
  const baseTotal = groups.reduce((t, g, i) => t + dayCost(i, g).km, 0);

  // ── 重分组：只交换（first-improvement，接受后重开扫描——陈旧基线会震荡，实测踩过）
  const moves: string[] = [];
  const dayNo = (i: number): string => `D${usable[i].day ?? i + 1}`;
  const tryOnce = (): boolean => {
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const before = dayCost(i, groups[i]).km + dayCost(j, groups[j]).km;
        for (let a = 0; a < groups[i].length; a += 1) {
          for (let b = 0; b < groups[j].length; b += 1) {
            const gi = [...groups[i]];
            const gj = [...groups[j]];
            [gi[a], gj[b]] = [gj[b], gi[a]];
            const after = dayCost(i, gi).km + dayCost(j, gj).km;
            if (after < before - 0.05) {
              moves.push(`交换 ${groups[i][a].name}(${dayNo(i)}) ↔ ${groups[j][b].name}(${dayNo(j)})`);
              groups[i] = gi;
              groups[j] = gj;
              return true;
            }
          }
        }
      }
    }
    return false;
  };
  for (let step = 0; step < REGROUP_MAX_STEPS && tryOnce(); step += 1) {
    /* first-improvement 重启扫描 */
  }
  const regroupTotal = groups.reduce((t, g, i) => t + dayCost(i, g).km, 0);
  const regroupSaved = baseTotal - regroupTotal;
  const regroupPct = baseTotal > 0 ? (regroupSaved / baseTotal) * 100 : 0;

  const round = (v: number): number => Math.round(v * 100) / 100;
  let regroup: JourneyRegroupSuggestion | undefined;
  if (regroupSaved >= REGROUP_MIN_SAVED_KM && regroupPct >= REGROUP_MIN_SAVED_PCT) {
    regroup = {
      days: groups.map((g, i) => {
        const best = dayCost(i, g);
        return {
          ...(usable[i].day !== undefined ? { day: usable[i].day } : {}),
          order: [...usable[i].head, ...best.order, ...usable[i].tail].map((p) => p.name),
          km: round(best.km),
        };
      }),
      moves,
      totalKm: round(regroupTotal),
      savedKm: round(regroupSaved),
      savedPct: Math.round(regroupPct),
    };
  }

  // ── 天序：片区质心串链。按**原始分组**算（天序建议与换点建议独立成立，
  // 各自采纳；把两者串成一个建议会让模型只能全收或全拒）。
  let dayOrder: JourneyDayOrderSuggestion | undefined;
  if (usable.length >= 3) {
    const centroids = usable.map((d) => centroidOf(d.points));
    const chainLen = (order: readonly number[]): number => {
      let t = 0;
      for (let k = 1; k < order.length; k += 1) t += haversineKm(centroids[order[k - 1]], centroids[order[k]]);
      return t;
    };
    const identity = centroids.map((_, i) => i);
    const before = chainLen(identity);
    // 天数 ≤ 8 穷举（7! 毫秒级）；行程规划不会有更多天，防御性截断即可。
    let bestOrder = identity;
    let bestLen = before;
    if (usable.length <= 8) {
      const permute = (rest: number[], acc: number[]): void => {
        if (!rest.length) {
          const len = chainLen(acc);
          if (len < bestLen - 1e-9) {
            bestLen = len;
            bestOrder = [...acc];
          }
          return;
        }
        for (let k = 0; k < rest.length; k += 1) {
          permute([...rest.slice(0, k), ...rest.slice(k + 1)], [...acc, rest[k]]);
        }
      };
      permute(identity, []);
    }
    const savedPct = before > 0 ? ((before - bestLen) / before) * 100 : 0;
    if (savedPct >= DAY_ORDER_MIN_SAVED_PCT) {
      dayOrder = {
        order: bestOrder.map((i) => usable[i].day ?? i + 1),
        chainKmBefore: round(before),
        chainKmAfter: round(bestLen),
        savedPct: Math.round(savedPct),
        note:
          "按每日片区质心的推进顺序算——各天仍从各自酒店出发时不改变总驾驶里程，" +
          "改的是整程的顺路感；酒店逐天不同或有到达/离开锚点时才影响真实里程。",
      };
    }
  }

  if (!regroup && !dayOrder) return undefined;
  return { totalGivenKm: round(baseTotal), ...(regroup ? { regroup } : {}), ...(dayOrder ? { dayOrder } : {}) };
}

/** 地理编码后端：可注入（单测不打高德）。返回 undefined = 编不到，不猜。 */
export interface RouteGeocodeBackend {
  locate(name: string, city?: string, signal?: AbortSignal): Promise<RoutePoint | undefined>;
}

/**
 * 审计落库（管理后台的前后对比数据源）。与 `setTripPlanStore` 同形态：
 * `enterprise/backend/shared/tools` 不连数据库，仓储由 agent-runtime 装配层注入。
 */
export interface RouteAuditStore {
  record(
    ctx: { sessionId: string; turnId?: string; agent?: string },
    payload: RouteAuditRecordPayload,
  ): Promise<void>;
}

/** 落库的一条：带坐标——后台要拿它画点连线，只有名字画不了图。 */
export interface RouteAuditRecordPayload {
  city?: string;
  days: Array<{
    day?: number;
    /** 传入顺序的点（锚点在前后，已含坐标）。 */
    points: RoutePoint[];
    givenKm: number;
    suggestedOrder?: string[];
    suggestedKm?: number;
    crossings: string[];
    unresolved: string[];
  }>;
  /** 全局层建议（有才落）——后台的"跨天调整"横幅吃它。 */
  journey?: JourneyAudit;
}

let auditStore: RouteAuditStore | undefined;

/** 装配层注入；传 undefined 即卸载（单测清场用）。 */
export function setRouteAuditStore(s: RouteAuditStore | undefined): void {
  auditStore = s;
}

function createAmapGeocodeBackend(): RouteGeocodeBackend {
  return {
    async locate(name, city, signal) {
      const amap = getAmapClient();
      if (!amap) return undefined; // 高德未接入：全部进 unresolved，症状可见，不抛死整次体检
      const hits = await amap.textSearch(
        // 多关键词分隔符清洗与 cityLimit 纠偏都在 amap 客户端层（M13-12），这里不再抄一份。
        { keywords: name.replace(/[|｜]/g, " ").trim(), region: city ?? "", cityLimit: !!city, limit: 1 },
        signal,
      );
      return hits[0] ? { name, lat: hits[0].lat, lon: hits[0].lon } : undefined;
    },
  };
}

/** 地理编码节流：高德免费 key QPS=3（与 resolveTripPlanCoords 同一实测口径）。 */
const GEOCODE_GAP_MS = 350;

export function createRouteAuditTool(
  backend: RouteGeocodeBackend,
): ExternalTool<RouteAuditArgs, RouteAuditResult> {
  return defineExternalTool<RouteAuditArgs, RouteAuditResult>({
    name: "route_audit",
    provider: "carlife-geo",
    // 只读计算 → §8.4 第三行自动放行，不经权限门。
    sensitive: false,
    // 最坏情况：十来个点全缺坐标，节流编码 ~4s，再留穷举与重试余量。
    timeoutMs: 15_000,
    retries: 0,

    real: async (args, ctx) => {
      if (!args.days.length) {
        throw new ToolError("route_audit", "invalid", "days 不能为空", false);
      }
      const cache = new Map<string, RoutePoint | undefined>();
      let geocoded = 0;
      const resolve = async (p: RouteAuditPoint): Promise<RoutePoint | undefined> => {
        if (p.lat !== undefined && p.lon !== undefined) {
          return { name: p.name, lat: p.lat, lon: p.lon };
        }
        if (!cache.has(p.name)) {
          if (geocoded > 0) await new Promise((r) => setTimeout(r, GEOCODE_GAP_MS));
          geocoded += 1;
          try {
            cache.set(p.name, await backend.locate(p.name, args.city, ctx.signal));
          } catch {
            cache.set(p.name, undefined); // 编不到就是编不到——进 unresolved，不猜
          }
        }
        return cache.get(p.name);
      };

      const round = (v: number): number => Math.round(v * 100) / 100;
      const days: RouteAuditDayResult[] = [];
      const recordDays: RouteAuditRecordPayload["days"] = [];
      // 全局层输入：**单点天也要进**——"点放错天"的病例里被换走的常常正是
      // 那个孤零零的点（实测：长隆单独一天，被换进了顺路的日子）。
      const journeyDays: JourneyDayInput[] = [];
      let totalGiven = 0;
      let totalBest = 0;
      for (const d of args.days) {
        const unresolved: string[] = [];
        const keep = async (p: RouteAuditPoint | undefined): Promise<RoutePoint | undefined> => {
          if (!p) return undefined;
          const hit = await resolve(p);
          if (!hit) unresolved.push(p.name);
          return hit;
        };
        const head = await keep(d.start);
        const tail = await keep(d.end);
        const points: RoutePoint[] = [];
        for (const p of d.points) {
          const hit = await keep(p);
          if (hit) points.push(hit);
        }
        const headArr = head ? [head] : [];
        const tailArr = tail ? [tail] : [];
        journeyDays.push({
          ...(d.day !== undefined ? { day: d.day } : {}),
          head: headArr,
          tail: tailArr,
          points,
        });
        if (points.length < 2) {
          // 点太少当天没有"顺序"可言；如实报，不硬造建议（跨天层照样考虑它）。
          days.push({
            ...(d.day !== undefined ? { day: d.day } : {}),
            given: { order: points.map((p) => p.name), km: 0, legs: [] },
            crossings: [],
            alreadyOptimal: true,
            unresolved,
          });
          // 审计记录也要有这一天——后台整程视图缺了单点天（如长隆全天）会画出残图。
          if (points.length > 0 || headArr.length > 0 || tailArr.length > 0) {
            recordDays.push({
              ...(d.day !== undefined ? { day: d.day } : {}),
              points: [...headArr, ...points, ...tailArr],
              givenKm: 0,
              crossings: [],
              unresolved,
            });
          }
          continue;
        }
        const audited = auditDay(headArr, points, tailArr);
        totalGiven += audited.given.km;
        totalBest += audited.suggested?.km ?? audited.given.km;
        days.push({ ...(d.day !== undefined ? { day: d.day } : {}), ...audited, unresolved });
        recordDays.push({
          ...(d.day !== undefined ? { day: d.day } : {}),
          points: [...headArr, ...points, ...tailArr],
          givenKm: audited.given.km,
          ...(audited.suggested
            ? { suggestedOrder: audited.suggested.order, suggestedKm: audited.suggested.km }
            : {}),
          crossings: audited.crossings,
          unresolved,
        });
      }

      const journey = auditJourney(journeyDays);

      if (auditStore && recordDays.length > 0) {
        try {
          await auditStore.record(
            { sessionId: ctx.sessionId, turnId: ctx.turnId, agent: ctx.agent },
            {
              ...(args.city ? { city: args.city } : {}),
              days: recordDays,
              ...(journey ? { journey } : {}),
            },
          );
        } catch {
          /* 旁路观测挂了不打断主业（文件头有立场）；后台会看到该会话缺审计记录 */
        }
      }

      return {
        days,
        ...(journey ? { journey } : {}),
        totalGivenKm: round(totalGiven),
        totalSuggestedKm: round(totalBest),
        totalSavedKm: round(totalGiven - totalBest),
        notice: ROUTE_AUDIT_NOTICE,
      };
    },

    mock: (args) => ({
      days: args.days.map((d) => ({
        ...(d.day !== undefined ? { day: d.day } : {}),
        given: {
          order: d.points.map((p) => p.name),
          km: 12.3,
          legs: [],
        },
        crossings: [],
        alreadyOptimal: true,
        unresolved: [],
      })),
      totalGivenKm: 12.3,
      totalSuggestedKm: 12.3,
      totalSavedKm: 0,
      notice: ROUTE_AUDIT_NOTICE,
    }),
  });
}

export const routeAuditTool = createRouteAuditTool(createAmapGeocodeBackend());
