/**
 * SSE 信封 → 桥接事件的投影（ACR-049）。
 *
 * **这是 `clients/shared/rust/carlife-core/src/fanout.rs` 里 `project()` 的逐条移植**，
 * 不是重新设计。原生端由 Rust 做这件事再 emit 给 WebView；演示构建里没有 Rust，
 * 同一件事由这里做。两边必须给出同样的结果，所以本文件的测试消费的是
 * `contracts/fixtures/contract-events.json`——Rust 那侧 `contract_roundtrip` 用的同一份。
 *
 * 移植时原样保留了三条纪律，每一条在 Rust 那边都是踩过坑才有的：
 *  - 垫场话、工具进展、会话标题**绝不进累积**：累积是"进历史"的唯一入口，
 *    它们进去了，用户翻历史就会看到一串"我在查你这车的手册"。
 *  - `turn_end` 时累积为空 → 只回 idle，不追加消息：撤回会清掉累积而 turn_end 照常到来，
 *    不判这一下就会在撤回文案下面挂一个空气泡。
 *  - 撤回**必须投影**：忽略它意味着端上继续显示那段被审核拦下的文本，
 *    而服务端以为已经撤掉了——"看起来没事、实际泄露"。
 *
 * 纯函数、零 IO，不 import 任何 Tauri 的东西。
 */

import { BRIDGE_EVENTS, type ChatMessage, type EventEnvelope } from "@carlife/shared";

export interface BridgeEmit {
  event: string;
  payload: unknown;
}

/** 每轮的正文累积。键是 turnId——同一条流上前后两轮不会串。 */
export class TurnAccumulator {
  private readonly parts = new Map<string, string>();
  push(turnId: string, text: string): void {
    this.parts.set(turnId, (this.parts.get(turnId) ?? "") + text);
  }
  take(turnId: string): string {
    const full = this.parts.get(turnId) ?? "";
    this.parts.delete(turnId);
    return full;
  }
}

const idle = (): BridgeEmit => ({ event: BRIDGE_EVENTS.assistantState, payload: "idle" });

/**
 * 去掉判别字段。Rust 那侧 emit 的是内层结构体（`PermissionRequest`、`UpdateBranch`…），
 * 序列化出来**没有** `type` / `kind`——那两个字段属于外层的带标签枚举。
 * 多带两个字段界面多半也不会坏，但"多半"不是对齐，载荷要与原生端逐字段一致。
 */
function inner<T extends object>(ev: T): Omit<T, "type" | "kind"> {
  const { type: _t, kind: _k, ...rest } = ev as T & { type?: unknown; kind?: unknown };
  return rest as Omit<T, "type" | "kind">;
}

export function project(env: EventEnvelope, acc: TurnAccumulator): BridgeEmit[] {
  const ev = env.event;
  switch (ev.type) {
    case "session":
      return [];
    case "prompt": {
      // 用户气泡的**唯一来源**：端上不做乐观插入，语音是 ASR 原文、文字是打的那句，都走这里。
      // 不带原文的 prompt 只可能来自很旧的服务端，忽略，靠回源校正。
      if (ev.transcript == null) return [];
      const attachments = ev.attachments && ev.attachments.length > 0 ? ev.attachments : undefined;
      const message: ChatMessage = {
        // NOTE(耦合)：镜像网关约定 `msg-{turnId}-u`，与 Rust 侧同一处耦合
        messageId: "msg-" + ev.turnId + "-u",
        sessionId: env.sessionId,
        turnId: ev.turnId,
        role: "user",
        source: ev.source,
        content: ev.transcript,
        ts: env.ts,
        ...(attachments ? { attachments } : {}),
      };
      return [{ event: BRIDGE_EVENTS.dialogMessage, payload: message }];
    }
    case "permission":
      // 原样透传，**不改助手状态机**：挂起的是工具调用，本轮的 delta/turn_end 仍会照常到来
      return [{ event: BRIDGE_EVENTS.dialogPermission, payload: inner(ev) }];
    case "tool_call":
      return [{ event: BRIDGE_EVENTS.dialogToolCall, payload: inner(ev) }];
    case "update":
      break;
    default:
      return [];
  }

  switch (ev.kind) {
    case "state":
      return [{ event: BRIDGE_EVENTS.assistantState, payload: ev.state }];
    case "delta":
      acc.push(ev.turnId, ev.text);
      return [{ event: BRIDGE_EVENTS.dialogDelta, payload: { turnId: ev.turnId, text: ev.text } }];
    case "turn_end": {
      const full = acc.take(ev.turnId);
      if (full.length === 0) return [idle()];
      const message: ChatMessage = {
        messageId: ev.messageId,
        sessionId: env.sessionId,
        turnId: ev.turnId,
        role: "assistant",
        source: "text",
        content: full,
        ts: env.ts,
      };
      return [{ event: BRIDGE_EVENTS.dialogMessage, payload: message }, idle()];
    }
    case "branch":
      // 分支跑完不等于这一轮结束，映射成 idle 会让 HUD 提前收起
      return [{ event: BRIDGE_EVENTS.dialogBranch, payload: inner(ev) }];
    case "retract": {
      acc.take(ev.turnId);
      const message: ChatMessage = {
        messageId: "msg-" + ev.turnId + "-retracted",
        sessionId: env.sessionId,
        turnId: ev.turnId,
        role: "assistant",
        source: "text",
        content: ev.replacement,
        ts: env.ts,
      };
      return [{ event: BRIDGE_EVENTS.dialogMessage, payload: message }, idle()];
    }
    case "filler":
      return [{ event: BRIDGE_EVENTS.dialogFiller, payload: inner(ev) }];
    case "title":
      return [{ event: BRIDGE_EVENTS.dialogTitle, payload: inner(ev) }];
    default:
      return [];
  }
}
