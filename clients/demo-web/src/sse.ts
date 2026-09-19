/**
 * SSE 帧解析——**纯函数，不碰 DOM、不碰 fetch**，所以能被 node:test 直接测。
 *
 * # 这个文件存在的唯一理由：两处曾经把自己的解析 bug 报成产品缺陷
 *
 * 网关下行的每一帧是一个**信封**，不是事件本身：
 *
 *     {"eventId":"…","sessionId":"…","ts":1789…,"event":{"type":"update","kind":"delta","turnId":"…","text":"…"}}
 *
 * 两层判别缺一不可，而错法的症状都离根因很远：
 *
 *   - 在第一层取 `kind`：`event.type` 恒为 `"update"`，`turn_end` 永远等不到，
 *     表现是"180 秒不收口"，实际 11 秒就收口了。
 *   - 增量取 `delta` 字段：实际字段名是 `text`（见 contracts 的 `UpdateDelta`），
 *     取错的表现是"回答 0 字"而事件计数完全正常。
 *
 * 所以判别逻辑集中在这里，并由 `test/sse.test.ts` 拿 contracts 的真实样例钉住。
 */

import type { EventEnvelope } from "@carlife/shared";

/** 从粘包的字节流里切出完整帧；返回切出的帧与剩下的尾巴（下次再拼）。 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { frames: parts.filter((p) => p.trim().length > 0), rest };
}

/** 一帧里可能有多行；只取 `data:` 行拼起来。解析不了就返回 null，不抛。 */
export function parseFrame(frame: string): EventEnvelope | null {
  const data = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data) as EventEnvelope;
  } catch {
    return null;
  }
}

/** 本轮新增的正文。不是 `delta` 字段，是 `text`。 */
export function deltaText(env: EventEnvelope): string | null {
  const ev = env.event;
  if (ev.type !== "update") return null;
  if (ev.kind !== "delta") return null;
  return ev.text;
}

/** 本轮是否收口。判别在第二层的 `kind` 上，不在第一层的 `type` 上。 */
export function isTurnEnd(env: EventEnvelope): boolean {
  const ev = env.event;
  return ev.type === "update" && ev.kind === "turn_end";
}

/** 助手形象五态，用来驱动界面上那个状态点。 */
export function assistantState(env: EventEnvelope): string | null {
  const ev = env.event;
  if (ev.type !== "update" || ev.kind !== "state") return null;
  return ev.state;
}

export interface PermissionView {
  interruptId: string;
  action: string;
  title: string;
  /** 这次动作要做什么。只显示动作名称是 FL-04 AC-04-2 明确禁止的。 */
  details: { label: string; value: string }[];
  /** 影响范围（如写入哪个日历账号）。 */
  scope: string | null;
  /**
   * 要提供给第三方的个人信息项。**必须渲染成独立一块**，不能并进 details——
   * 协议注释里写死了理由：混在一起，用户不会意识到"这次动作是什么"和
   * "我的哪些信息要发出去"是两回事。值在服务端已掩码，端上只渲染不自己拼。
   */
  disclosure: { label: string; value: string }[];
}

/** HITL 确认请求。返回 null 表示这帧不是确认请求。 */
export function permissionRequest(env: EventEnvelope): PermissionView | null {
  const ev = env.event;
  if (ev.type !== "permission") return null;
  return {
    interruptId: ev.interruptId,
    action: ev.action,
    title: ev.title,
    details: (ev.details ?? []).map((d) => ({ label: d.label, value: d.value })),
    scope: ev.scope ?? null,
    disclosure: (ev.disclosure ?? []).map((d) => ({ label: d.label, value: d.value })),
  };
}

/** 工具进展。`displayName` 是服务端给的人话，不是函数名——端上直接显示，不自己翻译。 */
export interface ToolProgress {
  id: string;
  label: string;
  status: "started" | "succeeded" | "failed";
}
export function toolProgress(env: EventEnvelope): ToolProgress | null {
  const ev = env.event;
  if (ev.type !== "tool_call") return null;
  return { id: ev.toolCallId, label: ev.displayName || ev.toolName, status: ev.status };
}

/**
 * 并行分支（lane）的一次状态变化。复合意图一句话拆成几条任务并行求解，
 * 这是访客**唯一能亲眼看到"它在同时办几件事"**的地方——不显示的话，
 * 那一两分钟就只是一段空白等待。
 */
export interface BranchProgress {
  agent: string;
  status: "started" | "ok" | "failed" | "timeout";
  note: string | null;
  durationMs: number | null;
}
export function branchProgress(env: EventEnvelope): BranchProgress | null {
  const ev = env.event;
  if (ev.type !== "update" || ev.kind !== "branch") return null;
  return { agent: ev.agent, status: ev.status, note: ev.note ?? null, durationMs: ev.durationMs ?? null };
}

/** 垫场话：整句一次下发，不是 token 流。只放在"思考区"，不进对话正文。 */
export function fillerText(env: EventEnvelope): string | null {
  const ev = env.event;
  if (ev.type !== "update" || ev.kind !== "filler") return null;
  return ev.text;
}

