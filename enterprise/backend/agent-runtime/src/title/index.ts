/**
 * 会话标题旁路（施工单 M28-01）。
 *
 * # 它是什么
 *
 * 一次性的、脱离主图的小调用：首轮对话收口之后，拿「车主问了什么 + 助手答了什么」
 * 生成一个不超过 15 字的名字，写进 `sessions.title`，再经 SSE 推给端上。
 * 一个会话**只生成一次**，之后再也不算。
 *
 * # 为什么不是 LangGraph 里的一个节点，也不是第六个子 Agent
 *
 * 标题对这轮对话的**结果没有任何影响**——它不进图状态、不影响路由、不参与应答。
 * 挂进主图意味着每一轮都要判一次"该不该生成"，还要承担"这一跳失败会不会拖垮这一轮"。
 * 而它真正的约束恰恰相反：**失败必须无声**，车主不该因为标题没起出来而少收到一个字。
 *
 * 同理它也不走 pi/ACP：那条路要起子进程、装工具表、可能还在思考。给一个 15 字的
 * 名字花那些钱和时间是错的档位——`ownership-task` 思考 49.5 秒一个工具没调那次
 * 就是这个错的极端形态。这里钉死非推理模型直连。
 *
 * # 为什么不放在 `sidecar/`
 *
 * `check:arch` 的 `sidecar-isolation` 禁止 `sidecar/` import `../llm`，
 * 而那条边界守的是"等待期旁路够不着业务能力"。标题旁路不属于那个语境
 * （它不在等待期说话、也不面向车主），塞进去只会为了蹭一个名字去破那条边界。
 *
 * # 兜底是截断首句，不是编一个
 *
 * 模型不可用（离线 / `CARLIFE_LLM=fake` / 超时 / 抛错）时回落到"车主首句截断"。
 * 那是一句**如实转述**，与旁路 L0「匹配不到就返回 undefined」不冲突——
 * 后者禁的是说一句用户无法证伪的话，而"把你自己说过的话截一段"没有这个问题。
 */

import { resolveDeepSeekModel } from "@carlife/shared";

import { createConfiguredChatStreamer } from "../llm";

/** 标题长度上限（字符数，按码位算）。 */
export const TITLE_MAX_CHARS = 15;

/**
 * 单次生成的墙钟上限。
 *
 * 8 秒不是性能目标是**放弃线**：标题晚到不影响任何事（下次拉列表照样能补），
 * 但挂着的请求会占住网关那一侧的一个 fire-and-forget 任务。
 * 超时就用兜底，不重试——重试只会把一次迟到变成两次。
 */
const TITLE_TIMEOUT_MS = 8000;

/**
 * 人设。三条都是有代价的：
 *
 * 1. **只输出标题本身**——模型的默认冲动是写「好的，这段对话的标题是：……」。
 * 2. **不要标点、不要引号**——它极爱给标题套上「」或以句号收尾，而那两样
 *    在一个 15 字的列表项里就是纯粹的噪音。`sanitizeTitle` 还会再兜一道，
 *    但提示词先说清楚能少掉大半。
 * 3. **说这段对话在谈什么，不复述结论**——「杭州行程规划」是标题，
 *    「明天杭州多云适合出行」是一句被压扁的回答。列表里要的是前者。
 */
export const TITLE_SYSTEM = [
  "你在给一段车载助手与车主的对话起标题。",
  `只输出标题本身，不超过 ${TITLE_MAX_CHARS} 个汉字。`,
  "不要输出引号、书名号、句号或任何解释性文字，不要写「标题：」。",
  "标题说的是这段对话在谈什么事，不是复述助手给出的结论。",
  "用中文名词短语，例如：杭州周末行程、保养周期确认、充电桩找不到。",
].join("\n");

/** 按码位截断（中文与 emoji 都不会被切成半个字）。 */
function cut(text: string, max: number): string {
  const cp = Array.from(text);
  return cp.length <= max ? text : cp.slice(0, max).join("");
}

/**
 * 把模型吐出来的一坨收拾成能直接显示的标题。
 *
 * **纯函数，可单测**——这是本模块里最容易错的一段：模型的花样（前缀、引号、
 * 换行后再补一段解释、markdown 加粗）没法靠提示词穷举，只能在这里逐一削掉。
 * 收拾不出东西时返回 `undefined`，由调用方回落兜底，**不返回空字符串**：
 * 空标题写进库之后，"生成过了"与"没生成"就再也分不开了。
 */
