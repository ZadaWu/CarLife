/**
 * 输出 PII 脱敏（施工单 M6-02，§8.3）。
 *
 * # 为什么自建
 *
 * §8.6 调研结论：现有 TS 库的 PII 规则全是欧美 locale（SSN/信用卡/email），
 * **没有身份证/银行卡/中国大陆手机号的规则**。这是自建的核心理由，不是 NIH。
 *
 * # 顺序讲究，不是实现细节
 *
 * 长规则先跑：18 位身份证必须先于银行卡匹配。反过来的话，身份证前 16 位
 * 会被银行卡规则抢先命中，脱出来的位置是错的。
 *
 * # 防误伤
 *
 * 15 位老身份证与银行卡长度重叠，靠**前 6 位是行政区划码**区分。
 * 宁可漏脱一个可疑串，也不要把订单号打成银行卡——后者用户立刻就会发现，
 * 而且会连带不信任其它输出。
 *
 * # 与内容审核解耦
 *
 * **脱敏永远跑**，哪怕内容审核判定 safe（§8.3 第 4 条）：
 * 一段内容可以完全无害，同时泄露一个手机号。"内容安全"和"信息泄露"是两个维度。
 */

export type PiiKind = "id_card" | "bank_card" | "phone" | "email" | "vin" | "plate";

export interface PiiRule {
  kind: PiiKind;
  pattern: RegExp;
  /** 保留头尾各几位，中间打码——全打码会让用户无法确认"是不是我的那个号"。 */
  mask: (raw: string) => string;
}

const keepEnds = (head: number, tail: number) => (raw: string) =>
  raw.length <= head + tail ? "*".repeat(raw.length) : raw.slice(0, head) + "*".repeat(raw.length - head - tail) + raw.slice(raw.length - tail);

/** 中国大陆行政区划码首位：1~8（9 未使用）。用于把老身份证与银行卡分开。 */
const ID_PREFIX = /^[1-8]\d{5}/;

/** 车牌省简称。stream-redact 的 CONTINUATION 依赖这份词表——两处必须同源（M42-02）。 */
export const PLATE_PROVINCES = "京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼";

/**
 * 顺序即优先级。**改动这个数组的顺序会改变脱敏结果**，不是风格问题。
 */
export const PII_RULES: readonly PiiRule[] = [
  // 18 位身份证：必须在银行卡之前
  { kind: "id_card", pattern: /\b[1-8]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, mask: keepEnds(6, 2) },
  /*
   * VIN：17 位、剔 I/O/Q（对齐 `isValidVin` 的字符集）、**至少含一个字母**——
   * 纯 17 位数字更可能是银行卡，留给下一条规则按它的口径打码（M42-02）。
   * 必须排在银行卡之前：含字母的 VIN 不会被银行卡规则碰，但顺序表达的是意图。
   */
  { kind: "vin", pattern: /\b(?=[A-HJ-NPR-Z0-9]{17}\b)[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z][A-HJ-NPR-Z0-9]*\b/g, mask: keepEnds(3, 4) },
  // 银行卡 16~19 位
  { kind: "bank_card", pattern: /\b\d{16,19}\b/g, mask: keepEnds(4, 4) },
  // 15 位老身份证（放在银行卡之后，靠前缀校验避免误伤）
  { kind: "id_card", pattern: /\b\d{15}\b/g, mask: keepEnds(6, 2) },
  { kind: "phone", pattern: /\b1[3-9]\d{9}\b/g, mask: keepEnds(3, 4) },
  /*
   * 车牌：省简称汉字 + 发牌机关字母 + 5 位（燃油）/6 位（新能源）序号，
   * 或 4 位 + 挂/学/警/港/澳 尾字。**只匹配完整形态**——口语里的"京A"两个字符
   * 不匹配（那是聊天不是号牌，误伤断言在回归样本集里）。
   * 汉字两侧没有 \b（\w 不含汉字），改用尾部负向前瞻防止吃进更长的串。
   * 保留形态：省简称 + 机关字母 + 尾 1 位（`京A****9`）——用户要能认出"是我的车"。
   */
  { kind: "plate", pattern: new RegExp(`[${PLATE_PROVINCES}][A-HJ-NPR-Z](?:[A-HJ-NPR-Z0-9]{4}[挂学警港澳]|[A-HJ-NPR-Z0-9]{5,6})(?![A-HJ-NPR-Z0-9])`, "g"), mask: keepEnds(2, 1) },
  { kind: "email", pattern: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, mask: (raw) => {
      const [user, domain] = raw.split("@");
      return `${user.slice(0, 1)}${"*".repeat(Math.max(1, user.length - 1))}@${domain}`;
    } },
];

export interface RedactResult {
  text: string;
  /** 命中统计——供审计观察脱敏命中率（F-26-11）。 */
  hits: Record<PiiKind, number>;
}

export function redact(input: string): RedactResult {
  const hits: Record<PiiKind, number> = { id_card: 0, bank_card: 0, phone: 0, email: 0, vin: 0, plate: 0 };
  let text = input;

  for (const rule of PII_RULES) {
    text = text.replace(rule.pattern, (raw) => {
      // 15 位串只有前缀像行政区划码才当身份证——否则留给后续规则或原样保留。
      if (rule.kind === "id_card" && raw.length === 15 && !ID_PREFIX.test(raw)) return raw;
      hits[rule.kind] += 1;
      return rule.mask(raw);
    });
  }

  return { text, hits };
}
