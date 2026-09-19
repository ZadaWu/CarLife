/**
 * 多天行程快照——端云契约（施工单 M13-01）。
 *
 * # 与两位近亲的关系，命名因此刻意绕开
 *
 * - `hud.ts` 里已有一个 `TripPlan`：那是 HUD 生活环的**展示**结构（锚位+语义化地点）。
 * - agent-runtime 的 `TripPlanState`：那是图状态里的**草案**（M12-03，跨轮细化用）。
 * 本文件是第三个角色：**确认后落库、并被网关原样返回给座舱的那份快照**。
 * 三者职责不同不合并；本类型是网关 `GET /v1/trip-plan/current` 与
 * `trip_plan_commit` 工具入参的唯一真相源，图状态与它对齐（M13-02）。
 *
 * # 真实性红线随类型走（M12 设计继承）
 *
 * spots/hotel 的 name 必须来自 poi_search；estPrice 恒带「估」字——
 * 后者在 `trip_plan_commit` 的 zod 层强制，这里的注释是语义声明。
 */

import {
  highlightsPage,
  paginateTipItems,
  tipItemsFromKeys,
  type DestinationHighlights,
  type HudSnapshot,
  type PretripItemRef,
  type TipPage,
  type TripNode,
  type WeatherContext,
} from "./hud";
import type { PoiKind } from "./poi-kind";

export type TripPlanStatus = "skeleton" | "refining" | "confirmed" | "cancelled";

/**
 * 「这份行程正在被导航」（M31-01）。
 *
 * # 为什么它挂在快照里而不是另开一路
 *
 * 端上取行程走的是网关 `GET /v1/trip-plan/current`（读 PG）。导航状态不落库
 * 就得为一个字段新建推送通道，不成比例；挂进快照则复用既有的"每轮回复落地即刷"
 * （c256a5d），零新增 plumbing。
 *
 * **重启后续上导航是正确行为，不是 bug**——车还在路上。这一点与 M30 的按轮
 * 暂存区（进程内、轮末即弃）不同：那个的寿命是一轮，这个的寿命是一次驾驶。
 *
 * `startedAt` 不只是留痕，它是**过期判据的唯一材料**：跨天的导航一律作废
 * （见 `tripPlanNavDay`）。没有它，昨天那次「出发」会一直挂在今天的屏幕上。
 */
export interface TripPlanNav {
  /** 导航的是第几天（1 起，与 `TripPlanDaySnapshot.day` 同口径）。 */
  day: number;
  /** 「出发」那一刻，ISO 时间戳。 */
  startedAt: string;
}

export interface TripPlanSpotSnapshot {
  name: string;
  indoor?: boolean;
  note?: string;
  /**
   * 真实坐标（M13-06）：由确认路径的**代码**经 poi_search 后端解析，不让 LLM 抄数字。
   * 缺省 = 没解析到——HUD 不标注、不猜坐标（真实性红线），名字仍进列表。
   */
  lat?: number;
  lon?: number;
  /**
   * 贴纸品类（M13-07）：确认路径的代码按高德 type 字段分类（`classifyAmapPoi`），
   * 与坐标同一次 poi_search 顺手取得。缺省 = 类目没查到——HUD 用通用景点贴纸，
   * **不按名字猜**（与坐标「不标不猜」同一条红线）。
   */
  poiKind?: PoiKind;
  /**
   * 建议游玩时段（M34-01，`HH:MM`，**预计口径**）：tour 分支的模型给出——
   * 时段语义（夜游必须晚上、长隆是全天、下午该有安排）只有模型知道，
   * 端上按 09:00+90min 拍出来的是「珠江夜游 预计 10:50–12:20」这类荒谬时间。
   * 缺省 = 模型没给或校验被丢弃（`sanitizeDayTimes`），HUD 回退端上排时。
   * 展示时恒带「预计」标注（估算口径纪律与 estPrice 同源）。
   */
  estStart?: string;
  estEnd?: string;
}

export interface TripPlanHotelSnapshot {
  name: string;
  /** 完整地址（对话层播报用）。**HUD 映射不得输出它**——HUD 只给语义化名称。 */
  address?: string;
  area?: string;
  rating?: string;
  /** 恒含「估」字（估算声明），commit 时 schema 强制。 */
  estPrice?: string;
  /** 真实坐标（M13-06），语义同 TripPlanSpotSnapshot。 */
  lat?: number;
  lon?: number;
}

/**
 * 换酒店日/到达日的住宿策略（M34-01）。**住宿是锚点不是 POI**：
 * 到达日先到酒店落脚（放行李/取车）再开始行程，每天结束回当晚酒店；
 * 换酒店日由模型二选一并在 note 里写清行李处置（自驾=行李在车、非自驾=寄存）。
 * 只出现在换酒店日与到达日；连住日不填。行李是 note 的一部分，不建数据结构。
 */
