/**
 * Challenger 的四个只读工具（施工单 M82-06 首版；M88-02 从
 * `research-runtime/src/challenge/tools.ts` 搬入并改成注册项）。
 *
 * # 全部只读，而且这条要能被机械检出
 *
 * 四个 `execute` 里没有 `insert` / `update` / `delete` / `upsert`——
 * `check:arch` 的 `research-tools-ro` 规则扫整个包的源码钉住它，
 * `test/readonly-scan.test.ts` 在单测层再钉一遍（规则不进各包的 test 脚本）。
 *
 * 理由不是洁癖：Challenger 是**唯一一个带工具循环的 Agent**（其余三个都是
 * 一次 `generateObject`）。工具循环意味着模型自己决定调什么、调几次，
 * 而它的任务是"去找反驳自己方的证据"——一个能写的工具在这个位置上，
 * 等于让一个被要求挑刺的模型有权改动被挑的东西。
 *
 * # 每个工具都有上界
 *
 * `limit ≤ 20`、工具步数 ≤ 8。没有上界的只读工具照样能把一次运行拖到超时，
 * 而超时的表现是"这张卡没有挑战记录"——看起来像没找到反例。
 * ⚠️ 上界的**落点**在两条路径上不同：直连路径是 AI SDK 的 `maxSteps`，
 * ACP 路径上 pi 没有这个参数，只能由 tools-endpoint 按 pi 会话计 invoke 次数
 * （M88-04）。所以 `CHALLENGE_MAX_STEPS` 住在工具表里，两条路各自取用同一个数。
 *
 * # 返回里只有派生字段
 *
 * `findCounterEvidence` 回的 `text` 来自 `units.byId(id).textRedacted`——
 * 整个包里不出现 `content` 键。经 ACP 之后这些字节要穿过 pi 的会话 jsonl，
 * 未脱敏原文一旦进去就落在磁盘上，而那一步没有任何提示。
 */

import { z } from "zod";

import type { ResearchToolDeps, ResearchToolRegistration } from "./registry";

/** 单个工具一次最多返回多少条。 */
export const TOOL_LIMIT_MAX = 20;

/** 一次挑战最多几步工具循环。 */
export const CHALLENGE_MAX_STEPS = 8;

/*
 * ── 四个返回形状写成具名类型 ───────────────────────────────
 *
 * 本单的红线是「入参与返回形状逐字不变」，而搬家最容易在返回上出错。
 * 写成具名类型不是为了好看：证据矩阵的四条查类能力**不经模型直调** `execute`
 * （`research-runtime/src/capabilities/lookup.ts`，M85-05），返回少一个字段
 * 或改一个名字，那一侧会当场编译红——这是这条红线唯一的机械检出点。
 */

/** `findCounterEvidence` 的返回。`text` 一律来自 `textRedacted`，没有第三个字段。 */
export interface CounterEvidenceResult {
  count: number;
  units: Array<{ unitId: string; text: string }>;
}

/** `listSystemEvents` 的返回。事件只回三个字段——内部标识不给模型。 */
export interface SystemEventsResult {
  count: number;
  events: Array<{ at: number; kind: string; summary: string }>;
}

/** `sliceBySegment` 的返回。 */
export interface SegmentSlicesResult {
  slices: Array<{ segment: string; n: number; share: number }>;
}

/** `thresholdSensitivity` 的返回。 */
export interface ThresholdSensitivityResult {
  flips: boolean;
  detail: string;
}

const findCounterEvidenceSchema = z.object({
  themeId: z.string(),
  limit: z.number().int().min(1).max(TOOL_LIMIT_MAX).default(10),
});

/** 找反例：这个主题里与主流相反的那些声音。 */
const findCounterEvidence: ResearchToolRegistration<
  z.infer<typeof findCounterEvidenceSchema>,
  CounterEvidenceResult
> = {
  name: "findCounterEvidence",
  description: "取某个主题的反例成员（polarity=counter-example 的证据单元）。只读。",
  schema: findCounterEvidenceSchema,
  agents: ["challenger"],
  promptSnippet: "取某个主题的反例证据单元（只读）",
  promptGuidelines: [
    "`findCounterEvidence` 是四问里「反例在哪」的唯一取数口——" +
      "判决里的 contradicted_by 只能填它回的 unitId，**不要编 id**。",
    "`findCounterEvidence` 一次最多回 20 条；回 0 条就是这个主题没有反例成员，" +
      "如实写进判决，不要换个 themeId 反复试。",
  ],
  execute: async ({ themeId, limit }, deps: ResearchToolDeps) => {
    const { counterUnitIds } = await deps.themeMembers(themeId);
    const picked = counterUnitIds.slice(0, limit);
    const units: Array<{ unitId: string; text: string }> = [];
    for (const id of picked) {
      const row = (await deps.repo.units.byId(id)) as { id: string; textRedacted: string | null } | null;
      if (row?.textRedacted) units.push({ unitId: row.id, text: row.textRedacted });
    }
    return { count: units.length, units };
  },
};

