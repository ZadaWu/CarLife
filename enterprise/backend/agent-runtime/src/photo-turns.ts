/**
 * 同一会话里「带照片的那一轮还在跑」的登记表。
 *
 * # 起因（2026-09-18 真机走查，turn-b77d694b / turn-6f2bf4b1）
 *
 * 车主发了一张仪表照片（没有文字）。视觉观察那一遍花了 17 秒，他等了 8 秒没见回复，
 * 又补了一句「帮我看看什么灯亮了」。这句话**就是那张照片的说明**，可系统把它当成一个
 * 独立的新问题另起了一轮，两轮在同一条图线程上并发：
 *
 * - 第二轮没有照片，观察节点把 `photoObservation` 清成空，检索词只剩一句白话，
 *   RAGFlow 三次 8 秒超时（「本次检索说明书失败」就是这么来的）；
 * - 它手里唯一的图是手册第 14 页的图示，于是把那张手册图说成「您发的这张图是后雾灯」
 *   ——而第一轮此刻正在把同一张照片认对（近光灯、驻车灯、安全带）。
 *
 * # 做法：纯文字轮先等带照片的那一轮跑完
 *
 * 等它跑完，第二轮读到的检查点里就有第一轮的消息**和它的照片观察**；观察节点再把
 * 这份观察沿用下来（`graph/vision.ts` 的继承逻辑），第二轮就知道「什么灯」指的是哪几盏。
 *
 * # 为什么只等「带照片的轮」，而且有上限
 *
 * 把同会话的轮次一律串行化听起来更干净，但不能这么做：敏感工具的权限确认是
 * **挂起一个 HTTP 请求等用户点头**（`guard/http-endpoint.ts`），那一轮在等人的时候一直算「在跑」，
 * 一律串行的话车主再说一句话就会永远等下去。照片轮没有这个问题的高发面，且等待封顶
 * （`PHOTO_TURN_WAIT_MAX_MS`）——到点就照常开跑，最坏回到改之前的行为，不会更糟。
 */

/** 最多等这么久。第一轮的典型耗时是 20~30 秒（视觉 17 s + 检索 + 表述）。 */
export const PHOTO_TURN_WAIT_MAX_MS = 45_000;

export interface PhotoTurnWait {
  /** 有没有等（false = 当时没有带照片的轮在跑）。 */
  waited: boolean;
  /** 等的是哪一轮。 */
  turnId?: string;
  /** 实际等了多久。 */
  ms: number;
  /** 等到上限还没完——照常开跑，但这一轮读不到那份观察。 */
  timedOut: boolean;
}

interface Entry {
  turnId: string;
  done: Promise<void>;
  resolve: () => void;
}

export class PhotoTurnRegistry {
  private inflight = new Map<string, Entry>();

  constructor(private now: () => number = Date.now) {}

  /**
   * 带照片的轮开始时登记。返回的函数在该轮收口（finally）时调用；重复调用无害。
   * 同一会话连发两张照片时后一轮覆盖前一轮——纯文字追问指的是**最近**那张。
   */
  begin(sessionId: string, turnId: string): () => void {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const entry: Entry = { turnId, done, resolve };
    this.inflight.set(sessionId, entry);
    return () => {
      resolve();
      // 只清自己那一条：后一张照片的轮可能已经把这个位置占了。
      if (this.inflight.get(sessionId) === entry) this.inflight.delete(sessionId);
    };
  }

  /** 当前会话有没有带照片的轮在跑。 */
  pending(sessionId: string): string | undefined {
    return this.inflight.get(sessionId)?.turnId;
  }

  /** 纯文字轮开跑前调：有带照片的轮在跑就等它收口，封顶 `maxMs`。 */
  async waitFor(sessionId: string, maxMs = PHOTO_TURN_WAIT_MAX_MS): Promise<PhotoTurnWait> {
    const entry = this.inflight.get(sessionId);
    if (!entry) return { waited: false, ms: 0, timedOut: false };
    const t0 = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      entry.done.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), maxMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return { waited: true, turnId: entry.turnId, ms: this.now() - t0, timedOut };
  }
}
