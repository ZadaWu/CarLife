/**
 * 「走高速还是省道」由 ③偏好决定（施工单 M66-02）。
 *
 * # 为什么是确定性规则，不让模型判断
 *
 * 这一步的输出会直接变成 `map_route` 的 `strategy` 参数——同一个人两次出发走不同的路，
 * 而且没有任何报错，那是最难发现的一类错。规则是纯函数：可以逐条被反例钉死，
 * 回放时能解释"这次为什么走了省道"。
 *
 * # 输入是 ③偏好的陈述，不是一个"画像字段"
 *
 * 本仓没有任何地方存"省钱"这个属性（2026-09-02 全查零命中）。但 ③偏好抽取器
 * （`memory/src/preference-extract.ts`）的 `driving` 域正则已经覆盖「高速 / 国道 / 绕路」，
 * 「我平时都走国道省钱」这类话早就会以 `domain:"driving"` 落进 Mem0——那就是输入。
 *
 * # 默认是高速
 *
 * 没偏好、偏好读不到（`degraded`）、偏好与路无关——三种情况都落 `highway`，
 * 但 reason 不同：卡上要能说出"按你平时省钱的偏好"与"偏好未读到，按默认高速"的区别，
 * 后者是拿默认值盖故障，必须说出来（与偏好页"空结果在降级下不代表没有"同一条纪律）。
 */

import type { NavRouteStrategy } from "@carlife/shared";

export interface PreferenceLike {
  content: string;
  /** ③偏好的领域标签；缺省时也参与判断（老记录没有 domain）。 */
  domain?: string | null;
}

export interface RoutePreferenceDecision {
  strategy: NavRouteStrategy;
  /** 卡上原样显示的一句话。 */
  reason: string;
  /** 命中的那条偏好原文（有则给，供排障与"这条哪来的"）。 */
  evidence?: string;
}

/** 只有这两个领域的偏好与路有关；`cabin`「喜欢 24 度」不该影响走不走高速。 */
const ROUTE_DOMAINS = new Set(["driving", "trip"]);

/** 省钱取向。`不走高速` 也在这里——它同时含「走高速」，必须先于 TIME 判。 */
const COST = /(省钱|少收费|不走高速|避免收费|省道|国道|过路费贵|少上高速|不上高速|省过路费)/;
/** 省钱的否定形态：「我从不省钱走国道」「别给我走国道」。命中即当没说过省钱。 */
const COST_NEGATED = /(从不|绝不|别|不要|不喜欢|没)(省钱|走国道|走省道|省过路费)/;
/** 时间取向。 */
const TIME = /(赶时间|高速优先|走高速|快点到|时间优先|直接上高速|越快越好)/;

export const DEFAULT_ROUTE_REASON = "默认走高速";
export const DEGRADED_ROUTE_REASON = "偏好未读到，按默认高速";

export function routePreferenceFrom(
  prefs: ReadonlyArray<PreferenceLike>,
  opts: { degraded?: boolean } = {},
): RoutePreferenceDecision {
  if (opts.degraded) return { strategy: "highway", reason: DEGRADED_ROUTE_REASON };
  // `listPreferences` 的结果按时间倒序：**先出现的是后写入的**，两类同时存在时取最近说的那一次。
  for (const p of prefs) {
    if (p.domain && !ROUTE_DOMAINS.has(p.domain)) continue;
    const text = (p.content ?? "").trim();
    if (!text) continue;
    if (COST.test(text) && !COST_NEGATED.test(text)) {
      return { strategy: "less_toll", reason: "按你平时省钱的偏好", evidence: text };
    }
    if (TIME.test(text) && !COST.test(text)) {
      return { strategy: "highway", reason: "按你平时赶时间的偏好", evidence: text };
    }
  }
  return { strategy: "highway", reason: DEFAULT_ROUTE_REASON };
}
