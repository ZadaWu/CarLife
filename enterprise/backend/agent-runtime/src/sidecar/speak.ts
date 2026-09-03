/**
 * 垫场话的出口：过输出管线再发（施工单 M18-04，F-45-10）。
 *
 * # 旁路不是安全边界的旁路
 *
 * 一条能出声却不过管线的通道，就是把 §8.3 整层绕过去了。
 * "它只说寒暄所以不用过"站不住——L0 现在只吐固定文案，但这条通道一旦存在，
 * L1（架构 §13-15）会把用户原话和记忆内容揉进去，PII 完全可能顺着它出来。
 * **管线要在通道建成的那一天就接上，不是等有风险了再补。**
 *
 * # 入口同步，过管线异步
 *
 * M18-02 的约束是"扇出入口不 `await`"，而 `checkOutput` 是异步的。
 * 两者不冲突：**入口同步返回，过管线在 fire-and-forget 的 promise 里做**，
 * 完成后再 push。代价是出声时刻晚一个管线往返（输入侧实测 225~287ms，
 * 输出侧同量级），这一段计入 M18-05 的"触发 → 出声 < 500ms"预算——
 * 吃不下就把阈值往前调，**不是把管线摘掉**。
 */

import type { FillerDraft } from "./templates";

/**
 * 只要 `checkOutput` 这一件事。
 *
 * 刻意不 import `../guard/pipeline` 的具体类型：旁路对安全层的依赖越窄，
 * 越不容易在以后被顺手扩大成"反正都引了，再拿点别的"。
 */
export interface FillerOutputGuard {
  checkOutput(text: string): Promise<{ allowed: boolean; text: string; reason?: string }>;
}

export interface FillerSpeakDeps {
  /** 未装配时丢弃（见下）。 */
  guard?: FillerOutputGuard;
  /** 真正下发。同步。 */
  push: (text: string, draft: FillerDraft) => void;
  /** 丢弃时的计数出口。 */
  onDropped?: (reason: "guard_denied" | "guard_error" | "no_guard") => void;
}

/**
 * 发一条垫场话。**同步返回**。
 *
 * 三种丢弃，都不产生任何用户可见行为：
 *
 * 1. `no_guard`——管线未装配。与主链路的 output fail-closed 同向：
 *    宁可不说，也不放行未审核的输出。旁路的"关闭"代价为零，这个取向没有争议。
 * 2. `guard_denied`——审核不通过。**直接丢弃，不发 `retract`、不发替换文案**：
 *    主内容判"拦"要撤回是因为用户已经读到了；垫场话还没发出去，
 *    发一句"这条我收回了"比不说更莫名其妙——用户根本不知道有过这句话。
 * 3. `guard_error`——管线抛错。同 1。
 */
export function emitFiller(deps: FillerSpeakDeps, draft: FillerDraft): void {
  if (!deps.guard) {
    deps.onDropped?.("no_guard");
    return;
  }
  void deps.guard
    .checkOutput(draft.text)
    .then((verdict) => {
      if (!verdict.allowed) {
        deps.onDropped?.("guard_denied");
        return;
      }
      // 用管线返回的 text：脱敏可能改写过它（L0 的固定文案不会，但 L1 会）
      deps.push(verdict.text, draft);
    })
    .catch(() => {
      deps.onDropped?.("guard_error");
    });
}
