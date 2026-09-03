/**
 * ③偏好候选抽取（施工单 M11-02，§7③）。
 *
 * # 为什么抽取放在编排层，不给模型一个写工具
 *
 * 与 §4 "编排决策在图"同源，但这里的理由更硬：③是**慢衰减、不硬删**的那一类。
 * 给 pi 侧一个写工具，模型会把随口一句固化成长期偏好，而那条记忆会跟着用户很久，
 * 且没有任何机制会发现它是错的——它只会让后续回答一直带着一个用户从没说过的前提。
 *
 * 所以抽取是**规则 + 可单测的纯函数**：能被反例钉死，能在回放里解释"这条哪来的"。
 *
 * # 判据：长期倾向，不是一次性陈述
 *
 * 这是本模块唯一真正难的地方。三条必须同时成立：
 *  1. 有**惯常性标记**（"一般/通常/习惯/都是/每次"）或明确的偏好动词（"喜欢/不喜欢/偏好"）；
 *  2. 落在**已知领域**（充电/通勤/驾驶/座舱…）——领域未知说明我们也不知道该怎么用它；
 *  3. **既不是一次性陈述，也不是提问**。
 *
 * 后两条是最容易漏的，而且漏的方式不一样：
 *  - 「今天我想早点走」有偏好动词、有领域，但它只属于今天——
 *    写进③之后，三个月后系统还会以为这个人喜欢早出发。
 *  - 「我平时充电应该充到多少」三道判据全过，而它是个**提问**。
 *    把用户的疑问记成他的习惯，之后系统会一直按一个他从没表达过的偏好回答。
 *    这一条是靠一次探针发现的：原来那条"疑问句不是偏好"的测试是**假绿**——
 *    用例里的"充一次电"不含"充电"这个连续子串，被领域判据挡掉了，
 *    看起来通过，实际上疑问这一路根本没人管。
 */

/** 已知领域。领域未知就不写——我们不知道怎么用的偏好，存了也只是噪声。 */
export const PREFERENCE_DOMAINS = {
  charging: /(充电|快充|慢充|补电|充满|电量)/,
  commute: /(通勤|上下班|上班路上|每天开)/,
  driving: /(开车|驾驶|车速|急加速|高速|市区|国道|绕路)/,
  cabin: /(空调|温度|座椅|音乐|电台|香氛|车内)/,
  trip: /(出行|自驾|长途|休息|服务区|出发时间)/,
  service: /(保养|维修|门店|4S)/,
} as const;

export type PreferenceDomain = keyof typeof PREFERENCE_DOMAINS;

/** 惯常性标记：把"这一次"与"一向如此"分开的关键。 */
const HABITUAL = /(一般|通常|习惯|都是|总是|每次|平时|经常|一直|从来)/;

/** 明确的偏好表达。 */
const PREFERENCE_VERB = /(喜欢|不喜欢|偏好|讨厌|受不了|更愿意|尽量|从不|绝不)/;

/**
 * 疑问。**命中即否决**。
 *
 * 「我平时充电应该充到多少」有惯常性标记、有领域、没有一次性标记——三道判据全过，
 * 而它是一个**提问**，不是一条偏好。把用户的疑问记成他的习惯，
 * 之后系统会一直按一个他从没表达过的偏好来回答。
 *
 * 中文疑问常常不带问号（语音输入尤其如此），所以不能只看标点。
 */
const INTERROGATIVE =
  /(吗|呢|吧|多少|几点|几个|多久|怎么|如何|为什么|为啥|哪个|哪些|是不是|好不好|要不要|该不该|应该)/;

/**
 * 一次性标记。**命中即否决**，优先级高于前两者。
 *
 * 「今天我想早点走」三个条件里前两个都满足，只有这一条能挡住它。
 */
const ONE_OFF = /(今天|今晚|明天|后天|这次|这趟|这回|临时|一次|刚才|现在|等下|马上)/;

export interface PreferenceCandidate {
  domain: PreferenceDomain;
  /** 归一后的偏好陈述（用于写入）。 */
  content: string;
  /** 0–1。**由规则给，不由模型自由填**——模型给的置信度没有可比性。 */
  confidence: number;
  /** 来自哪一句原话。用户要修正时得看到依据（F-21-11）。 */
  evidence: string;
}

/**
 * 低于此置信度不写。
 *
 * ③不硬删，写错的代价远高于漏写——漏了下次还能再学，写错要用户自己去删。
 */
export const MIN_CONFIDENCE = 0.5;

/**
 * 从一轮用户原话里抽取偏好候选。
 *
 * **只看用户说的，不看助手说的**：助手的措辞里全是"你可以…""建议你…"，
 * 拿它当偏好来源等于让系统把自己的建议记成用户的习惯。
 */
export function extractPreferences(userText: string): PreferenceCandidate[] {
  const out: PreferenceCandidate[] = [];
  // 按句切：一段话里可能只有一句是偏好，整段写进去会把无关内容也固化。
  const sentences = userText
    .split(/[。！？!?\n；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);

  for (const sentence of sentences) {
    if (ONE_OFF.test(sentence)) continue; // 一次性陈述，一律不写
    if (INTERROGATIVE.test(sentence)) continue; // 提问不是偏好

    const habitual = HABITUAL.test(sentence);
    const explicit = PREFERENCE_VERB.test(sentence);
    if (!habitual && !explicit) continue;

    const domain = (Object.keys(PREFERENCE_DOMAINS) as PreferenceDomain[]).find((d) =>
      PREFERENCE_DOMAINS[d].test(sentence),
    );
    if (!domain) continue; // 领域未知：不知道怎么用，就别存

    // 两个信号都在 → 0.8；只有一个 → 0.6。都不到 0.5 以下，
    // 因为走到这里已经过了三道判据；阈值留给未来更弱的信号源。
    const confidence = habitual && explicit ? 0.8 : 0.6;
    if (confidence < MIN_CONFIDENCE) continue;

    out.push({ domain, content: sentence, confidence, evidence: sentence });
  }

  // 同一领域一轮内只取最强的一条：一段话里反复提充电不该写出三条偏好。
  const best = new Map<PreferenceDomain, PreferenceCandidate>();
  for (const c of out) {
    const prev = best.get(c.domain);
    if (!prev || c.confidence > prev.confidence) best.set(c.domain, c);
  }
  return [...best.values()];
}
