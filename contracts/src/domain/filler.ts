/**
 * 等待期垫场话的 L0 文案表（施工单 M18-07 建表，M18-08 改成多句）。
 *
 * # 为什么放在共享包
 *
 * 两个消费方要读同一份：
 *  - `enterprise/backend/agent-runtime/src/sidecar/templates.ts` —— 生成那句话；
 *  - `enterprise/console` 的会话页 —— 由轨迹里的 `phase#index` **还原**那句话。
 *
 * # 为什么控制台是"还原"而不是"读取"
 *
 * `sidecar.filler` 这条 span 的 `detail` 里**只有档位与阶段序号**，没有文本
 * （M18-05 定的：文本是用户可见内容，轨迹里再存一份等于多一处要脱敏的地方）。
 * L0 的文案是代码常量，控制台完全可以自己算出来。
 *
 * 这条捷径只对 L0 成立：L1（模型生成，架构 §13-15）的句子无法由 phase 还原，
 * 等它落地时再单独决定要不要存文本。
 *
 * # 为什么一个阶段有多句
 *
 * 实测（`sess-7ebdabfe-575`）：一轮 10 秒的等待里，`tool.ragflow_retrieve`
 * 单跳就占 **3.8 秒**，而 span 是**完成时**才落的——检索正在跑的那几秒里
 * 轨迹侧一个事件都没有。每阶段只有一句时，那段最长的空白必然是哑的。
 *
 * 多句让同一阶段能继续说，但**说的仍是同一件事**：
 * "我在翻你这车的手册" → "手册有点厚，我找找对应那节"。
 * 第二句没有引入任何新断言。
 *
 * ⚠️ **不许写对未来的承诺**（"马上就好""快出来了"）——旁路不知道还要多久，
 * 这种话第一次说错就再也没人信了。有测试逐词挡着。
 */

/** 垫场话对应的链路阶段。 */
export type FillerPhase = "understanding" | "routing" | "profile" | "retrieval" | "composing";

/**
 * 阶段 → 一组话，**按顺序推进**，用完为止。
 *
 * 条数按实测的等待时长分配：`retrieval` 是最长的一跳（3.8s），给三句；
 * `routing` 与 `composing` 是毫秒级的转场，各一句就够。
 *
 * **没有 `default` / `fallback`**：匹配不到就该保持安静，
 * 而不是说一句没有事件支撑的"正在为您查询"——那在什么都没发生时说出口就是假话，
 * 且用户完全无法证伪（F-45-04）。`check:arch` 的 `sidecar-isolation` 守着这条。
 */
export const FILLER_PHRASE: Readonly<Record<FillerPhase, readonly string[]>> = Object.freeze({
  understanding: Object.freeze(["我在理解你的问题", "让我把你说的拆一下"]),
  routing: Object.freeze(["我看清楚该查什么了"]),
  profile: Object.freeze(["先看看你这辆车的档案", "档案里的信息我在核对"]),
  retrieval: Object.freeze([
    "我在翻你这车的手册",
    "手册有点厚，我找找对应那一节",
    "还在翻，这一段写得比较散",
  ]),
  composing: Object.freeze(["查到了，我组织一下怎么说"]),
});

export const FILLER_PHASES = Object.keys(FILLER_PHRASE) as FillerPhase[];

export function isFillerPhase(v: string): v is FillerPhase {
  return v in FILLER_PHRASE;
}

/**
 * 取某阶段的第 `index` 句（0 起）。
 *
 * **越界返回 `undefined`，不循环**——转圈说同样的话比不说更像卡住了。
 */
export function fillerPhraseAt(phase: string, index: number): string | undefined {
  if (!isFillerPhase(phase)) return undefined;
  return FILLER_PHRASE[phase][index];
}

/** 该阶段一共能说几句。认不出的阶段返回 0。 */
export function fillerPhraseCount(phase: string): number {
  return isFillerPhase(phase) ? FILLER_PHRASE[phase].length : 0;
}

/**
 * 解析 `sidecar.filler` span 的 `detail`。
 *
 * 形态：`l0 · retrieval#2`（M18-08 起带序号，1 起，便于人读）。
 * **向后兼容**不带序号的旧记录——那是 M18-05~07 期间落的库，按第 1 句还原。
 *
 * 解析不出来时 `phrase` 为 `undefined`，调用方**不得编一句话出来**——
 * 那会把"控制台显示的"和"用户真听到的"变成两回事，
 * 排障时会拿着一句从没播过的话去对因果。
 */
export function parseFillerDetail(detail: string | undefined): {
  source?: string;
  phase?: FillerPhase;
  /** 1 起的序号，便于人读；解析不出时缺省。 */
  ordinal?: number;
  phrase?: string;
} {
  if (!detail) return {};
  const [source, rest] = detail.split("·").map((s) => s.trim());
  if (!rest) return { ...(source ? { source } : {}) };

  const [phase, rawOrdinal] = rest.split("#");
  if (!isFillerPhase(phase)) return { ...(source ? { source } : {}) };

  const ordinal = rawOrdinal ? Number(rawOrdinal) : 1;
  const phrase = Number.isFinite(ordinal) ? fillerPhraseAt(phase, ordinal - 1) : undefined;
  return {
    ...(source ? { source } : {}),
    phase,
    ...(Number.isFinite(ordinal) ? { ordinal } : {}),
    ...(phrase ? { phrase } : {}),
  };
}
