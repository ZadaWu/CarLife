/**
 * @carlife/guardrails —— 通用 Guardrails 管线（§8，§10 要点 3）。
 *
 * **无业务耦合**：本包不含 CarLife 的硬禁清单、免责话术、车辆概念——
 * 那些在 `enterprise/backend/agent-runtime/src/guard/`。`check:arch` 的 guardrails-purity 守着这条。
 *
 * 管线形态：input → moderation → output（§8 三层内容管线）。
 * moderation 层（Qwen3Guard-Gen）归 M6-03，当前为可注入的接口。
 */

export { prefilter } from "./input/prefilter";
export {
  INJECTION_RULES,
  MAX_INPUT_CHARS,
  type InjectionRule,
  type PrefilterReason,
  type PrefilterVerdict,
} from "./input/rules";
export { redact, PII_RULES, type PiiKind, type PiiRule, type RedactResult } from "./output/pii";
export { createContentGuard } from "./moderation/content-guard";
export { createOpenAiCompatClient, type OpenAiCompatConfig, type OpenAiCompatClient } from "./moderation/openai-compat-client";
export { parseGuardOutput, GUARD_CATEGORIES } from "./moderation/parse";
export {
  createAliyunGuardClient,
  signRpc,
  stringToSign,
  canonicalQuery,
  AliyunGuardError,
  ALIYUN_GREEN_VERSION,
  type AliyunGuardClient,
  type AliyunGuardConfig,
  type AliyunGuardParams,
  type AliyunGuardResponse,
  type AliyunGuardDetail,
  type AliyunGuardDimension,
  type AliyunGuardService,
  type AliyunSuggestion,
} from "./moderation/aliyun-client";
export {
  createAliyunContentGuard,
  foldDetail,
  sliceContent,
  worseSuggestion,
  ALIYUN_MAX_CHARS,
  type AliyunVerdict,
  type AliyunGuardOptions,
} from "./moderation/aliyun-guard";
export {
  DEFAULT_POLICY,
  CATEGORY_KEYS,
  applyPolicy,
  validatePolicy,
  type CategoryPolicy,
  type FailMode,
  type GuardPolicy,
} from "./moderation/runtime-config";

import { prefilter } from "./input/prefilter";
import type { ContentGuard } from "./moderation/content-guard";
import type { PrefilterVerdict } from "./input/rules";
import { redact, type RedactResult } from "./output/pii";
import { applyPolicy, DEFAULT_POLICY, type GuardPolicy } from "./moderation/runtime-config";

export type { ContentGuard, GuardVerdict } from "./moderation/content-guard";

export interface PipelineOptions {
  /** 未注入时**跳过审核层**并在结果里标注——不是静默当作安全。 */
  moderation?: ContentGuard;
  /**
   * input 默认 fail-open、output 默认 fail-closed（§8.2 非对称 fail 模式）。
   * 模型挂了不能把正常对话全堵死；但也不能放行未审核的输出。
   */
  failOpenOnInput?: boolean;
  failClosedOnOutput?: boolean;
  /**
   * 运行时策略值（分类开关 + fail 模式）。
   *
   * **不传即用 `DEFAULT_POLICY`**（六类全开、input open / output closed）。
   * 回落到默认而不是"不应用策略"是刻意的：后者会让忘记注入策略的调用方
   * 得到一条完全不受策略约束的管线，而它跑起来毫无症状。
   *
   * 传入时 `policy` 里的 fail 模式**优先于** `failOpenOnInput` /
   * `failClosedOnOutput` —— 那两个是策略层落地之前的旧入口，
   * 两处都给时以运营可改的那份为准。
   */
  policy?: GuardPolicy;
}

