/**
 * 车主在卡片上点完之后，发出去的那一轮用户文本怎么拼（施工单 M106-04）。纯函数，无 React、无样式——单测直接打它。
 *
 * # 为什么一律带题干
 *
 * M104 的追问卡发的是「停着；一直亮」——题目是代码的封闭题库，下一轮读这句话的人知道问的是什么。
 * M106 起题目可以由模型自由提出，而**卡片不是消息**：对话历史里没有「副驾座位上放东西了吗？」这一句，
 * 光发一个「放了」，下一轮的模型看到的是一句没头没尾的话。所以答案总是带着题干走。
 */
import { INTERACTION_OTHER_LABEL, type InteractionChoice, type InteractionGuidance, type InteractionOpen } from "@carlife/shared";

export type AskPrompt = InteractionChoice | InteractionOpen;

export interface AskState {
  /** 选中的选项；选了「其他」时里面有 `INTERACTION_OTHER_LABEL`。开放题恒为空。 */
  picked: string[];
  /** 「其他」展开的那行输入；开放题的输入也放这里。 */
  other: string;
}

export const EMPTY_ASK: AskState = { picked: [], other: "" };

/** 题干去掉句末问号再接冒号：「车现在是停着的吗？：停着」读着别扭。 */
function stem(text: string): string {
  return text.replace(/[？?]\s*$/, "");
}

/** 这一题答完了没有；答完返回答案文本，没答完返回 `null`。 */
export function answerOf(ask: AskPrompt, state: AskState | undefined): string | null {
  const s = state ?? EMPTY_ASK;
  const typed = s.other.trim();
  if (ask.kind === "open") return typed || null;
  if (s.picked.length === 0) return null;
  // 选了「其他」却没写是什么，不算答完——发一个「其他」出去等于什么都没说。
  if (s.picked.includes(INTERACTION_OTHER_LABEL) && !typed) return null;
  const parts = s.picked.map((p) => (p === INTERACTION_OTHER_LABEL ? typed : p));
  return parts.join("、");
}

/** 全部题答完 ⇒ 「题干：答案；题干：答案」；有一题没答完 ⇒ `null`（不能发）。 */
export function composeAnswers(asks: readonly AskPrompt[], state: Readonly<Record<string, AskState>>): string | null {
  if (asks.length === 0) return null;
  const lines: string[] = [];
  for (const ask of asks) {
    const a = answerOf(ask, state[ask.id]);
    if (a === null) return null;
    lines.push(`${stem(ask.text)}：${a}`);
  }
  return lines.join("；");
}

/** 点一枚选项之后的新状态。单选互斥（再点同一枚不取消——单选没有「不选」）；多选切换。 */
export function togglePick(ask: InteractionChoice, state: AskState | undefined, option: string): AskState {
  const s = state ?? EMPTY_ASK;
  if (ask.kind === "single") return { ...s, picked: [option] };
  return { ...s, picked: s.picked.includes(option) ? s.picked.filter((p) => p !== option) : [...s.picked, option] };
}

/**
 * 选中即发，不用再点「发送」：只有一道单选、点的又不是「其他」。
 * 多选没法知道车主选完了没有；多道题要等都答完；「其他」要等他写。
 */
export function sendsOnPick(asks: readonly AskPrompt[], option: string): boolean {
  return asks.length === 1 && asks[0]!.kind === "single" && option !== INTERACTION_OTHER_LABEL;
}

/** 引导卡的回执：带标题，理由同上。 */
export function composeOutcome(guidance: InteractionGuidance, outcome: string): string {
  return `${guidance.title}：${outcome}`;
}
