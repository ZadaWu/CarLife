/**
 * 零延迟规则筛（施工单 M6-01，§8.1）。
 *
 * **纯函数、零 IO、零模型调用**——这三条是它存在的全部理由。
 * 命中即拒，返回统一话术；不回显用户原文（回显等于把注入内容再显示一遍）。
 */

import {
  INJECTION_RULES,
  MAX_INPUT_CHARS,
  type PrefilterVerdict,
} from "./rules";

/** 统一拒绝话术：不解释规则细节——说清楚等于教人绕过。 */
const REFUSAL = "这条消息我没法处理。换个说法再试试？";

export function prefilter(input: string): PrefilterVerdict {
  // 长度先判：它最便宜，且超长输入本身就是一种攻击面。
  if (input.length > MAX_INPUT_CHARS) {
    return {
      allowed: false,
      reason: "too_long",
      message: `单条消息请控制在 ${MAX_INPUT_CHARS} 字以内。`,
    };
  }

  for (const rule of INJECTION_RULES) {
    if (rule.pattern.test(input)) {
      return { allowed: false, reason: "injection", ruleId: rule.id, message: REFUSAL };
    }
  }

  return { allowed: true };
}
