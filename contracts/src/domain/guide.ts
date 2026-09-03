/**
 * 景区导览契约（施工单 M36-02）。
 *
 * 端云单一真相源：runtime 的采集产物（`agent-runtime/src/graph/subgraphs/guide.ts`）、
 * 网关 `POST /v1/guide/brief` 的回包、车机/手机导览页（M36-03/04）都吃这一份形状。
 * 字段语义与 M36-01 的 runtime 内部形态**逐字一致**——那边已迁移为 import 本文件。
 *
 * # 时间轴是确定性投影，不是模型产物
 *
 * `guideBriefToTimeline` 与 `tripPlanToHud` 同一分法：从结构化简报机械生成页面
 * 时间轴（停车 → 必玩点按路线序 → 餐饮/休息/厕所 → 离场补能），网关不掺一半、
 * 模型不参与——投影规则可单测，改起来不用赌模型。
 */

// ── 简报本体 ─────────────────────────────────────────────────

export type GuideBranch = "access" | "spots" | "comfort";

/** 分支结论走的哪条通道：提交通道 / 正文回落 / 两者皆无（该栏目缺席）。 */
export type GuideBranchSource = "submission" | "text" | "missing";

export interface GuideSource {
  url: string;
  title?: string;
}

export interface GuideSpotItem {
  name: string;
  location?: string;
  reason?: string;
  /** 只有通过全等校验的出处才有值；没有它就不得声称"据小红书"。 */
  source?: GuideSource;
  /** 由校验后出处的域名归类（小红书/抖音/…），无出处则无平台。 */
  platform?: string;
  /** 来源时间（页面所述）；抽不到就没有，**不编日期**。 */
  sourceDate?: string;
  lat?: number;
  lon?: number;
  mustSee?: string;
  kind?: "spot" | "photo";
}

export interface GuideParkingItem {
  name: string;
  address?: string;
  /** 到景区入口的距离（米，估算口径——展示层必须带"估算"字样）。 */
  distanceToGateMeters?: number;
  toGate?: string;
  note?: string;
  source?: GuideSource;
  lat?: number;
  lon?: number;
}

export interface GuideEnergyItem {
  name: string;
  address?: string;
  note?: string;
  lat?: number;
  lon?: number;
}

export interface GuideComfortItem {
  kind: "rest" | "food" | "toilet" | "pitfall";
  name?: string;
  note: string;
  source?: GuideSource;
}

export interface GuideAccessSection {
  parking: GuideParkingItem[];
  charging: GuideEnergyItem[];
  refuel: GuideEnergyItem[];
  arrivalAdvice?: string;
}

export interface GuideBrief {
  spot: string;
  city?: string;
  date?: string;
  selfDrive?: boolean;
  access?: GuideAccessSection;
  /** 已按游玩顺序排好（排序来源见 routeOrderSource）。 */
  spots: GuideSpotItem[];
  /** geo=坐标最近邻+去交叉；editorial=攻略提交顺序（页面必须如实标注）。 */
  routeOrderSource?: "geo" | "editorial";
  transportAdvice?: string;
  routeAdvice?: string;
  comfort: GuideComfortItem[];
  /** 缺了什么、哪些如实降级——矛盾与缺口不隐藏。 */
  caveats: string[];
  findings: string[];
  branchSources: Record<GuideBranch, GuideBranchSource>;
  /** 出处校验读数：对得上的 / 模型声称有出处的。排障用，不上页。 */
  sourcesVerified: { matched: number; claimed: number };
  generatedAt: string;
}

// ── 网关回包 ─────────────────────────────────────────────────

/**
 * `collecting` 是为两段式预留的位：当前网关是同步挂等（冷启实测 ~50s、预算 100s），
 * 端上拿到的只会是 ready / failed；若日后耗时涨破预算改两段式，端上不用二次适配。
 */
export type GuideBriefStatus = "ready" | "collecting" | "failed";

export interface GuideBriefResponse {
  status: GuideBriefStatus;
  brief?: GuideBrief;
  /** 本次是否来自⑤缓存——端上与排障要能区分"刚查的"与"缓存的"。 */
  cached?: boolean;
  computedAt?: string;
}