export interface InputResult {
  allowed: boolean;
  stage: "prefilter" | "moderation" | "passed";
  reason?: string;
  ruleId?: string;
  /** 审核层未接入时为 true——**让调用方知道这一层没跑**，不假装跑过。 */
  moderationSkipped?: boolean;
  /**
   * 被策略抑制的分类：模型判它不安全，但运营把该类关掉了，于是放行。
   *
   * **非空即意味着"这次放行是策略造成的"**。调用方必须把它写进审计——
   * 运营调完策略要能回答"因为我关了这类，放过了多少"，
   * 而没有这个字段时，被抑制的放行和本来就安全的放行在日志里长得一模一样。
   */
  suppressed?: string[];
}

/** 输入侧：规则筛 → 内容审核。 */
export async function runInputPipeline(
  text: string,
  opts: PipelineOptions = {},
): Promise<InputResult> {
  const pre: PrefilterVerdict = prefilter(text);
  if (!pre.allowed) {
    return { allowed: false, stage: "prefilter", reason: pre.message, ruleId: pre.ruleId };
  }

  if (!opts.moderation) {
    return { allowed: true, stage: "passed", moderationSkipped: true };
  }

  const policy = opts.policy ?? DEFAULT_POLICY;

  try {
    const raw = await opts.moderation.check(text, "input");
    // 策略在**模型结论之后**应用：模型永远按全类判，运营的开关只决定拦不拦。
    // 反过来（把关掉的类别从提示词里删掉）会让模型的判定基线随配置漂移，
    // 那时两次不同配置下的结论就不可比了。
    const v = applyPolicy(raw, policy);
    return v.safe
      ? { allowed: true, stage: "passed", ...(v.suppressed.length ? { suppressed: v.suppressed } : {}) }
      : { allowed: false, stage: "moderation", reason: `内容审核未通过：${v.categories.join("/")}` };
  } catch {
    // input fail 模式（§8.2）：审核模型挂了默认不把正常对话全堵死。
    const failOpen = policy.inputFailMode === "open" && (opts.failOpenOnInput ?? true);
    return failOpen
      ? { allowed: true, stage: "passed", moderationSkipped: true }
      : { allowed: false, stage: "moderation", reason: "内容审核不可用" };
  }
}

export interface OutputResult {
  allowed: boolean;
  text: string;
  redaction: RedactResult;
  reason?: string;
  /** 同 `InputResult.suppressed`：被策略抑制的分类，非空即"这次放行是策略造成的"。 */
  suppressed?: string[];
}

/**
 * 输出侧：内容审核 → PII 脱敏。
 *
 * **脱敏永远跑**，哪怕审核判定 safe（§8.3 第 4 条）——
 * "内容安全"和"信息泄露"是两个维度。
 */
export async function runOutputPipeline(
  text: string,
  opts: PipelineOptions = {},
): Promise<OutputResult> {
  let allowed = true;
  let reason: string | undefined;
  let suppressed: string[] = [];
  const policy = opts.policy ?? DEFAULT_POLICY;

  if (opts.moderation) {
    try {
      const raw = await opts.moderation.check(text, "output");
      const v = applyPolicy(raw, policy);
      suppressed = v.suppressed;
      if (!v.safe) {
        allowed = false;
        reason = `内容审核未通过：${v.categories.join("/")}`;
      }
    } catch {
      // output fail 模式（§8.2）：默认宁可不回复，也不放行未审核内容。
      if (policy.outputFailMode === "closed" && (opts.failClosedOnOutput ?? true)) {
        allowed = false;
        reason = "内容审核不可用，已保守拦截";
      }
    }
  }

  // 无论审核结论如何都脱敏——它管的是另一个维度。
  const redaction = redact(text);
  return { allowed, text: redaction.text, redaction, reason, ...(suppressed.length ? { suppressed } : {}) };
}
export {
  createStreamRedactor,
  holdbackLength,
  MAX_HOLDBACK,
  MIN_SAFE_HOLDBACK,
  type StreamRedactor,
} from "./output/stream-redact";
export {
  createModerationSession,
  DEFAULT_SLICE_CHARS,
  type ModerationSession,
  type ModerationSessionOptions,
} from "./moderation/stream-session";
export type { ModerationStreamContext } from "./moderation/content-guard";
