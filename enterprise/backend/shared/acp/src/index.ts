/**
 * `@carlife/acp` —— ACP 底座（变更单 ACR-035）。
 *
 * # 这个包是什么
 *
 * 「ACP Client 那一侧」的通用部分：连接、进程池、提示词装配、思考档、
 * `session/update` 到我们自己的流式事件的桥接。它**认识协议，不认识业务**。
 *
 * # 为什么要单独成包
 *
 * 用研面（`research-runtime`）要跑在同一套 ACP + pi 上，而
 * ADR-011
 * 与 `check:arch` 的 `research-isolation` 禁止它 import 车主面。
 * 底座不先抽出来，`pi-research` 与研究工具表只能长在 `agent-runtime` 里——
 * 也就是长在一个用研面够不着的位置上。
 *
 * # 两条硬边界（`check:arch` 的 `acp-substrate-pure` 守着）
 *
 * ① **不得 import `@carlife/{tools,db,memory,guardrails}`。**
 *    引了工具表，用研面就会间接拿到车主面的全部工具——而那**不报错**，
 *    只是模型手里多了一堆它不该有的能力。
 * ② **不得出现 `import.meta.url`。** 底座不许自己推断"我旁边有什么目录"：
 *    `piDir` 与 `promptsDir` 一律由 `AcpApp` 描述符给。
 *    这一条是本包最不直观、也最值得写下来的一条，理由见 `app.ts` 的文件头。
 */

/* 六步搬完，底座的对外面就是下面这些。 */

export {
  messageText,
  type ChatImagePart,
  type ChatStreamer,
  type ChatStreamHooks,
  type ChatTurnMessage,
  type LlmUsageSample,
} from "./stream";
export { defaultThinkingFor, type ThinkingLevel } from "./thinking";
export type { AcpApp, AcpSpanOptions, AcpSpanStatus, AcpTracer } from "./app";

export { splitThinkBursts, THINK_GAP_MS, type ThinkBurst, type ThoughtTick } from "./think";
export {
  classifyUnmapped,
  DEFERRED_UPDATES,
  IGNORED_UPDATES,
  isPiAcpUpdateNotice,
  projectUpdate,
  type ProjectedUpdate,
  type UnmappedBreakdown,
  type UpdateSink,
} from "./update-bridge";


export { canonicalAgent } from "./naming";
export {
  AcpClient,
  createAcpStreamer,
  modelSpecFor,
  trailingUserRunStart,
  type AcpClientOptions,
  type AcpHealth,
  type AcpPrompter,
} from "./connection";
export { AcpClientPool } from "./pool";
