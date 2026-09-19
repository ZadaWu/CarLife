/**
 * 「问它」三条能力（C10–C12）的判定与措辞（施工单 M89-04）。纯函数，不画界面。
 *
 * # 三个角色各自「它准备什么 / 它绝不决定什么」逐字来自设计稿 §4
 *
 * 那张表不是装饰：`AgentNote` 的 schema 里根本没有 `verdict` / `level` /
 * 码表改动这些字段，模型**结构上**就越不了权。界面上写出这两句，是为了让
 * 提问的人一眼看出该问谁——问分类学家"这条结论该不该升级"，它会认真答，
 * 而那句答案不作数。
 *
 * # 上界不在这里定，只从后端读
 *
 * `ASK_MAX_ROUNDS` 从 `@carlife/research/agent-note` 引，不抄一份字面量：
 * 抄了之后两边分叉的表现是界面显示"还能问 2 轮"、点下去回 400。
 */

import { ASK_MAX_ROUNDS, agentNoteSchema, type AgentNote } from "@carlife/research/agent-note";

export { ASK_MAX_ROUNDS };
export type { AgentNote };

/**
 * 问句的字数上限。与规则筛的 `MAX_INPUT_CHARS` 同一个值——超了服务端会拒。
 *
 * 与 `MAX_ANGLE_CHARS`（挑战面的追问角度）同值但**不共用常量**：两者管的是
 * 两个端点的两个字段，哪天服务端只放宽其中一个，共用的那份会连带改错另一个。
 */
export const MAX_QUESTION_CHARS = 500;

/** 三条 ask 能力的 `key`。与后端 `ASK_AGENT_OF` 的键逐字相同。 */
export type AskCapabilityKey = "ask-analyst" | "ask-taxonomist" | "ask-archivist";

/** 这条能力是不是「问它」。抽屉按它决定开哪个面板。 */
export const isAskCapability = (key: string): key is AskCapabilityKey => key.startsWith("ask-");

export interface AskRole {
  /** 角色名。用设计稿与能力目录里的中文名，不另起一个"更亲切"的称呼。 */
  name: string;
  /** 它准备什么。 */
  prepares: string;
  /** 它绝不决定什么。**这一句不能省**——它是这个面板存在的前提。 */
  neverDecides: string;
}

/**
 * 三个角色各一行，逐字抄自设计稿 §4 的表。
 *
 * 写成穷举的 `Record` 而不是 `key.replace("ask-", "")` 再查表：后者对拼错的 key
 * 也算得出一个"看起来对"的角色名，而界面会一本正经地把它显示出来。
 */
export const ASK_ROLES: Record<AskCapabilityKey, AskRole> = {
  "ask-analyst": {
    name: "分析师",
    prepares: "命题、解释、主题边界",
    neverDecides: "质量门判定、等级升降",
  },
  "ask-taxonomist": {
    name: "分类学家",
    prepares: "码提案、定义漂移报告、一致率解读",
    neverDecides: "采纳提案、锁版",
  },
  "ask-archivist": {
    name: "档案员",
    prepares: "证据检索、回溯链、脱敏核对",
    neverDecides: "权利与展示边界",
  },
};

/**
 * 这段问句发不发得出去。
 *
 * **前端只拦空与超长两样**，不复制服务端那 9 条注入规则——两份规则表必然漂移，
 * 而漂移的表现是前端放行、服务端拒，或者更糟：前端拒而服务端本来会放行。
 */
export function questionIssue(text: string): string | null {
  const t = text.trim();
  if (!t) return "先写清要问什么";
  if (t.length > MAX_QUESTION_CHARS) {
    return `问题请控制在 ${MAX_QUESTION_CHARS} 字以内（现在 ${t.length} 字）`;
  }
  return null;
}

export interface AskQuota {
  used: number;
  remaining: number;
  /** 还能不能问。到顶了输入框与按钮都要按这个禁用。 */
  can: boolean;
  /** 一句话说清现在是什么状况。到顶时说的是**接下来该做什么**，不是"操作失败"。 */
  note: string;
}

/**
 * 还能问几轮。
 *
 * `round` 是**服务端 202 回的那个数**（第一次问回 1），不是前端自己数的次数：
 * 同一范围的额度按 pi 会话键算，换个浏览器标签接着问仍然共用一份，
 * 前端自己数的话第 6 次点下去才发现已经满了。
 */
export function askQuota(round: number, limit: number = ASK_MAX_ROUNDS): AskQuota {
  const used = Math.max(0, Math.min(round, limit));
  const remaining = Math.max(0, limit - used);
  return {
    used,
    remaining,
    can: remaining > 0,
    note:
      remaining > 0
        ? `还能问 ${remaining} 轮（同一范围最多 ${limit} 轮）`
        : `已问满 ${limit} 轮，换个范围再问`,
  };
}

/** 一次提问的入参。抽出来是为了让"请求体长什么样"只有这一处。 */
export const askExtra = (question: string): { question: string } => ({ question: question.trim() });

/**
 * 把 `done` 帧的产物收成一条 `AgentNote`。
 *
 * 用 `agentNoteSchema` 而不是手写几个 `typeof`：形状的唯一真相源在后端那份
 * schema 里，手写的那份漏一个字段不会报错，只是界面上那一段静默变空。
 * 收不成就回 `null`，由界面如实说"这次没拿到笔记"。
 */
export function noteOf(result: unknown): AgentNote | null {
  if (typeof result !== "object" || result === null) return null;
  const parsed = agentNoteSchema.safeParse((result as { note?: unknown }).note);
  return parsed.success ? parsed.data : null;
}
