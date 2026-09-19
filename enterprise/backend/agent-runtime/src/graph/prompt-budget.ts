/**
 * 这一轮向车主要什么——统一预算（施工单 M106-02，F-20-09 / F-53-05 / F-54-10）。
 *
 * # 为什么要有它
 *
 * 在这之前有两套各自克制的询问：问诊追问说「一轮 ≤2 题」（`diagnosis.ts`），事实补录说「一轮最多一个」
 * （`elicitation.ts`，§4.6）。两套互不知情，`service` / `ownership` 又同时在两套的触发条件里——
 * 档案过期的车主拍一张仪表照，同一轮拿到的是正文末尾一句补录提问 + 两张芯片题，三个问题一起上。
 * 每一套都没有越自己的界，合起来越了车主的耐心（ADR-010 的形状：判断者缺「这一轮已经问了几个」这个事实）。
 *
 * M106 又加了第三路——模型提议。三路各管各的话，这个问题只会从「两套」变成「五种卡 × 三路」。
 *
 * # 它管什么、不管什么
 *
 * 管：本轮放行哪几张卡、还剩几个问题位（后者传给 elicitation）。
 * 不管：题库挑哪几道候选（`diagnosis.ts` 按结构化信号挑）、模型提什么（`service-asks.ts`）、
 * elicitation 问哪个槽位（`pickElicitation` 的排序与三条硬约束一行不动）。
 *
 * 纯函数，无 IO。模型一路进来的是 `unknown[]`——校验在这里做，只在这里做。
 */

import { createHash } from "node:crypto";

import {
  interactionVisibleTexts,
  isAskPrompt,
  validateInteractionPrompt,
  type DiagnosisQuestion,
  type DiagnosisRiskLevel,
  type InteractionPrompt,
} from "@carlife/shared";
import { redact } from "@carlife/guardrails";

import { checkHardBlock } from "../guard/hard-block-rules";

/**
 * - `asks: 2`：F-20-09 的原数（AC-20-7「一次 2–3 问」取下沿——手机竖屏两题加一张补拍卡已经是一屏）。
 *   elicitation 追加的那一句、失败追问的那一句，各占一位。
 * - `guidance` / `capture` 各 1：它们是请车主**做**一件事，一次只能做一件。
 * - `total: 4`：2 问 + 1 引导 + 1 拍照，恰好是各项上限之和；单列出来是为了以后调某一项时这条线还在。
 * - `rounds: 2`：提问至多两轮（F-20-09）。引导与拍照不计轮——补拍三次也还是在帮车主把这一件事弄清楚。
 */
export const PROMPT_BUDGET = { asks: 2, guidance: 1, capture: 1, total: 4, rounds: 2 } as const;

export interface BudgetInput {
  /** 题库按结构化信号挑出的候选，**未**去重、未截断。 */
  bank: readonly DiagnosisQuestion[];
  /** 观察层的补拍指引（具体到方向）。 */
  retakeHints: readonly string[];
  /** 模型一路，未校验。 */
  proposals: readonly unknown[];
  riskLevel: DiagnosisRiskLevel;
  previous?: { askedRounds: number; askedIds: readonly string[] };
  /** 本轮已被别人占掉的问题位（失败追问那一句 = 1）。 */
  reservedAsks?: number;
  /**
   * 给事实补录留一位（AC-54-10：出发前的能源余量**优先**）。
   *
   * 问诊的题平时先拿位——它关系到车主刚问的事，而里程、上次保养下一轮再问也不迟。
   * 唯独车主明说要出发的那一轮不行：余量是过期即废的（`perishable`），出发之后再问没有意义。
   * 留的位补录那边没用上（这趟已经问过一次）就空着——少问一个是安全的方向。
   */
  reserveForElicitation?: boolean;
}

export type DropReason =
  | "invalid"
  | "hard_block"
  | "asked_before"
  | "duplicate"
  | "high_risk_no_guidance"
  | "code_capture_wins"
  | "over_capture"
  | "over_guidance"
  | "no_ask_slot"
  | "rounds_exhausted"
  | "over_total";

