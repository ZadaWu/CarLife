/**
 * 行程详情抽屉的**当天派生**（施工单 M83-03）。纯函数，不碰 DOM、不读时钟。
 *
 * 抽屉是「这一程的目录」：选一天，下面只画那一天。这里把 `TripPlanSnapshot`
 * 折成三样东西——Day 卡的三行指标、沿途服务四格、行程时间轴的行。
 *
 * # 四条口径，都是"没有就别编"
 *
 * 1. **按天的里程与电量没有数据源**。契约里只有 `legs[].driveMinutes`（分钟）与
 *    `energyStops`（整程的名字数组），没有按天公里数、没有按天电量。参考图上的
 *    `36 km` / `21%` 是**整程出发段**的数，屏底状态栏已经有了。所以 Day 卡上不出现它们。
 * 2. **四格（充电站 / 餐饮 / 卫生间 / 停车场）的数据源都是快照里的 `services`**
 *    （沿途服务数据源交接，待执行事项 4；充电站自 M93-04 起并入，M93-05 起「景区」那一格去掉）：
 *    行程确认后由 runtime 在后台按当天停靠点周边查高德、写回快照（`route-services.ts`）。
 *    取数在 `dayServices` 内部经 `serviceOverride()` 完成；快照里没有它、或它是按另一版骨架
 *    算的（`tripServicesForDay` 比对 `skeletonKey`），四格一起退回「待查」。
 *    某一类目查成了才有数字——**0 是"查过了没有"**（粤北山区那种真实结果），不是待查。
 *    每一类还带 `pois` 明细（M93-04），端上据此让格子成为图层开关（M93-05）：
 *    点一下就把这一类画到地图上。有计数没明细的老快照 → 那一格置灰，不做成点了没反应。
 * 3. **没查成就是「待查」，不是 0**。0 的意思是"查过了，没有"，而我们没查——
 *    这与「读不到」不许用 0 顶替是同一条纪律。
 * 4. **补能点（`energyStops`）不在那四格里**，它走 `chargeStopNames()` 在格子下面单独一行：
 *    "这一路要在哪儿充"（求解结果）与"当天周边有多少桩"（查询结果）是两个问题。
 *
 * 时间同理：没有 `estStart/estEnd` 就留空并写「时间待定」，**不按 09:00 + 90 分钟
 * 拍一个**（`NavBar.tsx` 的既有纪律；端上排时是 M34-01 明令禁止的）。
 */

import { tripServicesForDay } from "@carlife/shared";
import type {
  ServicePoi,
  TripPlanDaySnapshot,
  TripPlanLeg,
  TripPlanSnapshot,
  TripStructureEdit,
} from "@carlife/shared";

/** 时间轴的一行。`kind` 决定能不能编辑（M83-04：只有 `spot` 行有控件）。 */
export interface TimelineRow {
  /**
   * `checkin` 是「中午先落脚」那一行（走查第九轮）——与末行的 `hotel` 是同一家店、
   * 不同的事：一个是办入住放行李，一个是玩完回来睡觉。见 `dayTimeline`。
   */
  kind: "origin" | "spot" | "checkin" | "hotel" | "return";
  /** 「09:00 – 11:30」或「17:30」；两端都没有就 undefined（留空，不编）。 */
  time?: string;
  name: string;
  /** 右侧说明：「出发」「建议停留 1.5 小时」「入住」「预计到达」「时间待定」。 */
  note: string;
}

/**
 * 沿途服务的一格。`value` 可能是「待查」——见文件头第 2、3 条。
 *
 * **「景区」那一格 M93-05 去掉了**：它数的是这份行程自己的 `spots` 条数，
 * 与旁边四格「周边查到了什么」根本不是一件事，并排放着本身就是误导
 * （日卡上已经有「N 个景点」，信息不丢）。
 */
export interface ServiceCell {
  key: ServiceCategoryKey;
  label: string;
  value: string;
}

/** 四类沿途服务。顺序即展示顺序，也是图层开关的顺序。 */
export const SERVICE_CATEGORY_KEYS = ["charge", "food", "restroom", "parking"] as const;
export type ServiceCategoryKey = (typeof SERVICE_CATEGORY_KEYS)[number];

/** 端上的类目键 → 快照里 `services.days[].pois` 的键（`charge` 那一格在契约里叫 `charging`）。 */
const POI_FIELD_OF: Record<ServiceCategoryKey, "charging" | "food" | "restroom" | "parking"> = {
  charge: "charging",
  food: "food",
  restroom: "restroom",
  parking: "parking",
};

/** Day 卡的三行指标。后两项 undefined = `legs` 缺省，整行不显示。 */
export interface DayMetrics {
  spots: number;
  driveMinutes?: number;
  chargeStops?: number;
}

export const PENDING = "待查";
const SERVICE_LABELS: Record<ServiceCategoryKey, string> = {
  charge: "充电站",
  food: "餐饮",
  restroom: "卫生间",
  parking: "停车场",
};

function dayOf(plan: TripPlanSnapshot, day: number) {
  return plan.skeleton.find((d) => d.day === day);
}

