/**
 * 工具统一注册表（施工单 M4-03，§10 要点 7 / FL-34 F-34-05）。
 *
 * **三个消费方共用这一份定义**（AC-34-9）：
 *   1. pi 注入 —— `enterprise/backend/pi-agents/.pi/extensions/` 调 `pi.registerTool`（M4-02）；
 *   2. MCP 包装 —— 对外暴露（POC 后，FL-34 F-34-08）；
 *   3. 单测 —— 脱离 Agent 与 LLM 直接测（AC-34-4）。
 *
 【权限门（M5-02 起生效）】
 * `sensitive: true` 的工具在执行前过 `/internal/guard/check`（§8.4）；
 * 只读工具**直接跳过**，零额外往返（§8.4 表第三行、F-27-09）。
 * 裁决点在 `agent-runtime/src/tools-endpoint.ts`——**工具自己不判断该不该执行**，
 * 那是安全边界的活，散到工具里迟早有一个忘了调。
 */

import { randomUUID } from "node:crypto";

import { POI_KINDS, WEATHER_KINDS } from "@carlife/shared";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { appointmentTool } from "./appointment";
import {
  dealerStoresTool,
  dealerSlotsTool,
  dealerPricingTool,
  testDriveBookTool,
} from "./dealer";
import { calendarTool } from "./calendar";
import { carCatalogTool } from "./car-catalog";
import { chargingTool } from "./charging";
import { contactLookupTool, contactUpdateTool } from "./contact";
import { refuelTool } from "./refuel";
import { costCalcTool } from "./cost-calc";
import { trimCompareTool } from "./trim-compare";
import { loanCalcTool } from "./loan-calc";
import { insuranceQuoteTool, THIRD_PARTY_TIERS } from "./insurance-quote";
import { repairHistoryTool, repairQuoteTool, repairStationsTool, repairSlotsTool } from "./repair";
import { insurancePolicyTool, insurancePrecheckTool } from "./insurance-claims";
// 轨迹概括复用⑤环境缓存的坐标取整：同一个精度口径只维护一处
import { roundCoord } from "./env-cache";
import type { ExternalTool, ToolCallContext } from "./external";
import { mapRouteTool } from "./map-route";
import { preferenceRecallTool } from "./memory";
import {
  submitDriveDraftTool,
  submitGuideAccessTool,
  submitGuideComfortTool,
  submitGuideSpotsTool,
  submitHotelsTool,
  submitNavPlanTool,
  submitTourDaysTool,
  submitTransitTool,
} from "./branch-submit";
import { webSearchTool } from "./web-search";
import { poiSearchTool } from "./poi-search";
import { routeAuditTool, type RouteAuditArgs, type RouteAuditResult } from "./route-audit";
import { destinationHighlightsTool } from "./destination-highlights";
import { pretripItemsTool } from "./pretrip-items";
import {
  tripPlanCommitTool,
  tripPlanCancelTool,
  tripPlanUpdateTool,
  tripPlanNavTool,
  tripPlanListTool,
  tripPlanQueryTool,
} from "./trip-plan-commit";
import { ragflowTool } from "./ragflow";
import { transitRouteTool } from "./transit-route";
import { dataFreshnessTool, type DataFreshnessArgs } from "./data-freshness";
import { energyGapTool, type EnergyGapArgs } from "./energy-gap";
import { refuelLogTool, type RefuelLogArgs } from "./refuel-log";
import { usageProfileTool } from "./usage-profile";
import { vehicleMemberTool } from "./vehicle-member";
import { memberPreferenceSetTool, type MemberPreferenceSetArgs } from "./member-preference";
import { cabinApplyPreferencesTool, type CabinApplyPreferencesArgs } from "./cabin-apply";
import { cabinStatusTool, type CabinVinArgs } from "./cabin-status";
import { cabinChildModeTool, cabinControlTool, type CabinControlArgs } from "./cabin-control";
import { CABIN_MEDIA_COMMANDS, cabinMediaTool, type CabinMediaArgs } from "./cabin-media";
import { vehicleProfileTool, vehicleProfileWriteTool } from "./vehicle-profile";
import { weatherTool } from "./weather";

export type AgentName =
  | "supervisor"
  | "buying"
  | "ownership"
  | "trip"
  | "cabin"
  | "service"
  // 试驾预约（M19-03，第六个业务 Agent）。
  // ⚠️ 这个联合类型在 `agent-runtime/src/acp-client/connection.ts` 有**第二份**，
  // 两处必须同步——只改一处的表现是 registry 编译红，而红的位置离改动很远。
  | "test-drive"
  // 多天行程 fan-out 的四个专家（M12）：只以 `-task` 会话形态被编排层驱动，无直达路由。
  | "drive"
  | "hotel"
  | "tour"
  | "transit"
  // 景区导游采集三分支（M36-01）：同 fan-out 形态（点击触发，无直达路由）。
  // access=停车/充电/加油与最后一公里；spots=必玩/打卡；comfort=休息/餐饮/厕所/避雷。
  | "guide-access"
  | "guide-spots"
  | "guide-comfort"
  // 出发导航规划（M66-01）：HTTP 触发（点「开始行程」）、只以 `nav-task` 会话被 runNavPlanFanout 驱动，
  // 无直达路由。名字不以 -task/-intent/-voice 结尾。与 connection.ts 的第二份必须同步。
  | "nav";

export interface ToolRegistration {
  name: string;
  description: string;
  /** 入参 schema：pi 注册与 MCP 暴露都要它 */
  schema: z.ZodTypeAny;
  /** 哪些 Agent 可用——依据 §4.3 能力映射表，不是所有 Agent 都拿到全部工具 */
  agents: readonly AgentName[];
  /** 敏感动作：执行前过权限门（§8.4）。只读工具为 false，根本不会调到权限门 */
  sensitive: boolean;
  /** 可否对外经 MCP 暴露——见 `listExposableForMcp` 的筛选规则 */
  mcpExposable: boolean;
  /**
   * 进系统提示词 `Available tools` 节的一行简介（M23-03）。
   *
   * pi 的规则是**不填就不进那一节**——工具只作为 schema 存在，模型在提示词里
   * 看不到它的存在感。所以 31 个工具全部必填（tools 测试守着），一行以内，
   * 讲"它是什么"；"怎么用/什么不能干"归 promptGuidelines。
   */
  promptSnippet: string;
  /**
   * 工具纪律 bullets，仅当该工具激活时进系统提示词 `Guidelines` 节（M23-03）。
   *
   * # 为什么纪律写在这里而不是各 Agent 的 prompts/*.md
   *
   * 纪律跟着工具走：哪个 Agent 拿到这个工具，哪个 Agent 就自动带上它的红线——
   * 写在 Agent prompt 里则是"声明面与授权面分家"，正是 INC-0009（drive 分支
   * prompt 点名了工具、ACL 没给）的根因土壤。
   *
   * # 格式硬约束（pi 文档明确警告）
   *
   * bullets 平铺进 Guidelines 节、无工具名前缀分组——"此工具"三个字模型分不清指谁。
   * **每条必须以 `` `tool_name` `` 开头**（tools 测试机械校验）。
   */
  promptGuidelines?: readonly string[];
  /**
   * 这次调用**在轨迹里怎么概括**（施工单 TD-08 追加，F-44-04 / AC-44-10）。
   *
   * # 为什么由每个工具自己声明，而不是上层统一序列化入参
   *
   * 入参里什么能进轨迹、什么不能，只有工具自己知道：
   * `weather` 的坐标取整到 1.1km 就够用且够钝，`appointment` 的联系方式
   * 一个字都不能进（它连给门店看的字段都是一张白名单，见 `describeDisclosure`）。
   * 交给上层"统一处理"必然要么过度脱敏到看不出区别，要么某天漏出一个不该漏的字段。
   *
   * # 不声明就什么都不放
   *
   * 缺省是安全的那一侧：轨迹里只有工具名与耗时。
   * 想看清"这五次调用差在哪"，就得**显式**为那个工具想清楚哪些字段可以露。
   *
   * 返回值要短（一行以内）、**不含用户原文**、且能区分同一轮里的多次调用。
   */
  /**
   * 落轨迹的一行概括。
   *
   * `result` 只在**成功之后**给（失败时 undefined）——只读工具常常需要记
   * "查到了几条"：没有它的话，回放页上"模型说没查到"分不清是工具真空
   * 还是模型没说。实测因此卡过一次排查（M13-12）。
   * 概括里放条数可以，**放命中内容不行**——那是用户隐私。
   */
  traceSummary?: (args: never, result?: unknown) => string;
  tool: ExternalTool<never, unknown>;
}

/**
 * 从工具返回里取"命中几条"。取不到就回 `?`——**不猜 0**：
 * "查到 0 条"与"不知道查到几条"在排查时是两个结论。
 */
function hitCount(result: unknown): string {
  const d = (result as { data?: { count?: unknown; plans?: unknown } } | undefined)?.data;
  if (typeof d?.count === "number") return String(d.count);
  if (Array.isArray(d?.plans)) return String(d.plans.length);
  return "?";
}

