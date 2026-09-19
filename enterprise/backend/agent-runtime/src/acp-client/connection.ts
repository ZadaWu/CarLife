/**
 * 垫片 + 车主面专属的那几样（施工单 M85-09 步 5，变更单 ACR-035）。
 *
 * # 这个文件现在分两半
 *
 * **上半是 re-export**：`AcpClient` / `createAcpStreamer` / 连接与会话管理都搬进了
 * `@carlife/acp`。搬的理由见那个包的文件头——用研面要跑在同一套 ACP 上，
 * 而 ADR-011 禁止它 import 车主面。
 *
 * **下半留在这里，因为它们是车主面的东西，不是底座的**：
 *  - `AgentName`：十五个车主面 Agent 的名字。底座只认 `string`——
 *    它不该知道 `hotel` 和 `nav` 是什么。
 *  - `toolListFor`：要 `@carlife/tools`。**这条是硬的**——底座引了工具表，
 *    用研面就间接拿到车主面的全部工具，而那不报错。
 *  - `withDateline` / `dateline`：要 `../holidays`，而且语义本身是车主面的
 *    （用研面分析的是一段已经发生过的窗，"今天"对它没有意义）。
 *    它经 `AcpApp.decoratePrompt` 注入给底座。
 *
 * # 调用点为什么一行没改
 *
 * 本单的红线是行为零变化，而"零变化"要能被回归证明——证明方式就是调用点与测试
 * 逐字不动。所以 `AcpClient` 在这里被包了一层：构造时自动带上车主面的描述符，
 * `new AcpClient({...})` 与 `new AcpClientPool()` 的写法与从前完全一样。
 */

import {
  AcpClient as AcpClientBase,
  createAcpStreamer as createAcpStreamerBase,
  type AcpClientOptions as AcpClientOptionsBase,
  type AcpHealth,
  type AcpPrompter,
  type ChatStreamHooks,
  type ChatStreamer,
} from "@carlife/acp";
import { canonicalAgent } from "@carlife/acp";
import { listForAgent, type AgentName as ToolAgentName } from "@carlife/tools";

import { holidayLine } from "../holidays";
import { createCockpitApp, COCKPIT_PI_DIR } from "./cockpit-app";

/*
 * 原样 re-export：这两个是纯函数，搬家时一行没动。
 * **导出面必须逐字对得上**——少一个的表现不是编译红，而是某个测试文件
 * 在运行时报 `does not provide an export named`（本单实测踩到一次）。
 */
export { modelSpecFor, trailingUserRunStart } from "@carlife/acp";
export type { AcpHealth, AcpPrompter } from "@carlife/acp";

/** 车主面的构造参数：`app` 由这里补上，调用点不用知道有这回事。 */
export type AcpClientOptions = Omit<AcpClientOptionsBase, "app"> & { app?: AcpClientOptionsBase["app"] };

/**
 * 车主面的 `AcpClient`。
 *
 * 只做一件事：**没传 `app` 时补上车主面的描述符**。
 * 底座那一侧 `app` 是必填的（漏传在 tsc 就红）——默认值只该出现在
 * "确实知道自己是车主面"的这一层，不该出现在底座里。
 */
export class AcpClient extends AcpClientBase {
  constructor(opts: AcpClientOptions = {}) {
    super({ ...opts, app: opts.app ?? createCockpitApp() });
  }
}

/** 同上：`piDir` 由车主面补。 */
export function createAcpStreamer(
  client: AcpPrompter,
  resolve: (hooks?: ChatStreamHooks) => { carlifeSessionId: string; agent: string },
): ChatStreamer {
  return createAcpStreamerBase(client, resolve, COCKPIT_PI_DIR);
}

// ── 下半：车主面专属 ───────────────────────────────────────