export interface BudgetResult {
  /** 渲染顺序：拍照 → 引导 → 提问（Brief 第 3 步：补拍在追问之上）。 */
  prompts: InteractionPrompt[];
  asksUsed: number;
  /** 留给 elicitation 的问题位。 */
  asksLeft: number;
  /** 「模型提了为什么没出来」要在轨迹里查得到。 */
  dropped: Array<{ reason: DropReason; id?: string; kind?: string }>;
}

function shortHash(parts: readonly string[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 8);
}

/**
 * 题库的题下发成芯片题：封闭选项、不带「其他」——题库的选项本来就是穷尽的。
 *
 * 单选还是多选由题自己说（`q.multi`，2026-09-19）。在这之前这里写死 `single`，
 * 于是「什么时候出现？冷车 / 热车 / 一直」这种**两项能同时为真**的题也只能点一个。
 */
export function toBankPrompt(q: DiagnosisQuestion): InteractionPrompt {
  return { id: q.id, origin: "code", kind: q.multi ? "multi" : "single", text: q.text, options: [...q.options], allowOther: false };
}

/** 只有一条提示时拍照卡的说明行。M104 的补拍卡在端上写着同一句，收回到这里。 */
export const RETAKE_DEFAULT_HINT = "补拍后判断会更准，也可以先按现在这张继续。";

/** 观察层的补拍指引 → 一张拍照卡。「一条提示怎么变成一张卡」从端上收回到这里（M104 是端上在拼）。 */
export function captureFromRetakeHints(hints: readonly string[]): InteractionPrompt | null {
  const [first, ...rest] = hints;
  if (!first) return null;
  const candidate = {
    id: `c-retake-${shortHash(hints)}`,
    origin: "code",
    kind: "capture",
    title: first,
    hint: rest.length > 0 ? rest.join("；") : RETAKE_DEFAULT_HINT,
  };
  // 观察层的提示语是我们自己的固定措辞，正常不会越限；万一越了就不出卡，而不是出一张撑破版式的卡。
  return validateInteractionPrompt(candidate);
}

/** 逐字段过一遍 `f`，重建同型对象。脱敏用；结构与 `interactionVisibleTexts` 一一对应。 */
function mapTexts(p: InteractionPrompt, f: (s: string) => string): InteractionPrompt {
  switch (p.kind) {
    case "single":
    case "multi":
      return { ...p, text: f(p.text), options: p.options.map(f) };
    case "open":
      return { ...p, text: f(p.text), ...(p.placeholder ? { placeholder: f(p.placeholder) } : {}) };
    case "guidance":
      return { ...p, title: f(p.title), steps: p.steps.map(f), source: p.source === null ? null : f(p.source), outcomes: p.outcomes.map(f) };
    case "capture":
      return { ...p, title: f(p.title), hint: f(p.hint) };
  }
}

/**
 * 模型一路进门：校验 → 重写 id 与 origin → 硬禁 → 脱敏。
 *
 * **id 由代码按内容哈希重写**：模型自报的 id 每轮都可能不一样（或者每轮都叫 `q1`），
 * 而跨轮去重要的是「同一句话不问第二遍」。`origin` 同理强制为 `model`——
 * 模型说自己是 `code` 并不会让它变成题库的题。
 */
function admit(proposals: readonly unknown[], dropped: BudgetResult["dropped"]): InteractionPrompt[] {
  const out: InteractionPrompt[] = [];
  for (const raw of proposals) {
    const isObject = typeof raw === "object" && raw !== null && !Array.isArray(raw);
    const seed = isObject ? { ...(raw as object), id: "m-pending", origin: "model" } : raw;
    const valid = validateInteractionPrompt(seed);
    if (!valid) {
      dropped.push({ reason: "invalid", kind: isObject ? String((raw as { kind?: unknown }).kind) : typeof raw });
      continue;
    }
    const texts = interactionVisibleTexts(valid);
    const id = `m-${valid.kind}-${shortHash([valid.kind, ...texts])}`;
    // 现有报告字段全是代码产物，所以报告一直绕过输出管线；模型的字第一次进报告，要过这两道。
    if (checkHardBlock(texts.join("\n")).blocked) {
      dropped.push({ reason: "hard_block", id, kind: valid.kind });
      continue;
    }
    const masked = mapTexts({ ...valid, id }, (s) => redact(s).text);
    // 掩码不改长度的假设万一不成立，宁可丢卡也不出一张越限的。
    const again = validateInteractionPrompt(masked);
    if (!again) {
      dropped.push({ reason: "invalid", id, kind: valid.kind });
      continue;
    }
    out.push(again);
  }
  return out;
}