export interface TripPlanLodging {
  /** checkin-midday = 上午玩完→退房→新酒店办入住→下午继续；checkin-evening = 白天全程玩、晚上入住。 */
  strategy: "checkin-midday" | "checkin-evening";
  /** 一句话说明（含行李处置），模型写，HUD 原样显示。 */
  note?: string;
  /**
   * 办入住的时段窗口 HH:MM（`estStart` 起、`estEnd` 止），由排行程的那一方给。
   *
   * # 为什么这个数必须由模型给，算不出来
   *
   * 第 1 天只有**一个自由量**——几点从家出发——而展示层是拿「第一个景点 estStart −
   * 当天去程段总时长」把它倒推出来的。于是「到片区」与「第一个景点开始」在数据上是同一刻，
   * 中间那次办入住没有任何可落脚的时间：窗口两头相等，等于没有窗口。
   *
   * 实测（turn-ced08ea1）：到达日的落脚行恒无时刻，车主问的是"到底几点到酒店"，
   * 而按现在的排法**第 1 天几乎永远落在这一档**（第一个景点本来就在下午，落脚行插在最前面，
   * 前一站不存在）。补一个"大概 12:40"是编的——到店那一刻算不出来。
   *
   * 所以向已经知道它的那一方要（ADR-012）：排这一天的模型本来就在决定"几点到、几点开始玩"。
   * 有了它，第 1 天的出发时刻也从「第一个景点倒推」改成「办入住倒推」，比原来更准
   * （原来的口径把办入住的时间算成了 0）。
   *
   * 缺省 = 模型没给（或老快照）：展示层退回原来的「前一站结束 – 下一站开始」那个间隙，
   * 两头缺一头就不给时刻——**不编**。
   */
  estStart?: string;
  estEnd?: string;
}

export interface TripPlanDaySnapshot {
  day: number;
  date?: string;
  theme: string;
  area?: string;
  spots: TripPlanSpotSnapshot[];
  hotel?: TripPlanHotelSnapshot;
  /** 住宿策略（M34-01）：仅换酒店日/到达日；缺省 = 连住或旧快照。 */
  lodging?: TripPlanLodging;
  /**
   * 从前一晚住处开到当天第一站的车程（M83 走查追修）。见 `TripPlanStartLeg`。
   *
   * **只有第 2 天起有**：第 1 天的出发时刻由 `legs` 的去程段倒推。
   * 缺省 = 没算出来（坐标缺、路径规划失败、非自驾）或老快照——
   * 展示层**不给出发时刻**，不按"早上九点"之类的假设编一个。
   */
  startLeg?: TripPlanStartLeg;
  /**
   * 从当天最后一站开到当晚住处的车程（M83 走查追修）。见 `TripPlanEndLeg`。
   *
   * **只有当天有酒店时才有**（最后一天通常没有酒店，那一天末行是返程或「预计到达」）。
   * 缺省 = 没算出来（坐标缺、路径规划失败）或老快照——展示层**不给到店时刻**。
   */
  endLeg?: TripPlanEndLeg;
  notes?: string[];
}

/** 一段行车（M77-01）。见 `TripPlanSnapshot.legs` 的说明。 */
export interface TripPlanLeg {
  /** 属于第几天（1 起）；按段尾站名对到 skeleton 的 spot，对不上缺省。 */
  day?: number;
  fromStop?: string;
  toStop?: string;
  /** 分钟。代码从 `solve()` 的 legMinutes 取，模型不写。 */
  driveMinutes: number;
  /** rest = 休息停靠（含待定占位）；charge = 补能停靠（段尾站在 energyStops 里）。 */
  reason?: "rest" | "charge";
  /** 段尾是 `PENDING_STOP` 占位——"这里需要停一次，但没人给得出名字"。 */
  pending?: boolean;
  /**
   * 去程还是返程（M102-01）。`buildLegs` 写：去程段 `outbound`、返程段 `return`。
   * 确认路径按方向各算一次高德路线时靠它分组——不靠"首段 fromStop 等于 destination"这类猜法。
   * M102 之前落库的旧快照没有这个字段：那时整条不重算，数保持原样。
   */
  direction?: "outbound" | "return";
  /**
   * ISO 时刻：这一段的 `driveMinutes` 是哪一刻按高德算路覆盖的（M102-01）。
   * **只有确认路径覆盖过的段才有**；缺省 = 仍是规划时 drive 分支提交的数。
   * 用时刻而不是布尔，与 `TripPlanStartLeg.computedAt` 同义：路况会变，展示侧能据此标"预计"。
   */
  computedAt?: string;
}

