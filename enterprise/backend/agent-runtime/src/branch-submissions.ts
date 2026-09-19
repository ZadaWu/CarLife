/**
 * 分支结论的按轮暂存区（施工单 M30-01，F-13-02 通道地基段）。
 *
 * # 它是①Working 层，不是存储
 *
 * 进程内 Map、按 (sessionId, turnId, agent) 键、轮结束即弃、**不落库**（§7①）。
 * runtime 重启丢失的后果只是"该轮回落 extractJson 路径"——设计内的降级，不是缺陷。
 * 别给它加持久化：分支结论的生命周期就是一轮，落库等于给一次性数据发永久居留。
 *
 * # 后写覆盖前写，这不是宽容，是自愈的一部分
 *
 * 模型提交坏参数被 schema 拒掉后会当场重试——重试成功的那次**必须**盖住任何先前状态。
 * 同轮重复提交计数上抛（`overwrites`），大屏排查"模型抖了几次"用。
 *
 * # 顺序不变量：先 record，再 notify
 *
 * `record` 里通知订阅者发生在写入之后。M30-02 的 fanout 拿到完成信号就会去 abort
 * 分支流——若通知先于写入，fanout 判完成时暂存区还空着，读到空回落 missing，
 * **数据丢了且零报错**。这条顺序由本文件保证，调用方不需要（也不可能）自己补。
 *
 * # 期望：内容不齐就退回，让模型在会话里当场重交
 *
 * 真跑 turn-dc5da219：骨架 3 天，tour 只交了第 1 天，形状合法所以照收，「提交即收工」随即掐流，
 * 第 2、3 天靠骨架守卫接回、整天没有时段。"这一轮该交几天"只有发分支的那一方知道（ADR-010），
 * 所以由它在发之前 `expectSubmission` 登记；`recordSubmission` 对不上就**不写入、不通知**，
 * 把原因返回给工具 → 模型看到「缺第 2、3 天」→ 同一个会话里重交（上下文都在，约一轮往返）。
 *
 * 两条不变量：
 *  1. **拒收有上限**（`maxRejects`）：到顶之后照收，交给下游的守卫兜——不让模型陷在重交循环里。
 *  2. **拒收不能让结果比不拒收更差**：被退的那份留在 `held`，模型之后没再交成（收场 / 超时）时
 *     由 fanout 经 `heldSubmission` 取走顶上——最坏情况逐字等于没有这道闸的从前。
 */

import type { SubmissionRejection } from "@carlife/tools";

export interface BranchSubmission {
  payload: unknown;
  tool: string;
  at: number;
}

type Waiter = (s: BranchSubmission) => void;

/** 这个槽**该收到什么**。由发分支的那一方在发之前登记；不登记 = 行为与从前逐字相同。 */
export interface SubmissionExpectation {
  /**
   * 返回拒收原因（原样给模型看：缺什么、怎么补）；`undefined` = 收下。
   * 只看结构化 payload——不读正文、不上正则（ADR-012）。抛错按"收下"处理：判据坏了不该拦住提交。
   */
  check(tool: string, payload: unknown): string | undefined;
  /** 同一跳里最多退回几次；到顶照收。 */
  maxRejects: number;
}

interface Slot {
  submission?: BranchSubmission;
  waiters: Waiter[];
  expectation?: SubmissionExpectation;
  /** 这一跳已经退回了几次；`clearSubmission`（新的一跳）归零。 */
  rejects: number;
  /** 最近一次被退回的提交：模型没再交成时的兜底（见文件头不变量 2）。 */
  held?: BranchSubmission;
}

const slots = new Map<string, Slot>();
let overwrites = 0;
let rejections = 0;

function key(sessionId: string, turnId: string, agent: string): string {
  return `${sessionId}#${turnId}::${agent}`;
}

function slot(k: string): Slot {
  let s = slots.get(k);
  if (!s) {
    s = { waiters: [], rejects: 0 };
    slots.set(k, s);
  }
  return s;
}

/**
 * 登记这个槽的期望。**在发分支之前调**——晚于提交的登记拦不住已经落地的那一份。
 * 同一轮对同一分支追发（修复轮的 rerun）时期望留着：追发要的同样是完整的一份。
 */
export function expectSubmission(
  sessionId: string,
  turnId: string,
  agent: string,
  expectation: SubmissionExpectation,
): void {
  slot(key(sessionId, turnId, agent)).expectation = expectation;
}

