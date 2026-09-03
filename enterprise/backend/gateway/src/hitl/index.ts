/**
 * HITL 中转：interrupt → `permission` 事件 → resume 回灌（施工单 M5-03，§3 HITL 中转）。
 *
 * # 网关只转换，不裁决
 *
 * 裁决在 `agent-runtime` 的权限门（§8.4，M5-02）。本模块做三件事：
 *  1. 把 runtime 的中断投影成 SSE `permission` 事件（§3 事件语义对齐 ACP）；
 *  2. 收 `POST /v1/session/:id/resume` 并回灌给 runtime；
 *  3. 幂等——重复 resume 不让动作执行两次（F-04-11 / F-27-10）。
 *
 * 网关**不含业务逻辑**（§3 注）：它不知道"写日历"该不该批，只知道怎么把这个问题
 * 送到用户面前、再把答案送回去。
 *
 * # 为什么 resume 是独立的 POST 而不是走 SSE
 *
 * SSE 是单向下行（§3）。用户动作一律走 `POST`——这不是妥协，是协议选型的直接结论：
 * "请求-响应 + 单向流"覆盖了本场景的全部需求，不需要 WS 的全双工。
 */

import type { PermissionRequest, SessionEvent } from "@carlife/shared";

/** runtime 侧上报的中断。 */
export interface InterruptNotice {
  sessionId: string;
  interruptId: string;
  action: string;
  title: string;
  details: Array<{ label: string; value: string }>;
  scope?: string;
  /**
   * 将提供给第三方的个人信息项（M15-04，F-26-09）。
   *
   * **网关只做协议转换，不碰它的内容**：值在 runtime 侧由 `describeDisclosure()`
   * 生成并已掩码。这里补一个默认空数组，是为了旧版本 runtime 不发这个字段时
   * 仍能投影出合法事件——缺字段与"本次不外发"语义相同。
   */
  disclosure?: Array<{ label: string; value: string }>;
}

export interface ResumeResult {
  ok: boolean;
  /** 已被处理过——**这不是错误**：用户连点与网络重发是正常情况（F-04-11）。 */
  duplicate?: boolean;
  reason?: string;
}

export interface HitlOptions {
  /** 把裁决送回 runtime（`Command(resume)` 的网关侧入口）。 */
  forwardResume: (args: { sessionId: string; interruptId: string; approved: boolean }) => Promise<boolean>;
  /** 下发 SSE 事件。 */
  emit: (sessionId: string, event: SessionEvent) => void;
  now?: () => number;
}

/**
 * 中断中转器。
 *
 * 它持有"哪些中断点还没被回答"的状态——**这不是业务状态**，是协议状态：
 * 没有它就无法判断一次 resume 是首次还是重发。
 */
export class HitlRelay {
  /** interruptId → 会话与受理时间。 */
  private open = new Map<string, { sessionId: string; at: number }>();
  /** 已回答过的中断点：重发时据此安全空转。 */
  private answered = new Map<string, boolean>();

  constructor(private opts: HitlOptions) {}

  private get now() {
    return this.opts.now ?? Date.now;
  }

  /** runtime 报告一个中断 → 投影成 `permission` 事件下发（§3）。 */
  onInterrupt(notice: InterruptNotice): void {
    this.open.set(notice.interruptId, { sessionId: notice.sessionId, at: this.now() });

    const payload: PermissionRequest = {
      interruptId: notice.interruptId,
      action: notice.action,
      title: notice.title,
      // 明细必须是具体内容，不是动作名——F-04-02 的硬要求，在类型上就是必填数组。
      details: notice.details,
      scope: notice.scope ?? null,
      // 外发个人信息单独一段，**不并进 details**：端上要把它渲染成独立一块，
      // 混排的话用户根本不会注意到"我的手机号要发出去"这件事（F-26-09）。
      disclosure: notice.disclosure ?? [],
    };
    this.opts.emit(notice.sessionId, { type: "permission", ...payload } as SessionEvent);
  }

  /**
   * 端上确认/拒绝。
   *
   * 幂等在**网关这一层就挡住**，而不是依赖 runtime——
   * 少一次跨进程往返，且重发在协议层就被识别，不会污染裁决日志。
   */
  async resume(args: { sessionId: string; interruptId: string; approved: boolean }): Promise<ResumeResult> {
    const prior = this.answered.get(args.interruptId);
    if (prior !== undefined) {
      // 重复 resume 是正常情况，返回成功而不是报错——报错会让端上重试，越试越乱。
      return { ok: true, duplicate: true };
    }

    const entry = this.open.get(args.interruptId);
    if (!entry) {
      return { ok: false, reason: "unknown_interrupt" };
    }
    if (entry.sessionId !== args.sessionId) {
      // 跨会话 resume 是越权，不是笔误——拒绝并留痕。
      return { ok: false, reason: "session_mismatch" };
    }

    this.answered.set(args.interruptId, args.approved);
    this.open.delete(args.interruptId);

    const forwarded = await this.opts.forwardResume(args);
    if (!forwarded) {
      // runtime 侧已不认这个中断（多半是超时收敛了）。端上得到明确答复，
      // 而不是一个悬着的请求。
      return { ok: false, reason: "interrupt_expired" };
    }
    return { ok: true };
  }

  /** 挂起中的中断（供运维面与 F-14-09）。 */
  listOpen(): Array<{ interruptId: string; sessionId: string; waitingMs: number }> {
    const now = this.now();
    return [...this.open.entries()].map(([interruptId, v]) => ({
      interruptId,
      sessionId: v.sessionId,
      waitingMs: now - v.at,
    }));
  }
}