/**
 * 三支全空的简报（M36-04 走查病例：并发挤爆时三分支全 missing）。
 * 端上拿它当 failed 呈现——一页空栏目没有"没查到，再试一次"诚实，
 * 也没有重试按钮。判据放 shared：两端（车机/手机）一份规则。
 */
export function guideBriefIsEmpty(brief: GuideBrief): boolean {
  return Object.values(brief.branchSources).every((v) => v === "missing");
}

// ── 后台采集任务（ACR-008）────────────────────────────────────

/**
 * 简报是否"完整"——与 runtime 缓存闸门同一判据（三支都到 + 有必玩点）。
 * 队列 worker 用它判任务成败：不完整 = 失败（可重试/可手动「获取」），
 * 静默算完成会把半成品说成"已就绪"。
 */
export function guideBriefIsComplete(brief: GuideBrief): boolean {
  return !Object.values(brief.branchSources).some((v) => v === "missing") && brief.spots.length > 0;
}

/** 逐景点任务的前端五态。unprocessed=没排过队也没缓存；ready=点开即秒开。 */
export type GuideJobState = "unprocessed" | "pending" | "processing" | "ready" | "failed";

export interface GuideJobSpot {
  spotName: string;
  state: GuideJobState;
  /** ready 时：内容此刻在⑤缓存里。 */
  cached?: boolean;
  /** failed 时一句可展示的原因。 */
  note?: string;
}

export interface GuideJobsStatus {
  spots: GuideJobSpot[];
  summary: {
    total: number;
    ready: number;
    processing: number;
    pending: number;
    failed: number;
    unprocessed: number;
  };
}

/** `GET /v1/guide/jobs` 的回包：没有已确认行程（或队列关着）时 jobs 为 null。 */
export interface GuideJobsResponse {
  planId?: string;
  jobs: GuideJobsStatus | null;
}

// ── 时间轴投影 ───────────────────────────────────────────────

export type GuideTimelineKind =
  | "parking"
  | "spot"
  | "photo"
  | "food"
  | "rest"
  | "toilet"
  | "charging"
  | "refuel";

export interface GuideTimelineEntry {
  /** 1 起的顺序号。简报没有钟点数据，时间轴按顺序号呈现，**不编造时刻**。 */
  index: number;
  kind: GuideTimelineKind;
  name: string;
  /** 一句说明（必看内容 / 到达方式 / 注意事项），没有就没有。 */
  note?: string;
}

const spotNote = (s: GuideSpotItem): string | undefined => s.mustSee ?? s.reason;

/**
 * 简报 → 单页时间轴。顺序是确定性规则：
 *  1. 停车场（第一个候选——它是行程的物理起点，自驾语境的第一格）；
 *  2. 必玩点按 `spots` 既有顺序（merge 已排好，这里不再重排）；
 *  3. 餐饮 → 休息 → 厕所（comfort 里带名字/地点感的条目；pitfall 是提醒不是站点，不进轴）;
 *  4. 离场补能：充电/加油各第一个候选。
 * 全空进全空出——空数组由页面决定怎么说，这里不造占位站点。
 */
export function guideBriefToTimeline(brief: GuideBrief): GuideTimelineEntry[] {
  const out: GuideTimelineEntry[] = [];
  const push = (kind: GuideTimelineKind, name: string, note?: string) => {
    out.push({ index: out.length + 1, kind, name, ...(note ? { note } : {}) });
  };

  const p = brief.access?.parking[0];
  if (p) push("parking", p.name, p.toGate ?? p.note);

  for (const s of brief.spots) {
    push(s.kind === "photo" ? "photo" : "spot", s.name, spotNote(s));
  }

  for (const kind of ["food", "rest", "toilet"] as const) {
    for (const c of brief.comfort) {
      if (c.kind !== kind) continue;
      // 没有名字的条目是"泛提示"（如"到处有开水"），进栏目不进轴——轴上的每格都该是个去处。
      if (!c.name) continue;
      push(kind, c.name, c.note);
    }
  }

  const charge = brief.access?.charging[0];
  if (charge) push("charging", charge.name, charge.note);
  const fuel = brief.access?.refuel[0];
  if (fuel) push("refuel", fuel.name, fuel.note);

  return out;
}