/** 当天的行车分段。`legs[].day` 缺省的段不算进任何一天——宁可不显示也不猜它属于哪天。 */
function legsOf(plan: TripPlanSnapshot, day: number) {
  return (plan.legs ?? []).filter((l) => l.day === day);
}

/** 「1 小时 40 分」/「55 分钟」。分钟数来自求解层，这里只管排版。 */
export function driveLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} 分钟`;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

/** 「1.5 小时」「40 分钟」：两端时间之差。跨夜（结束早于开始）按 0 处理，不给负数。 */
export function stayLabel(estStart: string, estEnd: string): string | undefined {
  const toMin = (s: string) => {
    const [hh, mm] = s.split(":");
    const h = Number(hh);
    const m = Number(mm);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : undefined;
  };
  const a = toMin(estStart);
  const b = toMin(estEnd);
  if (a === undefined || b === undefined || b <= a) return undefined;
  const d = b - a;
  if (d < 60) return `${d} 分钟`;
  const h = d / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
}

/**
 * Day 卡的三行指标。
 *
 * ⚠️ **`legs` 存在 ≠ 这一天有分段**（2026-09-14 实测真实行程才发现）。
 * `TripPlanLeg.day` 是可选的，而真实数据里它**基本不填**：`legs` 描述的是大交通那一段
 * （上海 → 徐州的高速行车与服务区停靠），段尾站名对不到 `skeleton` 的 spot 就缺省
 * （见 `trip-plan.ts` 对 `legs` 的说明）。
 *
 * 早先按 `l.day === day` 过滤后直接求和，于是真实行程的每一天都算出「行车约 0 分钟」
 * 「无补能停靠」——**看起来像查过了，其实一段都没对上**。演示数据没有 `legs`、走的是
 * 另一条分支，所以走查照不出来。现在：这一天一段都没有就是 `undefined`，调用方整行不画。
 */
export function dayMetrics(plan: TripPlanSnapshot, day: number): DayMetrics {
  const d = dayOf(plan, day);
  const spots = d?.spots.length ?? 0;
  const ls = legsOf(plan, day);
  if (ls.length === 0) return { spots };
  return {
    spots,
    driveMinutes: ls.reduce((sum, l) => sum + l.driveMinutes, 0),
    chargeStops: ls.filter((l) => l.reason === "charge").length,
  };
}

/**
 * 整程的补能点数（`energyStops`）——**不是按天的**。
 *
 * 充电点在真实数据里落在 `energyStops`（整程一个名字数组），不在 `legs[].reason`
 * （实测徐州那份：`legs` 三段全是 `rest`，充电站在 `energyStops` 里）。
 * 按天摊不开，所以调用方要**标明这是整程**，不能混进按天的格子里冒充当天的数。
 */
export function tripChargeStops(plan: TripPlanSnapshot): number | undefined {
  return plan.energyStops?.length;
}

// ── 充电站：整程补能点（M83 走查追修）──────────────────────────────────────

/**
 * 补能点的**展示名**：去掉第一个括号起的注解。
 *
 * `energyStops` 是自由文本，drive 分支的求解结果原样穿透（M13-02），实测三种形状：
 *  - `淮安六洞服务区国家电网电动汽车充电站`（干净）
 *  - `江都服务区（沪陕高速上海方向，约181km处）— 国网快充×3 + 蔚来换电站`
 *  - `永嘉县岩坦镇景泉村半岭村停车场充电站（沿线 375km 处，绕行约 767m，…）`
 *
 * 注解里是里程与绕行量，对"在哪补能"这个问题是噪音，且长到一行放不下。
 * **只切不改**：括号前那一段是模型给的原名，不做任何加工。
 */
export function chargeStopName(raw: string): string {
  const cut = raw.search(/[（(]/);
  return (cut > 0 ? raw.slice(0, cut) : raw).trim();
}

/** 整程补能点的展示名列表；没有就是空数组。 */
export function chargeStopNames(plan: TripPlanSnapshot): string[] {
  return (plan.energyStops ?? []).map(chargeStopName).filter(Boolean);
}

/**
 * 充电站那一格写什么。
 *
 * # 为什么不按 `transit` 判断"这趟开不开车"
 *
 * 实测（2026-09-14，库里六份已确认行程）：徐州与普陀山的 `transit.recommended` 是
 * `train`，却**带着补能点**——大交通后来改过、`energyStops` 没跟着清。
 * 拿 transit 当闸门会把真实存在的数据判没了，所以**以 `energyStops` 自己为准**，
 * 它有值就有值；只有在它空着的时候才轮到 transit 说话。
 *
 * # 三种状态，没有一种是「0 个」
 *
 * - 有补能点 → 「整程 N 个」。**整程二字不能省**：它没有按天归属
 *   （`legs[].reason` 实测基本不填、`energyStops` 也不带天），
 *   放进按天的格子里不标明，就是在说一件没人验证过的事。
 * - 没有 + 大交通是火车/飞机 → 「不适用」：这趟不开车。
 * - 没有 + 自驾或大交通未定 → 「无需补能」：契约写的就是"缺省 = 本次方案没有自驾补能点"
 *   （短途本来就不用补），这与"还没查"是两回事。
 */
export function chargeCellValue(plan: TripPlanSnapshot): string {
  const n = plan.energyStops?.length ?? 0;
  if (n > 0) return `整程 ${n} 个`;
  const t = plan.transit?.recommended;
  return t === "train" || t === "flight" ? "不适用" : "无需补能";
}

/**
 * 沿途服务四格（M93-05 起，去掉了「景区」）。
 *
 * # 这几个数是谁查的、什么时候查的
 *
 * | 格 | 来源 | 什么时候 |
 * |---|---|---|
 * | 充电站 · 餐饮 · 卫生间 · 停车场 | 快照里的 `services.days[]`——当天停靠点周边 `radiusM` 内的高德 POI 数 | 行程确认后由 runtime 在后台查一次、写回快照 |
 *
 * 四格现在**同源同口径**，这是 M93-05 的全部用意：从前「景区」数的是这份行程自己的站点、
 * 「充电站」读的是 drive 分支求解出来的 `energyStops`，三个来源摆在一排，
 * 而车主读到的是"这一排都是周边有什么"。
 *
 * 补能点没有消失，它换了个位置：`chargeStopNames()` 在格子下面单独成行——那是
 * "这一路要在哪儿充"，与"当天周边有多少桩"是两个问题，挤在同一格里必然有一个被顶掉。
 *
 * 某一类没查成 → 那一格「待查」；查过了没有 → 「0 个」。两者不是一回事（文件头第 2 条）。
 *
 * ⚠️ 取数走 `serviceOverride()` 在**函数内部**完成，不再由调用方传进来。从前那个
 * `override` 入参是 FL-18 落地前留的口子，真实数据源接上之后它只剩一个生产者，
 * 留着就等于让每个调用点都得记住"还要再调一次 serviceOverride"——漏一次就是满屏「待查」。
 */
export function dayServices(plan: TripPlanSnapshot, day: number): ServiceCell[] {
  const override = serviceOverride(plan, day);
  const mk = (key: ServiceCategoryKey): ServiceCell => ({
    key,
    label: SERVICE_LABELS[key],
    value: override?.[key] ?? PENDING,
  });
  return SERVICE_CATEGORY_KEYS.map(mk);
}

// ── 餐饮 / 卫生间 / 停车场：快照里的 `services`（沿途服务数据源交接，待执行事项 4）────────

/**
 * 「12 个」「0 个」「61 个」——**念快照里的真数**（2026-09-16 走查第四轮）。
 *
 * 这里原来把 25 及以上一律写成「25+ 个」，理由是高德每个取样点每类目最多回 25 条
 *（`route_services` 的 `MAX_PER_POINT`），到顶就说明"可能还有更多"。
 * 那条理由在 M93-04 之后就不成立了：计数是**一天多个停靠点去重后的并集**，
 * 真跑实测 43~99，而屏幕上 61、90、99 一律显示「25+ 个」——三个差着一倍的数长得一模一样，
 * 车主看不出任何差别，等于把这一格作废了。
 *
 * 单点触顶带来的低估仍然存在（真值只会更多，不会更少），这是取数侧的事；
 * 展示层的职责是**如实念出快照里的那个数**，不是替它加一层看不懂的封顶。
 *
 * 0 照写——它是"查过了没有"，与「待查」是两回事（文件头第 2、3 条）。
 */
export function serviceCountLabel(n: number): string {
  return `${n} 个`;
}

/**
 * 四格的 `override`：快照里有这一天、且是按当前骨架算的才有；没查成的类目不给（保持「待查」）。
 * 编辑预览里挪了景点，`tripServicesForDay` 比对不上就整个 undefined——四格如实变回待查。
 */
export function serviceOverride(
  plan: TripPlanSnapshot,
  day: number,
): Partial<Record<ServiceCategoryKey, string>> | undefined {
  const d = tripServicesForDay(plan, day);
  if (!d) return undefined;
  const out: Partial<Record<ServiceCategoryKey, string>> = {};
  for (const key of SERVICE_CATEGORY_KEYS) {
    const n = d[POI_FIELD_OF[key]];
    if (n !== undefined) out[key] = serviceCountLabel(n);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 某一天某一类可以画到地图上的点位（M93-05）。
 *
 * 与 `serviceOverride` 同一条纪律：骨架指纹对不上就当没有——**宁可不画，不画错的**。
 * 老快照（M93-04 之前落的）有计数没有 `pois`，这里返回空数组，展示层据此把格子置灰：
 * 显示成可点然后点了没反应，比一开始就说"这份行程没存点位"糟得多。
 */
export function servicePoisFor(
  plan: TripPlanSnapshot,
  day: number,
  category: ServiceCategoryKey,
): ServicePoi[] {
  return tripServicesForDay(plan, day)?.pois?.[POI_FIELD_OF[category]] ?? [];
}

/** 地图要画的一批点：按当前选中的类目摊平，带上类目好让标记选对图标与颜色。 */
export interface SelectedServicePoi extends ServicePoi {
  category: ServiceCategoryKey;
}

/**
 * 选中的那几类 → 地图要画的点（M93-05）。
 *
 * **筛选放在这里而不是地图组件里**：它是纯函数，可测；地图那边只负责把给它的点画出来。
 * `day` 缺省（全程视图）时返回空数组——十几天的四类点糊在一张图上没有可读性。
 */
export function selectedServicePois(
  plan: TripPlanSnapshot,
  day: number | undefined,
  selected: readonly ServiceCategoryKey[],
): SelectedServicePoi[] {
  if (day === undefined) return [];
  return selected.flatMap((category) =>
    servicePoisFor(plan, day, category).map((poi) => ({ ...poi, category })),
  );
}

/** 当天高速段的服务区名（去程落第 1 天）；没有就是空数组，调用方不画那一行。 */
export function serviceAreasFor(plan: TripPlanSnapshot, day: number): string[] {
  return tripServicesForDay(plan, day)?.serviceAreas ?? [];
}

/**
 * 一格的悬浮说明（`title`）——出处与口径**从屏幕上挪进提示里**（2026-09-16 走查第四轮：
 * 「这句话删除」）。
 *
 * 抽屉本来就装不下：那段三行的说明把时间轴挤到要滚两屏才看得见，而它回答的是
 * 一个只需要问一次的问题。删掉它但**不能把信息一起删掉**——
 * 一排「待查」不解释就是看起来坏了（M83 走查的原话），所以口径改挂在格子上。
 */
export function serviceCellTitle(plan: TripPlanSnapshot, value: string): string {
  const km = plan.services ? `周边 ${Math.round(plan.services.radiusM / 100) / 10} 公里` : "周边";
  const what =
    value === PENDING
      ? "这一类还没查成，不是「没有」"
      : `行程确认后按当天停靠点${km}查高德所得；「0 个」是查过没有`;
  return `${what}。点一下可以把这一类的点位显示在地图上，可多选`;
}

// ── 出发与返程的时刻（M83 走查追修）──────────────────────────────────────

/**
 * 「中午」的分界（12:00）。`checkin-midday` 的落脚行插在**跨过它的第一站**之前，
 * 见 `dayTimeline`；一天里哪一站算下午，只有钟点说了算。
 */
const MIDDAY_MIN = 12 * 60;

/** `"09:30"` → 570；不是这个形状返回 undefined。 */
function toMinutes(hhmm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h >= 0 && h < 24 && mi >= 0 && mi < 60 ? h * 60 + mi : undefined;
}

/** 570 → `"09:30"`。**越过当天两端就返回 undefined**——见 `dayDepartTime` 的说明。 */
function toClock(total: number): string | undefined {
  if (total < 0 || total >= 24 * 60) return undefined;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 返程链：`legs` 末尾那一串终点回到出发地的段（M77 走查追修加的）。
 *
 * 判据是**末段的 `toStop` 等于 `origin`**（`merge.ts` 的 `buildLegs` 显式这么写，
 * 闭环体检比的也是这个值）。往前收到"上一段的起点就是出发地"为止——
 * 那是去程的第一段，当天往返时它与返程段同在最后一天，不拦住就会把去程一起吞进来。
 *
 * # 段上写了 `direction` 就只认它（turn-ced8b400，2026-09-18）
 *
 * 上面那条"收到出发地为止"只防得住**当天往返**。多天行程的最后一天还有另一种去程段：
 * **换片区**（前一晚住处 → 当天片区），它的起点不是出发地，于是一路被收进返程链。
 * 实测：第 3 天「嵊泗县→普陀区 335 分」被算成返程，时间轴写「返程 9 小时 10 分 · 21:10 到」，
 * 而真正的返程是 215 分、15:35 到——差了五个半小时，且出发时刻的倒推也跟着少算这一段。
 * `direction` 是 `buildLegs` 自己写的（M102-01），比按站名猜可靠；老快照没有它才走猜的那条。
 */
export function returnLegs(plan: TripPlanSnapshot): TripPlanLeg[] {
  const legs = plan.legs ?? [];
  const origin = plan.origin;
  if (!origin || legs.length === 0) return [];
  const last = legs[legs.length - 1]!;
  if (last.toStop !== origin) return [];
  if (last.direction !== undefined) {
    const tail: TripPlanLeg[] = [];
    for (let i = legs.length - 1; i >= 0; i -= 1) {
      const leg = legs[i]!;
      if (leg.day !== last.day || leg.direction !== "return") break;
      tail.unshift(leg);
    }
    return tail;
  }
  const out: TripPlanLeg[] = [];
  for (let i = legs.length - 1; i >= 0; i -= 1) {
    const leg = legs[i]!;
    if (leg.day !== last.day) break;
    out.unshift(leg);
    if (leg.fromStop === origin) {
      // 这一段是去程的第一段（从出发地开出去的），不属于返程链。
      out.shift();
      break;
    }
  }
  return out;
}

/**
 * 这一天的**去程**行车段（不含返程链）。出发时刻按它们的总时长倒推。
 */
function outboundLegsOf(plan: TripPlanSnapshot, day: number): TripPlanLeg[] {
  const back = new Set(returnLegs(plan));
  return (plan.legs ?? []).filter((l) => l.day === day && !back.has(l));
}

/**
 * 这一天几点出发。
 *
 * 两个来源，**各管各的天，不重叠**：
 *  - 第 1 天：`当天第一站的 estStart − 当天去程段总时长`（去程段在 `legs` 里，那是大交通）。
 *  - 第 2 天起：`当天第一站的 estStart − startLeg.driveMinutes`（M83 走查追修回填的
 *    「前一晚住处 → 当天第一站」，由确认路径按坐标调高德算，代码算不让模型抄）。
 *
 * 缺哪一半就没有答案：**不给时刻**——「早上出发」这种话是编的。
 *
 * # 跨零点就不给
 *
 * 倒推出负数意味着要前一天出发。那是**可执行性**的结论（该由体检说），
 * 不是时间轴该替它下的判断，所以这里只是不给时刻。
 */
export function dayDepartTime(plan: TripPlanSnapshot, day: number): string | undefined {
  const d = dayOf(plan, day);
  const first = d?.spots[0];
  if (!first?.estStart) return undefined;
  const start = toMinutes(first.estStart);
  if (start === undefined) return undefined;

  // 第 2 天起：住处 → 第一站，由快照带来。
  if (day > 1) {
    const mins = d?.startLeg?.driveMinutes;
    return mins === undefined ? undefined : toClock(start - mins);
  }

  const legs = outboundLegsOf(plan, day);
  if (legs.length === 0) return undefined;
  /*
   * 第 1 天的锚点：**有办入住窗口就用它**，没有才退回第一个景点。
   *
   * 去程那几段开到的是当天的落脚片区，不是第一个景点。到达日的真实顺序是
   * 「到片区 → 办入住 → 第一个景点」，拿第一个景点当锚等于把办入住算成 0 分钟，
   * 倒推出来的出发时刻因此偏晚（实测 turn-ced08ea1：10:32，而中间还要办入住）。
   */
  const checkin = day === 1 ? toMinutes(d?.lodging?.estStart ?? "") : undefined;
  const anchor = checkin !== undefined && checkin <= start ? checkin : start;
  return toClock(anchor - legs.reduce((sum, l) => sum + l.driveMinutes, 0));
}

/** 模型给的办入住窗口，排版成「12:00 – 12:40」；没给或只给了一头就没有。 */
export function lodgingWindow(lodging: TripPlanDaySnapshot["lodging"]): string | undefined {
  const a = lodging?.estStart;
  const b = lodging?.estEnd;
  return a && b ? `${a} – ${b}` : undefined;
}

/**
 * 几点到当晚的住处。
 *
 * `当天最后一站的 estEnd + endLeg.driveMinutes`。缺哪一半就没有答案——
 * 没有 `endLeg`（坐标缺、规划失败、老快照）或最后一站没有结束时刻时**不给时刻**，
 * 那一行仍然写「入住」：住这件事是确定的，几点到不确定。
 *
 * 跨零点不给（与 `dayDepartTime` 同一条）：那是可执行性的结论，该由体检说。
 */
export function dayArriveHotelTime(plan: TripPlanSnapshot, day: number): string | undefined {
  const d = dayOf(plan, day);
  const mins = d?.endLeg?.driveMinutes;
  const last = d?.spots[d.spots.length - 1];
  if (mins === undefined || !last?.estEnd) return undefined;
  const end = toMinutes(last.estEnd);
  return end === undefined ? undefined : toClock(end + mins);
}

/**
 * 这一天几点回到出发地；没有返程链就没有这一行。
 *
 * `当天最后一站的 estEnd + 返程链总分钟`。最后一站没有 `estEnd` 时**仍然给这一行**
 * （回得去是事实），只是不给时刻——把"几点到家"编出来比不说更糟。
 */
export function dayReturnRow(plan: TripPlanSnapshot, day: number): TimelineRow | undefined {
  const back = returnLegs(plan);
  if (back.length === 0 || back[0]!.day !== day || !plan.origin) return undefined;
  const spots = dayOf(plan, day)?.spots ?? [];
  const lastEnd = spots.length ? spots[spots.length - 1]!.estEnd : undefined;
  const mins = back.reduce((sum, l) => sum + l.driveMinutes, 0);
  const end = lastEnd ? toMinutes(lastEnd) : undefined;
  const time = end !== undefined ? toClock(end + mins) : undefined;
  return {
    kind: "return",
    ...(time ? { time } : {}),
    name: plan.origin,
    note: `返程 ${driveLabel(mins)}`,
  };
}

/**
 * 当天的时间轴行。
 *
 * 首行是**推导**出来的，不是 `spots` 的一部分：Day 1 从 `plan.origin` 出发
 * （没有 origin 就只写「出发」，不猜城市）；Day 2+ 从前一晚的酒店出发
 * （前一天没有 hotel 就没有首行——不编一个"从哪出发"）。
 *
 * 末行是当晚酒店（「入住」）；没有 hotel 时最后一站带「预计到达」。
 */
export function dayTimeline(plan: TripPlanSnapshot, day: number): TimelineRow[] {
  const d = dayOf(plan, day);
  if (!d) return [];
  const rows: TimelineRow[] = [];

  const prevHotel = day > 1 ? dayOf(plan, day - 1)?.hotel : undefined;
  /*
   * 出发时刻（M83 走查追修）：算得出才写，算不出连"出发"两个字也照旧给——
   * 出发这件事是确定的，几点出发不确定。第 2 天起通常算不出（见 `dayDepartTime`）。
   */
  const departAt = dayDepartTime(plan, day);
  if (day === 1) {
    rows.push({ kind: "origin", ...(departAt ? { time: departAt } : {}), name: plan.origin ?? "出发", note: "出发" });
  } else if (prevHotel) {
    // 车程写在 note 里：出发时刻是倒推出来的，把依据摆出来才不像凭空给的。
    const mins = d.startLeg?.driveMinutes;
    rows.push({
      kind: "origin",
      ...(departAt ? { time: departAt } : {}),
      name: prevHotel.name,
      note: mins === undefined ? "出发" : `出发 · 车程 ${driveLabel(mins)}`,
    });
  }

  const spotRows: TimelineRow[] = [];
  for (const s of d.spots) {
    const both = s.estStart !== undefined && s.estEnd !== undefined;
    const stay = both ? stayLabel(s.estStart!, s.estEnd!) : undefined;
    spotRows.push({
      kind: "spot",
      ...(both ? { time: `${s.estStart} – ${s.estEnd}` } : s.estStart ? { time: s.estStart } : {}),
      name: s.name,
      note: stay ? `建议停留 ${stay}` : both || s.estStart ? "" : "时间待定",
    });
  }
  /*
   * 中午落脚那一行（2026-09-16 走查第九轮）。走查原话：「希望能在行程时间轴显示出
   * 目的地第一站落脚点，不然会很奇怪，到底直接去玩还是先办理入住登记」。
   *
   * 数据一直在（`day.lodging`，M34-01），但只画在了图上那张住宿提醒里；
   * 时间轴从出发直接跳到第一个景点、酒店只在末行出现，于是两处**互相矛盾**：
   * 提醒说"中午到酒店办入住"，时间轴说"到了就去玩，晚上才见到酒店"。
   *
   * 只有 `checkin-midday` 需要这一行：`checkin-evening` 的语义（白天全程玩、
   * 晚上入住）末行的酒店行已经逐字表达了，再加一行就是重复。
   *
   * 插在**第一个下午的景点之前**（12:00 起算）——这正是策略名里那个 midday。
   * 一天全是上午的点、或干脆没有时间时退到最前面：契约里写着「到达日先到酒店
   * 落脚再开始行程」，落脚在前是这条策略的本意。
   *
   * 时刻给的是**窗口**（走查第十轮：「check in 在规划时没有给时间，是几点钟到酒店办理入住」）：
   * 前一站的结束到后一站的开始，例如 `12:30 – 13:00`——两头都是骨架里已经有的数，
   * 落脚一定发生在这段里。**不给一个点**：到店那一刻算不出来（前一站到酒店的车程
   * 不在数据里），拍一个"12:40"出来就成了看起来查过、其实是编的数——同末行到店
   * 时刻那条纪律。排在最前（没有下午的点 / 没有时间）时两头缺一头，就不写时间。
   */
  if (d.lodging?.strategy === "checkin-midday" && d.hotel) {
    const afternoon = d.spots.findIndex((s) => {
      const at = s.estStart === undefined ? undefined : toMinutes(s.estStart);
      return at !== undefined && at >= MIDDAY_MIN;
    });
    const at = afternoon < 0 ? 0 : afternoon;
    const from = at > 0 ? d.spots[at - 1]?.estEnd : undefined;
    const to = d.spots[at]?.estStart;
    /*
     * 时刻优先用**排这一天的那一方给的办入住窗口**（`lodging.estStart/estEnd`），
     * 它到不了的时候才退回上面那个间隙。
     *
     * 为什么要有第一档：间隙那一档在**第 1 天几乎永远算不出来**——到达日的第一个景点本来就在下午，
     * 落脚行于是插在最前面，"前一站"不存在，`from` 缺席就整行不给时刻。实测（turn-ced08ea1）
     * 车主问的正是这一格："到如家商旅酒店的时间页没说"。而到店那一刻算不出来：第 1 天只有一个
     * 自由量（几点出发），它本身就是从景点时段倒推的，两头相等 = 没有窗口。所以向模型要，见契约里
     * `TripPlanLodging.estStart` 的说明。
     */
    const given = lodgingWindow(d.lodging);
    spotRows.splice(at, 0, {
      kind: "checkin",
      ...(given ? { time: given } : from && to ? { time: `${from} – ${to}` } : {}),
      name: d.hotel.name,
      note: "中午先办入住",
    });
  }
  rows.push(...spotRows);

  if (d.hotel) {
    /*
     * 到店时刻（M83 走查追修，用户走查："把最后一个景点到酒店的时间也算出来"）：
     * 末站结束 + `endLeg` 的车程。算不出就只写「入住」——住这件事是确定的，几点到不确定。
     */
    const arriveAt = dayArriveHotelTime(plan, day);
    const mins = d.endLeg?.driveMinutes;
    /*
     * 中午已经办过入住的那天，末行改说「回酒店」——同一家店一天里出现两次，
     * 两次都写「入住」就成了"入住两回"。
     */
    const what = d.lodging?.strategy === "checkin-midday" ? "回酒店" : "入住";
    rows.push({
      kind: "hotel",
      ...(arriveAt ? { time: arriveAt } : {}),
      name: d.hotel.name,
      note: mins === undefined ? what : `${what} · 车程 ${driveLabel(mins)}`,
    });
  } else if (rows.length > 0 && rows[rows.length - 1]!.kind === "spot") {
    rows[rows.length - 1] = { ...rows[rows.length - 1]!, note: "预计到达" };
  }
  /*
   * 返程（M83 走查追修）：最后一天开回出发地那一段。数据是 M77 走查追修加的
   * （`submit_drive_draft` 的 `returnMinutes` → `buildLegs` 的末段 `toStop = origin`）。
   * 没有返程链就没有这一行——**坐火车回去、或者行程本来就不闭环时不编一行出来**。
   */
  const back = dayReturnRow(plan, day);
  if (back) rows.push(back);
  return rows;
}

// ── 变更集的操作（M83-04）────────────────────────────────────────────
//
// 车主会连点好几下，所以每个操作都要把"同一件事的前一次"合并掉：
// 连着调三次顺序不该产生三条变更，换两次天也不该叠成两条。
// 合并规则写在这里而不是组件里——它们要被逐条断言，而组件要 React 才跑得起来。

/** 是不是同一天同一站的同类变更。 */
function sameTarget(a: TripStructureEdit, b: TripStructureEdit): boolean {
  if (a.kind !== b.kind || a.day !== b.day) return false;
  if (a.kind === "reorder") return true;
  return "spot" in a && "spot" in b && a.spot === (b as { spot: string }).spot;
}

/** 删一站。已经删过就不重复加。 */
export function pushRemove(
  edits: readonly TripStructureEdit[],
  day: number,
  spot: string,
): TripStructureEdit[] {
  const next: TripStructureEdit = { kind: "remove", day, spot };
  if (edits.some((e) => sameTarget(e, next))) return [...edits];
  return [...edits, next];
}

/** 撤销删除：把那一条拿掉。 */
export function undoRemove(
  edits: readonly TripStructureEdit[],
  day: number,
  spot: string,
): TripStructureEdit[] {
  return edits.filter((e) => !(e.kind === "remove" && e.day === day && e.spot === spot));
}

/**
 * 换天。同一站再换一次**改写**原来那条而不是追加——否则"第 2 天的 A 移到第 3 天；
 * 第 2 天的 A 移到第 4 天"两句话一起发给暖暖，它有理由照第一句做。
 * 换回原来那天等于没换，直接把变更撤掉。
 */
export function pushMove(
  edits: readonly TripStructureEdit[],
  day: number,
  spot: string,
  toDay: number,
): TripStructureEdit[] {
  const without = edits.filter((e) => !(e.kind === "move" && e.day === day && e.spot === spot));
  if (toDay === day) return without;
  return [...without, { kind: "move", day, spot, toDay }];
}

/** 重排某一天。同一天的前一条 reorder 被**替换**，只留最终顺序。 */
export function pushReorder(
  edits: readonly TripStructureEdit[],
  day: number,
  order: readonly string[],
): TripStructureEdit[] {
  const without = edits.filter((e) => !(e.kind === "reorder" && e.day === day));
  return [...without, { kind: "reorder", day, order: [...order] }];
}

/** 这一天有没有被改过（编辑态里 Day 卡上打个点用）。 */
export function dayTouched(edits: readonly TripStructureEdit[], day: number): boolean {
  return edits.some((e) => e.day === day || (e.kind === "move" && e.toDay === day));
}

/** 编辑态的一行：预览行 + `removed` 标记（软删的行仍然渲染，否则「撤销」无处可点）。 */
export interface EditableRow extends TimelineRow {
  removed?: boolean;
  /** 在**当天景点序列**里的位置（0 起），只有 `spot` 行有；上下移与换天都按它定位。 */
  index?: number;
}

/**
 * 编辑态渲染的行 = 预览的行 + **按原位置插回去的软删行**。
 *
 * 软删不是真删：那一行要留在原地变淡划线，「撤销」才有地方点。所以不能直接用
 * `applyStructureEdits` 的结果——它已经把那站拿掉了。
 */
export function editableRows(
  plan: TripPlanSnapshot,
  preview: TripPlanSnapshot,
  edits: readonly TripStructureEdit[],
  day: number,
): EditableRow[] {
  const rows: EditableRow[] = dayTimeline(preview, day).map((r) => ({ ...r }));
  const removedHere = edits.filter((e) => e.kind === "remove" && e.day === day) as Array<{
    kind: "remove";
    day: number;
    spot: string;
  }>;
  const original = plan.skeleton.find((d) => d.day === day)?.spots ?? [];

  for (const rm of removedHere) {
    const at = original.findIndex((s) => s.name === rm.spot);
    if (at < 0) continue;
    /*
     * 插回**原计划里的相对位置**：它前面还剩几站，就排在第几个景点行之后。
     *
     * ⚠️ 按"下一个景点行"定位是错的——删掉当天**最后一个**景点时没有下一个，
     * 那一行会被插到酒店行后面（2026-09-14 走查实测：出发 / 广州塔 / 酒店 / 海心沙）。
     * 所以按"已数过的最后一个景点行之后"定位，一个景点都不剩时落在酒店行之前。
     */
    const beforeCount = original.slice(0, at).filter((s) => rows.some((r) => r.name === s.name)).length;
    const spotIdx = rows.map((r, i) => (r.kind === "spot" ? i : -1)).filter((i) => i >= 0);
    let insertAt: number;
    if (beforeCount === 0) {
      const firstHotel = rows.findIndex((r) => r.kind === "hotel");
      insertAt = spotIdx[0] ?? (firstHotel >= 0 ? firstHotel : rows.length);
    } else {
      const anchor = spotIdx[Math.min(beforeCount, spotIdx.length) - 1];
      const firstHotel = rows.findIndex((r) => r.kind === "hotel");
      insertAt = anchor !== undefined ? anchor + 1 : firstHotel >= 0 ? firstHotel : rows.length;
    }
    const src = original[at]!;
    rows.splice(insertAt, 0, {
      kind: "spot",
      name: src.name,
      note: "已删除",
      removed: true,
      ...(src.estStart && src.estEnd ? { time: `${src.estStart} – ${src.estEnd}` } : {}),
    });
  }

  let idx = 0;
  for (const r of rows) {
    if (r.kind === "spot") {
      r.index = idx;
      idx += 1;
    }
  }
  return rows;
}

/**
 * 上下移一位：把 `name` 在 `order` 里往前 / 往后挪一格，返回新的完整顺序。
 * 挪不动（已在两端、不在表里）返回 `undefined`——调用方据此什么也不做。
 *
 * 放在这里而不是组件里，是为了让组件**一行数组手术都没有**：
 * 那条红线（预览与发给暖暖的话同源）才守得住，也才验得了。
 */
export function moveInOrder(
  order: readonly string[],
  name: string,
  delta: number,
): string[] | undefined {
  const at = order.indexOf(name);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= order.length) return undefined;
  const next = [...order];
  next.splice(at, 1);
  next.splice(to, 0, name);
  return next;
}

/**
 * 这一行相对**原计划**变成了什么样（M83 走查追修）。
 *
 * # 为什么不是动画
 *
 * 走查里点一下 ▲ 只看到行跳了一下，"它从第几位挪到第几位、我一共动过几下"全靠记。
 * 车机上更糟——手指还在屏幕上，动画早播完了。所以把变化**留在行上**：
 * 一枚常驻的小标，改了几位就写几位，切走再切回来它还在，撤销才消失。
 */
export type RowChange =
  | { kind: "moved-in"; fromDay: number }
  | { kind: "up"; steps: number }
  | { kind: "down"; steps: number }
  | { kind: "removed" };

/** 「↓ 后移 2 位」。方向词用"前 / 后"不用"上 / 下"——时间轴是顺序，不是位置。 */
export function rowChangeLabel(c: RowChange): string {
  if (c.kind === "moved-in") return `从 Day ${c.fromDay} 移来`;
  if (c.kind === "removed") return "已删除";
  return c.kind === "up" ? `↑ 前移 ${c.steps} 位` : `↓ 后移 ${c.steps} 位`;
}

/**
 * 每个景点行的变化标。
 *
 * 三类来源各判各的：
 *  - **从别的天移来**：目标天的行在原计划里根本没有它 → 找它原来在哪一天；
 *  - **顺序变了**：与原计划里的同天序列比下标；只比**两边都还在**的站
 *    （删掉的站不该让后面所有行都显示"前移 1 位"——那是删除的副作用，不是车主挪的）；
 *  - **删除**：软删的行（`editableRows` 已标 `removed`）。
 */
export function rowChanges(
  plan: TripPlanSnapshot,
  preview: TripPlanSnapshot,
  day: number,
): Map<string, RowChange> {
  const out = new Map<string, RowChange>();
  const before = (plan.skeleton.find((d) => d.day === day)?.spots ?? []).map((s) => s.name);
  const after = (preview.skeleton.find((d) => d.day === day)?.spots ?? []).map((s) => s.name);

  for (const name of after) {
    if (before.includes(name)) continue;
    const from = plan.skeleton.find((d) => d.day !== day && d.spots.some((s) => s.name === name));
    if (from) out.set(name, { kind: "moved-in", fromDay: from.day });
  }

  // 只在"两边都在"的子序列里比位次：删掉一站不该让它后面的每一行都报"前移 1 位"。
  const kept = before.filter((n) => after.includes(n));
  const keptAfter = after.filter((n) => kept.includes(n));
  for (const name of kept) {
    const i = kept.indexOf(name);
    const j = keptAfter.indexOf(name);
    if (i === j) continue;
    out.set(name, j < i ? { kind: "up", steps: i - j } : { kind: "down", steps: j - i });
  }
  return out;
}
