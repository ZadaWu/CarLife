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
 */

export interface BranchSubmission {
  payload: unknown;
  tool: string;
  at: number;
}

type Waiter = (s: BranchSubmission) => void;

interface Slot {
  submission?: BranchSubmission;
  waiters: Waiter[];
}

const slots = new Map<string, Slot>();
let overwrites = 0;

function key(sessionId: string, turnId: string, agent: string): string {
  return `${sessionId}#${turnId}::${agent}`;
}

function slot(k: string): Slot {
  let s = slots.get(k);
  if (!s) {
    s = { waiters: [] };
    slots.set(k, s);
  }
  return s;
}

/**
 * 落一份提交。turnId 缺失时**拒收**（返回 false）——归不了轮的提交谁也读不到，
 * 静默收下比拒绝更糟；工具结果会把这句话带回给模型。
 */
export function recordSubmission(
  ctx: { sessionId: string; turnId?: string; agent?: string },
  tool: string,
  payload: unknown,
): boolean {
  if (!ctx.turnId || !ctx.agent) return false;
  const s = slot(key(ctx.sessionId, ctx.turnId, ctx.agent));
  if (s.submission) overwrites += 1;
  s.submission = { payload, tool, at: Date.now() };
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
  if (s) s.submission = undefined;
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

/** 测试用：全量复位。 */
export function __resetSubmissions(): void {
  slots.clear();
  overwrites = 0;
}
