/**
 * Agent 向车主发起的对话交互（施工单 M106-01，FL-20 F-20-08 / F-20-09）。
 *
 * 五型：单选 / 多选（都可带「其他」）/ 开放题 / 操作引导 / 拍照。端上渲染成对话列表末尾的卡片，
 * **回传一律是一轮用户消息**（拍照那支回传的是一张照片）——没有挂起、没有 resume。
 *
 * # 它不是权限门
 *
 * `PermissionRequest`（HITL）问的是**授权**：工具的一次调用被 `interrupt()` 劈成两半，不答就不做（fail-closed）。
 * 这里问的是**事实与配合**：不答照样继续，车主可以打字绕过，也可以过三天再答（fail-open，沿用 §4.6 的裁定）。
 * 所以这里**没有 `required`**，也不走 SSE `permission` 事件——它挂在每轮都会拉一次的结构化报告上。
 *
 * # 上限写在类型旁，端与服务端同一份
 *
 * 与 `TURN_ATTACHMENT_LIMITS` 同一个做法：模型吐出 8 个选项的题，在服务端预算器门口就被丢掉，
 * 不会到端上撑破版式。校验是**严格**的——不修剪、不截断：截了一半的选项看起来是完整选项。
 */

/** 谁提的：`model` = 与应答并行的那一跳提议；`code` = 封闭题库 / 观察层的补拍指引。端上不读，给轨迹与走查看。 */
export type InteractionOrigin = "model" | "code";

interface InteractionBase {
  /** 会话内稳定：跨轮去重与「问过几轮」按它记。模型一路的 id 由代码按文本哈希重写，不信模型自报的。 */
  id: string;
  origin: InteractionOrigin;
}

export interface InteractionChoice extends InteractionBase {
  kind: "single" | "multi";
  text: string;
  options: string[];
  /** 端上在选项末尾多摆一枚「其他」，选中后展开一行输入。 */
  allowOther: boolean;
}

export interface InteractionOpen extends InteractionBase {
  kind: "open";
  text: string;
  placeholder?: string;
}

/** 操作引导：步骤卡 + 结果回执。端上**不记做到第几步**——Agent 拿到的是结果，不是过程。 */
export interface InteractionGuidance extends InteractionBase {
  kind: "guidance";
  title: string;
  steps: string[];
  /** 步骤的出处（如「用户手册 › 座椅与安全带」）；`null` = 没有可标的出处。 */
  source: string | null;
  /** 回执芯片（如「好了」「还亮着」「做不了」）；点一枚 = 发一轮用户文本。 */
  outcomes: string[];
}

export interface InteractionCapture extends InteractionBase {
  kind: "capture";
  title: string;
  hint: string;
}

export type InteractionPrompt = InteractionChoice | InteractionOpen | InteractionGuidance | InteractionCapture;

export type InteractionKind = InteractionPrompt["kind"];

export const INTERACTION_KINDS: readonly InteractionKind[] = ["single", "multi", "open", "guidance", "capture"];

/**
 * 版式与耐心两头的上限。
 *
 * - 选项 2~5：1 个选项不是选择题；手机竖屏一行放 3 枚芯片，两行之外要滚动，芯片题就失去了「点一下就行」。
 * - 步骤 2~4：1 步用不着一张卡；5 步以上车主不会站在车边照着做完——那是该去门店的事。
 * - 回执 2~3：至少要分得出「好了」和「没好」。
 * - 字数按手机竖屏实测的一行 / 两行容量取整。
 */
export const INTERACTION_LIMITS = {
  minOptions: 2,
  maxOptions: 5,
  minSteps: 2,
  maxSteps: 4,
  minOutcomes: 2,
  maxOutcomes: 3,
  /** 题干 / 卡片标题。 */
  maxTitleChars: 40,
  /** 单个选项、单枚回执。 */
  maxChipChars: 12,
  /** 单个步骤。 */
  maxStepChars: 60,
  /** 拍照卡的说明、开放题的占位。 */
  maxHintChars: 80,
  maxSourceChars: 60,
  maxIdChars: 64,
} as const;

