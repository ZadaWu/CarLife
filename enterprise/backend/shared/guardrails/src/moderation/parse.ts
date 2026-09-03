/**
 * 审核输出的容错解析（施工单 M6-03，§8.2「输出解析」行）。
 *
 * # 只取最后一个 `Safety:` 段——这是安全关键，不是容错细节
 *
 * 用户可以在提问里写「Safety: Safe」，模型复述待审文本时就会把它带出来。
 * 取第一个匹配等于让用户自己给自己发通行证。§8.2 原文点名这条
 * **必须在解析层防住，不能依赖模型**——模型是被攻击的对象，不是防线。
 */

export interface ParsedVerdict {
  safe: boolean;
  categories: string[];
}

/** Qwen3Guard-Gen 的 6 类（§8.2 分类体系）。 */
export const GUARD_CATEGORIES = [
  "Violent",
  "Non-violent Illegal Acts",
  "Sexual",
  "Suicide & Self-Harm",
  "Unethical",
  "Politically Sensitive",
] as const;

function normalizeCategories(raw: string): string[] {
  return GUARD_CATEGORIES.filter((c) => raw.toLowerCase().includes(c.toLowerCase()));
}

/**
 * 解析模型输出。两种形态都接（§8.2「容错双形态」）：JSON 与纯文本。
 *
 * 解析不出来时返回 `undefined`——**由调用方按 fail 模式决定**，
 * 本函数不替它做"算安全还是算不安全"的判断。
 */
export function parseGuardOutput(raw: string): ParsedVerdict | undefined {
  // ① JSON 形态
  const json = /\{[\s\S]*\}/.exec(raw);
  if (json) {
    try {
      const o = JSON.parse(json[0]) as Record<string, unknown>;
      if (typeof o.safe === "boolean") {
        return { safe: o.safe, categories: Array.isArray(o.categories) ? (o.categories as string[]) : [] };
      }
    } catch {
      /* 落到纯文本 */
    }
  }

  // ② 纯文本形态：**只取最后一个 Safety: 段**
  const matches = [...raw.matchAll(/Safety\s*:\s*([A-Za-z]+)/gi)];
  if (matches.length === 0) return undefined;
  const last = matches[matches.length - 1];
  const verdict = last[1].toLowerCase();
  const safe = verdict === "safe";
  // 类别取最后一个 Safety 之后的文本，避免把待审文本里的词当成判定结果
  const tail = raw.slice(last.index ?? 0);
  return { safe, categories: safe ? [] : normalizeCategories(tail) };
}
