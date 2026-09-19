/**
 * 能力目录（施工单 M85-02）。
 *
 * # 证据矩阵的 AI 入口是一条能力条，不是一个输入框
 *
 * 输入框会收到"帮我分析一下这个数据"，而页面上没有任何东西能回答那句话。
 * 能力条反过来：**先由选中的范围决定这一刻有哪几件事可做**，每一件都
 * 产出一个 typed 对象、都能被挑战、都不改变任何既成事实。
 * 三条缺一不进这张目录。
 *
 * # 为什么这份目录落在纯函数库，而不是前端
 *
 * `capabilitiesFor()` 是 G1 的检出点：**被小单元抑制的格上没有任何能力**。
 * 只放前端的话，后端的能力端点就没有闸门——绕过界面直接 POST 一次就穿了，
 * 而 G1 要防的恰恰是"AI 按钮成为小单元抑制机制的侧门"。
 * 所以前端渲染按钮与后端受理请求**必须调同一个函数**，这里是它唯一的家。
 *
 * # 层标记是耗时契约，不是装饰
 *
 * `🔍 lookup` < 1s 且不调模型、`✎ write` 10–60s、`💬 dialog` 多轮。
 * 界面按这个标记决定"即点即出"还是"弹运行态"；标错层的表现是
 * 点下去之后界面像死了 40 秒。`requiresModel()` 由 tier 唯一决定，
 * 不是另一份可以和它分叉的名单。
 */

import type { EvidenceCell } from "./types";

// ── 兜底桶 ───────────────────────────────────────────────

/**
 * 兜底桶的需求码。定义是「有明确诉求但不属于现有任何一类」。
 *
 * ⚠️ 这个码此刻在仓库里有**三份**字面量：本文件、`lenses/evidence-matrix.ts`、
 * `lenses/trend-signal.ts`。本单的边界禁止改 `research-runtime/**`，所以第三份
 * 先并存；两处镜头改成 import 本常量的去向记在 M85-02 验收文件 §7。
 * 它们分叉的表现是：能力条在兜底桶行上不出现 C8，而页面照常把那一行画成脚行。
 */
export const CATCH_ALL_NEED_PAIN = "other";

// ── 目录本身 ─────────────────────────────────────────────

export type CapabilityId =
  | "c1" | "c2" | "c3" | "c4" | "c5" | "c6"
  | "c7" | "c8" | "c9" | "c10" | "c11" | "c12";

/** 三层。字符串值同时是界面的图标键（`🔍` / `✎` / `💬`）。 */
export type CapabilityTier = "lookup" | "write" | "dialog";

/** 选中范围的**语义**种类。注意不是界面的 `{row, col}` 下标，见 `SelectionScope`。 */
export type SelectionKind = "cell" | "row" | "col" | "card" | "page";

/**
 * 选中范围。
 *
 * **它不是前端的 `MatrixSelection`**：那个是 `{row: 2, col: 0}` 这样的下标，
 * 只在某一次渲染里有意义。下标发到后端的话，后端无从校验"第 2 行是不是被抑制的行"
 * ——它手里的快照可能已经是下一版，行序变了。所以翻译责任在前端：
 * 由它把下标翻成码，后端只认码。
 */
export type SelectionScope =
  | {
      kind: "cell";
      needPainCode: string;
      sceneCode: string;
      /** 这一格是否被小单元抑制。为 true 时 `capabilitiesFor` 返回空数组（G1）。 */
      suppressed: boolean;
      catchAll: boolean;
      /** 这一格有没有方向变化（`direction !== "flat"`）。C3 只在有方向时出现。 */
      hasDirection: boolean;
    }
  | { kind: "row"; needPainCode: string; catchAll: boolean; suppressed: boolean }
  | { kind: "col"; sceneCode: string }
  | { kind: "card"; insightId: string }
  | { kind: "page" };

export interface Capability {
  id: CapabilityId;
  /** 稳定的可读键，进 URL 与端点路径段。 */
  key: string;
  /** 界面上的原文。 */
  title: string;
  tier: CapabilityTier;
  /** 这条能力在哪些范围种类上出现。 */
  scopes: readonly SelectionKind[];
  /** 产出什么 typed 对象——空字符串意味着它还不满足"必须产出 typed 对象"，不该进目录。 */
  produces: string;
  /**
   * 这条能力自己特别要守的硬约束（`G1`–`G4`、`no-model`）。
   * 四条 G 对所有能力都成立；列在这里的是**它最容易违反的那几条**，
   * 也是 `capability-guards.test.ts` 扫描时最该盯的。
   */
  guards: readonly string[];
}