export function sanitizeTitle(raw: string): string | undefined {
  // 只取第一行：模型常常"标题 + 换行 + 为什么这么起"。
  let t = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  t = t.replace(/[*`#]/g, "").trim();
  // 「标题：」「Title:」这类前缀
  t = t.replace(/^(标题|题目|title)\s*[:：]\s*/i, "");
  // 成对包裹符（可能套好几层）
  for (let i = 0; i < 3; i += 1) {
    const stripped = t.replace(/^[「『"'“”‘’《〈【\[(（]+/, "").replace(/[」』"'“”‘’》〉】\])）]+$/, "").trim();
    if (stripped === t) break;
    t = stripped;
  }
  // 结尾标点
  t = t.replace(/[。．.!！?？,，、;；:：~～]+$/, "").trim();
  if (t.length === 0) return undefined;
  return cut(t, TITLE_MAX_CHARS);
}

/**
 * 兜底：把车主首句截成标题。
 *
 * 截断时留一个省略号并**把总长仍压在 15 以内**（14 + 1）——不留的话
 * 「帮我看看明天去杭州的路上会」读起来像是标题本身出了问题，而不是被截短了。
 */
export function fallbackTitle(firstUserText: string): string | undefined {
  const t = firstUserText.replace(/\s+/g, " ").trim();
  if (t.length === 0) return undefined;
  const cp = Array.from(t);
  return cp.length <= TITLE_MAX_CHARS ? t : `${cut(t, TITLE_MAX_CHARS - 1)}…`;
}

export interface TitleInput {
  /** 归账用（成本口径）：这次调用烧的 token 记到哪个会话名下。 */
  sessionId: string;
  /** 首轮的轮次 id，同样是归账用。 */
  turnId: string;
  /** 车主首句原文。 */
  userText: string;
  /** 助手首轮回答全文；被撤回或为空时传空串。 */
  assistantText: string;
}

/** 生成一个标题。**永远给得出结果**（模型不行就回落截断），除非首句本身是空的。 */
export type TitleWriter = (input: TitleInput) => Promise<string | undefined>;

/**
 * 造一个标题生成器。
 *
 * 与 `createFillerWriter` 的区别：那个在离线路径下返回 `undefined`（旁路整条关掉），
 * 这个**任何情况下都返回一个可用的 writer**——因为标题的兜底本身就是完整可用的，
 * 而"离线时列表里全是没名字的会话"是一个看起来像坏了的状态。
 */
export function createTitleWriter(
  config: Parameters<typeof createConfiguredChatStreamer>[0],
  /** 用量出口（与主链路同一个计价闭包）。**标题也烧钱**，缺省不记（单测/离线）。 */
  recordUsage?: (sample: {
    sessionId: string;
    turnId: string;
    agent: string;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    durationMs: number;
    status: "ok" | "failed";
  }) => void,
): TitleWriter {
  // 离线路径直接不建 streamer：Fake 模型吐的是固定 tag（"【fake】第1轮回复…"），
  // 拿它当标题比截断首句还糟——**看起来像真的生成过**。
  const offline = process.env.CARLIFE_LLM === "fake";
  const streamer = offline
    ? undefined
    : createConfiguredChatStreamer(config, {
        system: TITLE_SYSTEM,
        // 钉死非推理模型，**不跟 `DEEPSEEK_MODEL` 走**——同 NARRATOR / 导游那条理由：
        // 有人把主链路调成推理模型，起个名字也要想十几秒。
        model: resolveDeepSeekModel(process.env.CARLIFE_TITLE_MODEL),
      });

  return async (input) => {
    const fallback = fallbackTitle(input.userText);
    if (!streamer) return fallback;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
    try {
      // 输入两端都截断：一轮长问答几千字全塞进去，标题质量不会更好，钱却是照付的。
      const prompt = [
        `车主：${cut(input.userText, 200)}`,
        input.assistantText.trim().length > 0 ? `助手：${cut(input.assistantText, 300)}` : "",
        "",
        "给这段对话起标题：",
      ]
        .filter((l) => l.length > 0 || l === "")
        .join("\n");

      let text = "";
      for await (const chunk of streamer([{ role: "user", content: prompt }], {
        // `agent` 让它在轨迹与成本表里与主链路分得开——混在一起会把
        // `llm.*.ttft` 的分位数拉花，而那组分位数是别处的判据。
        agent: "title",
        signal: controller.signal,
        ...(recordUsage
          ? {
              onUsage: (s) =>
                recordUsage({
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  agent: "title",
                  provider: s.provider,
                  model: s.model,
                  promptTokens: s.promptTokens,
                  completionTokens: s.completionTokens,
                  ...(s.cacheHitTokens !== undefined ? { cacheHitTokens: s.cacheHitTokens } : {}),
                  ...(s.cacheMissTokens !== undefined
                    ? { cacheMissTokens: s.cacheMissTokens }
                    : {}),
                  durationMs: s.durationMs,
                  status: s.status,
                }),
            }
          : {}),
      })) {
        text += chunk;
        // 早就超了就别把整段流收完——后面全是要被削掉的解释。
        if (text.length > 120) break;
      }
      return sanitizeTitle(text) ?? fallback;
    } catch {
      // 抛错、超时、被 abort 都走这里。**不重试**，回落兜底。
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  };
}
