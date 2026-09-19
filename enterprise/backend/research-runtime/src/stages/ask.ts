/**
 * 「问它」的两跳（施工单 M89-03）：探查跳经 ACP，收口跳直连 `generateObject`。
 *
 * # 与 Challenger 同形，但产出与职责都不一样
 *
 * `stages/challenge.ts` 是"替我们去推翻一张卡"，产出落 `research_challenges`。
 * 本文件是"研究员当面问一句"，产出是一份 `AgentNote`，**一行库都不写**——
 * 它是研究员的草稿（设计稿 §6：洞察卡 / 挑战记录 / 码提案三样才是图在 Agent
 * 返回后写的）。所以这里没有 repo、没有 create，只有两跳与一次引用核对。
 *
 * # 探查跳原样复用 `exploreAcp`，一个参数都不改
 *
 * 那个函数是 Challenger 的回滚路径的一半，改它的签名等于把两条不相干的
 * 演进绑在一起。选哪个 Agent 的 pi 进程**不由它的 `agent` 选项决定**——
 * 决定权在装配层给的那个 streamer（`createAcpStreamer(pool.clientFor(agent), …)`
 * 的 `resolve` 回调），所以每个问答 Agent 各有一条自己的 streamer。
 *
 * # 收口跳只整理，不新增
 *
 * 这一跳**手里没有任何工具**，它读到的全部东西就是探查跳那段文字。
 * 提示词把这件事写死：探查记录里没提到的结论、数字、id 一律不许出现。
 * 不写死的话，模型会拿它自己的常识把一份"没查到"的记录补成一段像样的分析。
 *
 * # 引用核对在代码里，不在提示词里（约束 2）
 *
 * `citedUnitIds` / `citedThemeIds` 与 **tools-endpoint 记下的"本轮工具真的返回过
 * 哪些 id"** 取交集，其余剥掉并在 `caveats` 里说明剥了几条。
 * 靠模型自律的话，编出来的 `unit-0007` 与真实的那一条在界面上长得一模一样，
 * 而研究员会顺着它去查一条不存在的证据。
 */

import { generateObject } from "ai";

import type { ChatStreamer } from "@carlife/acp";
import {
  agentNoteSchema,
  type AgentNote,
  type AskAgentName,
  type SelectionScope,
} from "@carlife/research";

import type { StepState } from "../acp/tools-endpoint";
import { exploreAcp } from "../challenge/acp-transport";
import { usageOf, type ResearchModel, type ResearchUsage } from "../llm";

/**
 * 备好的范围上下文。**由编排器取数**，本文件不认识仓储。
 *
 * `headline` 一句话说清问的是哪一格 / 行 / 卡 / 屏；`facts` 是已知的数字与定义，
 * 一行一条。被抑制的格只给"样本不足"那一句——明细在快照阶段就清空了，
 * 在这里补一个数字等于给 G1 开一道侧门。
 */
export interface AskContext {
  headline: string;
  facts: readonly string[];
}

export interface AskInput {
  agent: AskAgentName;
  scope: SelectionScope;
  contractId: string;
  question: string;
  /** 第几轮（从 1 起）。第 ≥2 轮不重发范围描述——pi 会话里还留着上一轮。 */
  round: number;
  context: AskContext;
}

export interface AskDeps {
  streamer: ChatStreamer;
  /** 这一次提问落在哪个 pi 会话上（`askSessionKey`）。同一范围的追问同键。 */
  sessionKey: string;
  stepsOf: (sessionKey: string) => StepState | undefined;
  /** 本轮工具返回过哪些 id。引用核对的白名单，必须在 `release` 之前读。 */
  seenIdsOf: (sessionKey: string) => ReadonlySet<string> | undefined;
  timeoutMs: number;
  /** 收口跳的模型。探查跳的模型在 pi 那边，由 `.pi/settings.json` 定。 */
  model: ResearchModel;
  recordUsage?: (u: ResearchUsage) => Promise<void> | void;
  /** 登记本轮取数（顺带把上一轮的计步与 id 账归零）。 */
  register: (key: string) => void;
  /** 摘掉本轮取数并销账。**成功与抛错都要调**，否则下一轮会带着上一轮的步数起手。 */
  release: (key: string) => void;
}

