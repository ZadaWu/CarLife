/**
 * 结构化汇聚：约束求解，不是文本拼接（施工单 M5-01，FL-13 F-13-02）。
 *
 * # 这是本 Sprint 最容易做浅的地方
 *
 * 最省事的实现是"把两段文字丢给 LLM 让它总结一下"。那样做的后果不是报错，
 * 是**"老人单段不超过 2 小时"被稀释成一句"建议适当休息"**——
 * 方案读起来完全正常，只有真的带着老人上路才发现问题（US-11 / F-18-07）。
 *
 * 因此本模块的硬性要求：
 *  1. 子 Agent 的返回**必须含结构化字段**（分段时长数组、续航余量数值），不能只有自然语言；
 *  2. 约束求解在**代码里**做，LLM 只负责把求解结果表述出来。
 *
 * 求解结果里带 `violations`——**汇聚不隐藏矛盾**（F-13-05）。解不开就显式呈现权衡，
 * 而不是挑一个看起来顺眼的方案交付。
 */

/**
 * `solve` 拆段时补出来的停靠点占位——**它代表"这里需要停一次，但没人给得出名字"**。
 *
 * 导出是为了让下游（`describeMerged`）能把它和真名字区分开。混在一起交给 LLM 的话，
 * 车主会听到"停靠点：待定停靠点"；而它真正该听到的是"这一处还没有具体名称"。
 */
export const PENDING_STOP = "待定停靠点";

/** 出行方案的结构化骨架。字段刻意少而硬——多了会诱使 Agent 用自然语言塞进来。 */
export interface TripDraft {
  /** 行车分段，单位分钟。**这是硬约束求解的对象**，不是描述性文字。 */
  legMinutes: number[];
  /** 停靠点名称，与 `legMinutes` 的间隔一一对应（长度 = legMinutes.length - 1）。 */
  stops: string[];
  /** 续航评估给出的余量百分比；缺失表示该分支未成功。 */
  rangeMarginPct?: number;
  /**
   * 补能点（充电或加油），**与 `stops` 分开**。
   *
   * 不能并进 `stops`：那个数组与 `legMinutes` 的间隔一一对应（长度差 1），
   * 混入补能点会当场破坏这个对应关系，而 `solve` 的拆段逻辑正建立在它之上。
   * 补能点是"路过哪儿能补能"，休息停靠点是"开多久该歇一次"——两回事。
   */
  energyStops?: string[];
  /**
   * 分支用工具查到的、车主问到但上面几个字段装不下的事实。
   *
   * # 为什么必须有这么一个"非结构化"的口子
   *
   * 此前汇聚只抠这几个硬字段，**分支的散文一律丢弃**。于是实测 turn-d454d12b：
   * 车主问"帮我找一天不下雨的我们回去"，意图抽得很准（goal 里明写"挑选一天不下雨的
   * 日期"、constraints 有"当天不下雨"），这段也完整发给了 `trip-task`——
   * 它多半查了天气也答了，但那句话不在 JSON 里，于是在这里被扔掉。
   * 应答节点拿到的求解结果里一个字都没有，只好自己再调 5 次 `weather`、
   * 再想 10 秒，把已经查过的东西重查一遍。**17.7 秒的应答里大半是在补这个窟窿。**
   *
   * 所以它不是"把自然语言放回汇聚"——F-13-02 守的是**硬约束求解**
   * （`legMinutes` 的拆分仍然在 `solve` 里以代码完成）。这里装的是**事实转述**，
   * 是分支已经用工具查到、却没有字段可放的那部分。
   *
   * 提示词里对它有一条硬要求：**只写用工具查到的**。没查过就不写——
   * 编一条"我查了天气"比不写严重得多（实测直连模型在缺这条约束时必编）。
   */
  findings?: string[];
}

/** 从意图四要素里解析出的可求解硬约束。 */
export interface SolvableConstraints {
  /** 单段行车时长上限（分钟）。同行老人/儿童时存在。 */
  maxLegMinutes?: number;
  /** 续航余量下限（百分比）。 */
  minRangeMarginPct?: number;
}

