/**
 * 输入规则筛的规则表（施工单 M6-01，§8.1）。
 *
 * # 它的价值在"零延迟"三个字
 *
 * 挡掉最廉价的攻击，**不占用后面更贵的模型审核层**：命中即拒，不消耗任何 LLM 调用。
 * 一次注入尝试如果要先花 10s 过一遍 Qwen3Guard 才被拒，这层就白做了。
 *
 * # 懒编译一次，全生命周期复用
 *
 * 顶层 `const` 在模块加载时编译一次（§8.1 原文对标 Rust 的 `OnceLock`）。
 * 放进函数里每次 `new RegExp` 是这类代码最常见的性能坑。
 *
 * # 无业务耦合
 *
 * 本包是**通用管线**（§10 要点 3）：不含 CarLife 的硬禁清单、免责话术、车辆概念。
 * 那些在 `enterprise/backend/agent-runtime/src/guard/`。`check:arch` 的 guardrails-purity 检查守着这条。
 */

/** 单条输入的长度上限（§8.1）。超限直接拒绝，不进入后续任何一层。 */
export const MAX_INPUT_CHARS = 500;

export interface InjectionRule {
  id: string;
  pattern: RegExp;
  /** 命中后给用户的说明——**不回显用户原文**，避免把注入内容再显示一遍。 */
  hint: string;
}

/**
 * 9 条中英双语注入黑名单（§8.1 原文列举的覆盖面）。
 *
 * 编号稳定：审计里记的是 `id`，改表时**不要重排编号**，否则历史审计对不上。
 */
export const INJECTION_RULES: readonly InjectionRule[] = [
  { id: "inj-01", pattern: /忽略(前面|上面|之前|以上).{0,6}(指令|要求|设定|提示)/i, hint: "检测到指令覆盖尝试" },
  { id: "inj-02", pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i, hint: "检测到指令覆盖尝试" },
  { id: "inj-03", pattern: /(开发者|调试|上帝|管理员)模式/i, hint: "检测到越权模式请求" },
  { id: "inj-04", pattern: /\b(developer|debug|god)\s*mode\b/i, hint: "检测到越权模式请求" },
  { id: "inj-05", pattern: /\bDAN\b|do\s+anything\s+now/i, hint: "检测到越狱提示词" },
  { id: "inj-06", pattern: /(system\s*prompt|系统提示词?|你的?(初始|原始)指令)/i, hint: "检测到系统提示词探测" },
  // 角色标签覆盖：`</system>`、`[INST]`、`<|im_start|>` 这类
  { id: "inj-07", pattern: /<\/?\s*(system|assistant|user)\s*>/i, hint: "检测到角色标签注入" },
  { id: "inj-08", pattern: /<\|\s*(im_start|im_end|system|endoftext)\s*\|>|\[\/?INST\]/i, hint: "检测到角色标签注入" },
  { id: "inj-09", pattern: /(你现在|从现在开始)(是|扮演|变成).{0,12}(不受限|无限制|没有任何限制)/i, hint: "检测到人设覆盖尝试" },
];

export type PrefilterReason = "too_long" | "injection";

export interface PrefilterVerdict {
  allowed: boolean;
  reason?: PrefilterReason;
  /** 命中的规则 id——审计用（§8.5：拦截与放行都要能追溯到具体规则）。 */
  ruleId?: string;
  /** 给用户的统一话术。 */
  message?: string;
}