/**
 * 落一份提交。turnId 缺失时**拒收**（返回 false）——归不了轮的提交谁也读不到，
 * 静默收下比拒绝更糟；工具结果会把这句话带回给模型。
 */
export function recordSubmission(
  ctx: { sessionId: string; turnId?: string; agent?: string },
  tool: string,
  payload: unknown,
): boolean | SubmissionRejection {
  if (!ctx.turnId || !ctx.agent) return false;
  const s = slot(key(ctx.sessionId, ctx.turnId, ctx.agent));
  if (s.expectation && s.rejects < s.expectation.maxRejects) {
    let reason: string | undefined;
    try {
      reason = s.expectation.check(tool, payload);
    } catch {
      reason = undefined; // 判据自己坏了：照收，别让一个 bug 把提交通道堵死。
    }
    if (reason) {
      // **不写 submission、不通知**：fanout 的竞速继续等，模型拿到原因后在会话里重交。
      s.rejects += 1;
      rejections += 1;
      s.held = { payload, tool, at: Date.now() };
      return { rejected: reason };
    }
  }
  if (s.submission) overwrites += 1;
  s.submission = { payload, tool, at: Date.now() };
  s.held = undefined; // 收下了合格的一份，兜底那份作废。
  // 顺序不变量：写入已完成，才把完成信号交出去（见文件头）。
  const waiters = s.waiters.splice(0, s.waiters.length);
  for (const w of waiters) w(s.submission);
  return true;
}

/**
 * 定向清一个分支槽（M35-01）：同轮对同一分支**追发第二跳**之前必须清——
 * 槽里还躺着首轮的提交，`waitSubmission` 会立刻拿旧值兑现，追跳分支根本
 * 不会被真正等待。只清 submission，不动 waiters（追跳自己会重新订阅）。
 */
export function clearSubmission(sessionId: string, turnId: string, agent: string): void {
  const s = slots.get(key(sessionId, turnId, agent));
  if (!s) return;
  s.submission = undefined;
  // 新的一跳：拒收额度重新计，上一跳被退的那份也不该顶到这一跳头上。
  s.rejects = 0;
  s.held = undefined;
}

/**
 * 被退回、且之后**没有**再交成的那一份（文件头不变量 2）。有合格提交时恒为 undefined。
 * fanout 在分支收场 / 超时而竞速里提交没赢时来取——取到就当这条分支的提交用。
 */
export function heldSubmission(
  sessionId: string,
  turnId: string,
  agent: string,
): BranchSubmission | undefined {
  const s = slots.get(key(sessionId, turnId, agent));
  return s && !s.submission ? s.held : undefined;
}

/** 读取（不删除）。merge 在汇聚时调；同轮可能读多次，删除交给轮级清理。 */
export function peekSubmission(
  sessionId: string,
  turnId: string,
  agent: string,
): BranchSubmission | undefined {
  return slots.get(key(sessionId, turnId, agent))?.submission;
}

/**
 * 订阅"该分支的提交落地"（M30-02 的完成信号入口）。
 * 已经有提交时立即兑现——fanout 起跑晚于提交的竞态不该丢信号。
 * 返回的 Promise 永不 reject；调用方用 race 与流/超时竞速，不等它兜底。
 */
export function waitSubmission(
  sessionId: string,
  turnId: string,
  agent: string,
): Promise<BranchSubmission> {
  const s = slot(key(sessionId, turnId, agent));
  if (s.submission) return Promise.resolve(s.submission);
  return new Promise((resolve) => {
    s.waiters.push(resolve);
  });
}

/**
 * 轮级清理：这一轮的所有分支槽一把清掉。挂在轮结束处；
 * 还挂着的 waiter 直接丢弃——轮都结束了，完成信号已无消费者。
 */
export function sweepTurn(sessionId: string, turnId: string): void {
  const prefix = `${sessionId}#${turnId}::`;
  for (const k of slots.keys()) {
    if (k.startsWith(prefix)) slots.delete(k);
  }
}

/** 排查用：同轮覆盖了几次（模型重试的痕迹）。 */
export function submissionOverwrites(): number {
  return overwrites;
}

/** 排查用：按期望退回了几次（含之后重交成功的）。 */
export function submissionRejections(): number {
  return rejections;
}

/** 测试用：全量复位。 */
export function __resetSubmissions(): void {
  slots.clear();
  overwrites = 0;
  rejections = 0;
}