const listSystemEventsSchema = z.object({ from: z.number(), to: z.number() });

/** 我们自己的变更：拐点先归因到它。 */
const listSystemEvents: ResearchToolRegistration<
  z.infer<typeof listSystemEventsSchema>,
  SystemEventsResult
> = {
  name: "listSystemEvents",
  description: "列出某时间窗内我们自己的系统变更（配置 / 护栏策略 / 知识库同步 / 部署）。只读。",
  schema: listSystemEventsSchema,
  agents: ["challenger"],
  promptSnippet: "列出时间窗内我们自己的系统变更（只读）",
  promptGuidelines: [
    "`listSystemEvents` 是四问里「是不是我们自己改的」那一问：" +
      "拐点先归因到我们自己的变更，再考虑用户侧的解释。",
    "`listSystemEvents` 的时间窗用 brief 给的那一对时间戳，不要自己另取一段。",
  ],
  execute: async ({ from, to }, deps: ResearchToolDeps) => {
    const events = await deps.repo.systemEvents.inWindow({ from, to });
    return {
      count: events.length,
      events: events.slice(0, TOOL_LIMIT_MAX).map((e) => ({
        at: e.at,
        kind: e.kind,
        summary: e.summary,
      })),
    };
  },
};

const sliceBySegmentSchema = z.object({ themeId: z.string() });

/** 哪个人群被漏掉了：按分群切一刀看分布。 */
const sliceBySegment: ResearchToolRegistration<
  z.infer<typeof sliceBySegmentSchema>,
  SegmentSlicesResult
> = {
  name: "sliceBySegment",
  description: "把某个主题按行为分群切开，看它是不是只集中在一小撮车上。只读。",
  schema: sliceBySegmentSchema,
  agents: ["challenger"],
  promptSnippet: "把某个主题按行为分群切开看分布（只读）",
  promptGuidelines: [
    "`sliceBySegment` 回的 share 的分母是**该主题命中的车辆数**，不是分群规模——" +
      "「这个群里很多车提到它」与「这个主题集中在这个群」不是一回事。",
    "`sliceBySegment` 里的「未分群」一行不要丢：它大的时候说明这张卡的边界没覆盖住大半的车。",
  ],
  execute: async ({ themeId }, deps: ResearchToolDeps) => ({
    slices: await deps.sliceBySegment(themeId),
  }),
};

const thresholdSensitivitySchema = z.object({
  code: z.string(),
  delta: z.number().min(-0.2).max(0.2),
});

/** 换个阈值翻不翻面。 */
const thresholdSensitivity: ResearchToolRegistration<
  z.infer<typeof thresholdSensitivitySchema>,
  ThresholdSensitivityResult
> = {
  name: "thresholdSensitivity",
  description: "把重要度/表现度阈值挪动 delta，看这个码会不会换象限。只读。",
  schema: thresholdSensitivitySchema,
  agents: ["challenger"],
  promptSnippet: "挪动重要度/表现度阈值看某个码换不换象限（只读）",
  promptGuidelines: [
    "`thresholdSensitivity` 是四问里「换个阈值还成不成立」：`flips=true` 说明这张卡的结论" +
      "依赖一个人为选定的阈值，判决至少是 weakened。",
    "`thresholdSensitivity` 的 delta 限在 ±0.2 内；" +
      "拿不到这个码（不存在或样本不足被抑制）时它会明说，**别把那当成「稳定」**。",
  ],
  execute: async ({ code, delta }, deps: ResearchToolDeps) => deps.thresholdSensitivity(code, delta),
};

/**
 * Challenger 的工具清单，**按工具名索引**。
 *
 * 导出这份带精确类型的 map，是为了让直连垫片
 * （`research-runtime/src/challenge/tools.ts`）能从它**推**出原来那个
 * AI SDK 工具对象的类型：键是工具名、值带各自的入参与返回类型。
 * 不导出的话垫片只能回一个 `Record<string, CoreTool>`，
 * 于是直调 `execute` 的那一侧（`capabilities/lookup.ts`）全面退化成 `any`。
 *
 * 顺序即 `describeForPi` 的顺序，也是提示词里 `Available tools` 节的顺序——
 * 按四问排，别打乱。
 */
export const CHALLENGE_TOOL_MAP = {
  findCounterEvidence,
  listSystemEvents,
  sliceBySegment,
  thresholdSensitivity,
};

/** 同一份东西的数组视图，给注册表用。**真相源是上面那个 map**。 */
export const CHALLENGE_TOOLS: readonly ResearchToolRegistration[] =
  Object.values(CHALLENGE_TOOL_MAP);
