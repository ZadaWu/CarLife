/**
 * 骨架的两种"对外形状"（施工单 M86-02 / M86-04，ACR-037）：
 *  - `skeletonToPlan`：落盘形状。写进 `tasks.trip.draft` 的是 `TripPlanState`（ACR-036 的任务状态
 *    只认这一种行程形状），骨架只是它 `status: "skeleton"` 时的一份早期版本；
 *  - `skeletonBlockFor`：给四条腿的提示词段（M86-04）。
 *
 * 两者都只读骨架、不查任何东西：名字与坐标从 `spot_search` 返回一路带到这里，中间没有人改写。
 */

import type { TripPlanState } from "../state";
import type { Coord, SkeletonDay, TripSkeleton } from "./types";

const fmt = (c: Coord): string => `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;

function dayLabel(d: SkeletonDay, total: number): string {
  if (d.roles.includes("arrival") && d.roles.includes("departure")) return "到达兼离开日，半天";
  if (d.roles.includes("arrival")) return "到达日，半天";
  if (d.roles.includes("departure") && total > 1) return "离开日，半天";
  return "整天";
}

export type SkeletonReader = "tour" | "hotel" | "drive";

/**
 * 给三条腿的骨架段（M86-04）。三段各说各的：tour 要景点与坐标（只补字段）、hotel 要片区与质心
 * （按片区找住宿）、drive 要每天的起终点（legDays 照填）。transit 不读骨架。
 *
 * 名字与坐标逐字来自骨架；`origin` 没给时写「出发地」并注明是模型查 `map_route` 用的那个起点。
 */
export function skeletonBlockFor(branch: SkeletonReader, skeleton: TripSkeleton, origin?: string): string {
  const k = skeleton.days.length;
  const from = origin?.trim() || "出发地";
  if (branch === "tour") {
    const days = skeleton.days.map((d) =>
      [
        `第 ${d.day} 天（${dayLabel(d, k)}）· 片区：${d.area}${d.theme ? ` · 主题：${d.theme}` : ""}`,
        `  景点：${d.spots.map((s) => `${s.name}（${fmt(s)}）`).join("、") || "（这天不安排游玩）"}`,
        // 备选也列出来（M87-03）：修复轮要换点时只能从这里挑；首轮只补字段的 tour 看到也无妨——它被要求原样保留。
        `  同片区备选：${d.alternates.map((s) => s.name).join("、") || "（无）"}`,
      ].join("\n"),
    );
    const rain = skeleton.rainPool.map((s) => s.name).join("、") || "（无）";
    return [
      "【逐天骨架（编排层已定，带坐标）】",
      ...days,
      `雨备池（室内馆，每天的 rainBackup 从这里挑）：${rain}`,
      "规则：**景点与天数原样保留**，不要增删、不要改名；骨架里的景点**不要再查**、**不要调 route_audit**（顺序已经过体检）；" +
        "你只补 estStart / estEnd / rainBackup / lodging；只有雨备池不够用时才 `spot_search` 室内馆。",
    ].join("\n");
  }
  if (branch === "hotel") {
    const days = skeleton.days.map(
      (d) => `第 ${d.day} 天 · 片区：${d.area}（质心 ${fmt(d.centroid)}）· 当天要去：${d.spots.map((s) => s.name).join("、") || "（不安排游玩）"}`,
    );
    return [
      "【逐天片区（编排层已定）】",
      ...days,
      "规则：按上面的片区找住宿——每个片区 2-3 个候选，`hotel_search` 的关键词带片区名或当天要去的点名（不要只搜市名）；" +
        "每条候选的 area **逐字填**该片区名；连住的片区只查一次；最后一天回家不需要住宿。",
    ].join("\n");
  }
  /*
   * 回程**单列一行**（turn-cf09b9ab）。
   *
   * 它原本挂在最后一天那一行的行尾，于是那一行是「片区A → 片区B → 出发地」——三个点、两条腿。
   * drive 照着它拼一次算路时只能把后两个点塞进 `waypoints`，高德按 origin → waypoints → destination
   * 依次跑，回程就被折进了去程：上海→张家港的 116 km 算成 402.7 km / 329 分，全程零报错。
   * 拆开之后每一行恰好是一条路，「一行一次 map_route」才是个能执行的指令。
   *
   * `k === 1` 原先单独一支，产出与下面的循环逐字相同（prev 为空取 from、末天补回程），
   * 留着就是同一件事要在两处同时改对——一并收进循环。
   */
  const legs: string[] = [];
  skeleton.days.forEach((d, i) => {
    const prev = skeleton.days[i - 1];
    const start = prev ? `${prev.area}（${fmt(prev.centroid)}）` : from;
    legs.push(`第 ${d.day} 天：${start} → ${d.area}（${fmt(d.centroid)}）`);
  });
  const last = skeleton.days[k - 1];
  if (last) legs.push(`回程（第 ${k} 天）：${last.area}（${fmt(last.centroid)}）→ ${from}`);
  return [
    "【每天的起终点（编排层已定）】",
    ...legs,
    `规则：\`map_route\` 的起终点用上面的坐标（片区质心），不用景点名；**上面每一行各查一次**——` +
    `一行就是一条路，起终点坐标相同的行不产生行车段、不用查；${origin ? "" : "「出发地」就是你查路线用的那个起点；"}` +
      `legs 里每一段自己写清 day / direction / from / to / minutes：去程与换片区的段 direction 填 outbound、day 填上面对应的那一天，` +
      `回程的段 direction 填 return、day 填最后一天 ${k}、**只放一份**、最后一段 to.kind 填 origin；不要自己重排片区顺序。`,
  ].join("\n");
}

/**
 * 骨架 → `TripPlanState`（`status: "skeleton"`）。
 *
 * `theme` 没有时用片区名顶：`TripPlanDaySnapshot.theme` 是必填串，而 1b 的骨架只有片区；
 * 1c 裁决过的骨架带主题。`caveats` 为空——骨架阶段没有估算值可声明。
 * `indoor` 原样带上：HUD 与 rainBackup 都认它。
 */
export function skeletonToPlan(skeleton: TripSkeleton, turnId: string): TripPlanState {
  return {
    status: "skeleton",
    destination: skeleton.destination,
    days: skeleton.days.length,
    skeleton: skeleton.days.map((d) => ({
      day: d.day,
      theme: d.theme ?? d.area,
      area: d.area,
      spots: d.spots.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon, ...(s.indoor ? { indoor: true } : {}) })),
    })),
    caveats: [],
    updatedTurnId: turnId,
  };
}
