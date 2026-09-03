/**
 * 流式输出的跨 chunk 脱敏（施工单 TD-06，FL-26 F-26-05）。
 *
 * # 冲突是真的：流式与脱敏天然打架
 *
 * §3 定了 token 流走 SSE 单向下行、逐事件推送。而 PII 模式可能**横跨两片**：
 *
 * ```
 * 第 1 片  "我的号码是1380"     → \b1[3-9]\d{9}\b 不匹配（只有 4 位）
 * 第 2 片  "0138000，有事打我"  → 不匹配（0 开头）
 * ```
 *
 * 逐片脱敏，手机号就完整地进了用户屏幕。攒满整段再脱敏则没有流式了。
 *
 * # 解法：扣住"还可能长成一个模式"的尾巴
 *
 * 不是扣固定字数。规则是：**结尾那串还可能继续长的字符先不发**，
 * 等它被一个不可能出现在模式里的字符（中文、空格、标点）截断，再连同前面一起判。
 *
 * 对中文回答这个代价极小——`\w` 在 JS 正则里是 `[A-Za-z0-9_]`，
 * 中文不在其中，所以中文字符**立刻就发**，只有结尾正在输出的那串
 * 数字/字母/邮箱片段会被短暂扣住。这正是唯一有风险的部分。
 *
 * # 诚实的局限：邮箱可能漏
 *
 * 邮箱模式没有长度上限（前缀可以任意长），而我们必须给缓冲设上限
 * （否则一段 base64 会让输出永远卡住）。超过 `MAX_HOLDBACK` 时按兜底策略放行，
 * 此时跨片的超长邮箱可能漏出去。这是**该方案的固有局限，不是实现缺陷**——
 * 缓冲方案没有这个问题但没有流式，取舍见 FL-26 未决项的定案。
 *
 * # 它不替代 `redact()`
 *
 * 本模块是 `redact()` 的**流式包装**，用的是同一份 `PII_RULES`。
 * 非流式路径（整段文本）继续直接用 `redact()`。
 */

import { redact, PLATE_PROVINCES, type RedactResult } from "./pii";

/**
 * 可能构成 PII 的字符类。
 *
 * 取 `PII_RULES` 里全部模式字符集的**并集**：数字、大小写字母、下划线
 * （`\w`），加邮箱用到的 `. % + - @`，以及身份证末位的 `X/x`（已含在字母里）。
 * M42-02 起再加车牌的省简称汉字与尾字（挂学警港澳）——车牌以汉字开头，
 * 不进这个类的话，chunk 恰好切在"沪|A12345"处时汉字已发出、模式永远拼不回来。
 * 代价是普通中文句子以"京"结尾时多扣一帧，符合"宁可多扣不可少扣"。
 *
 * **宁可多扣不可少扣**：多扣一个字符只是晚一帧发出，少扣一类就是漏一种 PII。
 */
const CONTINUATION = new RegExp(`[\\w.%+\\-@${PLATE_PROVINCES}挂学警港澳]`);

/**
 * 扣留上限。
 *
 * 超过它就放行，避免一段没有分隔符的长串（base64、URL、代码）
 * 把输出永远卡住——**输出卡死比漏一个超长邮箱更严重**，那是功能不可用。
 * 19 是定长模式里最长的（银行卡）；给到 64 是为了覆盖常见邮箱全长。
 */
export const MAX_HOLDBACK = 64;

/**
 * 最长定长模式的长度（银行卡 19 位）。
 *
 * 这是**硬下限**：把 `maxHoldback` 配到它以下，等于承诺"一个完整的银行卡号
 * 也可能被拆着发出去"，那时脱敏对定长模式就彻底失效了。
 * 所以构造时会向上取到它，而不是相信调用方给的值。
 */
export const MIN_SAFE_HOLDBACK = 19;

/**
 * 算出**必须扣留**的尾部长度。
 *
 * 从末尾往前数连续的 continuation 字符；数满 `MAX_HOLDBACK` 就停——
 * 再长也不扣了，见上面的取舍。
 */
export function holdbackLength(buffer: string, max = MAX_HOLDBACK): number {
  let n = 0;
  for (let i = buffer.length - 1; i >= 0 && n < max; i -= 1) {
    if (!CONTINUATION.test(buffer[i])) break;
    n += 1;
  }
  return n;
}

export interface StreamRedactor {
  /**
   * 推入新生成的一片，返回**此刻可以安全发出**的部分。
   *
   * 可能返回空串——那表示这一片全被扣住了，等下一片。调用方不该因此
   * 认为"流断了"，也不该把空串当成一个 delta 发出去。
   */
  push(chunk: string): { text: string; redaction: RedactResult };
  /**
   * 流结束：把剩下的全部吐出来。
   *
   * 此刻不会再有"下一片"，所以扣留的理由消失，可以放心整体判一次。
   * **不调 flush 就会丢掉最后那截**——收尾时忘了它，回答会缺一小段结尾。
   */
  flush(): { text: string; redaction: RedactResult };
  /** 当前扣在缓冲里、尚未发出的字符数。诊断与测试用。 */
  pending(): number;
}

const EMPTY: RedactResult = {
  text: "",
  hits: { id_card: 0, bank_card: 0, phone: 0, email: 0, vin: 0, plate: 0 },
};

/**
 * 创建一个流式脱敏器。**一轮回复一个实例**——
 * 跨轮复用会把上一轮的尾巴接到这一轮开头。
 */
export function createStreamRedactor(maxHoldback = MAX_HOLDBACK): StreamRedactor {
  // 向上取到硬下限：低于 19 时定长模式（银行卡/身份证）会被拆着发出去
  const limit = Math.max(maxHoldback, MIN_SAFE_HOLDBACK);
  let buffer = "";

  const emit = (text: string): { text: string; redaction: RedactResult } => {
    if (text === "") return { text: "", redaction: EMPTY };
    const r = redact(text);
    return { text: r.text, redaction: r };
  };

  return {
    push(chunk) {
      buffer += chunk;
      const hold = holdbackLength(buffer, limit);
      const safe = buffer.slice(0, buffer.length - hold);
      buffer = buffer.slice(buffer.length - hold);
      // 只对安全前缀脱敏：按构造，没有模式能跨过这个边界
      // （能跨的字符都还留在 buffer 里）
      return emit(safe);
    },

    flush() {
      const rest = buffer;
      buffer = "";
      return emit(rest);
    },

    pending() {
      return buffer.length;
    },
  };
}