export interface TripPlanSnapshot {
  status: TripPlanStatus;
  origin?: string;
  destination: string;
  /** ISO 日期（YYYY-MM-DD）；缺省 = 未定，HUD 按第 1 天展示。 */
  startDate?: string;
  days: number;
  /** 同行（带娃/老人）。 */
  party?: string;
  skeleton: TripPlanDaySnapshot[];
  transit?: { recommended?: "drive" | "train" | "flight"; summary: string };
  /**
   * 自驾补能点（drive 分支 solve() 的结果，M13-02 穿透）。
   * HUD 的 charge 锚位数据源；缺省 = 本次方案没有自驾补能点。
   */
  energyStops?: string[];
  /**
   * 行车分段（M77-01，F-62-01）：每一段开多久、从哪到哪、为什么停。
   *
   * **只存代码算出的值**：分钟数来自 drive 分支的结构化提交经 `solve()` 拆段后的 `legMinutes`，
   * 起止站与原因由代码按 `stops / energyStops` 对齐得出，模型不写这个字段。
   * 对不齐（`stops.length !== legMinutes.length - 1`）就**不写**——缺省而不是猜。
   * 老快照没有这个字段：`tripPlanStops()` 与 HUD 都不依赖它，缺省照常渲染。
   * 消费方：确认前的可执行性体检（FL-58 的时长项）与途中提醒（FL-62 的连续驾驶上限）。
   */
  legs?: TripPlanLeg[];
  /** 播报与展示时必须带的声明（估算、天气窗口外等）。 */
  caveats: string[];
  /**
   * 行前该带什么（M20-04）：确认路径按这次行程的天气算出来的物品 key。
   *
   * **只存 key，不存名字**——名字由 `PRETRIP_ITEMS` 查表得到。存 label 等于把
   * "图标下的字对不对"的正确性交给上游，M20-01 那次事故正是这么来的。
   *
   * 缺省 = 这次没算出来（天气挂了 / 没有坐标）或**老快照**——
   * 展示层回落基线清单，不是空卡。
   */
  pretripItems?: PretripItemRef[];
  /**
   * 这一程的天气（M20-05）：与 `pretripItems` **同一次调用、同一份天气**算出来的。
   * 分两处算必然出现"图标说晴天、物品带雨伞"。缺省 = 没算出来或老快照，展示层回落基线。
   */
  weather?: WeatherContext;
  /**
   * 目的地推荐（M32-02）：到了那儿吃什么、拍哪儿。
   *
   * **与 `pretripItems` 不同，它不参与确认那一跳**——那次调用要十几秒，
   * 串进确认里就是"说完确认之后卡十几秒才弹窗"。但"不能同步算"不等于"不能落库"：
   * 行程确认/变更后 runtime 在**后台**算一次，算完写回这一行（M32-02 修订，
   * `agent-runtime/src/graph/highlights.ts` 的 `createHighlightsBackfill`）。
   *
   * 所以从库里读出来的快照**带着它**；改了目的地的那一刻它被清掉，等新的算完再出现——
   * 上一程的馆子挂在这一程不是过期，是错。
   *
   * 缺省 = 后台还没算完（确认后的十几秒）/ 这次没算出来 / 修订之前的老行程。
   * 展示层不造推荐页，轮播退回单卡，不是空卡。
   * 老行程的兜底仍是读时补齐（网关 `?refreshPretrip=1` → `/internal/trip/highlights-refresh`），
   * 网关只在库里没有时才发那一跳。
   */
  destinationHighlights?: DestinationHighlights;
  /**
   * 正在导航（M31-01）。缺省 = 没在导航，端上显示行程模式。
   * 只由「出发」处置写入、「结束导航」清除；跨天自动作废（`tripPlanNavDay`）。
   */
  nav?: TripPlanNav;
  /**
   * 出发地 → 今天第一站这一段的高德驾车规划（2026-09-11，屏底状态栏的三格）。
   *
   * **读时算、不落库**：网关回 `/current` 时向 runtime 要一次（`/internal/trip/leg`），
   * runtime 走⑤环境缓存（地名→坐标 1h、规划 3 分钟）。它是"现在出发这一段怎么样"，
   * 与 `legs`（规划时按天拆的行车段）不是一回事。
   * 缺省 = 这次没算出来（没坐标 / 高德不可用 / 起点解析不出）——状态栏那三格显示「暂无」，
   * **不回落到任何常数**。
   */
  leg?: TripLeg;
  /**
   * 沿途服务（餐饮 / 卫生间 / 停车场 / 充电站 / 高速服务区）——行程详情抽屉那几格的数据源。
   *
   * **确认后后台算一次、写回这一行**（与 `destinationHighlights` 同一形态，`agent-runtime/src/graph/route-services.ts`）：
   * 一份三天行程约 30~50 次高德请求，串进确认那一跳不可接受，但不构成"不能落库"的理由。
   * 按**当天已解析坐标的停靠点**周边查（不沿折线均匀取样——高速段直线半径内的餐饮多在下道后的镇上，
   * 不可达），高速段以服务区为单位单独列名。
   *
   * 缺省 = 还没算完 / 这次没算出来 / 老快照——展示层保持「待查」。
   * 与之相对，`days[].food === 0` 是**查过了没有**（粤北山区那种真实结果），展示「0 个」。
   * `skeletonKey` 是按哪一版停靠点算的（`tripServicesKey`）：骨架变了这份就不作数，展示层退回「待查」。
   */
  services?: TripPlanServices;
  updatedTurnId: string;
}