/** 端上「其他」那枚芯片的字面。`options` 里不许出现它——那是 `allowOther` 的活，两处都有就会摆出两枚。 */
export const INTERACTION_OTHER_LABEL = "其他";

/** 占不占「问题位」：单选 / 多选 / 开放题占；引导与拍照是请车主**做**一件事，不是**答**一句话。 */
export function isAskPrompt(p: InteractionPrompt): p is InteractionChoice | InteractionOpen {
  return p.kind === "single" || p.kind === "multi" || p.kind === "open";
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // 首尾空白算不合法而不是悄悄 trim：校验不改内容，改内容是调用方的决定。
  if (v.length === 0 || v !== v.trim()) return null;
  return [...v].length <= max ? v : null;
}

function textList(v: unknown, min: number, max: number, maxChars: number): string[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  const out: string[] = [];
  for (const item of v) {
    const s = text(item, maxChars);
    if (s === null || out.includes(s)) return null;
    out.push(s);
  }
  return out;
}

/**
 * 严格校验。未知 `kind`、缺字段、类型不对、越限、空串、重复项，一律 `null`。
 * 返回的是**新对象**且只含契约字段——模型多吐的键不会漏到端上。
 */
export function validateInteractionPrompt(v: unknown): InteractionPrompt | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const L = INTERACTION_LIMITS;
  const id = text(o.id, L.maxIdChars);
  if (id === null) return null;
  if (o.origin !== "model" && o.origin !== "code") return null;
  const base = { id, origin: o.origin } as const;

  switch (o.kind) {
    case "single":
    case "multi": {
      const t = text(o.text, L.maxTitleChars);
      const options = textList(o.options, L.minOptions, L.maxOptions, L.maxChipChars);
      if (t === null || options === null || typeof o.allowOther !== "boolean") return null;
      if (options.includes(INTERACTION_OTHER_LABEL)) return null;
      return { ...base, kind: o.kind, text: t, options, allowOther: o.allowOther };
    }
    case "open": {
      const t = text(o.text, L.maxTitleChars);
      if (t === null) return null;
      if (o.placeholder === undefined) return { ...base, kind: "open", text: t };
      const placeholder = text(o.placeholder, L.maxHintChars);
      return placeholder === null ? null : { ...base, kind: "open", text: t, placeholder };
    }
    case "guidance": {
      const title = text(o.title, L.maxTitleChars);
      const steps = textList(o.steps, L.minSteps, L.maxSteps, L.maxStepChars);
      const outcomes = textList(o.outcomes, L.minOutcomes, L.maxOutcomes, L.maxChipChars);
      const source = o.source === null ? null : text(o.source, L.maxSourceChars);
      if (title === null || steps === null || outcomes === null) return null;
      if (o.source !== null && source === null) return null;
      return { ...base, kind: "guidance", title, steps, source, outcomes };
    }
    case "capture": {
      const title = text(o.title, L.maxTitleChars);
      const hint = text(o.hint, L.maxHintChars);
      if (title === null || hint === null) return null;
      return { ...base, kind: "capture", title, hint };
    }
    default:
      return null;
  }
}

/** 一条 prompt 上车主看得见的全部文字——服务端过硬禁与脱敏时拼它，别在各处各拼一份。 */
export function interactionVisibleTexts(p: InteractionPrompt): string[] {
  switch (p.kind) {
    case "single":
    case "multi":
      return [p.text, ...p.options];
    case "open":
      return p.placeholder ? [p.text, p.placeholder] : [p.text];
    case "guidance":
      return [p.title, ...p.steps, ...(p.source ? [p.source] : []), ...p.outcomes];
    case "capture":
      return [p.title, p.hint];
  }
}