const weatherSchema = z.object({
  points: z
    .array(z.object({ name: z.string(), lat: z.number(), lon: z.number() }))
    .min(1)
    .describe("沿途取样点"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("目标日期，省略取今天"),
});

const pretripItemsSchema = z.object({
  points: z
    .array(z.object({ name: z.string(), lat: z.number(), lon: z.number() }))
    .describe("行程取样点（目的地/首日景点即可）。给空数组表示没有坐标，工具直接走兜底"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("出发日，省略取今天"),
});

const destinationHighlightsSchema = z.object({
  destination: z.string().min(1).describe("目的地名，如「舟山普陀山」"),
  date: z.string().optional().describe("出发日 2026-09-01 形状；只影响季节表述与缓存键"),
});

/** 地点：地名与经纬度二选一。做成"都可选 + refine"而不是 union，是因为 */
/** 模型给 union 的命中率明显低于给一个扁平对象。 */
const placeSchema = z
  .object({
    name: z.string().optional().describe("地名，如「深圳北站」"),
    lat: z.number().optional(),
    lon: z.number().optional(),
    city: z.string().optional().describe("地名多义时用它收敛，如「深圳」"),
  })
  .refine(
    (v) => Boolean(v.name?.trim()) || (typeof v.lat === "number" && typeof v.lon === "number"),
    { message: "地点必须给 name 或 (lat, lon)" },
  );

const mapRouteSchema = z.object({
  origin: placeSchema,
  destination: placeSchema,
  waypoints: z.array(placeSchema).max(16).optional(),
  strategy: z
    .enum(["default", "highway", "no_highway", "less_toll"])
    .optional()
    .describe(
      "算路策略：highway=高速优先，less_toll=少收费，no_highway=不走高速，default=高德推荐。" +
        "出发导航规划由编排层指定，照填即可；不传 = 高德推荐",
    ),
  maxLegMinutes: z
    .number()
    .int()
    .positive()
    .max(600)
    .optional()
    .describe(
      "单段行车时长上限（分钟）。**给了才会返回沿途休息点**——同行者有老人小孩时必须给",
    ),
  samplePoints: z
    .number()
    .int()
    .min(2)
    .max(8)
    .optional()
    .describe("沿途取样点数量，默认按里程自适应。取样点用来查沿途天气"),
});

const costCalcSchema = z.object({
  vehiclePrice: z.number().positive().describe("车价（元）"),
  energy: z.enum(["bev", "phev", "icev"]).describe("能源类型"),
  years: z.number().int().positive().optional(),
  assumptions: z
    .object({
      annualKm: z.number().positive().optional(),
      electricityPricePerKwh: z.number().positive().optional(),
      fuelPricePerLiter: z.number().positive().optional(),
      kwhPer100km: z.number().positive().optional(),
      litersPer100km: z.number().positive().optional(),
      insuranceRate: z.number().positive().optional(),
      maintenancePerYear: z.number().nonnegative().optional(),
      residualRatePerYear: z.number().positive().optional(),
      // ⚠️ 新增字段**必须写进这里**：zod 是 strip 模式，schema 里没有的键会被
      // 静默剥掉——表现是"传了、没生效、也不报错"。M20-02 的快照字段踩过同一个坑。
      insuranceFirstYear: z
        .number()
        .nonnegative()
        .optional()
        .describe("首年保险金额（元），一般来自 insurance_quote 的分项合计。给了就替代车价×费率"),
    })
    .partial()
    .optional()
    .describe("可覆盖的计算假设；未给的用默认值，默认值会原样出现在结果里"),
});

/**
 * 日历读写。**扁平对象 + refine，不用 discriminatedUnion**——与 `placeSchema` 同一条理由，
 * 但这里的代价比"命中率低"严重得多：
 *
 * `z.discriminatedUnion` 经 `zodToJsonSchema` 出来的顶层是 `{anyOf: [...]}`，**没有 `type: "object"`**。
 * 持有这个工具的 Agent 注册工具表时被上游拒掉，**该 Agent 的每一次 prompt 都返回空**——
 * 不是"日历调不了"，是**整个 Agent 哑掉**。
 *
 * 实测症状：trip 与 ownership（两个持有 calendar 的 Agent）任何问题都回空，
 * 而 supervisor / service / buying / cabin 一切正常。没有任何报错，
 * 排查方向会一路指向 ACP、pi、模型，唯独指不到这里。
 */
const calendarSchema = z
  .object({
    op: z.enum(["read", "write"]).describe("read=查忙闲；write=创建事件（需用户确认）"),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("op=read 时必填：起始日期"),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("op=read 时必填：结束日期"),
    events: z
      .array(
        z.object({
          title: z.string().min(1),
          start: z.string().min(1).describe("ISO 8601，如 2026-08-22T08:00:00+08:00"),
          end: z.string().min(1),
          location: z.string().optional(),
          note: z.string().optional(),
        }),
      )
      .min(1)
      .optional()
      .describe("op=write 时必填：要创建的事件"),
    account: z.string().optional(),
  })
  .refine((v) => (v.op === "read" ? Boolean(v.from && v.to) : (v.events?.length ?? 0) > 0), {
    message: "op=read 需要 from/to；op=write 需要至少一个 event",
  });

const ragflowSchema = z.object({
  query: z.string().min(1).describe("检索问题（自然语言）"),
  dataset: z
    .enum(["vehicle-manuals", "repair-kb", "car-catalog"])
    .optional()
    .describe("数据集；省略取该 Agent 的默认集。**指定了越权的集会被忽略而不是报错**"),
  topK: z.number().int().positive().max(20).optional(),
  vehicleModel: z
    .string()
    .optional()
    .describe("车型限定（如 Model 3 / 迈锐宝）。**多车型知识库里不传就会检索到别的车**"),
});

const energyGapSchema = z.object({
  distanceKm: z.number().positive().describe("本次行程里程（公里）"),
  consumption: z
    .object({
      value: z.number().positive(),
      unit: z.enum(["L", "%"]),
      source: z.enum(["measured", "rated"]),
      sampleSize: z.number().int().nonnegative().optional(),
      windowDays: z.number().int().positive().optional(),
    })
    .optional()
    .describe("每百公里消耗量与口径。**由编排层从⑥取**，不要自己编一个数"),
  currentLevel: z
    .object({ value: z.number().nonnegative(), unit: z.enum(["L", "%"]) })
    .optional()
    .describe("车主口述的当前余量。**系统没有实时油量/电量**，只能问他"),
  capacity: z
    .object({ value: z.number().positive(), unit: z.enum(["L", "%"]) })
    .optional()
    .describe("一次补满能加多少。不知道就不要传——不传时不给补能次数"),
});

const refuelLogSchema = z.object({
  userId: z.string().min(1).describe("用户 id。**必填**：跨用户混算是严重事故"),
  vin: z.string().optional(),
  at: z.number().optional().describe("加油时间（Unix 毫秒），省略取当前"),
  liters: z.number().positive().describe("这次加了多少升。**不是油箱容量，也不是剩余量**"),
  odometerKm: z.number().positive().describe("加油时的里程读数。**区间油耗全靠它**"),
  source: z.enum(["owner-stated", "dealer", "telemetry"]).optional(),
});

const dataFreshnessSchema = z.object({
  userId: z.string().min(1).describe("用户 id。**必填**：跨用户混算是严重事故"),
  vin: z.string().optional().describe("一人多车时限定车辆；省略取默认车"),
});

const usageProfileSchema = z.object({
  userId: z.string().min(1).describe("用户 id。**必填**：跨用户混算是严重事故"),
  vin: z.string().optional().describe("一人多车时限定车辆"),
  windowDays: z.number().int().positive().max(365).optional().describe("统计窗口天数，默认 30"),
});

const vehicleMemberSchema = z.object({
  userId: z.string().min(1).describe("用户 id。**必填**：跨用户读他人家属名单是严重事故"),
  action: z
    .enum(["list", "profile", "history", "set_cabin_preference"])
    .describe("list=名单 / profile=某人的用车事实 / history=与某人相关的行程 / set_cabin_preference=写座舱偏好（仅在车主复述确认后）"),
  vin: z.string().optional().describe("限定车辆；名单是挂在车上的"),
  memberId: z.string().optional().describe("profile / history / set_cabin_preference 必填"),
  windowDays: z.number().int().positive().max(365).optional(),
  preference: z.record(z.string(), z.unknown()).optional().describe("set_cabin_preference 的偏好载荷（{} = 清空）"),
});

const cabinOpSchema = z.object({
  domain: z.string().describe("设备域：climate/seat/ambientLight/media/fragrance（childMode 走 cabin_child_mode）"),
  zone: z.string().optional().describe("分区：driver/passenger/rearLeft/rearRight/cabin/front/rear；省略=该域全部分区"),
  set: z.record(z.string(), z.unknown()).describe("要设置的字段与值，如 {tempC: 23} / {heating: 2}"),
});

const memberPreferenceSchema = z.object({
  userId: z.string().optional().describe("车主（由系统注入）"),
  memberId: z.string().describe("常用人员 id，从 vehicle_member action=list 拿；**不要编**"),
  memberName: z.string().optional().describe("称呼，只用于确认弹窗显示"),
  preference: z
    .record(z.string(), z.unknown())
    .describe("偏好：tempC/tempMaxC/seatHeating/seatVentilation/ambientBrightness/mediaContentTag/mediaVolumeLimit；{} = 清空"),
});

const cabinApplySchema = z.object({
  userId: z.string().optional().describe("车主（由系统注入）"),
  vin: z.string().optional().describe("省略 = 默认车"),
  seating: z
    .record(z.string(), z.string())
    .describe("谁坐哪：zone → memberId。zone 取 driver/passenger/rearLeft/rearRight；id 从 vehicle_member 查名单拿"),
});

const cabinStatusSchema = z.object({
  userId: z.string().optional().describe("车主（由系统注入）"),
  vin: z.string().optional().describe("省略 = 默认车"),
});

const cabinControlSchema = z.object({
  userId: z.string().optional().describe("车主（由系统注入）"),
  vin: z.string().optional().describe("省略 = 默认车"),
  ops: z.array(cabinOpSchema).min(1).max(20).describe("一次下发的设置操作组"),
  requestId: z.string().optional().describe("幂等键；通常省略，由系统按轮次派生"),
});

const cabinMediaSchema = z.object({
  userId: z.string().optional().describe("车主（由系统注入）"),
  vin: z.string().optional().describe("省略 = 默认车"),
  command: z
    .enum(CABIN_MEDIA_COMMANDS)
    .describe(
      "list=看曲库有哪些歌；select=点歌（换掉当前队列）；enqueue=追加到队列尾不打断；" +
        "play/pause/next/previous/stop=播放控制；mode=设循环与随机",
    ),
  query: z
    .string()
    .optional()
    .describe("点歌关键字，曲名或艺人。select/enqueue 用；都不给 = 整个曲库"),
  trackIds: z
    .array(z.string())
    .optional()
    .describe("精确点歌，id 从 command=list 拿；**不要编**，编的会被拒"),
  repeat: z.enum(["off", "one", "all"]).optional().describe("mode 用：不循环/单曲/列表"),
  shuffle: z.boolean().optional().describe("mode 用：随机播放"),
});

const vehicleReadSchema = z
  .object({
    vin: z.string().min(17).max(17).optional().describe("17 位 VIN"),
    userId: z.string().optional().describe("按车主取默认车（F-23-09）"),
  })
  .refine((v) => Boolean(v.vin ?? v.userId), { message: "必须给 vin 或 userId" });

const vehicleWriteSchema = z.object({
  vin: z.string().min(17).max(17),
  op: z.enum(["maintenance", "repair", "odometer"]),
  at: z.number().optional().describe("发生时间（Unix 毫秒），省略取当前"),
  odometerKm: z.number().nonnegative().describe("当时的里程读数"),
  items: z.string().optional().describe("op=maintenance 时必填：保养项目"),
  symptom: z.string().optional().describe("op=repair 时必填：症状"),
  resolution: z.string().optional(),
  source: z
    .enum(["owner-stated", "dealer", "telemetry"])
    .optional()
    .describe(
      "这条事实是谁说的。**省略即 owner-stated（车主自述）**——" +
        "本工具的入参是从对话里抽出来的，而对话里的事实只能是车主说的。" +
        "标错来源的后果是下游会说「根据行驶记录」，而它其实建立在一句口述之上",
    ),
  sessionId: z.string().optional().describe("关联的问诊会话，供回看原图"),
});

const submitHotelsSchema = z.object({
  hotels: z
    .array(
      z.object({
        name: z.string().min(1).describe("**必填**：酒店全名（含门店后缀）"),
        address: z.string().optional(),
        area: z.string().optional().describe("对应草案里哪个片区（day.area），merge 按它挂 day"),
        rating: z.string().optional(),
        estPrice: z.string().optional().describe("价格一律估算口径，merge 侧会补「估算」标注"),
        note: z.string().optional(),
      }),
    )
    .describe("酒店候选；没查到就提交空数组并在 findings 里说明"),
  findings: z
    .array(z.string())
    .optional()
    .describe("查到的、hotels 装不下的事实（一句话带依据）；没查过的一个字都不要写"),
});

/** `HH:MM`（24 小时制）。形状挡在 schema 层，语义（同天单调递增）在 merge 侧再校一遍。 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const submitTourDaysSchema = z.object({
  destination: z.string().optional(),
  days: z
    .array(
      z.object({
        day: z.number().int().positive().optional(),
        theme: z.string().optional(),
        area: z.string().optional().describe("片区，hotel 候选按它对齐"),
        spots: z
          .array(
            z.object({
              name: z.string().min(1).describe("逐字取自 poi_search"),
              indoor: z.boolean().optional(),
              estStart: z
                .string()
                .regex(HHMM)
                .optional()
                .describe("建议开始时段 HH:MM（预计口径）——夜游/演出必须落在其真实时段，非全天日要铺满上午+下午"),
              estEnd: z.string().regex(HHMM).optional().describe("建议结束时段 HH:MM，晚于 estStart"),
            }),
          )
          .optional(),
        lodging: z
          .object({
            strategy: z
              .enum(["checkin-midday", "checkin-evening"])
              .describe("换酒店日策略：checkin-midday=上午玩完退房、新酒店入住后下午继续；checkin-evening=白天全程玩、晚上入住"),
            note: z.string().optional().describe("一句话说明，含行李处置（自驾=行李在车、非自驾=寄存）"),
          })
          .optional()
          .describe("仅换酒店日与到达日填；连住日不填"),
        rainBackup: z.string().optional().describe("雨天室内备选"),
      }),
    )
    .describe("逐天骨架；没排出来就提交空数组并在 findings 说明"),
  findings: z.array(z.string()).optional(),
});

const routeAuditPointSchema = z.object({
  name: z.string().min(1).describe("点名（逐字取自 poi_search / 已知行程）"),
  lat: z.number().optional().describe("有坐标必须带上（poi_search 给过）——省一次地理编码"),
  lon: z.number().optional(),
});

const routeAuditSchema = z.object({
  city: z.string().optional().describe("目的地城市（中文名）；缺坐标的点用它地理编码"),
  days: z
    .array(
      z.object({
        day: z.number().int().positive().optional().describe("第几天（1 起），后台对比按它对齐"),
        start: routeAuditPointSchema.optional().describe("当天出发锚点（酒店/当前位置），不参与重排"),
        end: routeAuditPointSchema.optional().describe("当天收尾锚点（当晚酒店），不参与重排"),
        points: z
          .array(routeAuditPointSchema)
          .min(1)
          .max(20)
          .describe("待检的点，按你当前排的顺序传入"),
      }),
    )
    .min(1)
    .max(14),
});

const submitTransitSchema = z.object({
  trains: z
    .array(z.object({ no: z.string().min(1).describe("车次，逐字取自 transit_route"), durationMin: z.number().optional(), costYuan: z.number().nullable().optional() }))
    .optional(),
  flightAdvice: z
    .object({ durationHint: z.string().optional(), priceEstimate: z.string().optional().describe("必须带「估算」口径"), note: z.string().optional() })
    .optional(),
  findings: z.array(z.string()).optional(),
});

const submitDriveDraftSchema = z.object({
  legMinutes: z.array(z.number()).describe("每段行车分钟数——硬约束求解的对象，没有就提交空数组"),
  stops: z.array(z.string()).optional().describe("休息停靠点，长度 = legMinutes.length - 1"),
  energyStops: z.array(z.string()).optional().describe("补能点，与 stops 分开"),
  rangeMarginPct: z.number().optional().describe("续航余量百分比；没算就省略，不要编"),
  findings: z.array(z.string()).optional(),
});

// ── 出发导航规划的提交 schema（M66-01）。途经点只能取自 map_route 返回的 restStops，汇聚层按名字+坐标全等校验。 ──

const submitNavPlanSchema = z.object({
  strategy: z
    .enum(["default", "highway", "no_highway", "less_toll"])
    .describe("本次实际用于 map_route 的策略（编排层给的那个，原样回填）"),
  waypoints: z
    .array(
      z.object({
        name: z.string().min(1).describe("休息点名字，**逐字取自 map_route 的 restStops[].name**"),
        lat: z.number().describe("逐字取自 restStops[].lat；对不上会被汇聚层丢弃"),
        lon: z.number().describe("逐字取自 restStops[].lon"),
        atMinute: z.number().optional().describe("距出发约多少分钟（取 restStops[].atMinute）"),
        reason: z.string().optional().describe("为什么选它（一句话，针对同行者的需要）"),
      }),
    )
    .max(16)
    .describe("按行驶顺序的途中休息点；总时长不超过单段上限时提交空数组"),
  legMinutes: z
    .array(z.number())
    .describe("每段行车分钟数（休息点把路线切成 waypoints.length+1 段），来自 map_route 的真实数据，禁止编造"),
  findings: z.array(z.string()).optional(),
});

// ── 景区导游采集三分支的提交 schema（M36-01）。字段清单 = 该分支的结论形状。 ──

const guideSourceUrl = z
  .string()
  .optional()
  .describe("出处链接，**逐字复制自 web_search 结果清单**；改写/截断的会在汇聚层被丢弃");

const submitGuideSpotsSchema = z.object({
  spot: z.string().optional().describe("景区名"),
  spots: z
    .array(
      z.object({
        name: z.string().min(1).describe("必玩点/打卡点名字；有 poi_search 命中时逐字取自它"),
        location: z.string().optional().describe("位置（景区内相对位置或地址）"),
        reason: z.string().optional().describe("一句推荐理由"),
        sourceUrl: guideSourceUrl,
        platform: z
          .string()
          .optional()
          .describe("走红的社交平台（如实写；汇聚层以出处域名为准，对不上不展示）"),
        sourceDate: z
          .string()
          .optional()
          .describe("来源时间（页面所述）；抽不到就省略，**禁止编日期**"),
        lat: z.number().optional().describe("poi_search 给过坐标就带上（名字对得上才带）"),
        lon: z.number().optional(),
        mustSee: z.string().optional().describe("一句必看内容（到了这个点看什么）"),
        kind: z.enum(["spot", "photo"]).optional().describe("spot=游玩点；photo=打卡拍照点"),
      }),
    )
    .describe("必玩点/打卡点；没查到就提交空数组并在 findings 说明"),
  transportAdvice: z.string().optional().describe("园内代步设施建议（索道/观光车/摆渡船），查到才写"),
  routeAdvice: z.string().optional().describe("游玩方向/避峰建议（一句话）"),
  findings: z.array(z.string()).optional(),
});

const submitGuideAccessSchema = z.object({
  parking: z
    .array(
      z.object({
        name: z.string().min(1).describe("停车场名，逐字取自 poi_search"),
        address: z.string().optional(),
        distanceToGateMeters: z
          .number()
          .optional()
          .describe("到景区入口的距离（米，估算口径——汇聚层会补「估算」标注）"),
        toGate: z.string().optional().describe("从这里怎么到景区入口（步行X分钟/摆渡车/索道…）"),
        note: z.string().optional(),
        sourceUrl: guideSourceUrl,
        lat: z.number().optional(),
        lon: z.number().optional(),
      }),
    )
    .describe("停车场候选；没查到就提交空数组并在 findings 说明"),
  charging: z
    .array(z.object({ name: z.string().min(1), address: z.string().optional(), note: z.string().optional(), lat: z.number().optional(), lon: z.number().optional() }))
    .optional()
    .describe("景区周边充电站（纯电/插电车主用）"),
  refuel: z
    .array(z.object({ name: z.string().min(1), address: z.string().optional(), note: z.string().optional(), lat: z.number().optional(), lon: z.number().optional() }))
    .optional()
    .describe("景区周边加油站"),
  arrivalAdvice: z.string().optional().describe("自驾到达建议（一两句：停哪儿、怎么进景区）"),
  findings: z.array(z.string()).optional(),
});

const submitGuideComfortSchema = z.object({
  entries: z
    .array(
      z.object({
        kind: z
          .enum(["rest", "food", "toilet", "pitfall"])
          .describe("rest=休息区；food=餐饮；toilet=厕所；pitfall=避雷踩坑"),
        name: z.string().optional().describe("点名/店名（有就写）"),
        note: z.string().min(1).describe("一句话内容（在哪、注意什么）"),
        sourceUrl: guideSourceUrl,
      }),
    )
    .describe("休息/餐饮/厕所/避雷条目；没查到就提交空数组并在 findings 说明"),
  findings: z.array(z.string()).optional(),
});

const webSearchSchema = z.object({
  query: z.string().min(1).describe("要搜什么，如「普陀山 必玩 打卡 小红书」「普陀山 停车 攻略」"),
});

const preferenceRecallSchema = z.object({
  userId: z.string().describe("**必填**：偏好必须带用户维度，跨用户混读是严重事故"),
  query: z.string().optional().describe("检索词；省略则取最近若干条"),
  limit: z.number().int().positive().max(20).optional(),
});

const chargingSchema = z.object({
  route: z
    .array(z.object({ name: z.string().optional(), lat: z.number(), lon: z.number() }))
    .min(2)
    .describe("路线取样点，按行进顺序"),
  rangeKm: z.number().positive().describe("满电续航（km），取自④车辆档案"),
  startSoc: z.number().gt(0).max(1).describe("出发时电量比例 0~1"),
  radiusM: z.number().int().positive().max(50_000).optional().describe("沿线搜索半径，默认 5000"),
  minPowerKw: z.number().positive().optional().describe("最低可接受功率（kW）"),
});

/**
 * 加油站检索。**没有 `rangeKm`/`startSoc` 这类入参**——
 * 燃油车这边我们没有实时油量，给不了"该在哪加"，只给"路过哪儿有"。见 `refuel.ts` 文件头。
 */
const poiSearchSchema = z.object({
  city: z
    .string()
    .min(1)
    .describe(
      "目标城市中文名，如「广州」「舟山」「杭州」。**必须是省/市/区县这一级的行政区名**——" +
        "景区名（「普陀山」）与片区名（「西溪」「西湖湖滨」）不是行政区，填了会一条都查不到；" +
        "片区要限定就写进 keywords（city=杭州、keywords=西溪 湿地）",
    ),
  keywords: z.string().optional().describe("追加关键词，如「亲子」「珠江新城」「西溪 湿地」"),
  category: z
    .enum(["hotel", "attraction", "parking", "charging_station", "gas_station"])
    .describe(
      "hotel=住宿；attraction=景点；parking=停车场；charging_station=充电站；gas_station=加油站" +
        "（后三类是 M36-01 为景区到达面加的，按点位周边搜时 keywords 带上景区名）",
    ),
  limit: z.number().int().min(1).max(20).optional().describe("返回条数上限，默认 8"),
});

const transitRouteSchema = z.object({
  fromCity: z.string().min(1).describe("出发城市中文名"),
  toCity: z.string().min(1).describe("到达城市中文名"),
});

const refuelSchema = z.object({
  route: z
    .array(z.object({ name: z.string().optional(), lat: z.number(), lon: z.number() }))
    .min(2)
    .describe("路线取样点，按行进顺序"),
  everyKm: z.number().positive().max(500).optional().describe("沿线取点间隔（km），默认 100"),
  radiusM: z.number().int().positive().max(50_000).optional().describe("沿线搜索半径，默认 5000"),
});

const carCatalogSchema = z.object({
  query: z.string().min(1).describe("检索词，如「20 万以内纯电 SUV 续航」"),
  models: z.array(z.string()).optional().describe("限定车型；比较场景传多个"),
  limit: z.number().int().positive().max(20).optional(),
});

/*
 * 经销商四件套（M19-02）。
 *
 * **`testDriveBookSchema` 里没有 `storeName`、没有自由时间字符串**——这是防编的地基：
 * 模型只能填从 dealer_stores / dealer_slots 拿回来的 id，编一个 slotId 会被 404 拒掉。
 * 在此之前 appointment 收的是三个自由字符串，"深圳南山特斯拉中心"就是那么来的。
 */
const dealerStoresSchema = z.object({
  model: z.string().min(1).describe("车型，如「Model Y」"),
  city: z.string().optional().describe("城市中文名，如「深圳」"),
  district: z.string().optional().describe("区，如「南山」——车主常按区找店"),
  near: z
    .object({ lat: z.number(), lon: z.number() })
    .optional()
    .describe("参考坐标；给了就按距离升序并返回 distanceKm"),
  type: z.enum(["experience", "service"]).optional().describe("默认 experience（试驾在体验店）"),
});

const dealerSlotsSchema = z.object({
  storeId: z.string().min(1).describe("门店 id，**必须来自 dealer_stores**"),
  model: z.string().min(1),
  from: z.string().optional().describe("起始日期 YYYY-MM-DD，缺省为明天"),
  to: z.string().optional().describe("结束日期 YYYY-MM-DD，缺省为明天起 14 天"),
});

const dealerPricingSchema = z.object({
  model: z.string().min(1),
  trim: z.string().optional().describe("配置名；精确命中优先，半截词走模糊匹配"),
});

const insuranceQuoteSchema = z.object({
  vehiclePrice: z.number().positive().describe("车价（元）"),
  energy: z.enum(["bev", "phev", "icev"]).describe("能源类型；新能源才有电池与充电桩附加"),
  seats: z.number().int().min(1).max(9).optional().describe("座位数，决定交强险档位。缺省按 5 座"),
  thirdPartyCoverage: z
    .union([z.literal(100), z.literal(200), z.literal(300)])
    .optional()
    .describe("三者险保额档位（万元）。不给就三档都给——**不要自己合并成一个数**"),
  assumptions: z
    .object({
      compulsory: z.number().positive().optional(),
      damageRateLow: z.number().positive().optional(),
      damageRateHigh: z.number().positive().optional(),
      passengerPerSeatLow: z.number().nonnegative().optional(),
      passengerPerSeatHigh: z.number().nonnegative().optional(),
    })
    .partial()
    .optional()
    .describe("可覆盖的系数；未给的用默认值，默认值会带 source:assumed 原样出现在结果里"),
});

const loanCalcSchema = z.object({
  vehiclePrice: z.number().positive().describe("车价（元）"),
  downPayment: z.number().nonnegative().optional().describe("首付金额（元）。与 downPaymentRatio 二选一"),
  downPaymentRatio: z
    .number()
    .positive()
    .max(1)
    .optional()
    .describe("首付比例，0~1（三成写 0.3）。与 downPayment 二选一"),
  months: z.number().int().positive().describe("期数（月）。三年写 36"),
  annualRate: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "年利率（百分数，4.5% 写 4.5）。**车主没说就别填**——不填会走标注为「假设」的示例档位，" +
        "自己编一个利率会让整份月供看起来像报价",
    ),
});

const trimCompareSchema = z.object({
  models: z
    .array(z.string().min(1))
    .min(1)
    .max(4)
    .describe("要比的车型。给 1 个＝同车型配置摊开；给 2 个及以上＝跨车型对齐（取前两个成对）"),
  trims: z
    .array(z.string().min(1))
    .optional()
    .describe("只看这几个配置。**要用报价系统里的规范配置名**，半截词请先问清楚，不要自己拼"),
  priceFloorCny: z
    .number()
    .positive()
    .optional()
    .describe("整车价下界，由编排层注入，模型不用填"),
});

/**
 * 联系方式两件套（M19-06）。
 *
 * `userId` 都是**可选**：由 `tools-endpoint` 从会话反查注入。
 * 写成必填会重演 `vehicle_member` 的处境——模型根本不知道 userId 是什么，
 * 于是那个工具事实上只有子图在调，注册给模型的那一半是空的。
 */
const contactLookupSchema = z.object({
  userId: z.string().optional().describe("由编排层注入，模型不用填"),
  who: z.string().optional().describe("找谁：称呼或关系（\"妈妈\"）。**不填=车主本人**"),
  vin: z.string().optional().describe("限定车辆；人员是挂在车上的"),
});

const contactUpdateSchema = z.object({
  userId: z.string().optional().describe("由编排层注入，模型不用填"),
  memberId: z.string().min(1).describe("**必须来自 contact_lookup**——不能自己编一个 id"),
  phone: z
    .string()
    .min(1)
    .describe("手机号。车主原话即可，中文口语数字（幺八七…）也认；**认不出会拒收，不要补位**"),
});

const testDriveBookSchema = z
  .object({
    storeId: z.string().min(1).describe("**必须来自 dealer_stores**"),
    slotId: z.string().min(1).describe("**必须来自 dealer_slots**——编一个会被门店系统拒掉"),
    model: z.string().min(1),
    trim: z.string().optional(),
    // contact 是**外发白名单**：不在这里的字段没有出口能到门店（F-26-09）
    contact: z
      .object({
        name: z.string().min(1).describe("称呼，姓氏 + 先生/女士即可"),
        phone: z.string().min(1).describe("手机号，门店回拨用"),
        note: z.string().optional().describe("备注，由用户自己填，不代拟"),
      })
      .optional()
      .describe("将提供给门店的信息——确认弹窗会逐项列出。**档案里有号时用 memberId，不要填这里**"),
    /**
     * 走档案里已登记的联系方式（M19-06）。
     *
     * 给了它就**不需要也不应该**再填 `contact`：真号由工具层按 id 自己去库里取，
     * 全程不经过模型。`contact_lookup` 只给后四位就是为了这条路成立。
     */
    memberId: z.string().optional().describe("**必须来自 contact_lookup**——档案里的人员 id"),
    userId: z.string().optional().describe("由编排层注入，模型不用填"),
    idempotencyKey: z.string().optional(),
  })
  .refine((v) => Boolean(v.contact ?? (v.memberId && v.userId)), {
    message: "要么给 contact，要么给 memberId（配 userId）——门店回拨不到人等于没约",
  });

const repairVinSchema = z.object({
  vin: z.string().min(11).describe("车辆 VIN——**必须来自 vehicle_profile 或当前车辆上下文**，不要编"),
});

const repairStationsSchema = z.object({
  city: z.string().optional().describe("城市（可省略=全部维修站）"),
});

const repairSlotsSchema = z.object({
  stationId: z.string().min(1).describe("**必须来自 repair_stations**"),
});

const appointmentSchema = z
  .object({
    kind: z.enum(["test_drive", "service"]).describe("试驾 or 维修"),
    storeId: z.string().min(1),
    storeName: z.string().min(1),
    at: z.string().describe("期望时间，ISO 8601 带时区"),
    // contact 是**外发白名单**：不在这里的字段没有出口能到门店（F-26-09）
    contact: z
      .object({
        name: z.string().min(1).describe("称呼，姓氏 + 先生/女士即可"),
        phone: z.string().min(1).describe("手机号，门店回拨用"),
        note: z.string().optional().describe("备注，由用户自己填，不代拟"),
      })
      .optional()
      .describe("将提供给门店的信息——确认弹窗会逐项列出。**档案里有号时用 memberId，不要填这里**"),
    // 档案路（M44-01，平移自 test_drive_book 的 M19-06 形态）：真号由工具层按 id 取，不经模型。
    memberId: z.string().optional().describe("**必须来自 contact_lookup**——档案里的人员 id"),
    userId: z.string().optional().describe("由编排层注入，模型不用填"),
    subject: z.string().min(1).describe("试驾：车型；维修：预估项目"),
    idempotencyKey: z.string().optional().describe("同一次确认重复提交不下两单"),
  })
  .refine((v) => Boolean(v.contact ?? (v.memberId && v.userId)), {
    message: "要么给 contact，要么给 memberId（配 userId）——门店回拨不到人等于没约",
  });

/**
 * 行程确认落库的入参（M13-01）。
 *
 * 真实性红线在 schema 层再守一遍（确认落库是最后一道门，脏数据过了就上 HUD）：
 * `estPrice` 若存在必含「估」——M12 的"估价恒带估算标注"不赌模型守规矩，
 * 汇聚层补了一次（markEstimate），这里拒收漏网的。
 */
const estimatePrice = z
  .string()
  .refine((s) => /估/.test(s), { message: "估价必须带「估算」字样（M12 真实性红线）" });

const tripPlanSnapshotSchema = z.object({
  status: z.enum(["skeleton", "refining", "confirmed", "cancelled"]),
  origin: z.string().optional(),
  destination: z.string().min(1, "行程缺目的地"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.number().int().min(1),
  party: z.string().optional(),
  skeleton: z
    .array(
      z.object({
        day: z.number().int().min(1),
        date: z.string().optional(),
        theme: z.string(),
        area: z.string().optional(),
        spots: z.array(
          z.object({
            name: z.string().min(1),
            indoor: z.boolean().optional(),
            note: z.string().optional(),
            // 真实坐标（M13-06）：zod 是 strip 模式，这里不声明就会在落库时被
            // 静默剥掉——地图永远空，而链路看起来完全正常。
            lat: z.number().optional(),
            lon: z.number().optional(),
            // 贴纸品类（M13-07）：同上，不声明就会被 strip 掉，HUD 永远只有通用贴纸。
            poiKind: z.enum(POI_KINDS).optional(),
            // 建议时段（M34-01）：同一个坑的**第四次**——不声明，落库时被静默剥掉，
            // 症状是"三层提示词都加了、模型像是不配合"，实际字段死在这一行之前。
            estStart: z.string().regex(HHMM).optional(),
            estEnd: z.string().regex(HHMM).optional(),
          }),
        ),
        hotel: z
          .object({
            name: z.string().min(1),
            address: z.string().optional(),
            area: z.string().optional(),
            rating: z.string().optional(),
            estPrice: estimatePrice.optional(),
            lat: z.number().optional(),
            lon: z.number().optional(),
          })
          .optional(),
        // 住宿策略（M34-01）：同上，不声明即被 strip。
        lodging: z
          .object({
            strategy: z.enum(["checkin-midday", "checkin-evening"]),
            note: z.string().optional(),
          })
          .optional(),
        notes: z.array(z.string()).optional(),
      }),
    )
    .min(1, "行程骨架为空，没有可确认的内容"),
  transit: z
    .object({ recommended: z.enum(["drive", "train", "flight"]).optional(), summary: z.string() })
    .optional(),
  energyStops: z.array(z.string()).optional(),
  caveats: z.array(z.string()),
  /*
   * 行前物品（M20-04）：**不声明就会被 strip 掉**，症状是"图里带上了、库里没有"
   * 且全程零报错——与上面坐标、贴纸品类踩过的是同一个坑。
   * key 的值域交给 `@carlife/shared` 的契约表，这里只校验形状。
   */
  pretripItems: z
    .array(z.object({ key: z.string().min(1), reason: z.string().optional() }))
    .optional(),
  /** 这一程的天气（M20-05）：同样**不声明就会被 strip**，症状是图标永远回落太阳。 */
  weather: z.object({ kind: z.enum(WEATHER_KINDS), label: z.string().min(1) }).optional(),
  /*
   * 导航状态（M31-01）：**同样不声明就会被 strip**——这一栏被剥掉的症状是
   * 「导航中改了个景点，导航自己退了」。`trip_plan_nav` 自己不走这个 schema
   * （它只动库里那一栏），但 `trip_plan_update` 走，原地改写会把整份快照换掉。
   */
  nav: z.object({ day: z.number().int().min(1), startedAt: z.string().min(1) }).optional(),
  /*
   * 目的地推荐（M32-02）：**同样不声明就会被 strip**。
   *
   * 它按设计是读时补齐、不落库的，所以走 commit 这条路时**本来就该是缺省的**——
   * 声明它是为了 `trip_plan_update`：那条会原地改写整份快照，
   * 带着推荐的快照过一遍它就被剥空了，症状是"推荐卡显示了几秒又没了"。
   */
  destinationHighlights: z
    .object({
      destination: z.string(),
      foods: z.array(
        z.object({
          name: z.string(),
          note: z.string(),
          sourceUrl: z.string().optional(),
          sourceTitle: z.string().optional(),
        }),
      ),
      spots: z.array(
        z.object({
          name: z.string(),
          note: z.string(),
          sourceUrl: z.string().optional(),
          sourceTitle: z.string().optional(),
        }),
      ),
      photoTips: z.array(z.object({ spot: z.string(), tip: z.string() })),
      computedAt: z.string(),
    })
    .optional(),
  updatedTurnId: z.string(),
});

/*
 * 行程五件套的入参（M13-11 拆分）。
 *
 * `userId` 一律 `.min(1)` 但**模型填的不作数**——pi 路径由 tools-endpoint 的
 * `withUserId` 用会话身份覆盖。留着这个字段是因为子图直调时要自己带。
 */
const tripPlanCommitSchema = z.object({
  userId: z.string().min(1),
  plan: tripPlanSnapshotSchema,
  idempotencyKey: z.string().optional(),
});

const tripPlanCancelSchema = z.object({
  userId: z.string().min(1),
  /** 不给就取消最近确认的那一份（语音「行程取消掉」走这条）。 */
  planId: z.string().min(1).optional(),
});

const tripPlanUpdateSchema = z.object({
  userId: z.string().min(1),
  planId: z.string().min(1),
  plan: tripPlanSnapshotSchema,
});

const tripPlanNavSchema = z.object({
  userId: z.string().min(1),
  /** 导航第几天（1 起）；**null = 结束导航**（`nullable` 不是 `optional`：缺席不等于结束）。 */
  day: z.number().int().min(1).nullable(),
  planId: z.string().min(1).optional(),
});

const tripPlanListSchema = z.object({
  userId: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});

const tripPlanQuerySchema = z.object({
  userId: z.string().min(1),
  /** 目的地关键字，包含匹配。 */
  destination: z.string().min(1).optional(),
  /** 出发日区间，`YYYY-MM-DD`，闭区间。 */
  startFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  minDays: z.number().int().min(1).optional(),
  maxDays: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const TOOL_REGISTRY: readonly ToolRegistration[] = [
  {
    name: "calendar",
    promptSnippet: "读写车主日历：查忙闲片段、写行程与提醒事件（写需用户确认）",
    promptGuidelines: [
      "`calendar` 读只返回时间与忙闲、不含日程标题；写属敏感动作会触发用户确认，未确认前不得宣称\"已写入日历\"",
    ],
    description:
      "日历读写。读：查询指定日期范围的忙闲片段（只返回时间与忙闲，**不返回日程标题**）；写：创建行程或提醒事件（需用户确认）。",
    schema: calendarSchema,
    // §5：挂在出行规划与用车助手上，**不挂在购车/售后的预约流程**。
    agents: ["trip", "ownership"],
    // 写日历是"有后果但合法"的动作 → §8.4 需确认档。
    sensitive: true,
    // 涉及用户私有数据与副作用，**不对外暴露**（F-34-09）。
    mcpExposable: false,
    tool: calendarTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "weather",
    promptSnippet: "按取样点与日期查沿途逐段天气",
    promptGuidelines: [
      "`weather` 只覆盖今天起约 7 天，窗口外的日期不要预报，如实说明\"临近再查\"",
    ],
    description: "查询沿途逐段天气（按取样点与日期）。返回气温、降水与天气代码，不下结论。",
    schema: weatherSchema,
    // §4.3③ 出行规划的工具；Supervisor 也留着，便于单 Agent 阶段验证注入链路。
    // drive/tour 是多天行程 fan-out 的两个分支，**各自的 prompt 都点名要 `weather`**
    // （drive 查沿途天气、tour 用它决定哪天配雨天备选）。此前没给：模型手上没有这个工具，
    // 也不会说"我查不到"，它会照着常识写一段天气——见本文件末尾 ACL 与 prompt 的一致性说明。
    agents: ["trip", "supervisor", "drive", "tour"],
    sensitive: false,
    mcpExposable: true,
    /*
     * 坐标取整到 `roundCoord` 的 1.1km——天气在这个尺度上没差别，
     * 而这个精度既能把同一轮里的多次调用区分开，又钝到不构成位置追踪。
     * 点名（"黄山"）**不放**：那是用户原文或模型对用户原文的复述。
     */
    traceSummary: (a: never) => {
      const { points, date } = a as z.infer<typeof weatherSchema>;
      const head = points[0];
      const where = head ? `${roundCoord(head.lat)},${roundCoord(head.lon)}` : "?";
      return `${points.length} 点 · 首点 ${where}${date ? ` · ${date}` : ""}`;
    },
    tool: weatherTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "pretrip_items",
    promptSnippet: "按这次行程的天气推荐要带的物品",
    promptGuidelines: [
      "`pretrip_items` 取不到天气时返回常备件且 weatherAvailable=false，此时不得说\"根据天气\"",
    ],
    description:
      "按这次行程的天气推荐要带的物品（遮阳帽/防晒霜/水/雨伞/薄外套/墨镜/保温杯/口罩）。已去重、按优先级排序、最多 6 件；**取不到天气时返回常备三件并置 weatherAvailable=false，此时不得说「根据天气」**。",
    schema: pretripItemsSchema,
    // §4.3③ 出行规划这一路：骨架四专家里 tour/drive 会用到，主 Agent 也留着。
    agents: ["trip", "tour", "drive"],
    sensitive: false,
    mcpExposable: true,
    /*
     * 轨迹只记**点位数量 + 日期**，不记坐标——weather 那条记了取整坐标是因为
     * 它要能分辨"同一轮里查的是不是同一个地方"；本工具是它的下游，
     * 再记一遍等于把同一个位置写进轨迹两次。
     */
    traceSummary: (a: never) => {
      const { points, date } = a as z.infer<typeof pretripItemsSchema>;
      return `${points.length} 点${date ? ` · ${date}` : ""}`;
    },
    tool: pretripItemsTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "destination_highlights",
    promptSnippet: "目的地的美食排行榜、网红打卡点与拍照建议（实时联网搜索）",
    promptGuidelines: [
      "`destination_highlights` 的每条推荐都来自实时联网搜索；**没有 `source` 的条目不要说\"据小红书/据某某\"**，只说内容本身",
    ],
    description:
      "查这个目的地当下的美食排行榜、网红打卡点与对应的拍照建议（经模型内置联网搜索，实时）。各最多 3 条；**每条的 `source` 只有能与搜索结果对上时才有值**，没有 source 就不要声称出处。取不到时抛错而不返回兜底数据——凭记忆的推荐不可信。",
    schema: destinationHighlightsSchema,
    // §4.3③ 出行规划这一路：出行主 Agent 与 fan-out 的 tour 专家。
    // drive/hotel/transit 给不出理由——它们不负责"到了那儿玩什么"。
    agents: ["trip", "tour"],
    sensitive: false,
    mcpExposable: true,
    /*
     * 轨迹只记目的地与日期，**不记 URL**：出处链接在轨迹里没有排障价值
     * （要核对出处该看返回值），而它会把整条轨迹撑大。
     */
    traceSummary: (a: never) => {
      const { destination, date } = a as z.infer<typeof destinationHighlightsSchema>;
      return `${destination}${date ? ` · ${date}` : ""}`;
    },
    tool: destinationHighlightsTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "map_route",
    promptSnippet: "驾车路线规划：总里程/时长/过路费、沿途取样点与服务区",
    promptGuidelines: [
      "`map_route` 不返回逐条转向指令——导航归车机原生应用；服务区的 qualityNote 未经核实，要如实转述",
    ],
    description:
      "驾车路线规划：返回总里程/时长/过路费、**沿途取样点**（可直接喂给 weather 查逐段天气）、" +
      "以及按 maxLegMinutes 推出的沿途高速服务区。可指定 strategy（高速优先 / 少收费 / 不走高速）。" +
      "**不返回逐条转向指令**——规划要的是几点到、中间在哪停，导航归车机原生 App。" +
      "服务区只按 POI 类型筛选，卫生间状况未核实，结果里的 qualityNote 要如实转述。",
    schema: mapRouteSchema,
    // §4.3③ 出行规划专属。**不给用车助手**：它做的是"这辆车能不能到"，
    // 路线是出行规划的活，跨 Agent 结果经 graph/ 汇聚（§11）。
    // drive 是这条规则的正例而非例外：它就是"多天行程的往返自驾两段"，
    // 分段、休息点、补能点全从 `map_route` 的取样点推出来——没有它整条分支只能靠编。
    // nav（M66-01）：出发那一跳的单程规划，休息点候选与策略都从这里来。
    agents: ["trip", "drive", "nav"],
    sensitive: false,
    // 无状态、不落用户数据，与 weather 同档（F-34-09 的筛选规则）。
    mcpExposable: true,
    tool: mapRouteTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "ragflow_retrieve",
    promptSnippet: "检索知识库，返回带出处的片段",
    promptGuidelines: [
      "`ragflow_retrieve` 的出处只能来自返回结果，不得自行编写或补充出处",
    ],
    description:
      "检索知识库并返回**带出处**的片段。出处由 RAGFlow 给出，不得自行编写。" +
      "跨数据集访问在调用层被拒——不是靠这段描述约束。",
    schema: ragflowSchema,
    // §4.3：用车助手查说明书、售后查维修库、购车查车型库。三集严格隔离。
    agents: ["ownership", "service", "buying"],
    sensitive: false,
    // 知识库内容本身可公开，但**检索行为带用户意图**，且 repair-kb 是模拟数据，
    // 对外暴露会被误当作真实厂商资料（F-24-11）。不暴露。
    mcpExposable: false,
    /*
     * **query 一个字都不放**——那是用户原文（或模型对它的改写），
     * 正是 AC-44-10 说的"指标系统不是绕过审计脱敏的后门"。
     * 放数据集与车型限定：它们才是排查检索问题时要看的两件事
     * （查错了库、没带车型限定），且都不是用户数据。
     */
    traceSummary: (a: never) => {
      const { dataset, topK, vehicleModel } = a as z.infer<typeof ragflowSchema>;
      return [
        dataset ?? "默认集",
        vehicleModel ? `限定 ${vehicleModel}` : "未限定车型",
        topK ? `top${topK}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
    },
    tool: ragflowTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "member_preference_set",
    promptSnippet: "登记某位常用人员的座舱偏好（需车主确认）",
    description:
      "把某位常用人员的座舱偏好记进档案（温度/温度上限/座椅加热通风/氛围灯/播放内容/音量上限）。" +
      "**执行前会请车主确认**，确认弹窗里会逐条列出要记的内容；被拒时如实告知未保存。" +
      "memberId 从 vehicle_member 查名单拿——编一个会被拒。",
    schema: memberPreferenceSchema,
    agents: ["cabin"],
    // 写用户家人的档案 → §8.4 需确认档。「确认前不落库」（AC-50-2）由权限门保证，
    // 不由模型自觉：此前靠编排层的正则时序，登记改 A 型后降到工具层用结构兑现。
    sensitive: true,
    mcpExposable: false, // 他人 PII（F-34-09 同档）
    promptGuidelines: [
      "`member_preference_set` 之前先用 `vehicle_member` 查名单拿 memberId，**不要凭称呼编 id**",
      "`member_preference_set` 会弹确认框，你不必自己先问一遍「要保存吗」——弹窗就是那句问话；被拒时说明未保存，不要追问原因",
      "`member_preference_set` 记的是**长期习惯**（「我妈坐车容易晕，温度别超 24」）；「现在调到 26」是这一次的设置，用 `cabin_control`，不要写进偏好",
    ],
    traceSummary: (a: MemberPreferenceSetArgs) => `${Object.keys(a.preference ?? {}).length} 项偏好`,
    tool: memberPreferenceSetTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "cabin_apply_preferences",
    promptSnippet: "按「今天谁坐哪」把各人的座舱偏好一次调好",
    description:
      "给定每个座位坐了谁，自动把各人登记过的座舱偏好调好：分区能分的各设各的，" +
      "共享的（媒体/香氛）按规则仲裁，这车做不到的如实列出。" +
      "返回逐项**因为谁**、没做到什么、仲裁了什么——播报时要按人说清楚。",
    schema: cabinApplySchema,
    agents: ["cabin"],
    // 舒适域批量设置，与 cabin_control 同档：执行后播报，不弹确认
    sensitive: false,
    mcpExposable: false,
    promptGuidelines: [
      "`cabin_apply_preferences` 的 seating 只收 memberId——先用 `vehicle_member` 查名单，**不要凭称呼编 id**",
      "`cabin_apply_preferences` 的返回里 attributions 说明每项设置因为谁、undone 是这车做不到的、arbitrations 是共享资源让给了谁——**三样都要念给车主**，别只报好消息",
      "`cabin_apply_preferences` 没命中组合时会自动回退成各人偏好叠加，这是正常路径，**不要对车主说「没找到组合」**",
    ],
    traceSummary: (a: CabinApplyPreferencesArgs) => `${Object.keys(a.seating ?? {}).length} 个座位`,
    tool: cabinApplyPreferencesTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "cabin_status",
    promptSnippet: "查车机能力表与座舱当前状态（只读）",
    description:
      "查询这辆车的车机能力（几温区/有无座椅通风/有无香氛等）与舒适域当前状态。" +
      "**回答\"这车有没有 X\"之前先查它**——能力因车型而异，不查就说等于编。",
    schema: cabinStatusSchema,
    agents: ["cabin"],
    sensitive: false,
    mcpExposable: false, // 车辆私有状态（F-34-09 同档）
    traceSummary: (a: CabinVinArgs) => (a.vin ? `vin=${a.vin.slice(-6)}` : "默认车"),
    tool: cabinStatusTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "cabin_control",
    promptSnippet: "下发舒适域设置：空调/座椅/氛围灯/媒体/香氛",
    description:
      "把一组舒适域设置下发到车机（空调温度风量、座椅加热通风按摩、氛围灯、媒体、香氛）。" +
      "返回逐字段裁决结果（applied/clamped/skipped）——**必须完整转述，部分成功不得说成全部成功**。",
    schema: cabinControlSchema,
    agents: ["cabin"],
    // 舒适域动作执行后播报、不弹确认（§4.3④ 2026-08-25 回填）；儿童模式在另一个工具
    sensitive: false,
    mcpExposable: false,
    promptGuidelines: [
      "`cabin_control` 的逐字段裁决必须完整转述：被夹到边界的说明边界值（\"最高 28 度，已调到 28\"），被跳过的说明原因（\"这款车后排没有通风\"）；部分成功不得表述为全部成功，跳过的字段不得沉默",
      "`cabin_control` 或 `cabin_status` 报车机没连上/未绑定时如实说明并引导，不编造设置结果、不说\"已经调好了\"",
      "`cabin_child_mode` 负责儿童模式（后排屏锁/音量上限/儿童锁上锁）——`cabin_control` 不收 childMode 域，它会先征得车主确认",
    ],
    traceSummary: (a: CabinControlArgs) =>
      `${a.ops?.length ?? 0} 项（${[...new Set((a.ops ?? []).map((o) => o.domain))].join("/")}）`,
    tool: cabinControlTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "cabin_child_mode",
    promptSnippet: "儿童模式设置（后排屏锁/音量上限/儿童锁上锁）——需车主确认",
    description:
      "设置儿童模式：锁定后排屏幕、设置音量上限、给儿童锁上锁。影响后排乘员的乘坐体验，" +
      "执行前会请车主确认。**儿童锁只能上锁**——解除需车内物理操作，任何一层都不提供远程解除。",
    schema: cabinControlSchema,
    agents: ["cabin"],
    // 影响第三人的动作 → §8.4 需确认档（M24-03 方案 B：门是工具名粒度，故独立成名）
    sensitive: true,
    mcpExposable: false,
    promptGuidelines: [
      "`cabin_child_mode` 的动作在确认弹窗通过后才会执行；被拒时如实告知未执行，不再重试",
      "`cabin_child_mode` 只能给儿童锁上锁——解除不要尝试也不要答应，那需要车内物理操作",
    ],
    traceSummary: (a: CabinControlArgs) => `${a.ops?.length ?? 0} 项 childMode`,
    tool: cabinChildModeTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "cabin_media",
    promptSnippet: "车内音乐：看曲库、点歌、播放/暂停/上一首/下一首",
    description:
      "车内音乐的选曲与播放控制。曲库是车机本地的，**只有曲库里有的才放得了**——" +
      "点不到时如实说没有，不要换一首顶上，也不要说\"正在为您播放\"。" +
      "返回里 `status` 只说明播放器状态，`audible` 才是**真有没有声音出来**；" +
      "两者不一致时（比如车机那台机器没有播放器件）按 audible 说。" +
      "音量与「要不要音乐这个音源」不归它，那两样走 cabin_control 的 media 域。",
    schema: cabinMediaSchema,
    agents: ["cabin"],
    // 放歌与调空调同档：执行后播报、不弹确认（§8.4 表第三行）。
    sensitive: false,
    mcpExposable: false, // 车辆私有状态（F-34-09 同档）
    promptGuidelines: [
      "`cabin_media` command=select 不带 query 就是整库随机——车主说「放首歌」「放点音乐」而没指定曲目时直接这么调，**不要先问他想听什么**",
      "`cabin_media` 点不到歌时会告诉你曲库里有多少首——如实转达\"没有这首\"并说说有什么，**不要退而求其次放一首别的**，那是放错不是帮忙",
      "`cabin_media` 返回的 `audible:false` 意味着**实际上没有声音**（车机没有播放器件或出声位被占）——这时不能说\"已经放上了\"，要按 `audibleNote` 说明原因",
      "`cabin_media` 不管音量——调音量是 `cabin_control` 的 `{domain:\"media\", set:{volume:N}}`；「关掉音乐」两条路等效：`cabin_media` command=stop，或 `cabin_control` 把 media 的 source 设成 off",
      "`cabin_media` 的 `trackIds` 只能来自 command=list 的返回；**凭曲名编 id 会被拒**，要按曲名点歌就用 query",
      "`cabin_media` 返回 `rebuilt:true` 说明车机刚重连过、播放队列已重置——如实说一句，不要假装刚才那首还在",
    ],
    traceSummary: (a: CabinMediaArgs) =>
      [a.command, a.query ? `「${a.query}」` : "", a.trackIds?.length ? `${a.trackIds.length} 首` : ""]
        .filter(Boolean)
        .join(" "),
    tool: cabinMediaTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "vehicle_profile",
    promptSnippet: "读车辆档案（VIN/保养/维修历史）",
    description:
      "按 VIN 读取车辆档案（车型/年款/当前里程/保养周期/保养与维修历史）。" +
      "**查不到就明确返回没有记录，不推测填充**——用户可能拿它去和修理厂争议。",
    schema: vehicleReadSchema,
    agents: ["ownership", "service", "trip"],
    sensitive: false,
    mcpExposable: false, // 用户私有数据（F-34-09）
    tool: vehicleProfileTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "vehicle_profile_write",
    promptSnippet: "写车辆档案字段（需车主明确提供的事实）",
    description:
      "向车辆档案追加保养记录 / 维修记录，或推进当前里程。**只追加不修改**：" +
      "已写入的记录不提供改删接口——能改的历史没有争议价值。",
    schema: vehicleWriteSchema,
    agents: ["ownership", "service"],
    // 改用户的车辆记录是有后果的动作 → §8.4 需确认档
    sensitive: true,
    mcpExposable: false,
    promptGuidelines: [
      "`vehicle_profile_write` 记车主口述的事实时**按他说的口径原样记**：「18 万 6 千多」就记 186000，不四舍五入、不「精确化」，也不要因为它与你的推算不符就质疑他",
      "`vehicle_profile_write` 的确认弹窗上显示的就是**复述**——车主看到的是你要写进去的那几个数。所以不要在回答里再复述一遍问他「对吗」，那是第二次确认",
      "`vehicle_profile_write` 车主只提到一项（比如只说了里程）时**就只写那一项**，不要为了凑齐去追问另一项；回答里也不要说「已补齐」",
    ],
    tool: vehicleProfileWriteTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "usage_profile",
    promptSnippet: "查用车画像：近期里程/充电习惯/路况/续航表现",
    description:
      "查询这辆车的真实用车画像（日均里程、低温/常温实测续航、常用充电时段）。" +
      "**数据不足或过期时返回 usable:false 与具体原因，此时不得据此下个性化结论**。",
    schema: usageProfileSchema,
    // §4.3②③⑤：用车助手与售后靠它做"这辆车"的判断；出行规划用它估续航。
    agents: ["ownership", "service", "trip"],
    sensitive: false,
    mcpExposable: false, // 用户私有数据（F-34-09，listExposableForMcp 里也硬编码了）
    tool: usageProfileTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "energy_gap",
    promptSnippet: "算补能缺口：这趟要多少、你有多少、差多少、要补几次",
    description:
      "按里程 × 百公里能耗算本次需求量，与车主口述的当前余量比对，给缺口与建议补能次数。" +
      "**实时余量不是它的数据源**——系统拿不到，只能由入参传入（先问车主）。" +
      "够的时候明确返回够、补能次数为 0，**不要为了保险起见硬塞一次停靠**。" +
      "结论一律带区间与依据，不给「一定能开到」这类确定性判断。",
    schema: energyGapSchema,
    // 出行与行车分支要用它；用车助手答"这趟够不够"时也用得上。
    agents: ["trip", "drive", "ownership", "supervisor"],
    sensitive: false,
    mcpExposable: false, // 结果依赖这辆车的实测能耗，属用户私有数据
    promptGuidelines: [
      "`energy_gap` 的余量必须来自车主这一轮说的话，**不要用上一次的、也不要猜**——系统没有实时油量或电量",
      "`energy_gap` 返回 `sufficient: true` 时就说够、不用中途补，**不要再建议一次「保险起见」的停靠**",
      "`energy_gap` 的 `basis` 要说出来（口径来自实测还是厂标、多少样本），别只报一个数",
    ],
    traceSummary: (a: EnergyGapArgs) => `${a.distanceKm}km · ${a.consumption?.source ?? "无口径"}`,
    tool: energyGapTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "refuel_log",
    promptSnippet: "记一次加油（加了多少升、当时里程多少）",
    description:
      "把车主说的一次加油记进用车流水。**百公里油耗按两次加油之间算**，" +
      "所以单独一条记录还算不出油耗——要等下一次加油才有一个区间。" +
      "里程读数是必填的，缺了它这条记录没有价值。",
    schema: refuelLogSchema,
    agents: ["ownership", "trip", "drive"],
    // ⑥ 的观测，与 Trip 同族；⑥ 的写入本来就不过权限门，加确认只会制造确认疲劳。
    sensitive: false,
    mcpExposable: false,
    promptGuidelines: [
      "`refuel_log` 只记**加了多少升**，不要把「油箱还剩多少」或「油箱容量」填进 liters",
      "`refuel_log` 记完要如实说「要等下次加油才算得出这一段的油耗」，不要让车主以为立刻就有实测油耗了",
    ],
    traceSummary: (a: RefuelLogArgs) => `${a.liters}L @ ${a.odometerKm}km`,
    tool: refuelLogTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "data_freshness",
    promptSnippet: "查④⑥数据新不新：里程/上次保养/行程流水各自的时点与陈旧判定",
    description:
      "体检这辆车的档案与用车数据够不够新：当前里程、上次保养、行程流水三项**各自**给出" +
      "最后更新时刻、陈旧了多久、按什么阈值判的。**不可用时给理由不给数字**——" +
      "查不到时刻就返回 unknown，不推测填充。" +
      "**它只报告，不发问**：`suggested` 只是排好序的建议，要不要开口问车主由编排层决定。",
    schema: dataFreshnessSchema,
    // 与 usage_profile 同一组消费方：谁要判断"这辆车"的数据能不能用，谁就要先知道它新不新。
    agents: ["ownership", "service", "trip"],
    sensitive: false,
    mcpExposable: false, // 用户私有数据（F-34-09 同档）
    promptGuidelines: [
      "`data_freshness` 报某项 stale/unknown 时，回答里要说清**缺的是哪一项、上一条已知事实是什么时候的**，不要笼统说「数据不足」",
      "`data_freshness` 的 `suggested` 是**给系统看的建议**，不是让你去追问车主——要不要问、这一轮问不问由编排层决定",
    ],
    traceSummary: (a: DataFreshnessArgs) => (a.vin ? `vin=${a.vin.slice(-6)}` : "默认车"),
    tool: dataFreshnessTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "vehicle_member",
    promptSnippet: "查车辆关联成员及其乘车信息（只读）",
    description:
      "查这辆车的常用人员名单、某个人的用车事实、以及与他相关的行程历史。" +
      "**只陈述事实，不评价人**：没有驾驶评分、安全评级或习惯好坏的结论。" +
      "**查不到就明确说没有记录**；数据不足时只给原因不给数字，" +
      "回落到整车口径时 scope=vehicle，此时必须说明这是整车数据而不是这个人的。",
    schema: vehicleMemberSchema,
    // §4.3②③④：用车助手解释里程、出行规划取同行者约束、座舱陪伴"认识这个人"。
    // **不给 buying**（郑明还没车也没有家人名单可谈）；service 待 FL-20 的展示面落地再开。
    agents: ["ownership", "trip", "cabin"],
    sensitive: false,
    mcpExposable: false, // 他人 PII（F-46-13，listExposableForMcp 里也硬编码了）
    traceSummary: (a: never) => {
      const { action, memberId } = a as z.infer<typeof vehicleMemberSchema>;
      // **称呼一个字都不能进轨迹**：这里只放动作与成员 id 前缀。
      return `${action}${memberId ? ` · member=${memberId.slice(0, 8)}` : ""}`;
    },
    tool: vehicleMemberTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "submit_hotels",
    promptSnippet: "提交酒店候选结论（本轮必须以一次提交收尾）",
    promptGuidelines: [
      "`submit_hotels` 是你结论的**唯一**提交通道——查完酒店必须以一次 `submit_hotels` 调用收尾，不要把候选写在正文里",
      "`submit_hotels` 没查到也要提交：空 hotels + findings 里说明原因，让编排层如实转述，不要沉默",
    ],
    description:
      "提交酒店候选结论。参数即结论：hotels 数组（name 必填）+ findings。" +
      "**本轮必须以一次提交收尾**；没查到就提交空数组并在 findings 说明。",
    schema: submitHotelsSchema,
    // M30-01：只有 hotel 分支拿得到——提交通道按分支一对一，schema 就是该分支的字段清单。
    agents: ["hotel"],
    sensitive: false,
    mcpExposable: false, // 进程内暂存通道，对外暴露没有意义
    tool: submitHotelsTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "submit_tour_days",
    promptSnippet: "提交逐天骨架结论（本轮必须以一次提交收尾）",
    promptGuidelines: [
      "`submit_tour_days` 是你结论的**唯一**提交通道——排完必须以一次调用收尾，不要把骨架写在正文里",
      "`submit_tour_days` 没排出来也要提交：空 days + findings 说明原因",
      // M34-01：时段纪律放在这里而不只在 tour.md——纪律跟着工具走（M23-03 的既有取向），
      // 实测只写在 prompt 正文时模型全数漏填（sess-6c0ff8df：0/10 个点带时段）。
      "`submit_tour_days` **每个景点都要带 estStart/estEnd**（HH:MM 预计口径）：非全天日铺满上午+下午（下午空半天不是一份能照着走的行程），夜游/演出落晚间，与点序一致（顺序在后的不得更早，矛盾会被整天丢弃）",
      "`submit_tour_days` 换酒店日与到达日带 lodging（checkin-midday=上午玩完退房下午继续 / checkin-evening=白天全玩晚上入住），note 一句话写清行李处置；连住日不填",
    ],
    description:
      "提交逐天玩法骨架。参数即结论：days（含每天主题/片区/景点+**逐点预计时段**/住宿策略/雨天备选）+ findings。",
    schema: submitTourDaysSchema,
    agents: ["tour"],
    sensitive: false,
    mcpExposable: false,
    tool: submitTourDaysTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "submit_transit",
    promptSnippet: "提交大交通结论（本轮必须以一次提交收尾）",
    promptGuidelines: [
      "`submit_transit` 是你结论的**唯一**提交通道——查完必须以一次调用收尾，不要把方案写在正文里",
      "`submit_transit` 车次逐字取自 transit_route；没查到就提交空 trains + findings 说明",
    ],
    description: "提交大交通结论。参数即结论：trains（真实车次）+ flightAdvice（常识性对比）+ findings。",
    schema: submitTransitSchema,
    agents: ["transit"],
    sensitive: false,
    mcpExposable: false,
    tool: submitTransitTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "submit_drive_draft",
    promptSnippet: "提交自驾方案结论（本轮必须以一次提交收尾）",
    promptGuidelines: [
      "`submit_drive_draft` 是你结论的**唯一**提交通道——算完必须以一次调用收尾，不要把分段写在正文里",
      "`submit_drive_draft` 的 legMinutes 是硬约束求解的输入：来自 map_route 的真实数据，禁止编造",
    ],
    description: "提交自驾方案结论。参数即结论：legMinutes/stops/energyStops（求解器输入）+ findings。",
    schema: submitDriveDraftSchema,
    agents: ["drive"],
    sensitive: false,
    mcpExposable: false,
    tool: submitDriveDraftTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "submit_nav_plan",
    promptSnippet: "提交出发导航方案（本轮必须以一次提交收尾）",
    promptGuidelines: [
      "`submit_nav_plan` 是你结论的**唯一**提交通道——算完必须以一次调用收尾；总时长不超上限就提交空 waypoints",
      "`submit_nav_plan` 的途经点只能取自 map_route 返回的 restStops：名字、lat、lon 原样照抄，改一个字都会被汇聚层丢弃",
    ],
    description:
      "提交出发导航方案。参数即结论：strategy（编排层给的）+ waypoints（从 map_route 的 restStops 里挑，原名原坐标）+ legMinutes（真实分段）+ findings。",
    schema: submitNavPlanSchema,
    agents: ["nav"],
    sensitive: false,
    mcpExposable: false,
    tool: submitNavPlanTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "web_search",
    promptSnippet: "通用联网搜索（实时），返回要点整理与真实结果链接清单",
    promptGuidelines: [
      "`web_search` 引用出处时 `sourceUrl` 必须**逐字复制**自返回的 results 链接清单——改写/截断的链接会被汇聚层丢弃",
      "`web_search` 搜不到就如实说没搜到，**不要用你的记忆补**——凭记忆的推荐不可信",
    ],
    description:
      "通用联网搜索（经模型内置联网，实时）。返回要点整理文本 + 这次真实出现过的结果链接清单。" +
      "**引用出处只能逐字取自 results**；没搜到就如实说明，不返回凭记忆的兜底内容。",
    schema: webSearchSchema,
    // M36-01：只给导游采集三分支。不给既有六个业务 Agent——放开范围是另一个决策，
    // 每次调用都是按次计费 + 搜索结果全量进上下文（约 19k tokens），不搭车放开。
    agents: ["guide-access", "guide-spots", "guide-comfort"],
    sensitive: false,
    mcpExposable: false, // 查询词带用户意图，且每次调用真实计费——不对外暴露
    /*
     * 轨迹记 query 截断前 24 字 + 结果条数：query 是模型拼的检索词（不是用户原文），
     * 排障要靠它分辨"同一轮搜了什么"；截断防整条轨迹被长词撑大。
     */
    traceSummary: (a: never, r: unknown) => {
      const { query } = a as z.infer<typeof webSearchSchema>;
      const n = (r as { data?: { results?: unknown[] } } | undefined)?.data?.results?.length;
      const q = query.length > 24 ? `${query.slice(0, 24)}…` : query;
      return `${q} → ${typeof n === "number" ? `${n} 条` : "?"}`;
    },
    tool: webSearchTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "submit_guide_spots",
    promptSnippet: "提交景区必玩/打卡结论（本轮必须以一次提交收尾）",
    promptGuidelines: [
      "`submit_guide_spots` 是你结论的**唯一**提交通道——查完必须以一次调用收尾，不要把清单写在正文里",
      "`submit_guide_spots` 没查到也要提交：空 spots + findings 说明原因",
      "`submit_guide_spots` 的 sourceUrl 逐字取自 web_search 结果；sourceDate 抽不到就省略，禁止编日期；lat/lon 只在 poi_search 名字对得上时带",
    ],
    description:
      "提交景区必玩/打卡结论。参数即结论：spots（名字/位置/理由/出处/平台/来源时间/坐标/必看内容）" +
      "+ 代步设施与方向建议 + findings。",
    schema: submitGuideSpotsSchema,
    agents: ["guide-spots"],
    sensitive: false,
    mcpExposable: false,
    tool: submitGuideSpotsTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "submit_guide_access",
    promptSnippet: "提交景区到达与补能结论（本轮必须以一次提交收尾）",
    promptGuidelines: [
      "`submit_guide_access` 是你结论的**唯一**提交通道——查完必须以一次调用收尾，不要把候选写在正文里",
      "`submit_guide_access` 停车场/充电站名字逐字取自 poi_search；distanceToGateMeters 是估算口径，没依据就省略",
    ],
    description:
      "提交景区到达与补能结论。参数即结论：parking（含到入口距离与方式）+ charging/refuel + 到达建议 + findings。",
    schema: submitGuideAccessSchema,
    agents: ["guide-access"],
    sensitive: false,
    mcpExposable: false,
    tool: submitGuideAccessTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "submit_guide_comfort",
    promptSnippet: "提交景区休憩/餐饮/避雷结论（本轮必须以一次提交收尾）",
    promptGuidelines: [
      "`submit_guide_comfort` 是你结论的**唯一**提交通道——查完必须以一次调用收尾，不要把条目写在正文里",
      "`submit_guide_comfort` 避雷条目要有出处才算数（sourceUrl 逐字取自 web_search）；没出处的传闻不要提交",
    ],
    description:
      "提交景区休憩面结论。参数即结论：entries（rest/food/toilet/pitfall 各条带一句话内容与出处）+ findings。",
    schema: submitGuideComfortSchema,
    agents: ["guide-comfort"],
    sensitive: false,
    mcpExposable: false,
    tool: submitGuideComfortTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "preference_recall",
    promptSnippet: "读取车主偏好记忆（只读）",
    promptGuidelines: [
      "`preference_recall` 降级时 degraded=true——此时空结果不代表车主没有该偏好，不得据此下判断",
    ],
    description:
      "读取该用户的③偏好记忆（只读）。**「没有偏好」与「读不到偏好」是两件事**：" +
      "降级时 degraded=true，此时空结果不代表用户没有这个偏好，不得据此下判断。",
    schema: preferenceRecallSchema,
    // §4.3④ 座舱陪伴靠它做"认识这个人"；出行规划用它调节奏（休息频率、同行者习惯）。
    // hotel 分支的 prompt 明写"可用 `preference_recall` 看车主既有偏好"来挑房型，
    // 与 trip 调节奏是同一类用法，所以一并给它。
    agents: ["cabin", "trip", "hotel"],
    sensitive: false,
    mcpExposable: false, // 用户私有数据（F-34-09）
    tool: preferenceRecallTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "cost_calc",
    promptSnippet: "五年使用成本分项测算（返回全部计算假设，可改假设重算）",
    promptGuidelines: [
      "`cost_calc` 的结果是基于假设的测算，引用时带上关键假设并标注\"估算\"",
    ],
    description:
      "五年使用成本分项测算（车价/能耗/保险/保养/残值），返回全部计算假设，可改假设重算。",
    schema: costCalcSchema,
    agents: ["buying", "supervisor"], // §4.3① 购车顾问
    sensitive: false,
    mcpExposable: true,
    tool: costCalcTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "charging",
    promptSnippet: "沿路线按续航插点查充电站",
    promptGuidelines: [
      "`charging` 不返回空闲桩数或排队情况——这类实时数据无法获取，不得编造",
      "`charging` 与 `refuel` 按车辆能源类型二选一：纯电/插电查充电，燃油查加油",
    ],
    description:
      "沿路线按续航插点并查询充电站。返回该充电的累计里程位置与候选站（含功率、绕行距离）。" +
      "**不返回空闲桩数或排队情况——这类实时数据无法获取，结果里会带明确说明。**",
    schema: chargingSchema,
    // §4.3③ 出行规划；Supervisor 保留用于单 Agent 阶段验证。
    // drive 分支按车辆能源类型在 `refuel`/`charging` 里选一个查补能，两个都得给——
    // 只给一个的后果不是报错，是纯电车主拿到一份"沿途加油站"。
    agents: ["trip", "supervisor", "drive"],
    sensitive: false,
    mcpExposable: true,
    tool: chargingTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "refuel",
    promptSnippet: "沿路线查加油站",
    promptGuidelines: [
      "`refuel` 不判断是否需要加油、不给剩余可行驶里程——系统没有实时油量数据，要如实转述",
    ],
    description:
      "沿路线查加油站，返回路过位置的候选站（含品牌、绕行距离）。" +
      "**不判断是否需要加油、不给剩余可行驶里程——系统没有实时油量数据**，" +
      "结果里会带明确说明，请如实转述给车主。",
    schema: refuelSchema,
    // 出行规划要排沿途补能；用车助手做补能评估（fan-out 的 ownership-task 分支）也要。
    // drive 分支同理（与 `charging` 成对给，见那一条的说明）。
    agents: ["trip", "ownership", "supervisor", "drive"],
    sensitive: false,
    mcpExposable: true,
    traceSummary: (a: never) => {
      const { route, everyKm } = a as z.infer<typeof refuelSchema>;
      // 与 weather 同一原则：**不记地名**，坐标降精度到约 1.1km。
      const head = route[0];
      const where = head ? `${roundCoord(head.lat)},${roundCoord(head.lon)}` : "?";
      return `${route.length} 点 · 首点 ${where} · 每 ${everyKm ?? 100}km`;
    },
    tool: refuelTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "poi_search",
    promptSnippet: "城市内酒店/景点搜索（真实名称、地址、评分）",
    promptGuidelines: [
      "`poi_search` 不含任何价格数据；提及花费只能给经验估算区间并明确标注\"估算\"，以实际平台为准",
      "`poi_search` 返回的名称要逐字引用（含括号里的门店名），不得缩写、不得凭记忆报名字",
      "`poi_search` 的 city 只能填行政区（市/区县）：景区名与片区名会返回空，片区限定写进 keywords",
    ],
    description:
      "城市内酒店/景点搜索（真实名称、地址、评分）。**不含任何价格数据**——" +
      "提及花费只能给经验估算区间并明确标注估算，以实际平台为准。",
    schema: poiSearchSchema,
    // 多天行程：酒店归 hotel、景点归 tour；drive/trip 不需要（它们只管开车）。
    // guide-access/guide-spots（M36-01）：景区到达面查停车/充电/加油，园内点位查坐标——
    // 都要真实名称与坐标，凭记忆报点位正是本工具要杜绝的。guide-comfort 不给：
    // 休息/餐饮/避雷来自攻略文本（web_search），POI 类目里没有对应的可靠数据面。
    agents: ["hotel", "tour", "supervisor", "guide-access", "guide-spots"],
    sensitive: false,
    mcpExposable: true,
    traceSummary: (a: never, r: unknown) => {
      const q = a as z.infer<typeof poiSearchSchema>;
      const list = (r as { data?: { candidates?: Array<{ name?: string }> } } | undefined)?.data?.candidates;
      // 条数进轨迹：只记"查到几条"，不记命中的地点（那是行程隐私）。
      // 缺了它，"模型说没找到"分不清是工具空还是模型没说——实测卡过一轮排查。
      const n = Array.isArray(list) ? `${list.length} 条` : "?";
      return `${q.city} · ${q.category}${q.keywords ? " · 带关键词" : ""} → ${n}`;
    },
    tool: poiSearchTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "route_audit",
    promptSnippet: "行程顺序体检：跨天分组与天序 + 天内段距/交叉/最短顺序",
    promptGuidelines: [
      "`route_audit` 在提交每天的顺序前必须体检一次：把**全部天**一起传入（带上 poi_search 给的坐标），一次调用同时得到跨天与天内两层建议",
      "`route_audit` 返回 journey 时**先处理跨天**：按 regroup 换点（每天点数不变）、按 dayOrder 调天序，再按各天 suggested 排当天顺序；跨天调整要顾主题/门票/开放日/到达离开的半天，冲突时保留语义、局部采纳并在 findings 说明",
      "`route_audit` 只按直线距离算、不懂时段——夜游/演出/用餐/补能的时段由你把关；向用户提及里程时要说明是直线估算、以导航为准",
    ],
    description:
      "行程顺序体检，两层：跨天（哪个点归哪天、天序是否顺路）与天内（段距、累计里程、" +
      "交叉折返、最短顺序）。**建议只按距离，不懂语义**——时段/门票/开放日由你判断后采纳。",
    schema: routeAuditSchema,
    // 多天行程的逐天顺序归 tour；单日多点出行归 trip。别的 Agent 不排点序。
    agents: ["tour", "trip"],
    sensitive: false,
    mcpExposable: true,
    traceSummary: (a: never, r: unknown) => {
      const args = a as RouteAuditArgs;
      const res = (r as { data?: RouteAuditResult } | undefined)?.data;
      const pts = args.days.reduce((n, d) => n + d.points.length, 0);
      // 与 weather/refuel 同一原则：**不记地名**，只记规模与结论数字。
      const saved = res ? ` → 可省 ${res.totalSavedKm}km` : "";
      const crossed = res ? res.days.reduce((n, d) => n + d.crossings.length, 0) : 0;
      return `${args.days.length} 天 ${pts} 点${crossed ? ` · 交叉 ${crossed} 处` : ""}${saved}`;
    },
    tool: routeAuditTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "transit_route",
    promptSnippet: "跨城火车真实车次、时长、票价查询",
    promptGuidelines: [
      "`transit_route` 只覆盖火车；航班无数据源，提及飞机只能给带\"估算\"标注的经验建议，禁止编造具体航班号",
    ],
    description:
      "跨城大交通查询：火车真实车次、时长、票价（多策略合并）。**只覆盖火车**——" +
      "航班无数据源，提及飞机只能给时长/票价的经验估算并标注，禁止编造具体航班号。",
    schema: transitRouteSchema,
    // 大交通对比：transit 出方案，drive 需要"高铁多久"来对比自驾。
    agents: ["transit", "drive", "supervisor"],
    sensitive: false,
    mcpExposable: true,
    traceSummary: (a: never) => {
      const { fromCity, toCity } = a as z.infer<typeof transitRouteSchema>;
      return `${fromCity}→${toCity}`;
    },
    tool: transitRouteTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "car_catalog",
    promptSnippet: "车型/参数/配置检索与比较",
    description:
      "车型资料查询与并排比较（车型手册、配置参数、选装表、价格表）。返回带出处的原文片段，" +
      "不下「哪款更好」的结论。请求了但零命中的车型会显式列出。",
    schema: carCatalogSchema,
    // §4.3① 购车顾问专属：数据集隔离由 datasetsForAgent 在调用层强制。
    agents: ["buying"],
    sensitive: false,
    mcpExposable: true,
    tool: carCatalogTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "dealer_stores",
    promptSnippet: "按车型与城市/区查可试驾门店",
    description:
      "按车型 + 城市/区查可试驾的门店，返回 storeId。**门店名只能来自这里**——" +
      "在此之前门店是模型编的，用户拿着去很可能扑空。",
    schema: dealerStoresSchema,
    agents: ["test-drive", "buying", "supervisor"],
    sensitive: false,
    mcpExposable: true,
    traceSummary: (a: never) => {
      const { model, city, district } = a as z.infer<typeof dealerStoresSchema>;
      return `${model} · ${city ?? "?"}${district ? `/${district}` : ""}`;
    },
    tool: dealerStoresTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "dealer_slots",
    promptSnippet: "查某门店某车型的可预约时段",
    description:
      "某门店某车型的可预约试驾时段，返回 slotId 与剩余车辆数。" +
      "**下单前必须先调它**——时间不能自己拍一个。",
    schema: dealerSlotsSchema,
    agents: ["test-drive", "buying", "supervisor"],
    sensitive: false,
    mcpExposable: true,
    traceSummary: (a: never) => {
      const { storeId, model } = a as z.infer<typeof dealerSlotsSchema>;
      return `${storeId} · ${model}`;
    },
    tool: dealerSlotsTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "dealer_pricing",
    promptSnippet: "查车型×配置的厂商指导价（价格权威源）",
    description:
      "车型 × 配置的厂商指导价（结构化）。**这是价格的权威源**——" +
      "比从手册表格里正则抽可靠（曾把 FSD 选装包当成车价）。无人民币报价的车型如实缺省，不换算汇率。",
    schema: dealerPricingSchema,
    agents: ["test-drive", "buying", "supervisor"],
    sensitive: false,
    mcpExposable: true,
    tool: dealerPricingTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "repair_history",
    promptSnippet: "查这辆车在 4S 维修系统里的历史维修记录",
    description:
      "按 VIN 查 4S 维修系统里的历史维修记录（时间/里程/项目/处理结果/费用，simulated 来源）。" +
      "**与 vehicle_profile 的本地留档是两份账**：呈现时都要给、注明来源（4S 系统记录 vs 本地问诊留档），" +
      "同一件事两边都有记录时并列说明，不去重不合并。查不到就如实说没在 4S 系统修过。",
    schema: repairVinSchema,
    // 售后主用；用车助手回答"这车修过什么"也需要（F-20-05 工况关联的另半边）。
    agents: ["service", "ownership"],
    sensitive: false,
    mcpExposable: false, // 单车维修史是用户私有数据（F-34-09）
    tool: repairHistoryTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "repair_stations",
    promptSnippet: "查可预约的维修站（可按城市）",
    description:
      "查 4S 维修系统里可预约的维修站（simulated 来源），返回 stationId。" +
      "**维修站名只能来自这里**——编一个站名会让车主扑空。",
    schema: repairStationsSchema,
    agents: ["service"],
    sensitive: false,
    mcpExposable: false,
    tool: repairStationsTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "repair_slots",
    promptSnippet: "查某维修站的进厂时段",
    description:
      "某维修站的可预约进厂时段（每天 09/11/14/16 点四个窗口，simulated 来源）。" +
      "**下单时间必须来自这里**——时间不能自己拍一个。",
    schema: repairSlotsSchema,
    agents: ["service"],
    sensitive: false,
    mcpExposable: false,
    tool: repairSlotsTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "repair_quote",
    promptSnippet: "查这辆车正在维修中的报价单",
    description:
      "按 VIN 查 4S 维修系统里**进行中**的维修报价单（分项工料费/合计，simulated 来源）。" +
      "金额引用原文，不四舍五入不换算；没有进行中的维修就如实说没有。",
    schema: repairVinSchema,
    agents: ["service"],
    sensitive: false,
    mcpExposable: false,
    tool: repairQuoteTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "insurance_policy",
    promptSnippet: "查这辆车的保单（保险公司系统）",
    description:
      "按 VIN 查保险系统里的保单（险种/保额/免赔额/有效期，simulated 来源）。" +
      "**与 insurance_quote 是两回事**：那是买保险的估价，这是已有保单的查询。查不到就如实说未投保。",
    schema: repairVinSchema,
    agents: ["service", "buying"],
    sensitive: false,
    mcpExposable: false,
    tool: insurancePolicyTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "insurance_precheck",
    promptSnippet: "按维修中报价单做理赔预检（能报多少/自费多少）",
    promptGuidelines: [
      "`insurance_precheck` 的结果是**模拟测算**，转述时必须带 disclaimer 原文（\"模拟测算，实际以保险公司核定为准\"），金额引用原文不改写",
    ],
    description:
      "拿这辆车**正在维修中的报价单**向保险系统做理赔预检，返回覆盖金额/自费金额/免赔额与逐条目判定。" +
      "**报价单由系统自己取，你只给 VIN**——不要转述或自行拼报价金额。" +
      "没有进行中的维修报价单时会明确报错，此时如实告知车主，不要凭项目名估价。",
    schema: repairVinSchema,
    agents: ["service"],
    sensitive: false,
    mcpExposable: false,
    tool: insurancePrecheckTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "insurance_quote",
    promptSnippet: "车险分项报价测算",
    promptGuidelines: [
      "`insurance_quote` 给的是含假设的估算区间，引用必须带\"估算\"并提示以保险公司实际报价为准",
    ],
    description:
      "车险分项估算（纯规则计算）：交强险 / 车损 / 三者（**按保额档位**）/ 座位 / 新能源附加。" +
      "**每一项都是区间不是点值**——地区系数、无赔款优待、驾驶记录我们都拿不到。" +
      "**不要把区间中点当成一个数说出去。** 区间过宽时 usable=false 且不给合计，照实说给不了。" +
      "这不是报价，我们不接保险公司接口也不代办投保。",
    schema: insuranceQuoteSchema,
    agents: ["buying", "supervisor"],
    sensitive: false,
    mcpExposable: true,
    // 能源与档位进得去，金额进不去。
    traceSummary: (a: { energy?: string; thirdPartyCoverage?: number }) =>
      `energy=${a.energy ?? "-"} tier=${a.thirdPartyCoverage ?? "all"}`,
    tool: insuranceQuoteTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "loan_calc",
    promptSnippet: "车贷月供与利息测算",
    promptGuidelines: [
      "`loan_calc` 的利率是假设区间，结果必须标注\"估算\"，以金融机构实际审批为准",
    ],
    description:
      "车贷测算（纯规则计算）：等额本息月供/总利息/总支出 + 等额本金对照 + 全款对照。" +
      "**利率没给就不要编**——不填 annualRate，工具会用标注为「假设」的示例档位并给出区间。" +
      "只做测算与信息呈现，**不办理、不代办、不导流**。",
    schema: loanCalcSchema,
    agents: ["buying", "supervisor"],
    sensitive: false,
    mcpExposable: true,
    // 期数与"利率是不是假设的"进得去，金额进不去。
    traceSummary: (a: { months?: number; annualRate?: number }) =>
      `months=${a.months ?? "-"} rate=${a.annualRate === undefined ? "assumed" : "user"}`,
    tool: loanCalcTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "trim_compare",
    promptSnippet: "同/跨车型的配置差异对比",
    description:
      "把配置摊开成一张可比的表：同车型按指导价逐档对比，跨车型按**可核对的口径**成对" +
      "（同配置名优先，否则按指导价接近度），并给出逐项差异与差价。" +
      "**差异是算出来的，不要自己复述数字。**「哪个更值」是车主的取舍，本工具不给评分也不排名。",
    schema: trimCompareSchema,
    agents: ["buying", "supervisor"],
    sensitive: false,
    mcpExposable: true,
    // 车型与配置数进得去，用户原话进不去——同一轮里比两次也能靠车型名区分开。
    traceSummary: (a: { models?: string[]; trims?: string[] }) =>
      `models=${(a.models ?? []).join("/") || "-"}${a.trims?.length ? ` trims=${a.trims.length}` : ""}`,
    tool: trimCompareTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "contact_lookup",
    promptSnippet: "查车主预留联系方式（脱敏返回）",
    description:
      "查这辆车登记过的人员联系方式，返回 memberId 与**手机号后四位**。" +
      "**拿不到完整号码，这是设计如此**——下单时由系统按 memberId 自己取，你不需要看到它。" +
      "跟车主说的时候**只说「尾号 5613」这一种形式**：不要写 138****5613 这类星号串" +
      "（车机是语音出口，TTS 会把星号念成「星星星星」），也不要复述完整号码。" +
      "`hasPhone=false` 表示这个人没登记过号码，此时要问，**不要拿别人的号顶替**。",
    schema: contactLookupSchema,
    /*
     * 试驾/售后免去重复询问；座舱是人员档案的日常维护入口（M14-12 那个页面）。
     *
     * **supervisor 也要给**，这一条是真跑逼出来的：五个业务分支都会产出
     * `agentResults` → 走 `solved` → 应答由 `CARLIFE_ANSWER_RUNTIME=direct` 的
     * **无工具**直连模型接管。也就是说在分支里，模型结构上调不到任何工具。
     * 唯一还带着真工具表的路径是没命中专项规则时的 `general`（supervisor 经 ACP），
     * 而「把我手机号改成…」正好落在那里。不给的话模型只能编——
     * 实测它编出了一整套"登录验证 + 短信验证码"，我们根本没有这些东西。
     */
    agents: ["test-drive", "service", "cabin", "supervisor"],
    sensitive: false,
    mcpExposable: false, // 用户私有数据（F-34-09，listExposableForMcp 里也硬编码了）
    traceSummary: (a: never) => {
      const { who } = a as z.infer<typeof contactLookupSchema>;
      // **称呼与号码一个字都不进轨迹**：只记有没有带筛选词（同 vehicle_member 的纪律）。
      return who ? "by-keyword" : "self";
    },
    tool: contactLookupTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "contact_update",
    promptSnippet: "更新车主预留联系方式",
    description:
      "更新某个人登记的手机号。**memberId 必须来自 contact_lookup**。" +
      "写完返回改动前后的尾号——**两个都要念给车主听**（\"从尾号 8000 改成 5613\"），" +
      "这是他核对的唯一机会，改错了没有别的地方会提醒他。" +
      "**只说尾号**：不要念 138****8000 这类星号串，也不要复述完整号码。" +
      "认不出完整号码会拒收，此时请他重说一遍，**不要补位、不要猜**。" +
      "⚠️ 这个号**只用于门店回拨**。不要说它会用于登录、短信验证码、账号绑定或通知——" +
      "本系统没有这些功能，说了就是凭空承诺。",
    schema: contactUpdateSchema,
    // 同 contact_lookup：不给 supervisor 的话，模型结构上没有任何路径能调到它。
    agents: ["test-drive", "service", "cabin", "supervisor"],
    // 不过权限门（M19-06 D2）：改自己的号是低风险高频操作，弹窗摩擦大于收益。
    // 代价用"回报前后尾号"补——见 description。
    sensitive: false,
    mcpExposable: false, // 写他人 PII，**永远不对外**（F-34-09）
    traceSummary: (a: never) => {
      const { memberId } = a as z.infer<typeof contactUpdateSchema>;
      // 号码绝不进轨迹；成员 id 只留前缀。
      return `member=${memberId.slice(0, 8)}`;
    },
    tool: contactUpdateTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "test_drive_book",
    promptSnippet: "试驾下单（只收 storeId 与 slotId）",
    description:
      "试驾下单（需用户确认）。**只收 storeId + slotId**，两个都必须来自前面的查询——" +
      "自己编的时段会被门店系统拒掉。有副作用且不重试。" +
      "联系方式优先给 memberId（来自 contact_lookup），真号由系统自己取。",
    schema: testDriveBookSchema,
    // **不给 supervisor**：下单不该由兜底路由发起，它没有试驾上下文。
    agents: ["test-drive", "buying"],
    // §8.4 需确认档；CONFIRM_REQUIRED_TOOLS 必须同步含本名（agent-runtime 有断言）。
    sensitive: true,
    // 有副作用 + 外发个人信息，**不对外暴露**（F-34-09）。
    mcpExposable: false,
    traceSummary: (a: never) => {
      const { storeId, slotId } = a as z.infer<typeof testDriveBookSchema>;
      // **不记 contact**：审计里不该再存一份手机号（与 audit_logs 同一条纪律）。
      return `${storeId} · ${slotId}`;
    },
    tool: testDriveBookTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "appointment",
    promptSnippet: "维修/保养预约下单（需用户确认）",
    description:
      "试驾/维修预约下单（需用户确认）。提交前会列出将提供给门店的信息。" +
      "有副作用且不重试——重复提交会下两单。",
    schema: appointmentSchema,
    // 试驾归购车顾问（F-15-10），维修下单归售后（F-20-12）。
    agents: ["buying", "service"],
    // §8.4 需确认档：裁决在 tools-endpoint 的 /internal/guard/check，工具自己不判断。
    sensitive: true,
    // 有副作用 + 外发个人信息，**不对外暴露**（F-34-09）。
    mcpExposable: false,
    tool: appointmentTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "trip_plan_commit",
    promptSnippet: "把确认后的行程方案落库",
    description: "把用户已认可的多天行程草案确认落库（需用户确认）。有副作用且不重试。",
    schema: tripPlanCommitSchema,
    // 图节点直调（ctx.agent="trip"）；supervisor 留着便于链路自检。
    // 注意：**图直调不过 tools-endpoint 的权限门**，itineraryNode 自己先 check（M13-02）。
    agents: ["trip", "supervisor"],
    // §8.4 需确认档；CONFIRM_REQUIRED_TOOLS 必须同步含本名（agent-runtime 有断言）。
    sensitive: true,
    // 用户私有数据 + 副作用，不对外暴露（F-34-09）。
    mcpExposable: false,
    traceSummary: (a: never) => {
      const { plan } = a as z.infer<typeof tripPlanCommitSchema>;
      // 只记目的地与天数——酒店名/逐日安排是用户行程隐私，不进轨迹。
      return `commit ${plan?.destination} ${plan?.days}天`;
    },
    tool: tripPlanCommitTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "trip_plan_cancel",
    promptSnippet: "取消已确认的行程",
    description:
      "取消一份已确认的行程（需用户确认）。不给 planId 就取消最近确认的那一份。有副作用且不重试。",
    schema: tripPlanCancelSchema,
    agents: ["trip", "supervisor"],
    // §8.4 需确认档；CONFIRM_REQUIRED_TOOLS 必须同步含本名（agent-runtime 有断言）。
    sensitive: true,
    mcpExposable: false,
    traceSummary: (a: never) => {
      const { planId } = a as z.infer<typeof tripPlanCancelSchema>;
      return planId ? `cancel ${planId}` : "cancel current";
    },
    tool: tripPlanCancelTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "trip_plan_update",
    promptSnippet: "更新已确认行程的字段",
    description:
      "变更一份已确认的行程（改期/改地点/改住宿，需用户确认）。" +
      "**原地改写，planId 不变**。有副作用且不重试。",
    schema: tripPlanUpdateSchema,
    agents: ["trip", "supervisor"],
    sensitive: true,
    mcpExposable: false,
    traceSummary: (a: never) => {
      const { planId, plan } = a as z.infer<typeof tripPlanUpdateSchema>;
      return `update ${planId} → ${plan?.destination} ${plan?.days}天`;
    },
    tool: tripPlanUpdateTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "trip_plan_nav",
    promptSnippet: "开始/结束按已确认行程导航",
    description:
      "把一份已确认的行程切到导航（跟车）状态，或结束导航（day 给 null）。" +
      "**不改行程内容本身**，只标记「正在走第几天」。不给 planId 就作用于当前行程。",
    schema: tripPlanNavSchema,
    // 图节点直调（ctx.agent="trip"），与另外几个行程工具同口径。
    agents: ["trip", "supervisor"],
    /*
     * **不需确认**（§8.4）：不控车、无第三方收件人、随时可撤销——
     * 完整理由在 trip-plan-commit.ts 的工具处。
     * 因此它**不进** CONFIRM_REQUIRED_TOOLS；进了就是每次出发都打断驾驶。
     */
    sensitive: false,
    // 用户私有行程，不对外暴露（F-34-09，与其余行程工具一致）。
    mcpExposable: false,
    traceSummary: (a: never) => {
      const { day, planId } = a as z.infer<typeof tripPlanNavSchema>;
      return `${day === null ? "nav end" : `nav day=${day}`}${planId ? ` ${planId}` : " current"}`;
    },
    tool: tripPlanNavTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "trip_plan_list",
    promptSnippet: "列出车主的行程",
    description:
      "列出该用户**未取消**的行程，默认 10 条（limit 可调，上限 50）。" +
      "排序按相对今天的临近程度：进行中的在最前，其次是将要出发的（越近越前），" +
      "再次是刚结束的，最后是还没定日期的。" +
      "**每条都是完整行程**（逐日安排、住宿、大交通、起止日全在里面），不用再查第二次。",
    schema: tripPlanListSchema,
    agents: ["trip", "supervisor"],
    // 只读：不进权限门（§8.4 表第三行）。
    sensitive: false,
    // 用户私有行程，不对外暴露（F-34-09）。
    mcpExposable: false,
    /*
     * **条数要进轨迹**。原先只记 limit 不记结果，于是线上出现"模型说没查到"时，
     * 回放页上分不清是工具真的空、还是工具有货而模型没说——那次排查因此卡住。
     * 条数不是隐私（行程内容才是），记它零代价。
     */
    traceSummary: (a: never, r: unknown) =>
      `list limit=${(a as { limit?: number }).limit ?? "默认"} → ${hitCount(r)} 条`,
    tool: tripPlanListTool as unknown as ExternalTool<never, unknown>,
  },
  {
    name: "trip_plan_query",
    promptSnippet: "按条件查询车主的行程",
    description:
      "按条件查该用户未取消的行程：目的地关键字、出发日区间、天数区间，可组合。" +
      "排序与返回同 trip_plan_list（临近优先、每条都是完整行程）。" +
      "**查不到就是没有，不要改条件重试到查出东西为止**。",
    schema: tripPlanQuerySchema,
    agents: ["trip", "supervisor"],
    sensitive: false,
    mcpExposable: false,
    traceSummary: (a: never, r: unknown) => {
      const q = a as z.infer<typeof tripPlanQuerySchema>;
      // 只记条件与条数，不记命中的行程内容——后者是隐私。
      const cond =
        [
          q.destination && `dest=${q.destination}`,
          (q.startFrom || q.startTo) && `date=${q.startFrom ?? ""}~${q.startTo ?? ""}`,
          (q.minDays || q.maxDays) && `days=${q.minDays ?? ""}~${q.maxDays ?? ""}`,
        ]
          .filter(Boolean)
          .join(" ") || "无条件";
      // 同 list：命中条数进轨迹，否则"查到没有"这个问题回放时答不了。
      return `${cond} → ${hitCount(r)} 条`;
    },
    tool: tripPlanQueryTool as unknown as ExternalTool<never, unknown>,
  },
];

/** 某个 Agent 的工具表（按 §4.3 能力映射裁剪，不是全给）。 */
export function listForAgent(agent: AgentName): readonly ToolRegistration[] {
  return TOOL_REGISTRY.filter((t) => t.agents.includes(agent));
}

/**
 * 可经 MCP 对外暴露的工具（FL-34 F-34-09 的筛选规则，**写死在代码里**）：
 * 只暴露**无状态、无个人数据**的能力；**不暴露**涉及用户私有数据的（`vehicle_profile`/
 * `usage_profile`/`memory`）与**有副作用**的（`appointment`/`calendar`）。
 *
 * 规则写死而不是配置，是为了避免将来"顺手加一个"。
 */
export function listExposableForMcp(): readonly ToolRegistration[] {
  const PRIVATE_DATA = new Set([
    "vehicle_profile",
    "usage_profile",
    // M26-02：④⑥ 的时刻与陈旧度同样是这辆车的私有事实。
    // 声明处 `mcpExposable: false` 已经挡住它，这里**两处都写**（同 vehicle_member 的注释）：
    // 有人为了别的目的翻了声明位，还有这一道。
    "data_freshness",
    // M26-06：两者的结果都依赖这辆车的实测能耗与车主口述的余量。
    "energy_gap",
    "refuel_log",
    "vehicle_member",
    "memory",
    // 联系方式读写（M19-06）：读的是他人 PII，写的是他人 PII。
    "contact_lookup",
    "contact_update",
  ]);
  return TOOL_REGISTRY.filter(
    (t) => t.mcpExposable && !t.sensitive && !PRIVATE_DATA.has(t.name),
  );
}

/** 按名取工具，供 pi 扩展与单测使用。 */
export function getTool(name: string): ToolRegistration | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}

/**
 * 注册给 pi 用的工具描述（施工单 M4-02）。
 *
 * pi 的 `registerTool({ parameters })` 收 **JSON Schema**（其文档用 TypeBox 的
 * `Type.Object()`，而 TypeBox 在运行时产出的就是普通 JSON Schema 对象）。
 * 我们的真相源是注册表里的 zod schema，这里做一次转换——**不维护两份 schema**。
 */
export interface PiToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  sensitive: boolean;
  /** 见 `ToolRegistration.promptSnippet` / `promptGuidelines`——扩展端原样转给 `pi.registerTool`。 */
  promptSnippet: string;
  promptGuidelines?: readonly string[];
}

export function describeForPi(agent: AgentName): PiToolDescriptor[] {
  return listForAgent(agent).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: assertObjectSchema(t.name, zodToJsonSchema(t.schema, { target: "jsonSchema7" })),
    sensitive: t.sensitive,
    promptSnippet: t.promptSnippet,
    ...(t.promptGuidelines ? { promptGuidelines: t.promptGuidelines } : {}),
  }));
}

/**
 * 工具入参的顶层 JSON Schema **必须是 object**。
 *
 * `z.discriminatedUnion` / `z.union` 出来的是 `{anyOf: [...]}`，顶层没有 `type: "object"`，
 * 上游注册工具表时会拒掉——而后果不是"这个工具用不了"，是**持有它的 Agent 整个哑掉**：
 * 每一次 prompt 都返回空字符串，没有任何报错。
 *
 * 实测踩过：`calendar` 用了 discriminatedUnion，于是 trip 与 ownership 两个 Agent
 * 问什么都回空，而 supervisor / service / buying / cabin 一切正常。
 * 排查方向会一路指向 ACP、pi、模型，唯独指不到一个 schema 的形状上。
 *
 * 所以这条在**取工具表时就炸**，而不是等运行时表现出症状。
 * 多态入参一律写成"扁平对象 + refine"（`placeSchema` / `calendarSchema` 都是这么做的）。
 */
export function assertObjectSchema(tool: string, schema: unknown): Record<string, unknown> {
  const s = schema as Record<string, unknown>;
  if (s?.type !== "object") {
    throw new Error(
      `[${tool}] 工具入参的顶层 schema 必须是 object，实际是 ${JSON.stringify(Object.keys(s ?? {}))}。` +
        `union/discriminatedUnion 会生成 anyOf——改成「扁平对象 + refine」（见 calendarSchema 的说明）。`,
    );
  }
  return s;
}

/**
 * 工具调用的耗时观察者（施工单 TD-08 任务 3，F-44-04）。
 *
 * # 为什么挂在这里，而不是在两个调用点各埋一次
 *
 * 工具有**两条**入口：图节点直调 `invokeTool`（`graph/subgraphs/*`），
 * 与 pi 经 HTTP 打进 `tools-endpoint` 后再调 `invokeTool`。
 * 两处各埋会漂移——改一处忘另一处时，缺的那条在回放页上表现为
 * "这一跳不存在"，而不是"埋点漏了"。挂在这个共同的下游，一处覆盖两条。
 *
 * 沿用本包既有的模块级 DI（`setRagClient` / `setUsageStore` / `setAmapClient` 同款）：
 * `@carlife/tools` **不 import enterprise/backend/ 下的服务**（AC-34-4，`check:arch` 守），
 * 所以出口只能由装配层注入，不能反向依赖。
 *
 * 观察者**永不影响工具执行**：它抛错被吞，工具的返回值与异常原样透出。
 */
export interface ToolInvocationObservation {
  name: string;
  ctx: ToolCallContext;
  /**
   * 本次调用的 id，与 `ToolStartNotice.callId` 是同一个值（F-08-05）。
   *
   * 端上要靠它把"开始"和"完成"配成一对——**同一轮里同一个工具会被调好几次**
   * （出行 fan-out 里 `weather` 实测五次），只按工具名配对会把第一条的完成
   * 记到最后一条头上，表现是进度提示乱跳。
   */
  callId: string;
  startedAt: number;
  endedAt: number;
  status: "ok" | "failed";
  /**
   * 这次调用的一行概括，由工具自己的 `traceSummary` 产出（见那里的说明）。
   * 未声明的工具为 undefined——**缺省是安全的那一侧**。
   */
  summary?: string;
  /** 失败时的错误，供调用方自行归类。**不要原样落库**——外部报错里带过入参回显。 */
  error?: unknown;
}

export type ToolObserver = (o: ToolInvocationObservation) => void;

/**
 * 调用**开始**时的通知（F-08-05）。
 *
 * # 为什么不能复用 `ToolObserver`
 *
 * 那个观察者在调用**结束**时才触发（它要报耗时与成败）。而"正在查沿途天气"
 * 这句话存在的全部理由是填那十几秒空白——等工具跑完再说，
 * 说的就是一件已经不成立的事。
 *
 * 两个出口而不是给 `ToolInvocationObservation` 加个 `phase` 字段：
 * 后者会让现有的轨迹观察者（它按"一次调用 = 一条 span"记）必须先判分支，
 * 而那正是它今天不需要关心的事。
 */
export interface ToolStartNotice {
  name: string;
  ctx: ToolCallContext;
  /** 与结束时那条 `ToolInvocationObservation.callId` 相同。 */
  callId: string;
  startedAt: number;
}

export type ToolStartObserver = (o: ToolStartNotice) => void;

let toolObserver: ToolObserver | undefined;
let toolStartObserver: ToolStartObserver | undefined;

/** 装配层注入；传 undefined 即卸载（单测清场用）。 */
export function setToolObserver(o: ToolObserver | undefined): void {
  toolObserver = o;
}

export function getToolObserver(): ToolObserver | undefined {
  return toolObserver;
}

/** 同上，但触发在调用**开始**时。缺省即不通知——端上少一条进度，不影响执行。 */
export function setToolStartObserver(o: ToolStartObserver | undefined): void {
  toolStartObserver = o;
}

export function getToolStartObserver(): ToolStartObserver | undefined {
  return toolStartObserver;
}

/** 统一执行入口：pi 扩展与 MCP 都经这里，**权限门将来只需接一处**（M5-02）。 */
export async function invokeTool(
  name: string,
  args: unknown,
  ctx: ToolCallContext,
): Promise<unknown> {
  const reg = getTool(name);
  if (!reg) throw new Error(`未注册的工具：${name}`);

  const parsed = reg.schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`[${name}] 入参不合法：${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  // 入参校验失败**刻意不计入耗时**：那不是一跳外部调用，是本地拒绝，
  // 混进去会在时延分布里造出一堆 0ms 的假样本。
  const startedAt = Date.now();
  // 概括在**校验之后**算，所以拿到的是已解析的入参，不必自己防御脏数据。
  // 它自己抛错也只丢掉这一条概括，不影响工具执行（与观察者同一取向）。
  const summarize = (result?: unknown): string | undefined => {
    try {
      return reg.traceSummary?.(parsed.data as never, result);
    } catch {
      return undefined;
    }
  };
  // 失败路径用的是不带结果的那一版（此时也没有结果可给）。
  let summary = summarize();

  // 一次调用一个 id：同一轮里同一个工具会被调好几次（出行 fan-out 里
  // weather 实测五次），端上按名字配对会把完成记到别人头上。
  const callId = randomUUID();

  const observe = (status: "ok" | "failed", error?: unknown): void => {
    if (!toolObserver) return;
    try {
      toolObserver({ name, ctx, callId, startedAt, endedAt: Date.now(), status, summary, error });
    } catch {
      // 吞掉：观察者坏了不该让工具坏。
    }
  };

  if (toolStartObserver) {
    try {
      toolStartObserver({ name, ctx, callId, startedAt });
    } catch {
      // 同上：**它在工具执行之前**，抛出去会把一次正常调用变成失败。
    }
  }

  // 权限门不在这里调：它需要会话上下文与中断能力，落在 agent-runtime 的
  // tools-endpoint（M5-02）。本函数保持**纯执行**，才能被单测直接调用（AC-34-4）。
  try {
    const r = await reg.tool.call(parsed.data as never, ctx);
    // 成功后带着结果重算一次：只读工具靠它把"查到几条"记进轨迹。
    summary = summarize(r);
    observe("ok");
    return r;
  } catch (err) {
    observe("failed", err);
    throw err;
  }
}
