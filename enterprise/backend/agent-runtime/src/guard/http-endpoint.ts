/**
 * 动作权限门 `POST /internal/guard/check`（施工单 M5-02，§8.4 / §10 要点 4）。
 *
 * # 它与 ACP 协议无关
 *
 * `pi-acp` 不实现 `session/request_permission`（§0 已澄清 3）。但这不构成阻塞：
 * CarLife 的敏感动作**全部是我们自己注册的工具**，`execute()` 是我们写的代码，
 * 权限检查就是它内部的一次调用。M4-02 之后工具本就在本进程执行，
 * 所以这次"内部 HTTP"实际退化成**进程内函数调用**——比架构文档设想的还简单。
 * 端点形态仍保留（§10 要点 4 的落点），供将来工具移出进程时使用。
 *
 * # 三档裁决（§8.4 表）
 *
 * | 档 | 处理 |
 * |---|---|
 * | 硬禁 | **自动拒绝，不经用户、不进 HITL** |
 * | 需确认 | 触发 `interrupt()`，**本次调用保持挂起**等 resume |
 * | 放行 | 直接过；只读工具**根本不调本模块**，零额外往返（F-27-09） |
 *
 * # 挂起为什么是"天然的"
 *
 * 工具的 `await` 停在这里等 Promise，Promise 要等用户确认后才 resolve。
 * 不需要额外状态机——这是 §8.4 选内部调用而非协议扩展的直接好处。
 * 代价是**必须有超时兜底**：否则一个没人管的确认会永久占住一个挂起的调用。
 */

import { checkHardBlock, hardBlockReply, type HardBlockCategory } from "./hard-block-rules";
import { INTERRUPT_POINTS } from "../graph/interrupts";

export type GuardDecision = "allow" | "deny" | "needs_confirmation";

export interface GuardCheckRequest {
  sessionId: string;
  turnId?: string;
  agent?: string;
  /** 工具名（`appointment` / `calendar` …）。 */
  tool: string;
  /** 动作的人类可读摘要——**弹窗里显示的就是它**（F-04-02：不只显示动作名）。 */
  summary: string;
  /**
   * 动作的逐条明细（如行程的逐日安排）。**与 `disclosures` 不是一回事**：
   * 这里是"这次动作要做什么"，那里是"我的哪些信息要发出去"。
   *
   * 分开是因为端上把 `disclosures` 渲染成「将提供给门店的信息」——
   * 行程逐日清单挂在那个标题下，等于告诉用户行程要发给门店。
   */
  details?: string[];
  /** 将要外发的信息项（F-26-09 知情要求）。 */
  disclosures?: string[];
  /** 幂等键：同一个动作重复检查只产生一次裁决（F-27-10）。 */
  idempotencyKey?: string;
  /**
   * 动作指纹（会话 + 工具 + 入参）。由调用层算，用于**拒绝记忆**。
   *
   * 与 `idempotencyKey` 的区别：那个是"这是同一次请求"（调用方给），
   * 这个是"这是同一件事"（我们算）。模型重试时不会重发同一个幂等键，
   * 但它重试的确实是同一件事。
   */
  actionKey?: string;
}

export interface GuardCheckResult {
  decision: GuardDecision;
  /** 拒绝或需确认的原因；`deny` 时它就是给用户看的话术。 */
  reason: string;
  category?: HardBlockCategory;
  /** 需确认时的中断点 id，网关据此关联 resume。 */
  interruptId?: string;
}

/**
 * 还没对外的确认（ACR-023 / M69-04）：同一会话已经有一条确认在端上时，后到的在这里排队。
 * 排队期间**不起确认计时**（那是用户的思考时间）、不发 `onInterrupt`；只起一个排队上限计时，防无限等。
 */
interface QueuedConfirmation {
  request: GuardCheckRequest;
  startedAt: number;
  enqueuedAt: number;
  resolve: (r: GuardCheckResult) => void;
  queueTimer: ReturnType<typeof setTimeout>;
}