export interface MergeResult {
  draft: TripDraft;
  /** 未被满足的约束——**显式呈现，不隐藏**（F-13-05）。 */
  violations: string[];
  /** 因分支失败而缺失的信息，需在交付时标注（F-13-04）。 */
  missing: string[];
  /** 是否所有硬约束都满足。 */
  satisfied: boolean;
}

/**
 * 求解结果里"缺失信息"一节的固定标头（M37-02）。
 *
 * trip 与 itinerary 的 describe* 都用它开头；`failure-followup` 按它判断
 * "本轮有没有缺失"来决定要不要追加主动询问。**必须经本常量引用**——
 * 三处各写一份字面量的话，改一处漏两处，症状是失败轮突然不再追问，零报错。
 */
export const MISSING_SECTION_HEADER = "缺失的信息（必须标注，不要假装有）：";

/**
 * 从中文约束文本里抽出"单段不超过 N 小时/分钟"。
 *
 * 放在代码里而不是让模型解析：这条数值一旦被模型"理解"成描述性文字，
 * 后面的求解就无从谈起。宁可正则漏抽（漏了会体现在 violations 为空 + 无上限），
 * 也不要让它变成一个模糊的语义。
 */
export function extractConstraints(constraints: readonly string[]): SolvableConstraints {
  const out: SolvableConstraints = {};
  for (const c of constraints) {
    const hour = /(?:单段|连续|一次)[^0-9]{0,6}(\d+(?:\.\d+)?)\s*(?:个)?小时/.exec(c);
    if (hour) out.maxLegMinutes = Math.min(out.maxLegMinutes ?? Infinity, Number(hour[1]) * 60);
    const minute = /(?:单段|连续|一次)[^0-9]{0,6}(\d+)\s*分钟/.exec(c);
    if (minute) out.maxLegMinutes = Math.min(out.maxLegMinutes ?? Infinity, Number(minute[1]));
    const margin = /续航[^0-9]{0,8}(\d+)\s*%/.exec(c);
    if (margin) out.minRangeMarginPct = Math.max(out.minRangeMarginPct ?? 0, Number(margin[1]));
  }
  if (out.maxLegMinutes === Infinity) delete out.maxLegMinutes;
  return out;
}

/**
 * 求解：把超限的行车分段**强制拆分**，而不是在文案里提一句"建议休息"。
 *
 * 拆分是真的改数据结构——下游拿到的 `legMinutes` 每一项都 ≤ 上限，
 * 因此"输出方案的单段时长 ≤ 约束上限"这条断言（F-18-07）能自动化验证。
 */
export function solve(draft: TripDraft, c: SolvableConstraints): MergeResult {
  const violations: string[] = [];
  let legs = [...draft.legMinutes];
  const stops = [...draft.stops];

  if (c.maxLegMinutes !== undefined && c.maxLegMinutes > 0) {
    const limit = c.maxLegMinutes;
    const split: number[] = [];
    for (const leg of legs) {
      if (leg <= limit) {
        split.push(leg);
        continue;
      }
      // 均分成 ceil(leg/limit) 段，保证每段都不超限且总时长不变。
      const parts = Math.ceil(leg / limit);
      const each = leg / parts;
      for (let i = 0; i < parts; i += 1) split.push(each);
      // 拆出来的每个新间隔都需要一个停靠点；名称待路线数据填充。
      for (let i = 0; i < parts - 1; i += 1) stops.push(PENDING_STOP);
    }
    legs = split;
  }

  if (c.minRangeMarginPct !== undefined) {
    if (draft.rangeMarginPct === undefined) {
      violations.push(`续航余量未知，无法确认是否满足 ≥${c.minRangeMarginPct}% 的要求`);
    } else if (draft.rangeMarginPct < c.minRangeMarginPct) {
      violations.push(
        `续航余量 ${draft.rangeMarginPct}% 低于要求的 ${c.minRangeMarginPct}%——需增加充电停靠或改路线`,
      );
    }
  }

  return {
    draft: {
      legMinutes: legs,
      stops,
      rangeMarginPct: draft.rangeMarginPct,
      energyStops: draft.energyStops,
      // 逐字段重建而不是展开 draft：加字段时**必须回来这里**，
      // 漏一个的表现是它在 `solve` 之后凭空消失，而上下游都看不出哪一步丢的。
      findings: draft.findings,
    },
    violations,
    missing: [],
    satisfied: violations.length === 0,
  };
}