export interface AskResult {
  note: AgentNote;
  steps: number;
  hitLimit: boolean;
  /** 被剥掉的引用条数。0 表示模型引的每一条工具都真的返回过。 */
  strippedCitations: number;
}

/** 追问那一轮接在问句前面的一句话。测试逐字断言它，别在别处再写一遍。 */
export const FOLLOW_ON_NOTE = "承接同一范围的上一轮（你手里还留着上一轮查过的东西）。";

/** 剥掉引用时追加进 `caveats` 的那句话。前缀固定，界面按它认这一条。 */
export const CITATION_CAVEAT_PREFIX = "引用核对：";

/** `caveats` 的上界（与 `agentNoteSchema` 同源）。追加那一句不能把笔记撑破 schema。 */
const CAVEATS_MAX = 5;

/**
 * 问一次。
 *
 * 顺序不能改：**登记 → 探查 → 读 id 账 → 收口 → 核对引用 → 摘掉**。
 * 读 id 账必须排在 `release` 之前（`release` 会把那一行销掉），
 * 排在之后拿到的恒是 `undefined`，于是每一条引用都会被剥掉——
 * 而那看起来像"模型总在编引用"。
 */
export async function ask(input: AskInput, deps: AskDeps): Promise<AskResult> {
  const brief = composeAskBrief(input);
  const system = composeAskSystem(input);
  /*
   * 用量归到**被问的那个 Agent**（`research-analyst` / `-taxonomist` / `-archivist`）。
   * `exploreAcp` 的 `usageFrom` 写死 `research-challenger`、收口模型的 `usageOf` 按模型
   * 种类记——两处都是给 Challenger 写的，原样透传会让三个新成员的账全记到别人头上，
   * 而 `llm_usage` 一行都不少、看不出来（M89-05 收口时 SQL 才发现）。
   * 在这里改 `agent` 而不改那两处：它们仍只服务 Challenger，本文件是唯一知道"这次问的是谁"的地方。
   */
  const recordUsage = deps.recordUsage
    ? (u: ResearchUsage) => deps.recordUsage?.({ ...u, agent: `research-${input.agent}` })
    : undefined;

  deps.register(deps.sessionKey);
  try {
    const explored = await exploreAcp(
      { brief, system },
      {
        streamer: deps.streamer,
        sessionKey: deps.sessionKey,
        stepsOf: deps.stepsOf,
        timeoutMs: deps.timeoutMs,
        ...(recordUsage ? { recordUsage } : {}),
      },
    );

    // 在 release 之前读——见函数头。拿不到就是"这一轮工具一条 id 都没返回过"。
    const seenIds = deps.seenIdsOf(deps.sessionKey) ?? new Set<string>();

    const wrapUp = await generateObject({
      model: deps.model.model,
      schema: agentNoteSchema,
      system,
      prompt: wrapUpPrompt(input.question, explored.text, explored.hitLimit),
      temperature: 0,
    });
    await recordUsage?.(
      usageOf(deps.model, wrapUp.usage, wrapUp.providerMetadata as Record<string, unknown> | undefined),
    );

    const { note, stripped } = checkCitations(wrapUp.object, seenIds);
    return { note, steps: explored.steps, hitLimit: explored.hitLimit, strippedCitations: stripped };
  } finally {
    /*
     * 失败路径同样要摘：不摘的话这个键的计步行留着上一轮的步数，
     * 下一轮一上来就可能"步数已用满"，而那时日志里只有一句"用满了"，
     * 看不出它是上一轮花掉的（tools-endpoint 文件头第 4 条）。
     */
    deps.release(deps.sessionKey);
  }
}

/**
 * 发给 pi 的那条 user 消息。
 *
 * 第 1 轮 = 范围描述 + 已知数字 + 问句；第 ≥2 轮 = **只有问句**加一句承接。
 * 第二轮重发范围描述不是"多几行"：pi 会话里已经有那一段，重发等于把同一段
 * 上下文塞进历史两遍，而模型会把它读成"研究员又强调了一遍这一格"。
 */
