/**
 * 问诊轮的「配合请求」提议（施工单 M106-03，F-20-08 / F-20-09）。
 *
 * # 它解决什么
 *
 * 题库的 4 道题对谁都一样。车主拍的是一盏安全带灯、手册又写着「副驾放了重物也会亮」时，
 * 该问的是「副驾座位上放东西了吗」，该给的是「把东西拿走、插舌拔出再插到底」那两步——
 * 这些只有看过**这一次**的观察与手册命中的人提得出来。那是模型的活。
 *
 * # 分工：模型提议，代码裁决
 *
 * 这里只负责把模型的提议**取回来**：拼输入、收文本、定界出 JSON 数组。
 * 每一条合不合规、放不放行、占不占问题位，全在 `prompt-budget.ts`——一处校验，一处裁决。
 * 风险分级不经过这里：它只吃结构化信号（ADR-012）。
 *
 * # 与应答并发，而不是串在它前后
 *
 * 它吃的是 narrator 的同一份输入（求解结果已在里面：手册 RAG、这辆车的数据、【图片观察】），
 * 不吃 narrator 的输出——所以两者可以同时起跑，墙钟不增加。代价是提议与正文出自两次生成，
 * 可能各说各的；压法是同一份输入 + 提示词约束，不是串行。
 *
 * # fail-open
 *
 * 超时、抛错、吐坏，结果都是「模型没提」，预算器照样用题库与补拍两路出卡。
 * 这一跳**不允许**让车主这一轮少拿一个字（与 `resolveElicitation` 那段 try/catch 同一条纪律）。
 */

import { INTERACTION_LIMITS, INTERACTION_OTHER_LABEL, type DiagnosisRiskLevel } from "@carlife/shared";
import type { ChatStreamer, ChatStreamHooks, ChatTurnMessage } from "@carlife/acp";

import { PROMPT_BUDGET } from "./prompt-budget";

/** narrator 收尾之后最多再等这么久。提议与应答同时起跑、又不思考，正常早就回来了；这是给慢的那一次兜底。 */
export function serviceAsksGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SERVICE_ASKS_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 3000;
}

/** 回滚口：`off` 时第三路恒空，行为退回 M106-02。 */
export function serviceAsksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CARLIFE_SERVICE_ASKS ?? "on") !== "off";
}

const L = INTERACTION_LIMITS;

/**
 * 系统提示词。上限数字**全部从 `INTERACTION_LIMITS` 拼进来**，不手抄——
 * 手抄的那份会在有人调常量的那天悄悄过期，而症状只是「模型提的卡莫名其妙被丢」。
 *
 * # 措辞是量出来的，不是想出来的（M107-01）
 *
 * M106 首版跑 16 次离线对照（`scripts/dev/probe/service-asks-prompt-bench.mts`，输入取自真实轮次的轨迹）：
 * **引导只出现 6%，高风险轮 7/8 整轮回 `[]`**。三处病灶各对一处改动：
 *
 * 1. 「风险等级为高时不要提引导」原先是「怎么提」清单的**最后一行**，模型读成了「高 ⇒ 什么都不提」——
 *    `turn-de11b409` 4/4 沉默，而它上文有手册原文「请重新扣紧座椅安全带…移除空座椅上的任何重物」，三步都在。
 *    现在挪进独立的「不提什么」小节，并明写此时**问题和拍照照常提**。
 * 2. 原先只有「上文没有手册依据就不要提引导」这半句禁止，**没有一句召唤**，模型的默认就是不提。
 *    现在给出可判定的触发条件（上文出现车主自己能做的动作就提一张），并列出手册里那几种说法。
 * 3. 首版改完后出现新毛病：模型给**自己编的**步骤挂一个沾边的出处（空调霉味那轮把「吹外循环 5 分钟」
 *    挂到「每年更换空调滤清器」名下，步骤与出处的 3-gram 重合度只有 0~4%）。那比 `source: null` 更糟——
 *    车主会以为这是厂家教他做的。于是加了「`source` 和 steps 必须是同一段」那三行，复量后该样本全部改填 null。
 *
 * 改完 16 次：引导 88%、高风险轮沉默 0/8、挂靠出处 0 条、危险步骤 0 条。数字与判据在 M107-01 验收里。
 * **再改这段话，先跑那个对照台**：它的输入是固定的真实轮次，改一个字就能量出差多少。
 */
