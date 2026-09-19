/**
 * `@carlife/research-tools`：用研面的只读工具表（施工单 M88-02，ACR-038 步 2）。
 *
 * 三个消费方共用这一份定义：
 *   1. 直连路径 —— `research-runtime/src/challenge/tools.ts` 的垫片拼回 AI SDK `tool()`；
 *   2. ACP 路径 —— `pi-research/.pi/extensions/research-tools.ts` 取 `describeForPi`，
 *      执行经 research-runtime 的 tools-endpoint 回调 `invokeTool`（M88-03 / M88-04）；
 *   3. 单测 —— 脱离 Agent 与 LLM 直接调。
 *
 * **不 import `@carlife/tools` / `@carlife/acp` / `@carlife/agent-runtime` / `@carlife/memory`**：
 * 工具表不该认识协议，更不该认识车主面（ADR-011）。`check:arch` 的 `research-tools-ro` 守。
 */

export {
  ANALYST_TOOLS,
  ANALYST_TOOL_MAP,
  type AgreementReportResult,
  type CodebookLookupResult,
  type EvidenceByCodeResult,
  type LensCellView,
  type LensQueryResult,
  type ThemeMembersResult,
} from "./analyst";

export {
  ARCHIVIST_TOOLS,
  ARCHIVIST_TOOL_MAP,
  type EvidenceByIdResult,
  type PassportBrief,
  type SourcePassportResult,
} from "./archivist";

export {
  CHALLENGE_MAX_STEPS,
  CHALLENGE_TOOLS,
  CHALLENGE_TOOL_MAP,
  TOOL_LIMIT_MAX,
  type CounterEvidenceResult,
  type SegmentSlicesResult,
  type SystemEventsResult,
  type ThresholdSensitivityResult,
} from "./challenge";

export {
  RESEARCH_AGENT_NAMES,
  allowNullOnOptional,
  assertObjectSchema,
  describeForPi,
  getTool,
  invokeTool,
  listAll,
  listForAgent,
  stripNulls,
  type CodebookAgreementView,
  type CodebookAxisView,
  type CodebookCodeView,
  type CodebookView,
  type CodedAxis,
  type CodedUnitBrief,
  type LensSnapshotView,
  type PiToolDescriptor,
  type ResearchAgentName,
  type ResearchInvokeResult,
  type ResearchToolDeps,
  type ResearchToolRegistration,
  type UnitView,
} from "./registry";
