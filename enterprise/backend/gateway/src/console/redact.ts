/**
 * 后台脱敏（施工单 M3-04 的最小实现）。
 *
 * ⚠️ **这不是最终归宿**：PII 管线的正式实现是 `enterprise/backend/shared/guardrails/src/output/pii.ts`
 * （FL-26 / §8.3），该包本 Sprint 全部是空壳，所以这里先落一份最小版本。
 * TODO(FL-26)：`enterprise/backend/shared/guardrails` 落地后删除本文件，改为直接消费它，
 * **不要让两套规则长期并存**——同一段文本在后台与在对话输出里脱敏结果不同是事故。
 *
 * 与那份设计对齐的两点（否则将来合并会出现行为差异）：
 *  1. **长规则先跑**：18 位身份证先于银行卡，避免短规则抢先命中导致误脱敏。
 *  2. **防误伤**：15 位老身份证需与银行卡按长度+前缀区分，不当银行卡处理。
 */

interface Rule {
  name: string;
  re: RegExp;
  mask: (m: string) => string;
}

const keepEdges = (m: string, head: number, tail: number): string =>
  `${m.slice(0, head)}${"*".repeat(Math.max(m.length - head - tail, 1))}${m.slice(m.length - tail)}`;

// 顺序即优先级：越长越具体的规则越靠前。
const RULES: readonly Rule[] = [
  {
    // 18 位身份证（含 X 结尾）——必须先于银行卡
    name: "id_card_18",
    re: /\b\d{17}[\dXx]\b/g,
    mask: (m) => keepEdges(m, 4, 2),
  },
  {
    // 15 位老身份证：前 6 位为行政区划码（1-9 开头），与银行卡按长度+前缀区分
    name: "id_card_15",
    re: /\b[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}\b/g,
    mask: (m) => keepEdges(m, 4, 2),
  },
  {
    name: "bank_card",
    re: /\b\d{16,19}\b/g,
    mask: (m) => keepEdges(m, 4, 4),
  },
  {
    name: "phone_cn",
    re: /\b1[3-9]\d{9}\b/g,
    mask: (m) => keepEdges(m, 3, 2),
  },
  {
    name: "email",
    re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    mask: (m) => {
      const [user, domain] = m.split("@");
      return `${user.slice(0, 1)}***@${domain}`;
    },
  },
];

export interface RedactResult {
  text: string;
  redacted: boolean;
  hits: string[];
}

export function redact(text: string): RedactResult {
  let out = text;
  const hits: string[] = [];

  for (const rule of RULES) {
    // 每条规则用新 RegExp 避免 lastIndex 在 /g 下跨调用残留
    const re = new RegExp(rule.re.source, rule.re.flags);
    out = out.replace(re, (m) => {
      hits.push(rule.name);
      return rule.mask(m);
    });
  }

  return { text: out, redacted: hits.length > 0, hits };
}