/**
 * 地图上要画的一个服务点。**只带画得出来的那三个字段**——
 * 高德的 `id` 与 `typecode` 端上用不到，不进快照（快照是要落库、要随每轮读写的）。
 */
export interface ServicePoi {
  name: string;
  lat: number;
  lon: number;
}

/**
 * 每天每类最多存几条明细（M93-04）。
 *
 * 计数是"周边有多少"，明细是"图上画哪些"，二者**本来就可以不等**：
 * `food: 65` 配 `pois.food.length: 20` 是正常形态，展示层说"周边 65 个，图上是最近的 20 个"。
 * **计数不许改成 20**——那会把"查过了有 65 个"说成 20 个。
 *
 * 20 这个数来自体积：4 类 × 20 条 × 约 40 B ≈ 3.2 KB/天，一份 3 天行程让 `plan` 从约 6 KB
 * 涨到约 16 KB，仍远低于需要担心的量级。
 */
export const MAX_POIS_PER_CATEGORY = 20;

/** 某一天的沿途服务计数。每个计数**各自可缺省**：那一类目查询失败就缺省（待查），查过没有才是 0。 */
export interface TripPlanDayServices {
  day: number;
  /** 当天停靠点周边 `radiusM` 内的餐饮 POI 数（按 POI 去重）。 */
  food?: number;
  /** 公共厕所数。母婴室（高德 200304）不计入。 */
  restroom?: number;
  /** 停车场数。 */
  parking?: number;
  /**
   * 充电站数（M93-04）。
   *
   * 与 `TripPlanSnapshot.energyStops` **不是一回事**：那是 drive 分支**求解**出来的补能点
   * （"这一路要在哪儿充"），车没有实测续航时分支按纪律交空数组；这一项是**查**出来的
   * "当天停靠点周边有多少桩"，与要不要补能无关。从前这一格读的是前者，于是恒显「无需补能」。
   */
  charging?: number;
  /**
   * 逐类的 POI 明细，**按到当天停靠点的最近距离升序**、每类最多 `MAX_POIS_PER_CATEGORY` 条。
   *
   * 某类查到了但一条都没有时**不写该键**：计数说"有没有"，明细说"画哪些"，
   * 空数组与缺键在展示层是同一件事，少一个空数组少一份歧义。
   */
  pois?: {
    food?: ServicePoi[];
    restroom?: ServicePoi[];
    parking?: ServicePoi[];
    charging?: ServicePoi[];
  };
  /** 大交通高速段沿途的服务区名（去程落第 1 天）。没有高速段 / 没算出来则缺省。 */
  serviceAreas?: string[];
}

export interface TripPlanServices {
  /** ISO 时刻：这份是什么时候算的。 */
  computedAt: string;
  /** 停靠点周边查询半径（米）。展示"周边 3 公里"要念它，不要写死。 */
  radiusM: number;
  /** 按哪一版停靠点算的，见 `tripServicesKey`。 */
  skeletonKey: string;
  days: TripPlanDayServices[];
}

/**
 * 停靠点指纹：逐天的景点名与酒店名，外加出发地（高速段服务区按它算）。
 *
 * 两端各算一次、必须相等（后台写入时记下，展示时比对），所以它住在契约里而不是任一端。
 * 只看名字不看坐标：坐标回填是确认路径的副作用，同一版骨架前后两次解析结果可能有一两个点差异。
 */
export function tripServicesKey(plan: TripPlanSnapshot): string {
  const days = [...plan.skeleton]
    .sort((a, b) => a.day - b.day)
    .map((d) => `${d.day}:${d.spots.map((s) => s.name).join("|")}#${d.hotel?.name ?? ""}`);
  return `${days.join(";")}@${plan.origin ?? ""}`;
}

/**
 * 某一天的沿途服务；**骨架已经变了就当没有**（展示层退回「待查」，后台会按新骨架重算）。
 * 抽屉的编辑预览（挪景点、删景点）走的也是这条路：预览里的骨架与算时的对不上，格子如实变回待查。
 */
export function tripServicesForDay(plan: TripPlanSnapshot, day: number): TripPlanDayServices | undefined {
  const s = plan.services;
  if (!s || s.skeletonKey !== tripServicesKey(plan)) return undefined;
  return s.days.find((d) => d.day === day);
}

