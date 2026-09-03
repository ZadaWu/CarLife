/**
 * ②情景候选抽取（施工单 M11-03，§7②）。
 *
 * # ②与对话历史是两样东西
 *
 * §7 把它们分开列，而实现上最容易做成同一件事：把每轮对话都塞进②。
 * 那样②就变成了对话历史的一份向量副本——既没有增加信息，
 * 又让衰减任务在删一堆本来就该在 messages 表里的东西。
 *
 * ②是**被认为值得记住的事件**：一次问诊、一次异常、一次长途。
 * 判据落成代码而不是写在 prompt 里，三条必须同时成立：
 *  1. 有**事件性动词**（出现/坏了/换了/跑了/修了…）——闲聊与提问都过不了这一关；
 *  2. 能定出**发生时间**（`occurredAt`）；
 *  3. **不是长期习惯**（那是③，由 `preference-extract` 负责）。
 *
 * # `occurredAt` 不是写入时间
 *
 * 用户说"上个月空调坏过一次"，这条记忆的发生时间是**上个月**。
 * 填成"现在"会让指数衰减把一件旧事当成新鲜事，权重整体偏高——
 * 而这个错误在页面上完全看不出来：两条记忆长得一模一样，只是排序悄悄错了。
 * 所以相对时间要真的解析，解析不出来才退回"现在"，并把这件事标出来。
 */

export type EpisodicSubType = "trip" | "consultation" | "incident" | "interaction";

/**
 * 事件性标记。**没有它就不是一次"发生过的事"**，只是陈述或提问。
 *
 * 分两类是因为它们的语法形态不同，一条正则塞不下：
 *  - **动作**：带体标记（了/过/掉），"坏了"与"坏过一次"是同一件事的两种说法，
 *    所以匹配的是词干 + 可选体标记，不是固定词组；
 *  - **故障状态**：「不制冷」「没反应」这类描述里根本没有动词，
 *    但它们恰恰是②最典型的内容——漏掉它们，一半的问诊都记不下来。
 */
const EVENT_ACTION =
  /(出现|发生|坏|抛锚|熄火|打不着|换|修|保养|跑|开|去|撞|剐|追尾|拖车|报警|亮)(了|过|掉|完)/;
/**
 * 症状。**这一类是名词或形容词，本来就不带体标记**——
 * 「三天前异响」没有任何动词，但它是一次再典型不过的故障事件。
 * 一开始把"异响/漏油/冒烟"塞进动作类要求配"了/过"，于是这句话被判成不是事件。
 */
const EVENT_SYMPTOM =
  /(异响|异味|漏油|漏水|漏电|冒烟|不制冷|不制热|不工作|不出风|不启动|没反应|失灵|亮着|响得厉害|抖得厉害)/;
const isEvent = (s: string) => EVENT_ACTION.test(s) || EVENT_SYMPTOM.test(s);

/** 与③重叠的长期习惯标记：命中即让给③，避免同一句话两边都写。 */
const HABITUAL = /(一般|通常|习惯|都是|总是|每次|平时|经常|一直|从来)/;

/** 提问不是事件（与 ③ 同一条理由）。 */
const INTERROGATIVE = /(吗|呢|多少|几点|多久|怎么|如何|为什么|为啥|哪个|是不是|要不要|该不该)/;

/** 子类判定：按最具体的先匹配。 */
const SUBTYPE_RULES: Array<{ type: EpisodicSubType; re: RegExp }> = [
  // 顺序即优先级：一句话可能同时含"坏了"与"去了店里"，症状比就诊更能定性这件事。
  { type: "incident", re: /(坏|异响|漏|冒烟|抛锚|熄火|打不着|报警|撞|剐|追尾|拖车|不制冷|不制热|不工作|不出风|不启动|没反应|失灵|异味)/ },
  { type: "consultation", re: /(修|保养|换)(了|过|完)|(店|4S|修理厂|检测|诊断)/ },
  { type: "trip", re: /(跑|开|去)(了|过)|(自驾|长途|出差|旅行)/ },
];

const DAY = 86_400_000;

/**
 * 相对时间解析。返回 `undefined` 表示句子里没有时间线索。
 *
 * 只认**明确的**相对表达。模糊的（"前阵子""好久以前"）不猜——
 * 猜一个日期比没有日期更糟：它会以一个看起来精确的值参与衰减计算。
 */