/**
 * 十二条能力（设计稿 §4 九条 + §5「问它」三条）。`title` 用设计稿原文，
 * 不要改写成"更专业"的说法——这一条条就是研发在页面上会读到的句子。
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: "c1",
    key: "summarize-cell",
    title: "归纳这一格",
    tier: "write",
    scopes: ["cell"],
    produces: "InsightCard",
    guards: ["G1", "G2"],
  },
  {
    id: "c2",
    key: "find-counter-evidence",
    title: "找反例",
    tier: "lookup",
    scopes: ["cell", "row"],
    produces: "CounterEvidenceList",
    guards: ["G1"],
  },
  {
    id: "c3",
    key: "system-events",
    title: "这是我们自己干的吗",
    tier: "lookup",
    scopes: ["cell"],
    produces: "SystemEventOverlap",
    guards: ["G1"],
  },
  {
    id: "c4",
    key: "slice-by-segment",
    title: "谁被漏掉了",
    tier: "lookup",
    scopes: ["cell", "row", "col"],
    produces: "SegmentSlice",
    guards: ["G1"],
  },
  {
    id: "c5",
    key: "threshold-sensitivity",
    title: "换个阈值还成立吗",
    tier: "lookup",
    scopes: ["cell", "row"],
    produces: "ThresholdSensitivity",
    guards: ["G1"],
  },
  {
    id: "c6",
    key: "challenge-card",
    title: "挑战这张卡",
    tier: "write",
    scopes: ["card"],
    produces: "ChallengeRecord",
    guards: ["G2"],
  },
  {
    id: "c7",
    key: "follow-up",
    title: "追问",
    tier: "dialog",
    scopes: ["card"],
    produces: "FollowUpThread",
    guards: ["G2"],
  },
  {
    id: "c8",
    key: "propose-code",
    title: "从兜底桶提码",
    tier: "write",
    scopes: ["row", "cell"],
    produces: "CodeProposal",
    guards: ["G1", "G3"],
  },
  {
    id: "c9",
    key: "red-team",
    title: "这一屏的红队清单",
    tier: "lookup",
    scopes: ["page"],
    produces: "RedTeamFinding[]",
    guards: ["no-model"],
  },
  /*
   * ── C10–C12「问它」（施工单 M89-03）──
   *
   * 三条都是 `💬 dialog`：一次提问 = 两跳（探查跳经 ACP 让模型自己循环调只读工具，
   * 收口跳直连 `generateObject(agentNoteSchema)`），同一范围可追问到 `ASK_MAX_ROUNDS`。
   *
   * **三条都不写 `gate`**：G1 由 `capabilitiesFor` 第一行统一挡，在这里再写一遍
   * 只会造出第二处判据——两处分叉时被抑制的格上会冒出一个能问的按钮。
   *
   * 范围为什么是这三套（设计稿 §4 各角色的「我准备什么」）：
   *  - analyst 看数字，格 / 行 / 卡 / 屏都答得上；
   *  - taxonomist 看的是码与主题的边界，那是**行**与**整屏**的事，一格答不了；
   *  - archivist 看的是某几条证据的来源与权利，所以给格 / 行 / 卡，整屏没有对象。
   *
   * **列（`col`）上一条都不放**：列是场景维度，三个角色都没有"按场景"的问法；
   * 放开它等于让模型去横跨全部需求码答一句听起来合理的话（同 C4 在列上的那条 400）。
   */
  {
    id: "c10",
    key: "ask-analyst",
    title: "问分析师",
    tier: "dialog",
    scopes: ["cell", "row", "card", "page"],
    produces: "AgentNote",
    guards: ["G1", "G2"],
  },
  {
    id: "c11",
    key: "ask-taxonomist",
    title: "问分类学家",
    tier: "dialog",
    scopes: ["row", "page"],
    produces: "AgentNote",
    guards: ["G1", "G2", "G3"],
  },
  {
    id: "c12",
    key: "ask-archivist",
    title: "问档案员",
    tier: "dialog",
    scopes: ["cell", "row", "card"],
    produces: "AgentNote",
    guards: ["G1", "G2"],
  },
];

/**
 * 要不要调模型，**只由 tier 决定**。
 *
 * 单独维护一份"要模型的能力"名单会和 tier 分叉，而分叉的表现是界面把一条
 * 40 秒的能力渲染成即点即出：用户点完看到的是一个没有任何反馈的按钮。
 */
export const requiresModel = (c: Capability): boolean => c.tier !== "lookup";

const byId = new Map<CapabilityId, Capability>(CAPABILITIES.map((c) => [c.id, c]));

export const capabilityById = (id: CapabilityId): Capability => {
  const c = byId.get(id);
  if (!c) throw new Error(`未知能力 ${id}`);
  return c;
};

/**
 * 这一刻有哪几件事可做。
 *
 * **G1 在第一行**：被抑制的格与行上一条能力都没有。理由不是"没意思"，
 * 是抑制清空了明细（`suppressCells` 返回的对象里没有 n / N / pct），
 * 于是任何一条能力要么拿不到输入、要么只能去库里重新取一遍——
 * 而后者正是抑制要堵的那个洞。
 */
export function capabilitiesFor(scope: SelectionScope): readonly Capability[] {
  if ((scope.kind === "cell" || scope.kind === "row") && scope.suppressed) return [];

  return CAPABILITIES.filter((c) => {
    if (!c.scopes.includes(scope.kind)) return false;
    // C3 问的是"这次方向变化是不是我们自己干的"——没有方向变化就没有这个问题。
    if (c.id === "c3") return scope.kind === "cell" && scope.hasDirection;
    // C8 只在兜底桶上有意义：提的码是从"归不上现有十个码的那一堆"里提的。
    if (c.id === "c8") {
      return (scope.kind === "row" || scope.kind === "cell") && scope.catchAll;
    }
    return true;
  });
}

/**
 * 把一格快照数据翻成 `SelectionScope`。
 *
 * 放在这里而不是前端，是因为"什么叫有方向"「什么叫兜底桶」这两个判断
 * 前后端必须一致；前端自己判一遍的话，能力条与端点的闸门会对同一格给出不同答案。
 */
export function cellScope(
  needPainCode: string,
  cell: { suppressed?: boolean } & Partial<Pick<EvidenceCell, "scene" | "direction">>,
): SelectionScope {
  return {
    kind: "cell",
    needPainCode,
    sceneCode: cell.scene ?? "",
    suppressed: cell.suppressed === true,
    catchAll: needPainCode === CATCH_ALL_NEED_PAIN,
    hasDirection: cell.direction != null && cell.direction !== "flat",
  };
}