export function budgetPrompts(input: BudgetInput): BudgetResult {
  const dropped: BudgetResult["dropped"] = [];
  const askedBefore = new Set(input.previous?.askedIds ?? []);
  const seen = new Set<string>();
  const fresh = (p: InteractionPrompt): boolean => {
    if (askedBefore.has(p.id)) {
      dropped.push({ reason: "asked_before", id: p.id, kind: p.kind });
      return false;
    }
    if (seen.has(p.id)) {
      dropped.push({ reason: "duplicate", id: p.id, kind: p.kind });
      return false;
    }
    seen.add(p.id);
    return true;
  };

  const model = admit(input.proposals, dropped).filter(fresh);
  const bank = input.bank.map(toBankPrompt).filter(fresh);

  // ── 拍照：观察层那张压过模型的。它来自「框外还有半边仪表」这样的事实，模型那张来自推测。
  //    代码那张**不进跨轮去重**：同一句「右侧没拍到」第二次出现，说明车主补拍的那张还是没拍到。
  const captures: InteractionPrompt[] = [];
  const codeCapture = captureFromRetakeHints(input.retakeHints);
  const modelCaptures = model.filter((p) => p.kind === "capture");
  if (codeCapture) {
    captures.push(codeCapture);
    for (const p of modelCaptures) dropped.push({ reason: "code_capture_wins", id: p.id, kind: p.kind });
  } else {
    captures.push(...modelCaptures.slice(0, PROMPT_BUDGET.capture));
    for (const p of modelCaptures.slice(PROMPT_BUDGET.capture)) dropped.push({ reason: "over_capture", id: p.id, kind: p.kind });
  }

  // ── 引导：报告正在说「建议立即停止」时，旁边再挂一张「自己动手试试」是自相矛盾。
  const modelGuidance = model.filter((p) => p.kind === "guidance");
  const guidance: InteractionPrompt[] = [];
  if (input.riskLevel === "high") {
    for (const p of modelGuidance) dropped.push({ reason: "high_risk_no_guidance", id: p.id, kind: p.kind });
  } else {
    guidance.push(...modelGuidance.slice(0, PROMPT_BUDGET.guidance));
    for (const p of modelGuidance.slice(PROMPT_BUDGET.guidance)) dropped.push({ reason: "over_guidance", id: p.id, kind: p.kind });
  }

  // ── 提问：先放**一条**模型的（扣住这一次输入的那条），再用题库补，再用剩余的模型题补。
  //    只按来源排一个先后会饿死另一路：题库先 ⇒ 有灯的那一轮两个位永远是 parked + since；
  //    模型先 ⇒ 喂风险分级的那几道结构化题永远问不出去。
  const roundsLeft = (input.previous?.askedRounds ?? 0) < PROMPT_BUDGET.rounds;
  const slots = roundsLeft ? Math.max(0, PROMPT_BUDGET.asks - (input.reservedAsks ?? 0)) : 0;
  const ownSlots = Math.max(0, slots - (input.reserveForElicitation ? 1 : 0));
  const modelAsks = model.filter(isAskPrompt);
  const ordered = [...modelAsks.slice(0, 1), ...bank, ...modelAsks.slice(1)];
  const asks = ordered.slice(0, ownSlots);
  for (const p of ordered.slice(ownSlots)) dropped.push({ reason: roundsLeft ? "no_ask_slot" : "rounds_exhausted", id: p.id, kind: p.kind });

  const all = [...captures, ...guidance, ...asks];
  const prompts = all.slice(0, PROMPT_BUDGET.total);
  for (const p of all.slice(PROMPT_BUDGET.total)) dropped.push({ reason: "over_total", id: p.id, kind: p.kind });

  const asksUsed = prompts.filter(isAskPrompt).length;
  return { prompts, asksUsed, asksLeft: Math.max(0, slots - asksUsed), dropped };
}