/**
 * 当天从**住处**开到第一站的车程（M83 走查追修）。
 *
 * # 它补的是哪个洞
 *
 * `TripPlanSnapshot.legs` 只描述**大交通**（去程上海 → 苏州、返程苏州 → 上海）——
 * `submit_drive_draft` 的 `legMinutes` 装的就是那一段。市内每天从酒店开到第一个景点
 * 的车程从没有人提交过，于是行程详情抽屉里第 2 天起的「从酒店出发」**永远没有时刻**
 * （用户 2026-09-14 走查原话："第二天从酒店出发也没有出发时间点"）。
 *
 * # 为什么是代码算而不是模型给
 *
 * 两组坐标之间开多久，是高德能 100% 确定的量，不是模型的决策——与坐标回填同一条纪律
 * （M13-06「代码解析不让 LLM 抄数字」）。而且**没有哪个分支手里有全部信息**：
 * 酒店是 hotel 分支定的、每天第一站是 tour 分支定的，只有汇聚之后才同时知道。
 *
 * 算的时机与坐标回填同一跳（确认路径，权限门之前）：那时两端坐标刚解析好、
 * 现成可用，且弹窗批的与落库的是同一份数据。
 *
 * # 只有第 2 天起有
 *
 * 第 1 天的出发时刻由 `legs` 的去程段倒推（那是大交通，本来就有数据），
 * 两处口径不重叠——同一件事有两个来源，迟早对不上。
 */
export interface TripPlanStartLeg {
  /** 从哪儿出发（前一晚的酒店名）。 */
  fromName: string;
  /** 车程分钟数。高德 `v5/direction/driving` 的 `cost.duration`，代码取整，模型不写。 */
  driveMinutes: number;
  /** ISO 时刻：这个数是哪一刻算的。路况会变，展示侧据此决定要不要标"预计"。 */
  computedAt: string;
}

/**
 * 当天最后一站开到**当晚住处**的车程（M83 走查追修）。
 *
 * 与 `TripPlanStartLeg` 对称：那个是「早上从哪儿出发」，这个是「晚上几点到酒店」。
 * 用户走查原话：「第一天第二天要住酒店的，最好把最后一个景点到酒店的时间也算出来，
 * 这样用户能方便地了解自己的时间安排」——没有它，时间轴末尾那一行只有「入住」
 * 两个字，一天什么时候结束是看不出来的。
 *
 * 同样由确认路径按坐标调高德算，代码算不让模型抄；只有**当天有酒店**的日子才有。
 */
export interface TripPlanEndLeg {
  /** 开到哪儿（当晚酒店名）。 */
  toName: string;
  /** 车程分钟数。高德 `v5/direction/driving` 的 `cost.duration`，代码取整。 */
  driveMinutes: number;
  /** ISO 时刻：这个数是哪一刻算的。 */
  computedAt: string;
}

/** 见 `TripPlanSnapshot.leg`。`road` 缺席 = 路况读不到（未知路段过半），不等于畅通。 */
export interface TripLeg {
  distanceKm: number;
  durationMin: number;
  road?: { label: string; status: "畅通" | "缓行" | "拥堵" };
  /** ISO 时刻，端上据此标"数据更新中"。 */
  computedAt: string;
}

// ── 真实地图停靠点（施工单 M13-06）───────────────────────────────────

/** 一处停靠：HUD 真实地图的标注单元。坐标缺省 = 只进列表不上图。 */
export interface TripPlanStop {
  name: string;
  /** 属于第几天（1 起）。 */
  day: number;
  kind: "spot" | "hotel" | "charging";
  /** 贴纸品类：spot 取快照的 poiKind（缺省=通用景点），hotel/charging 品类即身份。 */
  poiKind?: PoiKind;
  lat?: number;
  lon?: number;
  /** 建议时段（M34-02 透传 M34-01 的快照字段）；缺省 = 模型没给，端上回退排时。 */
  estStart?: string;
  estEnd?: string;
  /**
   * 该停靠覆盖的全部天（M34-02，仅 hotel 用）：连住去重后只有一个 marker，
   * 但标注必须如实——只写首日 `Day 1` 时，"D2 的酒店在哪"没有答案（用户走查原话）。
   * 缺省 = 单日模式或旧调用方。
   */
  days?: number[];
}

/**
 * 某一天（`day` 1 起）或全程（`day` 缺省）的有序停靠点。
 *
 * **单日 = 以酒店为闭环**（用户走查定的场景语义）：先到酒店（首日放行李 /
 * 末日退房寄存），再逐个景点，最后回酒店（取行李/落脚）——路线的"回环"由
 * 地图层画（closeLoop），这里只保证酒店在首位且只出现一次。
 * 当天没有酒店（纯往返日）就只有景点序列。
 *
 * 全程 = 逐天串联景点 + 每晚酒店按天挂尾；**连住同一家酒店只标一次**——
 * 重复标记会把地图糊住，且路线会在酒店上原地打转。
 */