export type AgentName =
  | "supervisor"
  | "buying"
  | "ownership"
  | "trip"
  | "cabin"
  | "service"
  // 试驾预约（M19-03，第六个业务 Agent）。**名字不能以 `-task`/`-intent`/`-voice` 结尾**——
  // `canonicalAgent` 会剥掉那些后缀，`loadAgentPrompt` 就去找错文件了，
  // 而外部症状只是"分支失败"（`trip-task.md` 那次踩过）。`test-drive` 安全。
  | "test-drive"
  // 多天行程 fan-out 的四个专家（M12-02）：只以 `-task` 会话被编排层驱动（思考档
  // 随后缀落 off），**没有直达路由**——route.ts 的目标里没有它们，answer 也不发给它们。
  | "drive"
  | "hotel"
  | "tour"
  | "transit"
  // 景区导游采集三分支（M36-01）：同上，仅以 `-task` 会话被 runGuideFanout 驱动，
  // 触发方式是点击景点（HTTP），不经聊天路由。与 registry.ts 的第二份必须同步。
  | "guide-access"
  | "guide-spots"
  | "guide-comfort"
  // 出发导航规划（M66-01）：仅以 `nav-task` 会话被 runNavPlanFanout 驱动，触发方式是点「开始行程」（HTTP），
  // 不经聊天路由。与 registry.ts 的第二份必须同步。
  | "nav"
  // 多天行程 Plan 层的语义裁决（M86-03，ACR-037）：只以 `tour-plan-task` 会话被 runTripPlanLayer 驱动，
  // 不进路由、不应答。与 registry.ts 的第一份必须同步。
  | "tour-plan"
  // 装配体检修复的裁决会话（M86-05，ACR-037 第 5 步）：只以 `trip-review-task` 会话被 reviewLoop 驱动，
  // 不进路由、不应答；思考档由 PI_OVERRIDES 钉 high。与 registry.ts 的第一份必须同步。
  | "trip-review";

/**
 * 该 Agent 的工具允许清单（施工单 M23-01），拼给 `--tools`。
 *
 * # 为什么从 `listForAgent` 派生而不是另写一份
 *
 * ACL 的单一真相源是 registry 的 `agents` 数组（M23-00 红线）。describe 端裁剪、
 * invoke 端 403、本清单三处**必须同源**——第四份手写清单出现之日，就是它们漂移之始。
 * 名字与扩展注册的完全一致也由同源保证：pi 对 `--tools` 里的未知名**静默忽略**
 * （2026-08-25 实测 T4），拼错不会报错，只会让那个工具无声消失。
 *
 * # 为什么在 spawn 时算而不是缓存
 *
 * 注册表是静态模块，`listForAgent` 是一次数组 filter；连接重建本来就是罕见路径，
 * 缓存只会引入"注册表变了但清单没变"的第三种状态。
 */
export function toolListFor(agent: AgentName | string): string {
  return listForAgent(canonicalAgent(agent) as ToolAgentName)
    .map((t) => t.name)
    .join(",");
}

/**
 * 每次 `session/prompt` 前置一行「今天是几号」。
 *
 * 模型不知道今天的日期，而车主的话里全是相对日期（「下周末」「后天」「十七号」）。
 * turn-45356a1a（2026-09-04）里车主说「下周末去杭州」，意图会话拿 `2027-04-17`、
 * drive 分支拿 `2025-01-01` 去查天气，两次都在窗口判定上失败；drive 是从报错信息里
 * 带的「至 2026-09-07」反推出今天，改成不传日期才查到。此前提示词里没有任何一处
 * 给过当天日期——`elicitation/extract.ts` 有先例，但只在信息抽取那条路径上。
 *
 * **放在这里而不放系统提示词**：系统提示词在 pi 进程启动时一次拼死（`--append-system-prompt`），
 * 进程跨过零点日期就错了；这一行按轮拼，跨零点自然对。
 * 时区取北京时间，与天气/门店时段的口径一致（见 `weather.ts` 的 `today()`），
 * 否则跨零点前后会差一天。
 */
export function dateline(now: number = Date.now()): string {
  const bj = new Date(now + 8 * 3_600_000);
  const ymd = bj.toISOString().slice(0, 10);
  const weekday = "日一二三四五六"[bj.getUTCDay()];
  return `【今天是 ${ymd}（周${weekday}），北京时间】`;
}

/**
 * 给一轮 prompt 前置"模型手里没有、又必须准"的事实：今天几号，以及接下来的节假日。
 *
 * 节假日是 2026-09-13 那次真跑补的：车主说「去过中秋节」，tour 分支排出 2026-09-15
 * ——而那是**2027 年**的中秋，模型把农历年份串了。`dateline` 只解决了相对日期
 * （「下周二」「后天」），解决不了「中秋是几号」。农历换算不该让模型做，
 * 它做不对，且错了没人看得出来（9/15 看上去就是个正常日期）。
 *
 * 表覆盖不到时 `holidayLine` 回空串，这里就只前置日期行——**宁可不给，也不给错的**。
 */
export function withDateline(text: string, now: number = Date.now()): string {
  const holidays = holidayLine(now);
  return [dateline(now), holidays, text].filter(Boolean).join("\n");
}
