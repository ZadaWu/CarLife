/**
 * 车主面的 `AcpApp` 描述符（施工单 M85-09 步 4，变更单 ACR-035）。
 *
 * # 这个文件是整条链上 `@carlife/tools` 唯一该出现的位置
 *
 * 底座（`@carlife/acp`）不许 import 工具表：引了它，用研面就间接拿到了车主面的
 * 全部工具（订单、日历、车控……），**而那不报错**——模型手里多出一堆它不该有的
 * 能力，只有真跑一遍看工具有没有被调到才发现（`pool.ts` 的文件头记着同一形状的事故）。
 * 所以工具表、轨迹、节假日这三样都在这里注入，底座只拿到回调。
 *
 * # 这里的 `piDir` 是「车主面的」，不是「这个文件旁边的」
 *
 * 以前 `connection.ts` 用 `resolve(import.meta.url, "../../../pi-agents")` 自己推。
 * 那行代码搬进底座之后**仍然算得对**（层数恰好一样），而用研面接上来时
 * 它就会把车主面的 `.pi/extensions` 与 prompts 加载给用研面——零报错。
 * 所以路径改由描述符给，`check:arch` 的 `acp-substrate-pure` 禁掉底座里的
 * `import.meta.url`。**本文件里留着它是对的**：车主面确实就在 pi-agents 旁边。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listForAgent, type AgentName as ToolAgentName } from "@carlife/tools";
import type { AcpApp, AcpTracer, ThinkingLevel } from "@carlife/acp";

import { CancelledError } from "../trace";
import { recordPrompt, recordSpan, span } from "../trace/span";
import { canonicalAgent, loadAgentPrompt, thinkingLevelFor } from "./agent-prompt";
import { withDateline } from "./connection";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 车主面的 pi 配置目录。`.pi/extensions` 与 `settings.json` 都在它下面。 */
export const COCKPIT_PI_DIR = resolve(HERE, "../../../pi-agents");
export const COCKPIT_PROMPTS_DIR = resolve(COCKPIT_PI_DIR, "prompts");

/**
 * 车主面的轨迹实现。四样都是既有函数，这里只是把它们装进一个对象。
 *
 * `cancelled` 造的是 `trace` 的 `CancelledError`——调用方按 `err.cancelled`
 * 把取消与真失败分开，底座自己 new 一个的话两边对不上，
 * 而对不上时取消会被当成失败上报。
 */
export const cockpitTracer: AcpTracer = {
  span,
  recordSpan,
  recordPrompt,
  cancelled: (message) => new CancelledError(message),
};

/**
 * 车主面的十六个 Agent。与 `connection.ts` 的 `AgentName` 联合类型同源
 * ——那份是类型，这份是运行期的池键清单（`cockpit-app.test.ts` 钉两份逐字对齐）。
 */
export const COCKPIT_AGENTS = [
  "supervisor",
  "buying",
  "ownership",
  "trip",
  "cabin",
  "service",
  "test-drive",
  "drive",
  "hotel",
  "tour",
  "transit",
  "guide-access",
  "guide-spots",
  "guide-comfort",
  "nav",
  // 多天行程 Plan 层的语义裁决会话（M86-03）：池键 tour-plan:high，与 tour:off 各自独立进程。
  "tour-plan",
  // 装配体检修复的裁决会话（M86-05）：池键 trip-review:high，只在 CARLIFE_TRIP_PLAN_LAYER=review 时被发。
  "trip-review",
] as const;

export function createCockpitApp(opts: { toolsEndpoint: string; piDir?: string } = { toolsEndpoint: "" }): AcpApp {
  const piDir = opts.piDir ?? COCKPIT_PI_DIR;
  return {
    id: "cockpit",
    piDir,
    promptsDir: resolve(piDir, "prompts"),
    agents: COCKPIT_AGENTS,
    toolsEndpoint: opts.toolsEndpoint,
    // `loadAgentPrompt` 是同步的；描述符要 Promise 是为了让用研面能去库里取。
    promptFor: async (agent) => loadAgentPrompt(agent),
    thinkingFor: (agent): ThinkingLevel => thinkingLevelFor(agent),
    /*
     * ACL 的单一真相源是 registry 的 `agents` 数组（M23-00 红线）。
     * describe 端裁剪、invoke 端 403、本清单三处**必须同源**——
     * 第四份手写清单出现之日，就是它们漂移之始。
     */
    toolNamesFor: (agent) => listForAgent(canonicalAgent(agent) as ToolAgentName).map((t) => t.name),
    tracer: cockpitTracer,
    // 车主面要前置"今天几号 + 接下来的节假日"；用研面不传这个（见 `AcpApp.decoratePrompt`）。
    decoratePrompt: withDateline,
  };
}
