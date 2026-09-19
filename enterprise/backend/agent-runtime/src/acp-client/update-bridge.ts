/**
 * 垫片：实现已搬进 `@carlife/acp`（施工单 M85-09 步 2，变更单 ACR-035）。
 * 为什么留着它而不是改调用点，见同目录 `think.ts` 的文件头。
 */

export {
  classifyUnmapped,
  DEFERRED_UPDATES,
  IGNORED_UPDATES,
  isPiAcpUpdateNotice,
  projectUpdate,
  type ProjectedUpdate,
  type UnmappedBreakdown,
  type UpdateSink,
} from "@carlife/acp";
