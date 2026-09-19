/**
 * 「问它」三条能力（C10–C12）的产出形状与会话键（施工单 M89-03）。
 *
 * # 「它绝不决定什么」落成 schema，不落成提示词
 *
 * 设计稿 §4 给三个角色各写了一栏「我绝不决定」：analyst 不出等级、
 * taxonomist 不改码表、archivist 不定展示边界。提示词里写一遍是**请求**，
 * 而模型一旦越权，产出仍然是一段读起来很像结论的文字，没人看得出它越了权。
 * 落成 schema 就变成**结构上办不到**：`AgentNote` 里根本没有 `verdict` /
 * `level` / `recommendation` 这些字段，模型想填也没有地方填。
 *
 * 所以这个 schema 是 `.strict()` 的：模型多吐一个键时 `generateObject` 直接失败、
 * 能力 `fail`，**不静默剥掉**。剥掉的话越权那一次看起来和正常那一次一模一样，
 * 而我们恰恰想知道它什么时候试图越权。
 *
 * # 会话键为什么带上 contractId
 *
 * 同一格坐标（需求码 × 场景）在两个研究合同上是两段窗口、两批数据。
 * 键里不带合同的话，第二个合同上的追问会落进第一个合同的 pi 会话，
 * 模型带着另一段窗口的上下文继续答——两边的数字都对，只是不在同一个窗上。
 *
 * # 这个文件为什么在纯函数库里
 *
 * 前端要按 `AgentNote` 渲染、服务端要按它收口，两边必须是同一份形状；
 * 轮数上界也一样（界面显示"还剩几轮"、端点按它拒收）。
 * 两份字面量分叉的表现是界面显示还能问、点下去回 400。
 */

import { z } from "zod";

import type { SelectionScope } from "./capabilities";

/**
 * 同一范围最多问几轮。设计稿 §11 P4 已定，不是可配置项。
 *
 * 与 `FOLLOW_UP_MAX_ROUNDS`（3，同一张卡的追问）是**两笔账**：那条管的是
 * 挑战记录，这条管的是笔记。共用一个常量的话，调其中一个会连带改另一个的语义。
 */
export const ASK_MAX_ROUNDS = 5;

/**
 * 一次提问的产出。
 *
 * `citedUnitIds` / `citedThemeIds` 不是装饰：服务端收口后会拿它们与
 * **工具真的返回过的 id 集合**取交集，不在集合里的剥掉（施工单 M89-03 约束 2）。
 * 引用不靠模型自律——它编一个 `unit-0007` 出来时，那一条读起来和真的一模一样。
 */
export const agentNoteSchema = z
  .object({
    /** 正文。空的笔记等于没答，所以 `.min(1)`。 */
    answer: z.string().min(1),
    /** 引用到的证据单元 id。 */
    citedUnitIds: z.array(z.string()).max(20),
    /** 引用到的主题 id。 */
    citedThemeIds: z.array(z.string()).max(10),
    /** 保留意见：哪些没查清、哪些数字不该这么读。 */
    caveats: z.array(z.string()).max(5),
    /** 建议接着问什么。研究员照着点一下就是下一轮。 */
    nextQuestions: z.array(z.string()).max(3),
  })
  .strict();

export type AgentNote = z.infer<typeof agentNoteSchema>;

/** 三条 ask 能力的 `key`。与 `CAPABILITIES` 里的 c10 / c11 / c12 逐字对应。 */
export type AskCapabilityKey = "ask-analyst" | "ask-taxonomist" | "ask-archivist";

/** 三个问答 Agent 的规范名。与 `@carlife/research-tools` 的 ACL 值域同名。 */
export type AskAgentName = "analyst" | "taxonomist" | "archivist";

/**
 * 能力 key → 问谁。
 *
 * 写成表而不是 `key.replace("ask-", "")`：后者对任何拼错的 key 都算得出一个
 * "看起来对"的 Agent 名，而那个名字会一路传到 pi 进程池里去 spawn 一个进程。
 */
export const ASK_AGENT_OF: Record<AskCapabilityKey, AskAgentName> = {
  "ask-analyst": "analyst",
  "ask-taxonomist": "taxonomist",
  "ask-archivist": "archivist",
};

/**
 * 范围的稳定字符串形式。
 *
 * ⚠️ **格上不带镜头名**：`SelectionScope` 的 `cell` 里没有 `lens`
 * （它是 M85-02 定下的形状，本单红线之一是不动它）。今天证据矩阵是唯一
 * 会出能力条的镜头，所以不带它不会串键；将来别的镜头也出能力条时，
 * 要先给 `SelectionScope` 加维度，再回来改这里——两件事一起做，不要只改这里。
 */
export function askScopeKey(scope: SelectionScope): string {
  switch (scope.kind) {
    case "cell":
      return `cell:${scope.needPainCode}:${scope.sceneCode}`;
    case "row":
      return `row:${scope.needPainCode}`;
    case "col":
      return `col:${scope.sceneCode}`;
    case "card":
      return `card:${scope.insightId}`;
    default:
      return "page";
  }
}

/**
 * 一次提问落在哪个 pi 会话上。
 *
 * **同一范围的追问必须同键**：池按 `carlifeSessionId` 复用 pi 会话，同键意味着
 * 第二轮不必重发 brief，模型带着上一轮查过的东西继续查（设计稿 §11 P4）。
 * 键里少任何一段的后果都不报错：少 agent 就是三个角色共用一个会话、
 * 少 contractId 就是拿另一段窗口的上下文答这次的问题。
 */
export function askSessionKey(
  agent: AskAgentName,
  scope: SelectionScope,
  contractId: string,
): string {
  return `ask:${agent}:${askScopeKey(scope)}:${contractId}`;
}
