/**
 * 旁路自己的闲聊记忆（施工单 M18-09，走查第五轮）。
 *
 * # 为什么它必须有一份，而且必须是自己的
 *
 * 在这之前旁路**完全没有跨轮记忆**：`registry` 按 `turnId` 存，
 * `closePair` 在 turn 结束时把整个 `PairSession` 删掉，`said` / `place` 跟着没。
 * 后果是同一次驾驶里连问三个跟深圳有关的问题，它会把"深圳的荔枝"从头说三遍——
 * 而**每一轮单看都没毛病**，只有连着开一段路的人才听得出来。
 *
 * 它观察的是主会话，记的却必须是**自己说过什么**：主会话的历史里根本没有垫场话
 * （M18-04 的三条不留痕断言守着），所以这份记忆没有别的地方可以借。
 *
 * # 为什么是进程内的 Map，不是 Mem0
 *
 * `check:arch` 的 `sidecar-isolation` 禁止 `sidecar/` import `@carlife/memory`
 * 与 `@carlife/db`——那条边界是 F-45-09"能力边界靠依赖守"的落地。
 * 真要给旁路接上②情景/③偏好那种跨会话的记忆，是一个**要单独决定的设计**
 * （谁写、写哪个 category、衰减怎么算、PII 怎么办），不该顺手在这里破掉边界。
 *
 * 所以这一层的定位说清楚：**"这一趟车的记忆"，不是"这个人的记忆"**。
 * 进程重启即失忆，与旁路"坏了也不该影响主链路"的定位是一致的。
 *
 * # 泄漏是这一层唯一的真风险
 *
 * 会话不会通知我们"我结束了"——车主可能就此下车。所以两道闸都要有：
 * 按条数封顶（`MAX_SAID`）、按空闲时间清（`IDLE_MS`），且清扫**挂在写入路径上**，
 * 不另起定时器（M18-08 已经为一个定时器付过一次代价）。
 */

/** 每个会话最多记几句。够避免重复，又不至于把上下文喂爆。 */
const MAX_SAID = 24;

/** 一个会话多久没动就忘掉。比 ①Working 的 24h 短得多——闲聊没有那么长的价值。 */
const IDLE_MS = 30 * 60 * 1000;

/** 同时记多少个会话。超了先扔最久没动的。 */
const MAX_SESSIONS = 200;

interface ChatMemo {
  /** 这一趟里说过的闲话，按顺序。 */
  said: string[];
  /** 聊过哪些地方。用来判断"这个地方是不是刚聊过"。 */
  places: string[];
  /** 起过几次头。开场白按它轮换，所以同一趟车里每轮的开场都不一样。 */
  turns: number;
  lastAt: number;
}

const memos = new Map<string, ChatMemo>();

function sweep(now: number): void {
  for (const [id, m] of memos) {
    if (now - m.lastAt > IDLE_MS) memos.delete(id);
  }
  while (memos.size > MAX_SESSIONS) {
    let oldest: [string, number] | undefined;
    for (const [id, m] of memos) {
      if (!oldest || m.lastAt < oldest[1]) oldest = [id, m.lastAt];
    }
    if (!oldest) break;
    memos.delete(oldest[0]);
  }
}

function memoOf(sessionId: string, now: number): ChatMemo {
  let m = memos.get(sessionId);
  if (!m) {
    m = { said: [], places: [], turns: 0, lastAt: now };
    memos.set(sessionId, m);
    sweep(now);
  }
  m.lastAt = now;
  return m;
}

/**
 * 本轮开始。返回这一趟车里的第几轮（0 起）——开场白按它轮换。
 *
 * **不清空 `said`**：那正是这一层存在的理由。
 */
export function beginChatTurn(sessionId: string, now: number): number {
  const m = memoOf(sessionId, now);
  const n = m.turns;
  m.turns += 1;
  return n;
}

/** 记一句说过的话。 */
export function rememberSaid(sessionId: string, text: string, now: number): void {
  const m = memoOf(sessionId, now);
  m.said.push(text);
  while (m.said.length > MAX_SAID) m.said.shift();
}

/** 记一个聊过的地方。 */
export function rememberPlace(sessionId: string, place: string, now: number): void {
  const m = memoOf(sessionId, now);
  if (!m.places.includes(place)) m.places.push(place);
  while (m.places.length > 8) m.places.shift();
}

/** 这一趟车里说过的话（含更早的轮次）。 */
export function recallSaid(sessionId: string): readonly string[] {
  return memos.get(sessionId)?.said ?? [];
}

/** 这个地方在这一趟里是不是已经聊过了。 */
export function placeSeen(sessionId: string, place: string): boolean {
  return memos.get(sessionId)?.places.includes(place) ?? false;
}

/** 仅供测试与指标：泄漏检测靠它。 */
export function chatMemorySize(): number {
  return memos.size;
}

export function resetChatMemory(): void {
  memos.clear();
}