export function tripPlanStops(plan: TripPlanSnapshot, day?: number): TripPlanStop[] {
  const days = [...plan.skeleton].sort((a, b) => a.day - b.day);
  if (day !== undefined) {
    const d = days.find((x) => x.day === day);
    if (!d) return [];
    const stops: TripPlanStop[] = [];
    if (d.hotel) {
      stops.push({ name: d.hotel.name, day: d.day, kind: "hotel", poiKind: "hotel", lat: d.hotel.lat, lon: d.hotel.lon });
    }
    for (const s of d.spots) {
      stops.push({
        name: s.name,
        day: d.day,
        kind: "spot",
        poiKind: s.poiKind ?? "spot",
        lat: s.lat,
        lon: s.lon,
        ...(s.estStart && s.estEnd ? { estStart: s.estStart, estEnd: s.estEnd } : {}),
      });
    }
    return stops;
  }
  const stops: TripPlanStop[] = [];
  // 连住去重保留（重复 marker 会把地图糊住），但标注要如实：先收齐每家酒店覆盖的天。
  const hotelDays = new Map<string, number[]>();
  for (const d of days) {
    if (d.hotel) hotelDays.set(d.hotel.name, [...(hotelDays.get(d.hotel.name) ?? []), d.day]);
  }
  const seenHotels = new Set<string>();
  for (const d of days) {
    for (const s of d.spots) {
      stops.push({
        name: s.name,
        day: d.day,
        kind: "spot",
        poiKind: s.poiKind ?? "spot",
        lat: s.lat,
        lon: s.lon,
        ...(s.estStart && s.estEnd ? { estStart: s.estStart, estEnd: s.estEnd } : {}),
      });
    }
    if (d.hotel && !seenHotels.has(d.hotel.name)) {
      seenHotels.add(d.hotel.name);
      stops.push({
        name: d.hotel.name,
        day: d.day,
        kind: "hotel",
        poiKind: "hotel",
        lat: d.hotel.lat,
        lon: d.hotel.lon,
        days: hotelDays.get(d.hotel.name),
      });
    }
  }
  return stops;
}

/** 导航目标：今天第一站（M66-02 从车机端 `departure.ts` 上移，两端一份规则）。 */
export interface TripPlanNavTarget {
  lat: number;
  lon: number;
  name: string;
}

/**
 * 今天该去哪：今日（未开始按第 1 天）第一个带坐标的落点；
 * 今日全无坐标时退到全程第一个带坐标的。全程都没有 → undefined，
 * 调用方如实说"这份行程还没有可导航的坐标"，不编一个点。
 *
 * 出发卡（车机端）与出发导航规划（runtime `/internal/trip/nav-plan`）都用它——
 * 两处各写一份的话，卡上导去 A、方案却按 B 算休息点，而且零报错。
 */
export function tripPlanNavTarget(plan: TripPlanSnapshot, todayIso: string): TripPlanNavTarget | undefined {
  const idx = tripDayIndex(plan, todayIso);
  const day = (idx ?? 0) + 1;
  const candidates = [...tripPlanStops(plan, day), ...tripPlanStops(plan)];
  const hit = candidates.find((s) => s.lat !== undefined && s.lon !== undefined);
  return hit ? { lat: hit.lat!, lon: hit.lon!, name: hit.name } : undefined;
}

/**
 * 把天列表压成人读的范围标注（M34-02）：连续段并成 `Day 1–2`，
 * 非连续分开列 `Day 1、Day 3`（隔天回住同一家的真实形态，不假装连住）。
 */
export function formatDayRanges(days: readonly number[]): string {
  if (days.length === 0) return "";
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const d of sorted.slice(1)) {
    if (d === prev + 1) {
      prev = d;
      continue;
    }
    parts.push(start === prev ? `Day ${start}` : `Day ${start}–${prev}`);
    start = prev = d;
  }
  parts.push(start === prev ? `Day ${start}` : `Day ${start}–${prev}`);
  return parts.join("、");
}

/** 有没有可上真实地图的点（≥2 才画得出路线；1 个也允许标注）。 */
export function tripPlanHasCoords(plan: TripPlanSnapshot): boolean {
  return tripPlanStops(plan).some((s) => s.lat !== undefined && s.lon !== undefined);
}

// ── tripPlan → HudSnapshot 映射（施工单 M13-04）───────────────────────
//
// 全部确定性规则，放 shared 是因为网关返回的与座舱消费的必须是同一份契约，
// 且这些规则要能脱离 Tauri 单测。设计判据全文见
// 内部文档 映射规则」一节。

/**
 * 生活环锚位的**路径顺序**（clients/shared/ui RING_SEGMENTS：家→park→charge→rest→wetland）。
 * 多日行程按天序占位：第 1 天在 park 位、第 2 天在 charge 位……
 * 琥珀轨迹于是自然把整程串起来（定稿 HUD_light.png 的观感）。
 * 锚位只管**落位**，图标由 kind 决定（HudScreen 侧 KIND_SPRITE）——
 * 否则第 2 天的景点会顶着充电桩图标。
 */
const RING_ORDER = ["park", "charge", "rest", "wetland"] as const;