export function composeAskBrief(input: AskInput): string {
  if (input.round >= 2) {
    return [FOLLOW_ON_NOTE, "", "── 研究员的问题 ──", input.question.trim()].join("\n");
  }
  return [
    "── 这次问的范围 ──",
    input.context.headline,
    "",
    "── 已知的数字与定义 ──",
    ...factLines(input.context),
    "",
    "── 研究员的问题 ──",
    input.question.trim(),
    "",
    "先用你手上的只读工具去查，再回答。答案里逐条写出你引用的 unitId / themeId——" +
      "没查到就说没查到，不要凭印象给一个数字。",
  ].join("\n");
}

/**
 * 两跳共用的 system：**只放范围上下文**。
 *
 * 角色本身的职责说明（"我准备什么 / 我绝不决定什么"）是 pi 进程级的系统提示词
 * （`pi-research/prompts/<agent>.md`，经 `--append-system-prompt` 注入），
 * 在这里再拼一份的话会出现两套口径，而它们分叉时不报错。
 * 与 `stages/challenge.ts` 同口径：acp 那条路上 `system` 只有收口跳读得到。
 */
export function composeAskSystem(input: AskInput): string {
  return [
    `你正在回答研究员针对一个具体范围提的问题（研究合同 ${input.contractId}）。`,
    "",
    "── 这次问的范围 ──",
    input.context.headline,
    "",
    "── 已知的数字与定义 ──",
    ...factLines(input.context),
  ].join("\n");
}

/**
 * 已知数字那几行。
 *
 * **一条都没有时说出来**，不是留白：留白会被模型读成"这一格什么都没有"，
 * 而实际情况是"这一次没给你数字，你自己去查"——两者的下一步动作不同。
 */
function factLines(context: AskContext): string[] {
  if (context.facts.length === 0) return ["- （这一范围上没有已知数字，自己用工具查）"];
  return context.facts.map((f) => `- ${f}`);
}

/** 收口跳的 prompt。**只整理，不新增**——这一跳手里没有任何工具。 */
function wrapUpPrompt(question: string, exploredText: string, hitLimit: boolean): string {
  return [
    `研究员问的是：${question.trim()}`,
    "",
    "下面是你刚才的探查过程记录：",
    exploredText || "（没有产出文字）",
    "",
    "把上面这段整理成一份结构化笔记。**只整理，不新增**：" +
      "探查记录里没提到的结论、数字、证据 id 一律不许出现——你在这一跳手里没有任何工具，" +
      "查不了任何东西，凭印象补上的那一条与查出来的那一条在界面上长得一模一样。",
    "`citedUnitIds` / `citedThemeIds` 只填探查记录里出现过的 id；一条都没有就留空数组。",
    hitLimit
      ? "⚠️ 工具步数已用满或探查超时：没查清楚的写进 `caveats`，**不要当成查过了**。"
      : "没查清楚的写进 `caveats`，不要把没查到说成没有。",
  ].join("\n");
}

/**
 * 引用核对：只留工具真的返回过的 id（约束 2）。
 *
 * 剥掉几条要说出来。不说的话，一份被剥空引用的笔记看起来只是"这次没引用"，
 * 而它其实是"这次引的全是编的"——两者对研究员的下一步动作完全不同。
 */
export function checkCitations(
  raw: AgentNote,
  seenIds: ReadonlySet<string>,
): { note: AgentNote; stripped: number } {
  const citedUnitIds = raw.citedUnitIds.filter((id) => seenIds.has(id));
  const citedThemeIds = raw.citedThemeIds.filter((id) => seenIds.has(id));
  const stripped =
    raw.citedUnitIds.length - citedUnitIds.length + (raw.citedThemeIds.length - citedThemeIds.length);
  if (stripped === 0) return { note: { ...raw, citedUnitIds, citedThemeIds }, stripped };

  /*
   * `caveats` 的上界是 5（schema 定的，冒烟会拿 `agentNoteSchema` 再验一次产出）。
   * 满了就挤掉模型写的最后一条——**核对这一句永远不能是被挤掉的那个**，
   * 它是"这份笔记的引用有问题"的唯一提示。
   */
  const line = `${CITATION_CAVEAT_PREFIX}剥掉 ${stripped} 条工具没返回过的 id`;
  const caveats = [...raw.caveats.slice(0, CAVEATS_MAX - 1), line];
  return { note: { ...raw, citedUnitIds, citedThemeIds, caveats }, stripped };
}
