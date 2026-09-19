/**
 * 行程「天与天抱团 / 交叉」的量法（2026-09-15 定稿设计 §1 与 §6 的测量工具）。
 *
 * # 它回答什么
 *
 * 「这一份多天行程，每天的点是不是真的聚在一片、天与天之间分不分得开」。
 * 这件事在单测里验不了——单测只能验"days 长度等于车主要的天数""每个点都有时段"，
 * 而"第 2 天的点其实离第 1 天的片区更近"这种事，形状完全合法，全程零报错。
 *
 * 判据只需要坐标，不需要真跑：**每个点离自己那天的质心近，还是离别的天的质心更近**。
 * 离别的天更近的点占比（下称误归率）就是"抱团 + 交叉"的直接度量。
 * 2026-09-15 用它打出的分布（09-03/04 基线 6~7%，09-12 起 13~20%）是本轮排查的第一手证据。
 *
 * # 数据从哪来
 *
 * pi 的会话记录 `enterprise/backend/pi-agents/.pi/agent/sessions/<cwd-slug>/*.jsonl`：
 * 每个 tour 会话里既有 `spot_search` 的返回（带 lat/lon），也有最终那次 `submit_tour_days`
 * 的参数（哪天排了哪些点）。两者按景点名对上就能算。`route_audit` 的入参里也带坐标，
 * 一并收进登记簿——模型自己查到的点不一定每个都在 search 返回里（它会跨轮复用）。
 *
 * **不读数据库、不发任何请求**：纯离线，跑多少遍都不花钱，历史会话随时可复量。
 *
 * # 怎么用
 *
 *   corepack pnpm probe:tour-clustering                 # 全部日期，按天汇总
 *   corepack pnpm probe:tour-clustering --since 2026-09-12
 *   corepack pnpm probe:tour-clustering --detail        # 逐会话列出，定位最差的那几个
 *
 * 改 Plan 层前后各跑一次，看误归率这一列。判据（设计 §6）：
 * **误归率回到 10% 以下、且天内平均半径不上升**。半径必须一起看——把所有点塞进一天
 * 误归率天然是 0，那不是"分好了"，是"没分"。
 *
 * # 判据只有一份（M86-01）
 *
 * 计分本体在 `evals/trip-clustering/score.ts`，评测 `eval:trip-clustering` 与本探针共用它。
 * 本探针只保留"从 pi 会话 jsonl 里把坐标与最后一次提交抠出来"这一段——Plan 层落地后
 * 搜索搬到编排层，新会话里不再有返回坐标，这条数据源只对历史会话有效；要量新链路用评测。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { scoreDayGroups, type Coord, type DayGroup } from "../../../evals/trip-clustering/score.js";

/** pi 会话目录：cwd 被 pi 转成 slug 当目录名，这里按前缀找，不写死那一长串。 */
const SESSIONS_ROOT = "enterprise/backend/pi-agents/.pi/agent/sessions";

interface SessionScore {
  file: string;
  date: string;
  /** 有坐标、参与计算的点数。 */
  points: number;
  /** 离别的天质心更近的点数。 */
  misassigned: number;
  /** 点到自己那天质心的平均距离（km）——"每天是不是紧凑"。 */
  radiusKm: number;
  /** 天质心两两平均距离（km）——"天与天分不分得开"。 */
  separationKm: number;
}

function sessionsDir(): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(SESSIONS_ROOT);
  } catch {
    return undefined;
  }
  // 目录名是 cwd 的 slug，一个仓库只有一个；有多个时取条目最多的那个。
  const dirs = entries.filter((e) => e.startsWith("--"));
  if (dirs.length === 0) return undefined;
  return join(
    SESSIONS_ROOT,
    dirs
      .map((d) => ({ d, n: readdirSync(join(SESSIONS_ROOT, d)).length }))
      .sort((a, b) => b.n - a.n)[0]!.d,
  );
}

/**
 * 一个会话文件 → 一份评分。不是 tour 会话、没有最终提交、或坐标凑不够两天的返回 undefined。
 *
 * 坐标登记簿**只收工具返回与 route_audit 入参里的真坐标**：模型正文里写的坐标一律不取
 * （ADR-008：行程点坐标不接受模型给的值）。
 */