/** 今天是行程第几天（0 起）；行程已结束返回 null。无 startDate 按第 1 天。 */
export function tripDayIndex(plan: TripPlanSnapshot, todayIso: string): number | null {
  if (!plan.startDate) return 0;
  const start = Date.parse(plan.startDate);
  const today = Date.parse(todayIso);
  if (Number.isNaN(start) || Number.isNaN(today)) return 0;
  const diff = Math.floor((today - start) / 86_400_000);
  if (diff >= plan.days) return null; // 过期：卡片收起（调用方回落默认快照）
  return Math.max(0, Math.min(diff, plan.days - 1)); // 未开始按第 1 天预览
}

/**
 * 导航失效阈值（小时）。超过它的 `nav` 一律当没有。
 *
 * # 为什么按经过时长判，不按"是不是今天"
 *
 * `startedAt` 是 `toISOString()`，即 **UTC**。拿它的日期段与本地今天比，
 * 东八区早上 7 点出发（= UTC 前一天 23 点）会被判成"昨天的导航"当场作废——
 * 一次正常的早班出行，刚说完出发就退出了导航模式。
 *
 * 经过时长没有时区，所以判据用它。12 小时的取舍方向也是明确的：
 * 判松一点最坏是第二天早上屏幕还挂着跟车模式（说一声「结束导航」即可），
 * 判紧一点则是**开着车开着开着导航自己没了**——后者严重得多。
 */
export const NAV_MAX_AGE_H = 12;

/**
 * 正在导航第几天（1 起）；没在导航返回 undefined。
 *
 * 四种"不算在导航"一并收在这里，调用方只问一次：
 * 没有 nav / 行程不是 confirmed / 超过 `NAV_MAX_AGE_H` / day 落在行程天数之外。
 * 最后一条防的是行程被改短之后 nav 指向一个已经不存在的日子。
 */
export function tripPlanNavDay(plan: TripPlanSnapshot, nowIso: string): number | undefined {
  const nav = plan.nav;
  if (!nav || plan.status !== "confirmed") return undefined;
  if (!Number.isInteger(nav.day) || nav.day < 1 || nav.day > plan.days) return undefined;
  const started = Date.parse(nav.startedAt);
  const now = Date.parse(nowIso);
  // 时间戳解析不了就**不认这次导航**：拿不准的时候停在行程模式，不硬跟车。
  if (Number.isNaN(started) || Number.isNaN(now)) return undefined;
  if (now - started > NAV_MAX_AGE_H * 3_600_000) return undefined;
  return nav.day;
}

/**
 * 把已确认行程映射成 HUD 快照；**不该展示时返回 null**（未确认 / 已取消 / 已结束），
 * 由调用方回落默认快照——"收起"的落法是不渲染行程数据，不是渲染一张空卡。
 *
 * 站点是**整程概览**（用户走查修正，对齐定稿 HUD_light.png）：每天一个代表站点
 * （首个景点，无景点用当天酒店），按天序落在环的路径顺序上——编号即第几天，
 * 琥珀轨迹把 4 天串成一条路线。剩余锚位依次补末日酒店（终点收束光晕）与补能点。
 * 超过 4 天只显示前 4 天——HUD 是概览不是行程单；不足 4 个照常返回，
 * **不用占位假地点凑数**（真实性红线）。当天细节在右侧 tips 卡与对话层。
 *
 * energy/weather/assistantState 原样取 `base`——它们不来自行程。
 * 酒店**只上名字不上地址**（HUD 可视化边界：地点一律语义化名称）。
 */
