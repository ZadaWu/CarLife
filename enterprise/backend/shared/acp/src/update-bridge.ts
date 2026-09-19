/**
 * acp-client/update-bridge —— `session/update` → 图节点事件（施工单 M4-01 任务 3）。
 *
 * 【映射依据（M4-01 spike 实测的 update 类型）】
 *   agent_message_chunk      → delta（文本增量，驱动端上 SSE 的 update/delta）
 *   agent_thought_chunk      → thought（思考过程；本 Sprint 不下发，FL-03 F-03-04 归后续）
 *   tool_call / tool_call_update → 本 Sprint 只计数，事件下发归 M5（FL-08 F-08-05 人话化）
 *   session_info_update / available_commands_update / plan → 与端上语义无关，计数忽略
 *
 * 【不变量】映射不到的类型**忽略 + 计数上报，不抛错**——与 FL-01 F-01-08
 * 的端上适配器同一原则：协议演进不该让对话链路崩掉。
 *
 * 本模块**不产出 SessionEvent**：事件构造在 `events/`，封套在网关。这里只做语义分类，
 * 保证换掉 pi 时端上事件语义不变（这正是 ACP 边界的意义，§0）。
 */

/**
 * 映射不到的类型分三桶——**它们不是同一件事，不该报成同一条风险**。
 *
 * 这张分类表与上面的 `switch` 是同一份真相，所以放在同一个文件里：
 * 抄一份到 `health.ts` 就是又一个会静默漂掉的副本（`INC-0015` 刚记过这个形状）。
 *
 * 之前 `riskSummary` 把三桶合成一句
 * 「存在未映射的 ACP update 类型：available_commands_update×10, session_info_update×36,
 * tool_call×25, tool_call_update×50」，于是它**每次都在喊**：
 * 前两类是这里明写忽略的噪音，读的人看两次就学会跳过整行——
 * 而这一行原本要报的第三桶（协议真的演进了）就此再也没人看见。
 */

/**
 * 与端上语义无关，映射不到也不欠什么。**丢弃，不进风险行。**
 *
 * `tool_call` / `tool_call_update` 从 F-08-05 落地起进了这一桶：
 * 端上的工具进展**不从这里来**。理由是覆盖面——pi 的 update 只覆盖
 * 模型自己发起的调用，而购车检索、双路检索、试驾下单是图节点直调 `invokeTool` 的，
 * 那条路上根本没有 ACP update。接这边等于一半场景仍然对着空白等，
 * 而这半边看起来"已经做了"。真正的生产方挂在两条入口的共同下游
 * （`index.ts` 的 `setToolStartObserver` / `setToolObserver`）。
 */
export const IGNORED_UPDATES: readonly string[] = [
  "session_info_update",
  "available_commands_update",
  "plan",
  "tool_call",
  "tool_call_update",
];

/**
 * 已知欠着：**有消费方设计、没有生产方**。
 *
 * 值是"欠的是什么"，直接给人看。它们不进风险行——风险行的契约是
 * 「空数组才是可以上台的状态」，而一条永远清不掉的常驻项会把这个契约作废。
 *
 * **目前为空**，这是好事，不是忘了填：唯一一笔（端上工具进度没有生产方）
 * 已在 F-08-05 落地时还清。留着这个机制是因为下一笔迟早会有——
 * 而"定义了却没人写"这个形状在本仓已经记过两次（INC-0016 是其中之一）。
 */
export const DEFERRED_UPDATES: Readonly<Record<string, string>> = {};

export interface UnmappedBreakdown {
  /** 明写忽略的：报出来只是噪音。 */
  ignored: Record<string, number>;
  /** 已知欠着的：`欠的是什么 → 计数`。 */
  deferred: Record<string, { count: number; owes: string }>;
  /** **这一桶才是这条计数当初要报的东西**：协议演进的早期信号。 */
  unexpected: Record<string, number>;
}

/**
 * 两张表可以传进来，**是为了让"欠账"这一桶在它当前为空时仍然可测**。
 *
 * 不这么做的话，这个机制会随着最后一笔欠账被还清而失去测试覆盖，
 * 等下一笔出现时没人知道它还灵不灵——而"曾经测过、现在没测"
 * 与"从来没测过"在 CI 上长得一模一样。
 */
export function classifyUnmapped(
  counts: Record<string, number>,
  tables: { ignored: readonly string[]; deferred: Readonly<Record<string, string>> } = {
    ignored: IGNORED_UPDATES,
    deferred: DEFERRED_UPDATES,
  },
): UnmappedBreakdown {
  const out: UnmappedBreakdown = { ignored: {}, deferred: {}, unexpected: {} };
  for (const [kind, count] of Object.entries(counts)) {
    if (tables.ignored.includes(kind)) out.ignored[kind] = count;
    else if (tables.deferred[kind]) out.deferred[kind] = { count, owes: tables.deferred[kind] };
    else out.unexpected[kind] = count;
  }
  return out;
}

export type ProjectedUpdate =
  | { kind: "delta"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "unmapped"; rawKind: string };

export interface UpdateSink {
  push(item: { kind: "delta" | "thought"; text: string }): void;
  fail(e: Error): void;
}

/**
 * pi-acp 0.0.33 自己拼出的启动版本提示。
 *
 * 它不是模型内容，却被适配器作为普通 `agent_message_chunk` 发出；只匹配
 * 完整固定格式，避免吞掉用户或模型正常提到「新版本」的句子。
 */
const PI_ACP_UPDATE_NOTICE_RE =
  /^New version available: v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)? \(installed v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\)\. Run: `npm i -g @earendil-works\/pi-coding-agent`$/;

export function isPiAcpUpdateNotice(text: string): boolean {
  return PI_ACP_UPDATE_NOTICE_RE.test(text.trim());
}

/** ACP 的文本内容块形状：`{ type: "text", text: "..." }`。 */
function textOf(update: Record<string, unknown>): string | undefined {
  const content = update.content as { type?: string; text?: unknown } | undefined;
  if (content && content.type === "text" && typeof content.text === "string") return content.text;
  // 少数实现把文本直接挂在 update 上，容错取一次。
  if (typeof update.text === "string") return update.text;
  return undefined;
}

export function projectUpdate(update: unknown): ProjectedUpdate {
  if (!update || typeof update !== "object") return { kind: "unmapped", rawKind: "(non-object)" };
  const u = update as Record<string, unknown>;
  const rawKind = typeof u.sessionUpdate === "string" ? u.sessionUpdate : "(missing sessionUpdate)";

  switch (rawKind) {
    case "agent_message_chunk": {
      const text = textOf(u);
      return text === undefined ? { kind: "unmapped", rawKind } : { kind: "delta", text };
    }
    case "agent_thought_chunk": {
      const text = textOf(u);
      return text === undefined ? { kind: "unmapped", rawKind } : { kind: "thought", text };
    }
    default:
      return { kind: "unmapped", rawKind };
  }
}