export function parseOccurredAt(sentence: string, now: number): number | undefined {
  const m = (re: RegExp) => re.exec(sentence);

  if (m(/(今天|今早|今晚|刚才|刚刚)/)) return now;
  if (m(/昨天/)) return now - DAY;
  if (m(/前天/)) return now - 2 * DAY;
  if (m(/大前天/)) return now - 3 * DAY;

  const daysAgo = m(/([一二三四五六七八九十两百\d]+)\s*天前/);
  if (daysAgo) return now - cnNum(daysAgo[1]) * DAY;

  const weeksAgo = m(/([一二三四五六七八九十两\d]+)\s*(?:周|个?星期)前/);
  if (weeksAgo) return now - cnNum(weeksAgo[1]) * 7 * DAY;

  if (m(/上(?:个)?(?:周|星期)/)) return now - 7 * DAY;

  const monthsAgo = m(/([一二三四五六七八九十两\d]+)\s*个?月前/);
  if (monthsAgo) return now - cnNum(monthsAgo[1]) * 30 * DAY;

  if (m(/上(?:个)?月/)) return now - 30 * DAY;

  const yearsAgo = m(/([一二三四五六七八九十两\d]+)\s*年前/);
  if (yearsAgo) return now - cnNum(yearsAgo[1]) * 365 * DAY;

  if (m(/去年/)) return now - 365 * DAY;

  return undefined;
}

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 只处理日常口语量级（一~几十）。超出的走阿拉伯数字。 */
function cnNum(raw: string): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  if (raw === "十") return 10;
  const tenIdx = raw.indexOf("十");
  if (tenIdx >= 0) {
    const tens = tenIdx === 0 ? 1 : (CN_DIGITS[raw[tenIdx - 1]] ?? 1);
    const ones = CN_DIGITS[raw[tenIdx + 1]] ?? 0;
    return tens * 10 + ones;
  }
  return CN_DIGITS[raw] ?? 1;
}

export interface EpisodicCandidate {
  subType: EpisodicSubType;
  content: string;
  /** Unix 毫秒。**用户陈述的发生时间**，不是写入时间。 */
  occurredAt: number;
  /**
   * `occurredAt` 是否为推断值（句中无时间线索时退回"现在"）。
   *
   * 必须显式带出去：一条"其实不知道什么时候"的记忆参与指数衰减时，
   * 与一条确知时间的记忆有本质区别，而两者在库里长得一模一样。
   */
  occurredAtInferred: boolean;
  evidence: string;
}

/**
 * 从一轮用户原话里抽取情景候选。
 *
 * 与③一样**只看用户说的**：助手的措辞里全是假设与建议，
 * 拿它当来源等于把系统自己的猜测记成发生过的事。
 */
export function extractEpisodes(userText: string, now: number): EpisodicCandidate[] {
  const out: EpisodicCandidate[] = [];
  const sentences = userText
    .split(/[。！？!?\n；;]/)
    .map((s) => s.trim())
    // 阈值 4：「空调坏了」是一次完整的事件陈述，「坏了」不是——
    // 后者没有主体，记下来之后没人知道是什么坏了。
    .filter((s) => s.length >= 4);

  for (const sentence of sentences) {
    if (INTERROGATIVE.test(sentence)) continue;
    // 长期习惯让给③：同一句话两边都写会让"一次事件"与"一贯如此"混成一团。
    if (HABITUAL.test(sentence)) continue;
    if (!isEvent(sentence)) continue;

    const parsed = parseOccurredAt(sentence, now);
    const subType =
      SUBTYPE_RULES.find((r) => r.re.test(sentence))?.type ?? ("interaction" as EpisodicSubType);

    out.push({
      subType,
      content: sentence,
      occurredAt: parsed ?? now,
      occurredAtInferred: parsed === undefined,
      evidence: sentence,
    });
  }
  return out;
}

/**
 * 事件指纹：用于去重。
 *
 * 同一件事在几轮对话里被反复提到是常态（"那次空调坏了…" "就是上个月那次…"），
 * 每提一次写一条，②会被同一件事灌满，而衰减按条数算——
 * 一件被反复提起的旧事会因为条数多而显得比新事更重要。
 *
 * 按**发生日 + 子类**聚合，不按文本：同一件事的措辞每次都不一样。
 */
export function episodeFingerprint(c: EpisodicCandidate): string {
  const day = Math.floor(c.occurredAt / DAY);
  return `${c.subType}:${day}`;
}