export function tripPlanToHud(
  plan: TripPlanSnapshot,
  todayIso: string,
  base: HudSnapshot,
): HudSnapshot | null {
  if (plan.status !== "confirmed") return null;
  const dayIndex = tripDayIndex(plan, todayIso);
  if (dayIndex === null) return null;

  const today =
    plan.skeleton.find((d) => d.day === dayIndex + 1) ?? plan.skeleton[dayIndex] ?? plan.skeleton[0];
  if (!today) return null;

  // 每天一个代表站点，按天序占环位。
  const nodes: TripNode[] = [];
  const dayOf = (i: number) => plan.skeleton.find((d) => d.day === i + 1) ?? plan.skeleton[i];
  for (let i = 0; i < Math.min(plan.days, RING_ORDER.length); i += 1) {
    const d = dayOf(i);
    const repSpot = d?.spots[0];
    const rep = repSpot ?? (d?.hotel ? { name: d.hotel.name } : undefined);
    if (!rep) continue;
    nodes.push({
      anchor: RING_ORDER[nodes.length],
      name: rep.name,
      // 贴纸品类（M13-07）：景点用确认路径按高德 type 分出的 poiKind，
      // 缺省落通用景点贴纸——不按名字猜；代表点是酒店时品类即身份。
      kind: repSpot ? (repSpot.poiKind ?? "spot") : "hotel",
    });
  }
  // 剩余锚位：先补能点、后酒店——**酒店必须排最后**，
  // 终点收束光晕落在数组末位上，落脚处才是终点，不能是充电站。
  // 酒店取**最后一晚**的（回程日常无酒店，「末日的酒店」多数时候是空的）；
  // 已作代表点上环的不重复上。
  const lastHotel = [...plan.skeleton]
    .sort((a, b) => a.day - b.day)
    .reverse()
    .find((d) => d.hotel)?.hotel;
  const wantHotel = lastHotel !== undefined && !nodes.some((n) => n.name === lastHotel.name);
  const energyStop = plan.energyStops?.[0];
  if (energyStop && nodes.length < RING_ORDER.length - (wantHotel ? 1 : 0)) {
    nodes.push({ anchor: RING_ORDER[nodes.length], name: energyStop, kind: "charge" });
  }
  if (wantHotel && nodes.length < RING_ORDER.length) {
    nodes.push({ anchor: RING_ORDER[nodes.length], name: lastHotel.name, kind: "hotel" });
  }
  if (nodes.length === 0) return null; // 整程一个真实地点都没有——没有可上环的数据

  /*
   * 提示卡只放**物品**，且 label 必须就是这张图标画的东西（M20-01 用户走查）。
   *
   * 这里曾经把「先到酒店放行李再出发」挂在水瓶图标上、把当天的天气备注挂在
   * 遮阳帽图标上。图标下的文字一显示出来，卡片就变成了「水瓶 = 放行李」——
   * 而且去重保留的是**先入的**那条，于是真正的「水」「遮阳帽」反被顶掉，
   * 三件物品的名字没有一件对得上图。
   *
   * 行李与天气备注是**行程内容**，归对话层与地图标注（同上一段的取舍）；
   * 它们要重新进这张卡，前提是先有对应的物品贴纸（行李箱 / 雨伞），
   * 而不是借用现有图标的位置。
   */
  /*
   * 分页原样沿用 base：物品清单在有无行程时是同一份，行程只换地图与站点。
   *
   * 这里原来会把整份清单摊平再按图标品类去重（M19-05：同一张图在一张卡上出现
   * 两三次）——那个重复来自上面那些借图标位的行程提示，它们已经不进来了。
   * 而摊平去重有个副作用：`base` 的第 2 页整页被吃掉，行程模式下这张卡永远单页，
   * 页码、圆点、滑动引导跟着一起消失。base 自己的每一页内部本就无重复图标。
   */
  return {
    trip: {
      origin: base.trip.origin,
      nodes,
      // 进度按天：已经过去的天数段更亮——这是行程日历意义上的"已抵达"，
      // 不是定位（HUD 不做导航，Brief §3.1）。
      activeSegment: Math.min(dayIndex, nodes.length),
    },
    energy: base.energy,
    tips: {
      /*
       * 卡片标题固定为「行前温馨提示」（M19-05 用户走查）。
       *
       * 这里原来写的是 `第N天 · 目的地`，于是同一张卡在有无行程时叫两个名字，
       * 而卡片的**职责**并没有变——它自始至终是 Brief §3.3 的物品提醒入口。
       * 行程进行到第几天由地图标记上的 `Day N` 与时刻承担，不必再占标题。
       */
      headline: "行前温馨提示",
      /*
       * 有 `pretripItems` 就用这次行程算出来的（M20-04），否则沿用 base 的基线清单。
       * 老快照没有这个字段——回落是**兼容**，不是降级，所以不加任何标记。
       *
       * 名字在这里查表补上：契约里没有名字，端上也不该自己编一个。
       * 表里没有的 key 直接丢（`tipItemsFromKeys` 负责），一个都不剩时同样回落——
       * 一张空卡比一张旧卡糟。
       */
      pages: withHighlightsPage(pretripPages(plan) ?? base.tips.pages, plan),
    },
    // 行程算出来的天气优先；老快照没有这个字段时回落基线（兼容路径，不加标记）。
    weather: plan.weather ?? base.weather,
    assistantState: base.assistantState,
    freshness: base.freshness,
    // 出发这一段（状态栏三格）：只有这一程带着才有，**不从 base 取**——base 里没有它，也不该有。
    ...(plan.leg ? { leg: plan.leg } : {}),
  };
}

/**
 * 物品页之后**按需追加**一页目的地推荐（M32-02）。
 *
 * 三段全空时一页都不加——`pages` 与没有推荐时**逐字段相等**，
 * 于是 `useCarousel(pages.length)` 自然退回单卡形态，页码与圆点跟着消失。
 * **不给"暂无推荐"留一页占位**：空卡比没有卡糟。
 */
function withHighlightsPage(pages: TipPage[], plan: TripPlanSnapshot): TipPage[] {
  const page = highlightsPage(plan.destinationHighlights);
  return page ? [...pages, page] : pages;
}

/** `pretripItems` → 分页物品；没有可展示的物品时返回 undefined（调用方回落基线）。 */
function pretripPages(plan: TripPlanSnapshot) {
  if (!plan.pretripItems?.length) return undefined;
  const items = tipItemsFromKeys(plan.pretripItems.map((i) => i.key));
  return items.length > 0 ? paginateTipItems(items) : undefined;
}
