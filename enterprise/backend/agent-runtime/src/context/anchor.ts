/**
 * 锚定块的钉版本与 delta（施工单 M84-03，ACR-036 §4.9）。
 *
 * # 为什么要"钉"
 *
 * 锚定块进的是直连的 `system` 与 pi 会话的第一条 prompt——**前缀**。前缀变了，
 * 这个线程此前累积的缓存全部作废。而车主档案在一次对话中间是会变的（他刚确认了一份行程、
 * worker 刚算出一条保养提醒），于是"如实反映最新事实"与"别动前缀"直接冲突。
 *
 * 取舍是：**前缀不动，变化走本轮尾区的一行 delta**。下一个线程自然拿到新版本。
 * 代价是同一线程内锚定块可能落后几分钟——而它装的本来就是"一个线程内基本不变"的东西。
 *
 * # 为什么钉在进程内存里而不是图状态
 *
 * 渲染本来就是确定性的（同一份事实 → 同一段文本），所以"钉"只在**事实变了**的时候
 * 才起作用。进程重启后按当前事实重钉，最坏是这个线程换一次前缀——而重启本来就把
 * pi 会话也清了。为这点收益加一个图通道、多一处检查点兼容，不划算。
 * 形状与 `turn-runner.ts` 的 `this.threads` 同款，上限同理。
 */

import { renderAnchor, type ContextAgent } from "./render";
import { aclFor } from "./render";
import type { UserContext } from "@carlife/shared";

/** 钉住的一份。`key` 是 `${threadId}::${agent}`——不同 Agent 的锚定块内容不同（投影表不同）。 */
interface Pinned {
  version: number;
  text: string;
  /** 钉的时候那份 `UserContext` 的指纹，用来判"事实变了没有"。 */
  fingerprint: string;
  pinnedAt: number;
}

/** 上限，防内存无界。超了整体丢弃——丢的只是"前缀稳定性"，不是正确性。 */
const MAX_PINS = 5_000;

/**
 * 一份 `UserContext` 的指纹。**稳定序列化**：键按字典序，数组保持调用方给的顺序
 * （`assembleUserContext` 已经排过）。
 *
 * 不用 `JSON.stringify` 直接比，是因为对象键序取决于插入顺序，而插入顺序会随
 * 哪几段读到了而变——那会让"其实没变"看起来像变了。
 */
export function fingerprintContext(ctx: UserContext): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = stable(o[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(stable(ctx));
}

export class AnchorPins {
  private pins = new Map<string, Pinned>();
  private seq = 0;

  constructor(private now: () => number = Date.now) {}

  private key(threadId: string, agent: string): string {
    return `${threadId}::${agent}`;
  }

  /**
   * 取这个 (线程 × Agent) 的锚定块。**第一次调用时钉住，之后原样返回**。
   *
   * `changed` 说的是"事实与钉的时候不一样了"——调用方据此在本轮尾区加一行 delta，
   * **不重钉**（重钉就等于换前缀，那正是要避免的）。
   */
  resolve(threadId: string, agent: string, ctx: UserContext): { text: string; version: number; changed: boolean } {
    const key = this.key(threadId, agent);
    const fingerprint = fingerprintContext(ctx);
    const existing = this.pins.get(key);
    if (existing) {
      return { text: existing.text, version: existing.version, changed: existing.fingerprint !== fingerprint };
    }
    if (this.pins.size >= MAX_PINS) this.pins.clear();
    this.seq += 1;
    const pinned: Pinned = {
      version: this.seq,
      text: renderAnchor(ctx, aclFor(agent).anchor),
      fingerprint,
      pinnedAt: this.now(),
    };
    this.pins.set(key, pinned);
    return { text: pinned.text, version: pinned.version, changed: false };
  }

  /** 只为测试与排障：这个线程钉了几份。 */
  size(): number {
    return this.pins.size;
  }
}

/**
 * 事实变了时进本轮尾区的那一行。
 *
 * **只说"哪几段变了"，不重述内容**：重述等于把锚定块又抄一遍，尾区预算吃不消，
 * 而模型真正需要知道的是"别全信上面那段档案里的这几项"。
 */
export function anchorDeltaLine(changed: boolean): string | undefined {
  return changed
    ? "档案有更新：上面【车主档案】那一段是这次对话开始时的快照，之后有变动；以本轮说的为准。"
    : undefined;
}

export type { ContextAgent };