export const SERVICE_ASKS_SYSTEM = [
  "你是汽车售后问诊里的「配合请求」提议者。你**不回答车主**——回答由另一位同事同时在写，你看不到他写了什么。",
  "分工：他负责讲清楚「这是什么、为什么会这样」；**凡是要车主动手试一下、或者再看一眼、再拍一张，然后回你一句结果的，都归你**。他不会出这些卡，你不提就没有。",
  "",
  "只输出一个 JSON 数组，不要任何解释、不要 markdown 围栏。每一项是下面五种之一：",
  `1. 单选 {"kind":"single","text":"题干","options":["…"],"allowOther":true|false}`,
  `2. 多选 {"kind":"multi","text":"题干","options":["…"],"allowOther":true|false}`,
  `3. 开放题 {"kind":"open","text":"题干","placeholder":"可选，示例答案"}`,
  `4. 操作引导 {"kind":"guidance","title":"做什么","steps":["…"],"source":"出处"或 null,"outcomes":["…"]}`,
  `5. 拍照 {"kind":"capture","title":"拍什么","hint":"怎么拍"}`,
  "",
  "硬性上限（超了整条作废，不会被截断）：",
  `- options ${L.minOptions}~${L.maxOptions} 个，每个 ≤${L.maxChipChars} 字，不要写「${INTERACTION_OTHER_LABEL}」——需要兜底就把 allowOther 设为 true；`,
  `- steps ${L.minSteps}~${L.maxSteps} 步，每步 ≤${L.maxStepChars} 字；outcomes ${L.minOutcomes}~${L.maxOutcomes} 枚，每枚 ≤${L.maxChipChars} 字，要分得出「好了」和「没好」；`,
  `- text / title ≤${L.maxTitleChars} 字；hint / placeholder ≤${L.maxHintChars} 字；source ≤${L.maxSourceChars} 字。`,
  "",
  "## 先看有没有操作引导可提",
  "**上文（手册、图示、观察）里只要出现了车主自己就能做的动作，就提一张引导**——这是车主最想要的一张卡，别漏。手册里这些说法都算：",
  "「请重新扣紧 / 重新插拔」「请移除…上的重物」「请清洁 / 擦拭」「请关闭后重新打开」「请检查…是否」「请确认…」「点击 控制 > …」。",
  `把它们写成 ${L.minSteps}~${L.maxSteps} 步车主照着做得完的话，\`source\` 填那段的出处（手册 › 章 › 节，或「手册第 N 页」）。`,
  "手册没写、但显然无害的复位动作也可以提，此时 `source` 填 null：把座椅上的东西拿开、把盖子合严、关掉再打开、看一眼屏幕上的读数、等几分钟再看。",
  "",
  "**`source` 和 steps 必须是同一段**：填了出处，就表示这几步是上文那段话说的，你只是换成了车主听得懂的说法——",
  "不能在里面掺上文没提过的动作。想让车主做的事上文没写，就老老实实填 null。",
  "给自己想的步骤挂一个沾边的出处，车主会以为这是厂家教他做的——那不是引用，是骗他。",
  "",
  "「无害」的边界（越界就别提，宁可只提问题）：",
  "- 可以：徒手能做、不用工具、不改变车辆设置、做错了也能立刻恢复原样。",
  "- 不可以：拆装任何部件、举升或钻到车底、碰电瓶电路保险丝、加注或放出任何液体、需要工具或手套、要在行驶中做。",
  "",
  "## 再看要问什么",
  "- **扣住这一次**：题干里要出现这次看到的具体东西（哪盏灯、哪个部位、哪种声音、哪股气味）。对任何车主都能问的泛泛之题不要提。",
  "- 选项能穷尽就封闭（allowOther:false）；穷尽不了才开 allowOther。能点选就不要用开放题。",
  "- 选项写短，四五个字最好；一个选项超出上限，**整道题**都会被丢掉。",
  "- 下面会给出「代码已经会问的题」和「已经问过的」，不要重复它们，换个说法重复也不行。",
  "",
  "## 不提什么",
  "- **风险等级为「高」时不提操作引导**——那时该说的是停驶检查，不是自己动手。**但问题和拍照照常提**：越是要送修，越需要问清楚症状、拍清楚仪表，这些是车主到店前唯一能补上的信息。",
  "- 不下结论：不写「肯定是」「一定是」「没问题」「放心开」这类话。",
  "- 不为了凑数提题：一张卡都不值得提时输出 `[]`。但**不要因为拿不准就整轮什么都不提**——上文有手册依据或有明显要确认的症状时，至少给一张。",
  "",
  `一轮最多 ${PROMPT_BUDGET.guidance} 张引导、${PROMPT_BUDGET.capture} 张拍照、${PROMPT_BUDGET.asks} 道题；超出的部分会被丢弃，所以把最有用的排在前面。`,
].join("\n");