function scoreSession(path: string, file: string): SessionScore | undefined {
  const raw = readFileSync(path, "utf8");
  if (!raw.includes("submit_tour_days")) return undefined;

  const coords = new Map<string, Coord>();
  let lastSubmit: { days?: Array<{ day?: number; spots?: Array<{ name?: string }> }> } | undefined;

  for (const line of raw.trim().split("\n")) {
    let entry: { message?: Record<string, unknown> };
    try {
      entry = JSON.parse(line) as { message?: Record<string, unknown> };
    } catch {
      continue;
    }
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "assistant") {
      for (const part of (msg.content as Array<Record<string, unknown>>) ?? []) {
        if (part.type !== "toolCall") continue;
        const args = (part.arguments ?? {}) as Record<string, unknown>;
        if (part.name === "route_audit") {
          for (const d of (args.days as Array<{ points?: Array<Record<string, unknown>> }>) ?? []) {
            for (const p of d.points ?? []) {
              if (typeof p.name === "string" && typeof p.lat === "number" && typeof p.lon === "number") {
                if (!coords.has(p.name)) coords.set(p.name, { lat: p.lat, lon: p.lon });
              }
            }
          }
        }
        // 最后一次提交才算数：修复轮会重交，中间那几份是过程不是结论。
        if (part.name === "submit_tour_days") lastSubmit = args as typeof lastSubmit;
      }
    }

    if (msg.role === "toolResult" && typeof msg.toolName === "string" && /search/.test(msg.toolName)) {
      const text = ((msg.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? "").join("");
      try {
        const parsed = JSON.parse(text) as { data?: unknown };
        const data = (parsed.data ?? parsed) as { candidates?: Array<Record<string, unknown>> };
        for (const c of data.candidates ?? []) {
          if (typeof c.name === "string" && typeof c.lat === "number" && typeof c.lon === "number") {
            coords.set(c.name, { lat: c.lat, lon: c.lon });
          }
        }
      } catch {
        /* 工具返回不是 JSON（出错文本）就跳过——它本来也没有坐标 */
      }
    }
  }

  if (!lastSubmit) return undefined;

  const groups: DayGroup[] = [];
  for (const d of lastSubmit.days ?? []) {
    const points = (d.spots ?? [])
      .map((s) => (typeof s.name === "string" ? coords.get(s.name) : undefined))
      .filter((c): c is Coord => c !== undefined);
    if (points.length > 0) groups.push({ day: d.day ?? groups.length + 1, points });
  }
  // 少于两天没有"天与天"可言；坐标覆盖不足时宁可不报，也不拿半份数据下结论。
  // 计分本体在 evals/trip-clustering/score.ts（含 0.05 km 的同景区容差），这里只喂分组。
  const score = scoreDayGroups(groups);
  if (!score) return undefined;

  return {
    file: file.slice(0, 19),
    date: file.slice(0, 10),
    points: score.points,
    misassigned: score.misassigned,
    radiusKm: score.radiusKm,
    separationKm: score.separationKm,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const detail = argv.includes("--detail");
  const sinceIdx = argv.indexOf("--since");
  const since = sinceIdx >= 0 ? argv[sinceIdx + 1] : undefined;

  const dir = sessionsDir();
  if (!dir) {
    console.error(`找不到 pi 会话目录（${SESSIONS_ROOT}/--*）。先跑几轮行程规划再来量。`);
    process.exitCode = 1;
    return;
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .filter((f) => (since ? f.slice(0, 10) >= since : true))
    .sort();

  const scores: SessionScore[] = [];
  for (const f of files) {
    const s = scoreSession(join(dir, f), f);
    if (s) scores.push(s);
  }

  if (scores.length === 0) {
    console.log("没有可计算的 tour 会话（需要 submit_tour_days + 至少两天有坐标的点）。");
    return;
  }

  const byDate = new Map<string, SessionScore[]>();
  for (const s of scores) {
    const list = byDate.get(s.date) ?? [];
    list.push(s);
    byDate.set(s.date, list);
  }

  console.log("日期        会话  点数  误归率        天内半径   天间距");
  for (const [date, rows] of [...byDate.entries()].sort()) {
    const points = rows.reduce((s, r) => s + r.points, 0);
    const mis = rows.reduce((s, r) => s + r.misassigned, 0);
    const radius = rows.reduce((s, r) => s + r.radiusKm, 0) / rows.length;
    const sep = rows.reduce((s, r) => s + r.separationKm, 0) / rows.length;
    const pct = ((100 * mis) / points).toFixed(0);
    console.log(
      `${date}  ${String(rows.length).padStart(4)}  ${String(points).padStart(4)}  ` +
        `${String(mis).padStart(3)} (${pct.padStart(2)}%)  ${radius.toFixed(2).padStart(7)} km  ${sep.toFixed(2).padStart(6)} km`,
    );
  }

  const points = scores.reduce((s, r) => s + r.points, 0);
  const mis = scores.reduce((s, r) => s + r.misassigned, 0);
  console.log(`\n合计：${scores.length} 个会话、${points} 个点，误归 ${mis}（${((100 * mis) / points).toFixed(1)}%）`);
  console.log("判据：误归率 < 10% 且天内半径不上升。两个一起看——全塞进一天时误归率天然是 0。");

  if (detail) {
    console.log("\n最差的会话：");
    for (const r of scores.filter((x) => x.misassigned > 0).sort((a, b) => b.misassigned - a.misassigned).slice(0, 15)) {
      console.log(
        `  ${r.file}  误归 ${r.misassigned}/${r.points}  半径 ${r.radiusKm.toFixed(2)} km  天间距 ${r.separationKm.toFixed(2)} km`,
      );
    }
  }
}

main();