/**
 * 从分支的自然语言输出里抽出结构化字段。
 *
 * 抽不到时**不猜**——记入 `missing` 并让下游降级标注（F-13-04），
 * 而不是编一个看起来合理的数字。
 */
export function parseTripDraft(text: string): Partial<TripDraft> {
  const out: Partial<TripDraft> = {};
  const json = /\{[\s\S]*\}/.exec(text);
  if (json) {
    try {
      const o = JSON.parse(json[0]) as Record<string, unknown>;
      if (Array.isArray(o.legMinutes) && o.legMinutes.every((x) => typeof x === "number")) {
        out.legMinutes = o.legMinutes as number[];
      }
      if (Array.isArray(o.stops)) {
        out.stops = (o.stops as unknown[]).filter((x): x is string => typeof x === "string");
      }
      if (Array.isArray(o.energyStops)) {
        out.energyStops = (o.energyStops as unknown[]).filter(
          (x): x is string => typeof x === "string",
        );
      }
      if (Array.isArray(o.findings)) {
        out.findings = (o.findings as unknown[]).filter(
          // 空串要滤掉：模型交一个 `[""]` 时，下游"有没有查到"的判断会变成 true，
          // 而它其实什么也没说——这正是 `unmetAsks` 最不该被骗过去的地方。
          (x): x is string => typeof x === "string" && x.trim().length > 0,
        );
      }
      if (typeof o.rangeMarginPct === "number") out.rangeMarginPct = o.rangeMarginPct;
    } catch {
      /* 抽不到就是抽不到 */
    }
  }
  return out;
}

/** 把分支结果合成一份方案。失败分支体现在 `missing`，不静默吞掉。 */
export function mergeBranches(
  branches: readonly { agent: string; status: string; text: string }[],
  constraints: readonly string[],
): MergeResult {
  const draft: TripDraft = { legMinutes: [], stops: [] };
  const missing: string[] = [];

  for (const b of branches) {
    if (b.status !== "ok") {
      missing.push(`${b.agent} 分支${b.status === "timeout" ? "超时" : "失败"}`);
      continue;
    }
    const parsed = parseTripDraft(b.text);
    if (parsed.legMinutes) draft.legMinutes = parsed.legMinutes;
    if (parsed.stops) draft.stops = parsed.stops;
    if (parsed.energyStops) draft.energyStops = parsed.energyStops;
    if (parsed.rangeMarginPct !== undefined) draft.rangeMarginPct = parsed.rangeMarginPct;
    // findings **追加不覆盖**：两条分支查的是不同的东西（行程侧查天气/路线，
    // 补能侧查加油站），后一条覆盖前一条就等于随机丢掉半边。
    // 其余字段是覆盖语义，因为它们按任务分给了唯一一条分支（见 trip.ts 的字段清单）。
    if (parsed.findings?.length) draft.findings = [...(draft.findings ?? []), ...parsed.findings];
    // 下面这条判定**刻意不算 findings**：只交出 findings、没给分段时长的分支，
    // 主业仍然没干成。把它算进去会让"分支返回了东西"掩盖"分支没干活"。
    if (
      !parsed.legMinutes &&
      !parsed.stops &&
      !parsed.energyStops &&
      parsed.rangeMarginPct === undefined
    ) {
      missing.push(`${b.agent} 分支未返回结构化字段`);
    }
  }

  const result = solve(draft, extractConstraints(constraints));
  return { ...result, missing, satisfied: result.satisfied && missing.length === 0 };
}
