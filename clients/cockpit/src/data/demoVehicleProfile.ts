/**
 * 「档案页演示」固定快照（devbar / `?profile=demo` 专用，
 * 与 `demoTripPlan`、`demoPermission` 同款取向；施工单 M14-14）。
 *
 * # 存在的唯一理由：把版式放到定稿旁边逐像素比
 *
 * 档案页的真实数据只经 Tauri 命令来，浏览器里拿不到——于是版式走查
 * 只能看到 offline 卡片，跟定稿没法比。这份快照让页面在浏览器里
 * 按 1672×941 渲染出完整版式，`scripts/assets/ui-diff.mjs` 才有东西可对。
 *
 * # 数值刻意照抄定稿
 *
 * `理想 L7 / 18,620km / 1,380km / 日均 46km / 32 条行程` 全部取自
 * `内部文档`。**这不是"编数据"**，
 * 恰恰相反：只有让内容与定稿逐字相同，diff 出来的差异才全是版式差异，
 * 而不是"文案长度不一样导致换行位置不同"。
 *
 * # 它进不了真实链路
 *
 * 只有 `?profile=demo` 才会被读到（同 `?vehicles=empty` / `?hitl=demo` 先例）。
 * Tauri 窗口不带 query，真实档案永远走 `fetch_vehicles`。
 */

import type {
  ChangeListState,
  MemberListState,
  PreferenceState,
  UsageState,
  VehicleView,
} from "../features/ownership/types";

export const DEMO_VEHICLE: VehicleView = {
  vin: "LSVAA49P4E2008921",
  /*
   * 定稿画的是「理想 L7」，这里用 **Model Y**：素材只覆盖知识库真实收录的
   * 4 款车，理想 L7 没有形象，渲染出来是个"理"字占位块——那样比出来的
   * 差异全在那一格，反而盖住了真正要看的版式问题。
   * 其余数值仍逐字照抄定稿。
   */
  model: "Model Y",
  modelYear: 2025,
  purchasedAt: Date.UTC(2025, 2, 1),
  odometerKm: 18_620,
  energyType: "phev",
  maintenance: [
    {
      at: Date.UTC(2026, 4, 14),
      odometerKm: 17_240,
      items: "常规保养",
      source: "门店",
    },
  ],
  /*
   * 维修样例一条带处置+问诊、一条都不带（M29-02）：详情页"未记录处置"的
   * 版式走查需要两种形态同屏。
   */
  repairs: [
    {
      at: Date.UTC(2026, 6, 2),
      odometerKm: 18_100,
      symptom: "行驶中底盘异响",
      resolution: "更换右前下摆臂衬套",
      source: "门店",
      sessionId: "demo-session-1",
    },
    {
      at: Date.UTC(2026, 7, 20),
      odometerKm: 18_560,
      symptom: "充电口盖偶发无法弹开",
      source: "车主自述",
    },
  ],
  forecast: {
    remainingKm: 1_380,
    basis: ["厂商手册 · Model Y 2025 款", "上次保养 2026-05-14 · 17,240km"],
    degraded: false,
  },
  knowledge: {
    state: "live",
    links: [
      { dataset: "vehicle-manuals", datasetName: "车辆说明书", documents: ["a.md"] },
      { dataset: "repair-kb", datasetName: "维修与保养手册", documents: ["b.md"] },
    ],
  },
};

export const DEMO_USAGE: UsageState = {
  kind: "ready",
  profile: {
    fetched: 32,
    verdict: { usable: true },
    summary: {
      windowDays: 30,
      avgDailyKm: 46,
      commonChargeHours: [19, 20, 21],
      dominantRoadType: "city",
      sampleSize: 32,
      staleDays: 1.1,
      derivation: [
        "（演示）日均里程 = 窗口内总里程 1380.0km ÷ 30 天",
        "（演示）样本量 = 窗口内 32 条行程",
      ],
    },
  },
};

/** 人员页的版式走查同样需要名单——名字与标签照抄定稿。 */
export const DEMO_MEMBERS: MemberListState = {
  kind: "ready",
  members: [
    {
      id: "demo-mom",
      vin: DEMO_VEHICLE.vin,
      displayName: "妈妈",
      relation: "母亲",
      roles: ["passenger"],
      ageBand: "senior",
      needs: ["restroom", "fatigue"],
    },
    {
      id: "demo-adong",
      vin: DEMO_VEHICLE.vin,
      displayName: "阿东",
      relation: "本人",
      roles: ["driver"],
      ageBand: "adult",
      needs: [],
    },
  ],
};

/** 变更记录页的版式走查（M29-05）：覆盖三种角色措辞与 denied 形态。 */
export const DEMO_CHANGES: ChangeListState = {
  kind: "ready",
  changes: [
    {
      id: "demo-chg-1",
      at: "2026-08-25T10:12:00.000Z",
      actorRole: "owner",
      action: "vehicle.maintenance.append",
      summary: "记了一笔保养",
    },
    {
      id: "demo-chg-2",
      at: "2026-08-20T18:03:00.000Z",
      actorRole: "system",
      action: "vehicle.elicitation.fill",
      summary: "对话里确认后写入档案（里程、保养记录）",
    },
    {
      id: "demo-chg-3",
      at: "2026-08-18T09:40:00.000Z",
      actorRole: "owner",
      action: "vehicle.odometer",
      summary: "上报的里程低于当前值，未生效（18,620 → 300 km）",
    },
    {
      id: "demo-chg-4",
      at: "2026-03-02T08:00:00.000Z",
      actorRole: "owner",
      action: "vehicle.upsert",
      summary: "建立了车辆档案",
    },
  ],
  nextCursor: null,
};

export const DEMO_PREFERENCES: PreferenceState = {
  kind: "ready",
  preferences: [
    { id: "p1", content: "偏好周末短途自驾" },
    { id: "p2", content: "带儿童出行优先选有儿童座椅" },
  ],
};

/** `?profile=demo`：浏览器里按定稿内容渲染完整版式。Tauri 窗口不受影响。 */
export function isProfileDemo(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("profile") === "demo";
}

/** `?page=people`：截图脚本直接落到人员页（两页都要与定稿比）。 */
export function isPeopleDemo(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("page") === "people";
}

/**
 * `?theme=dark`：给截图脚本用的初始主题。
 * 深色定稿也要比，而主题原本只能从 devbar 点——截图脚本点不了。
 */
export function demoTheme(): "light" | "dark" | undefined {
  if (typeof window === "undefined") return undefined;
  const t = new URLSearchParams(window.location.search).get("theme");
  return t === "dark" || t === "light" ? t : undefined;
}