/** 挂起中的确认。**必须有超时**，否则没人管的确认会永久占住一个调用。 */
interface PendingConfirmation {
  interruptId: string;
  sessionId: string;
  request: GuardCheckRequest;
  resolve: (r: GuardCheckResult) => void;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface GuardGateOptions {
  /**
   * 挂起超时。§13-4 提醒 Node 的默认 HTTP 超时要为这个端点单独放宽；
   * 因为工具已在进程内，我们不受 HTTP 超时约束，但**业务超时仍然必要**：
   * 超时后按"未确认 = 不执行"收敛（FL-04 F-04-05），
   * **绝不允许"过了很久突然自己执行了"**。
   */
  confirmTimeoutMs?: number;
  /** 挂起数上限（F-27-12），防止内存被无人认领的确认吃满。 */
  maxPending?: number;
  /**
   * 拒绝记忆的有效期。默认 10 分钟。
   *
   * 不是永久：用户改主意是正常的，"十分钟前不肯"不该变成"这辈子别问了"。
   */
  refusalTtlMs?: number;
  now?: () => number;
  /** 需确认时通知外部（网关据此下发 `permission` 事件）。 */
  onInterrupt?: (p: { interruptId: string; request: GuardCheckRequest }) => void;
  /** 每次裁决（**含放行**）落审计——§8.5 的硬要求。 */
  onAudit?: (a: { request: GuardCheckRequest; result: GuardCheckResult; durationMs: number }) => void;
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_REFUSAL_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING = 100;

/**
 * 需要用户确认的工具（§8.4 表第二行）。只读工具不在此列，也根本不会调到这里。
 *
 * **导出是为了能被断言**（M13-02）：不在这个集合里的 sensitive 工具会被"自动放行"，
 * 后果是最险的一种——行程无确认落库、链路看起来完全正常。
 * 新增 sensitive 工具时这里必须同步，测试守着 `trip_plan_commit` 这一条。
 */
export const CONFIRM_REQUIRED_TOOLS = new Set([
  "appointment",
  "calendar",
  "trip_plan_commit",
  // M13-11 拆分：取消与变更各自成工具，两个都要问。
  // **拆工具时最容易漏的就是这里**——漏了就是 sensitive 却自动放行，
  // 现象是"行程被改了/取消了但从没弹过窗"，而链路看起来完全正常。
  "trip_plan_cancel",
  "trip_plan_update",
  // M14-03：问诊留档改的是用户的车辆记录（可能被拿去和修理厂争议），
  // 此前它是"sensitive 但不在集合里"——正是上面警告的自动放行形态。
  "vehicle_profile_write",
  // M19-02：试驾下单。漏加就是"sensitive 但自动放行"——无确认下单，
  // 而链路看起来完全正常。
  "test_drive_book",
  /*
   * M24-03：儿童模式（后排屏锁 / 音量上限 / 儿童锁上锁）——影响后排乘员，需车主确认。
   *
   * **这是本注释警告过的坑第四次发作**（前三次：trip_plan_cancel/update、
   * vehicle_profile_write、test_drive_book）。M24-03 在 registry 标了 `sensitive: true`
   * 就以为完事了，这里没加——真跑 sess-e48edc84-edf 里权限门直接判
   * 「非敏感动作，自动放行」，屏幕锁上了而弹窗从未出现，模型还自作主张说
   * 「如果刚才的确认弹窗您通过了」。子图测试用的是注入的 fake gate，永远发现不了。
   *
   * 所以这次不只补一行：`guard.test.ts` 增加**全集不变量**——registry 里每个
   * `sensitive: true` 的工具都必须在本集合里。靠人记得同步的两处声明，迟早再漏第五次。
   */
  "cabin_child_mode",
  /*
   * M24 收口：登记座舱偏好改 A 型后，「确认前不落库」（AC-50-2）从编排层的
   * 正则时序降到这里用结构兑现——模型随时可以调，用户没点确认就一个字都不写。
   */
  "member_preference_set",
]);

export class GuardGate {
  private pending = new Map<string, PendingConfirmation>();
  /**
   * 同会话排队（ACR-023 设计要点 9 / M69-04）。
   *
   * 端上确认层只有一个槽（`onPermission: (p) => setPermission(p)`），运行时却允许同一会话多条确认同时挂起：
   * 两条同时到达时第二条把第一条从屏幕上顶掉，被顶掉的挂到 10 分钟超时按「不执行」收敛——用户以为没约上，
   * 其实是没看见。行程 fan-out 里本就可能撞上，分叉—汇合的并行 lane 让它必然撞上。
   *
   * 所以**同一会话同时只放一条确认出去**：`active` 记这一条的 interruptId，后到的进 `queue`；前一条 resume 或超时后
   * 按 lane 优先级出队（主 lane 先、副 lane 按意图顺序，同优先级按到达）。排在门内而不是端上，是因为端上单槽要改两个端
   * 和一份契约，门内改一处所有端受益。裁决语义（硬禁 / 放行 / 拒绝记忆 / 幂等 / 超时 = 不执行）一个字不动。
   */
  private queue = new Map<string, QueuedConfirmation[]>();
  private active = new Map<string, string>();
  /** 副 lane 的 agent 顺序，`dispatch` 每轮登记；不在表里的 agent 一律算主 lane（优先级 0）。 */
  private laneOrder = new Map<string, string[]>();
  /** 幂等：同一 key 的裁决只产生一次（F-27-10）。 */
  private decided = new Map<string, GuardCheckResult>();
  /**
   * 已被用户否掉（拒绝或超时未答）的动作指纹。
   *
   * **只记「不」，不记「是」**——这个不对称是刻意的：
   * 记住一次同意，就等于让一次点击授权了后面所有同名动作，
   * 一句"帮我加个日历"可能变成三条重复日程。
   * 而记住一次拒绝只会少打扰用户，方向是安全的。
   */
  private refused = new Map<string, { reason: string; at: number }>();
  private seq = 0;

  constructor(private opts: GuardGateOptions = {}) {}

  private get now() {
    return this.opts.now ?? Date.now;
  }

  /** 对外挂起 + 门内排队的总数——排队不能成为新的无界增长。 */
  pendingCount(): number {
    return this.pending.size + this.queuedCount();
  }

  private queuedCount(): number {
    let n = 0;
    for (const q of this.queue.values()) n += q.length;
    return n;
  }

  /**
   * 登记本轮 lane 顺序（ACR-023）：`agents` 是副 lane 的 Agent 名按意图顺序。
   * 出队优先级 = 主（不在表里）0，副按下标 1..N。每轮由 `dispatch` 覆盖；空表即删。
   */
  setLaneOrder(sessionId: string, agents: readonly string[]): void {
    if (agents.length) this.laneOrder.set(sessionId, [...agents]);
    else this.laneOrder.delete(sessionId);
  }

  private priorityOf(sessionId: string, agent: string | undefined): number {
    const order = this.laneOrder.get(sessionId);
    if (!order || !agent) return 0;
    const i = order.indexOf(agent);
    return i < 0 ? 0 : i + 1;
  }

  /**
   * 裁决一次动作。**需确认时返回的 Promise 会一直挂起**，直到 resume 或超时。
   */
  async check(req: GuardCheckRequest): Promise<GuardCheckResult> {
    const startedAt = this.now();

    // 幂等：连点、网络重发不产生第二次裁决，更不产生第二次执行（F-27-10）。
    if (req.idempotencyKey) {
      const prior = this.decided.get(req.idempotencyKey);
      if (prior) return prior;
    }

    // ① 硬禁：自动拒绝，不经用户（§8.4 表首行）。
    //    判定同时看动作摘要、明细与外发项——摘要里没写但下面两处有的也要拦。
    //    **加字段就要加进这里**：明细漏扫的话，硬禁词藏在某一天的安排里就能过门。
    const haystack = [req.summary, ...(req.details ?? []), ...(req.disclosures ?? [])].join(" ");
    const hard = checkHardBlock(haystack);
    if (hard.blocked) {
      const result: GuardCheckResult = {
        decision: "deny",
        reason: hardBlockReply(hard.category!),
        category: hard.category,
      };
      this.finish(req, result, startedAt);
      return result;
    }

    // ③ 放行：不需要确认的工具直接过。
    if (!CONFIRM_REQUIRED_TOOLS.has(req.tool)) {
      const result: GuardCheckResult = { decision: "allow", reason: "非敏感动作，自动放行" };
      this.finish(req, result, startedAt);
      return result;
    }

    // ② 需确认前先看拒绝记忆：**同一件事被否过就别再弹**（F-27-10 的实际形态）。
    //
    // 实测过一次连弹七个确认框：模型被拒后立刻重试，而每次重试都是一个新的
    // interruptId、一个新的弹窗。用户拒绝的是"这件事"，不是"这一次调用"。
    // 在车里连打断七次，比不写日历糟得多。
    const refusal = req.actionKey ? this.refused.get(req.actionKey) : undefined;
    if (refusal && this.now() - refusal.at < (this.opts.refusalTtlMs ?? DEFAULT_REFUSAL_TTL_MS)) {
      const result: GuardCheckResult = {
        decision: "deny",
        // 话术要让模型明白"别再试了"，而不是以为这次偶然失败。
        reason: `${refusal.reason}（同一动作刚被否决过，未再次打扰用户；换个做法或先问问他）`,
      };
      this.finish(req, result, startedAt);
      return result;
    }

    if (this.pendingCount() >= (this.opts.maxPending ?? DEFAULT_MAX_PENDING)) {
      const result: GuardCheckResult = {
        decision: "deny",
        reason: "当前待确认动作过多，已拒绝本次请求以保护系统",
      };
      this.finish(req, result, startedAt);
      return result;
    }

    // ④ 需确认：进本会话的队列；没有对外挂起的确认时立即出队（ACR-023 / M69-04）。
    return new Promise<GuardCheckResult>((resolve) => {
      const item: QueuedConfirmation = {
        request: req,
        startedAt,
        enqueuedAt: this.now(),
        resolve,
        // 排队上限：与确认超时同款时长——前面那条要是十分钟没人管，这条也不该无限等。
        queueTimer: setTimeout(
          () => this.expireQueued(req.sessionId, item),
          this.opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
        ),
      };
      if (typeof item.queueTimer === "object" && "unref" in item.queueTimer) item.queueTimer.unref();
      const q = this.queue.get(req.sessionId) ?? [];
      q.push(item);
      this.queue.set(req.sessionId, q);
      this.dispatchNext(req.sessionId);
    });
  }

  /** 排队中就到了上限：按「等待确认超时」deny，与超时语义同款；它没拿过 interruptId，不进拒绝记忆。 */
  private expireQueued(sessionId: string, item: QueuedConfirmation): void {
    const q = this.queue.get(sessionId);
    if (!q) return;
    const i = q.indexOf(item);
    if (i < 0) return;
    q.splice(i, 1);
    if (q.length === 0) this.queue.delete(sessionId);
    const result: GuardCheckResult = { decision: "deny", reason: "等待确认超时，本次动作未执行（排队中未轮到）" };
    this.finish(item.request, result, item.startedAt);
    item.resolve(result);
  }

  /**
   * 出队：本会话没有对外挂起的确认时，按 lane 优先级取队首，走原来的挂起路径
   * （同一个 interruptId 规则、同一个 `onInterrupt`、同一个确认计时——排队只改"什么时候对外"，不改裁决）。
   */
  private dispatchNext(sessionId: string): void {
    if (this.active.has(sessionId)) return;
    const q = this.queue.get(sessionId);
    if (!q || q.length === 0) {
      this.queue.delete(sessionId);
      this.laneOrder.delete(sessionId);
      return;
    }
    // 稳定排序：优先级小的先出（主 0 < 副 1..N），同优先级按到达。
    q.sort((a, b) => this.priorityOf(sessionId, a.request.agent) - this.priorityOf(sessionId, b.request.agent) || a.enqueuedAt - b.enqueuedAt);
    const item = q.shift()!;
    clearTimeout(item.queueTimer);
    if (q.length === 0) this.queue.delete(sessionId);

    const req = item.request;
    const startedAt = item.startedAt;
    this.seq += 1;
    // **引用集中声明的中断点 id**（F-04-10）：这是"这一处挂起属于哪个中断点"的
    // 唯一物理标记。新增中断点却不登记进 `INTERRUPT_POINTS` 时，那边的测试会红。
    const interruptId = `itr-${INTERRUPT_POINTS.guardConfirm.id}-${req.sessionId}-${this.seq}`;

    const timer = setTimeout(() => {
      this.pending.delete(interruptId);
      if (this.active.get(sessionId) === interruptId) this.active.delete(sessionId);
      // 超时按"未确认 = 不执行"收敛（F-04-05）——**不是默认同意**。
      const result: GuardCheckResult = {
        decision: "deny",
        reason: "等待确认超时，本次动作未执行",
        interruptId,
      };
      this.finish(req, result, startedAt);
      item.resolve(result);
      this.dispatchNext(sessionId);
    }, this.opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS);

    // Node 的定时器不该让进程活着等一个没人管的确认。
    if (typeof timer === "object" && "unref" in timer) timer.unref();

    this.pending.set(interruptId, {
      interruptId,
      sessionId: req.sessionId,
      request: req,
      resolve: (r) => {
        this.finish(req, r, startedAt);
        item.resolve(r);
      },
      createdAt: this.now(),
      timer,
    });
    this.active.set(sessionId, interruptId);

    this.opts.onInterrupt?.({ interruptId, request: req });
  }

  /**
   * 用户确认/拒绝后由网关回灌（§3 HITL 中转 → `Command(resume)`）。
   *
   * 返回 false 表示这个中断点不存在或已被处理——**重复 resume 是正常情况**
   * （用户连点、网络重发），必须安全地什么都不做（F-27-10）。
   */
  resume(interruptId: string, approved: boolean): boolean {
    const p = this.pending.get(interruptId);
    if (!p) return false;
    this.pending.delete(interruptId);
    clearTimeout(p.timer);
    p.resolve(
      approved
        ? { decision: "allow", reason: "用户已确认", interruptId }
        : { decision: "deny", reason: "用户拒绝了本次动作", interruptId },
    );
    // 这一条落定了，本会话排在后面的才出队（ACR-023 / M69-04）。
    if (this.active.get(p.sessionId) === interruptId) this.active.delete(p.sessionId);
    this.dispatchNext(p.sessionId);
    return true;
  }

  /** 挂起中的确认列表（供运维面与 F-14-09 的可观测性）；排队中的也列出并标 `queued`——运维面要能看到"卡在队里"。 */
  listPending(): Array<{ interruptId: string; sessionId: string; tool: string; waitingMs: number; queued?: boolean }> {
    const now = this.now();
    const out: Array<{ interruptId: string; sessionId: string; tool: string; waitingMs: number; queued?: boolean }> = [
      ...this.pending.values(),
    ].map((p) => ({
      interruptId: p.interruptId,
      sessionId: p.sessionId,
      tool: p.request.tool,
      waitingMs: now - p.createdAt,
    }));
    for (const [sessionId, q] of this.queue) {
      for (const item of q) {
        out.push({ interruptId: "(queued)", sessionId, tool: item.request.tool, waitingMs: now - item.enqueuedAt, queued: true });
      }
    }
    return out;
  }

  private finish(req: GuardCheckRequest, result: GuardCheckResult, startedAt: number) {
    if (req.idempotencyKey) this.decided.set(req.idempotencyKey, result);
    // 只记「不」。硬禁不必记（每次都会被同一条规则拦下），
    // 记的是"用户说了不"与"用户没答"这两种——它们都意味着这件事没有被同意。
    if (
      req.actionKey &&
      result.decision === "deny" &&
      result.category === undefined &&
      result.interruptId !== undefined
    ) {
      this.refused.set(req.actionKey, { reason: result.reason, at: this.now() });
    }
    // **含放行**的全量审计（§8.5）：只记拦截的系统永远不知道自己漏了什么。
    this.opts.onAudit?.({ request: req, result, durationMs: this.now() - startedAt });
  }
}
