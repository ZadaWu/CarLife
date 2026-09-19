/**
 * 图标匹配器：目录召回 → 闸门 → 成对核验，**闸门没过时再拿端上的类别名直接核验一次**。
 *
 * # 为什么端上的类别名要参与匹配，而不只是起「疑似」的名字
 *
 * M80-15 把检测器的类别名接进链路时只给了它一条口：目录没对上时顶替召回第一名当「最接近的」。
 * 名字**从不参与检索与核验**。2026-09-18 真机走查（turn-2db10f67）暴露了这条口的代价：
 * 端上 YOLO 明明说了 `parking_lights`，crop 里就是那盏灯，可描述子被劈开的半符号污染、
 * 目录闸门没过，于是整条链的结论退回「疑似」——而手册里那张 `parking_lights.png` 就在手边，
 * 拿 crop 和它做一次成对核验（`VERIFY_PROMPT`，只答 same / different / unsure）本可以直接定案。
 *
 * # 这不是"信检测器"
 *
 * 检测器的名字仍然只是候选：它指向手册里哪一张图，最后说 same 的是核验器，与目录召回那条路
 * 过闸门之后的裁决方式**完全相同**。核验说 different / unsure，结论就还是「疑似」，措辞不变。
 * 所以名字进来了，边界没动：名称与级别仍只来自手册目录，核验仍是唯一的定案方。
 *
 * # 顺序
 *
 * 先走目录那条路（召回 + 闸门 + 核验），过了就以它为准，名字不参与——与 M80-15 一致。
 * 只在**目录闸门没过、且检测器给了名字、且手册里有那张图**时多一次核验；三条缺一就回到原来的「疑似」。
 * 代价是这种情形下多一次视觉模型调用，只发生在本来就要说「疑似」的项上。
 *
 * # 为什么抽成函数
 *
 * 这段原来是 `index.ts` 启动时的一个闭包，依赖都从作用域里拿，没法单测——
 * 上面那条"名字从不参与"的缺口就是这么藏了两天的。现在依赖全部显式传入。
 */

import { semanticsOfRow, type Candidate, type MatchResult } from "@carlife/rag";

import type { IconMatcher } from "./vision";

type IconRow = Parameters<typeof semanticsOfRow>[0];

export interface HintAwareMatcherDeps {
  /** 双路召回（`recallCandidates`）。 */
  recall: (args: { crop: Buffer; descriptor: Parameters<IconMatcher>[0]["descriptor"]; vehicleModel?: string; k: number }) => Promise<{ candidates: Candidate[] }>;
  /** 闸门 + 核验（`decideMatch`）。 */
  decide: (candidates: readonly Candidate[], crop: Buffer) => Promise<MatchResult>;
  /** 按 symbol_id 取目录行；索引里没有这个符号就 null。 */
  getBySymbol: (q: { symbolId: string; vehicleModel?: string }) => Promise<IconRow | null>;
  /** 手册图标图片；取不到 null（容器里没挂 data/ 时就是这样）。 */
  iconImage: (symbolId: string) => Buffer | null;
  /** 成对核验。 */
  verifyPair: (userCrop: Buffer, catalogIcon: Buffer) => Promise<"same" | "different" | "unsure">;
}

export function createHintAwareMatcher(deps: HintAwareMatcherDeps): IconMatcher {
  return async ({ crop, descriptor, vehicleModel, symbolHint }) => {
    const { candidates } = await deps.recall({ crop, descriptor, vehicleModel, k: 8 });
    const decided = await deps.decide(candidates, crop);
    // 目录对上了就以目录为准，名字不参与（M80-15）。
    if (decided.matched || !symbolHint) return decided;

    const row = await deps.getBySymbol({ symbolId: symbolHint, vehicleModel: vehicleModel || undefined });
    // 解析不出语义（索引里没有这个 symbol）就当没给。
    if (!row) return decided;
    const semantics = semanticsOfRow(row);

    // 端上点名了一个符号、手册里有它的图：拿 crop 直接核验一次。
    const icon = deps.iconImage(row.symbolId);
    if (icon) {
      const verdict = await deps.verifyPair(crop, icon);
      if (verdict === "same") {
        return {
          matched: true,
          verified: true,
          semantics,
          sim: decided.sim ?? 0,
          margin: 0,
          evidence: `目录闸门未过（${decided.reason}）· 端上类别 ${symbolHint} 与手册图成对核验 same`,
        };
      }
      // 核验没说 same：结论仍是「疑似」，只是理由更具体。
      return { ...decided, reason: `${decided.reason}; hint_verify_${verdict}`, top: semantics, topSource: "detector" as const };
    }
    return { ...decided, top: semantics, topSource: "detector" as const };
  };
}