const RISK_ZH: Record<DiagnosisRiskLevel, string> = { low: "低", medium: "中", high: "高" };

export interface ServiceAsksContext {
  /** narrator 的同一份输入（不含图片：观察层的文字段已经在里面）。 */
  answerMessages: readonly ChatTurnMessage[];
  /** 题库这一轮的候选题干——代码会问，模型别重复。 */
  bankTexts: readonly string[];
  /** 这个会话里已经发过的卡的题干 / 标题。 */
  askedTexts: readonly string[];
  riskLevel: DiagnosisRiskLevel;
}

export function buildServiceAsksMessages(ctx: ServiceAsksContext): ChatTurnMessage[] {
  const list = (items: readonly string[]) => (items.length ? items.map((t) => `- ${t}`).join("\n") : "（无）");
  const tail = [
    "【提议任务】",
    `当前风险等级：${RISK_ZH[ctx.riskLevel]}`,
    `代码已经会问的题：\n${list(ctx.bankTexts)}`,
    `已经问过的：\n${list(ctx.askedTexts)}`,
    "按系统提示词的格式输出 JSON 数组。",
  ].join("\n\n");
  return [...ctx.answerMessages, { role: "user", content: tail }];
}

/**
 * 从模型文本里定界出**第一个顶层 JSON 数组**。
 *
 * 只做括号配对（认字符串与转义），不理解内容——条目的校验在预算器。
 * 前后带解释、带 ```json 围栏都取得出来；不是数组、配不上、解析失败一律 `[]`。
 */
export function parseProposals(text: string): unknown[] {
  const start = text.indexOf("[");
  if (start < 0) return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

/** 收完流再解析。抛错由调用方兜（`startProposals`）。 */
export async function collectProposals(streamer: ChatStreamer, messages: ChatTurnMessage[], hooks?: ChatStreamHooks): Promise<{ raw: string; proposals: unknown[] }> {
  let raw = "";
  for await (const chunk of streamer(messages, hooks)) raw += chunk;
  return { raw, proposals: parseProposals(raw) };
}

export interface ProposalsHandle {
  /**
   * narrator 收尾之后调：最多再等 `graceMs`，到点中止那次调用并当作没提。**永不 reject。**
   * `outcome` 进轨迹——「模型没提」与「模型没来得及」要分得开。
   */
  settle(graceMs?: number): Promise<{ proposals: unknown[]; outcome: "ok" | "timeout" | "error" | "off"; raw?: string }>;
}

const OFF: ProposalsHandle = { settle: async () => ({ proposals: [], outcome: "off" }) };

/**
 * 起跑。**在 narrator 流之前调**，返回的句柄在流之后 `settle()`。
 * `proposer` 缺席（fake / 开关 off / 没配 key）⇒ 恒空，不起任何调用。
 */
export function startProposals(proposer: ChatStreamer | undefined, ctx: ServiceAsksContext, hooks: Omit<ChatStreamHooks, "signal" | "agent"> = {}): ProposalsHandle {
  if (!proposer) return OFF;
  const abort = new AbortController();
  type Settled = Awaited<ReturnType<ProposalsHandle["settle"]>>;
  const running: Promise<Settled> = collectProposals(proposer, buildServiceAsksMessages(ctx), { ...hooks, agent: SERVICE_ASKS_AGENT, signal: abort.signal }).then(
    ({ raw, proposals }) => ({ proposals, outcome: "ok" as const, raw }),
    (err: unknown) => {
      console.error(`[service-asks] 提议失败，本轮按没提处理：${err instanceof Error ? err.message : String(err)}`);
      return { proposals: [], outcome: "error" as const };
    },
  );
  return {
    async settle(graceMs = serviceAsksGraceMs()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<Settled>((resolve) => {
        timer = setTimeout(() => resolve({ proposals: [], outcome: "timeout" }), graceMs);
      });
      const result = await Promise.race([running, timeout]);
      clearTimeout(timer);
      // 超时后那次调用还在烧 token：主动中止，别等它自己结束（见 ChatStreamHooks.signal 的说明）。
      if (result.outcome === "timeout") abort.abort();
      return result;
    },
  };
}

/** 用量与轨迹里的名字。`-task` 后缀：产出给代码解析（与 pi 侧的命名约定一致；直连这边档位由 `DIRECT_CALL_SITES` 定）。 */
export const SERVICE_ASKS_AGENT = "service-asks-task";
