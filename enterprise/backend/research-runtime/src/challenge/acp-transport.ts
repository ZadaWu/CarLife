/**
 * Challenger 探查那一跳的两条 transport（施工单 M88-05，ACR-038 步 5）。
 *
 * # 只有探查跳换了跑法，收口跳一字不动
 *
 * `challenger.ts` 是两段式：先带只读工具查（本文件），再 `generateObject(challengeSchema)`
 * 收口（不在本文件里，也不许因为本文件而改）。两条路径给收口跳的东西形状相同——
 * `{ text, steps, hitLimit }`——所以切开关不改判定口径、不改表、不改任何端点。
 *
 * # 两条路径的 system / user 拼法**不逐字相同**，这是刻意接受的
 *
 * | | direct | acp |
 * |---|---|---|
 * | 判定口径（四问） | `composeSystem()` 拼进 `system` 参数 | pi 进程启动时经 `--append-system-prompt` 注入（`bin/pi-approved.sh`，进程级） |
 * | 追问角度 | 同样拼进 `system`（`composeSystem` 的追加段） | 进**本轮 user 消息的第一段**，标题用同一个 `EXTRA_ANGLE_HEADING` |
 * | brief | `prompt` 参数 | user 消息，接在角度段后面 |
 *
 * 角度在 acp 下不能走 system：那份系统提示词是**按进程**拼死的，一个 pi 进程
 * 先后服务很多次挑战，往里塞这一次的角度等于塞给了后面所有次。
 * 两段文字的内容与顺序仍然一致（口径在前、角度在后、brief 最后），差的只是
 * "哪一段算 system"。判定口径本身两条路读的是**同一个文件**
 * （`pi-research/prompts/challenger.md`，见 `index.ts` 的装配）。
 *
 * # `temperature: 0` 在 acp 下没有对应物
 *
 * pi 不暴露 temperature。接受（ACR-038 兼容节已记）：思考档已恒 `off`
 * （`research-app.ts` 的 `thinkingFor`），产出又要经收口跳再结构化一次，
 * 探查这一跳的随机性影响的是"查了什么"，不是"怎么判"。
 *
 * # `hitLimit` 只能从回调面拿，不能数文本
 *
 * pi 的工具调用**不进** `agent_message_chunk`（底座 `update-bridge` 只投影文本片），
 * 所以流拼出来的那段文字里看不见工具调用。步数的唯一真相源是
 * `tools-endpoint` 按 pi 会话计的那张表（ACR-038 实施陷阱 3）。
 * 数文本里的关键词是 ADR-012 明令禁止的那种做法，也数不准。
 */

import { generateText } from "ai";

import type { ChatStreamer, LlmUsageSample } from "@carlife/acp";

import type { StepState } from "../acp/tools-endpoint";
import type { ResearchUsage } from "../llm";
/*
 * 与 `challenger.ts` 互相 import（它调本文件的两个 explore，本文件取它的标题常量）。
 * 环是安全的：这里只在函数体里读那个常量，两个模块都已求值完毕。
 * 复制一份字面量反而更危险——追加段的标题必须两条 transport 逐字相同。
 */
import { EXTRA_ANGLE_HEADING } from "./challenger";

export type ChallengerTransport = "direct" | "acp";

/** 开关的环境变量名。冒烟脚本与测试都读这一个常量，不各写一份字面量。 */
export const CHALLENGER_TRANSPORT_ENV = "RESEARCH_CHALLENGER_TRANSPORT";

/** 开关缺省。M88-06 起是 `acp`；`direct` 是回滚值（`.env.example` 的 `RESEARCH_CHALLENGER_TRANSPORT` 一行）。 */
export const DEFAULT_CHALLENGER_TRANSPORT: ChallengerTransport = "acp";

/** ACP 一次探查的超时。缺省 3 分钟——8 步工具循环加上模型自己的思考，1–2 分钟是常态。 */
export const CHALLENGER_ACP_TIMEOUT_ENV = "RESEARCH_CHALLENGER_ACP_TIMEOUT_MS";
export const DEFAULT_ACP_TIMEOUT_MS = 180_000;

/** 超时后等流自己收尾（好让 `onUsage` 还有机会报一次用量）的宽限。 */
const TIMEOUT_GRACE_MS = 1_000;

/** 超时时接在过程记录末尾的那句话。收口跳会读到它，冒烟与用例按它断言。 */
export const ACP_TIMEOUT_NOTE = "⚠️ 探查超时";

/**
 * 读开关。**缺省是 `acp`**（M88-06 翻的；M88-05 结束时还是 `direct`，那时两条路径
 * 并行、开关不翻，让前五单每一单 revert 都不改线上行为）。`direct` 留作回滚值：
 * 回滚 = 把 `RESEARCH_CHALLENGER_TRANSPORT` 设成 `direct`，不用回代码。
 *
 * 认不出的值一律回**缺省**并 warn，不回另一条路径：静默换路径的话，一个拼错的
 * 环境变量会把整条路径换掉，而两条路径产出的记录形状一模一样，库里看不出来。
 */
export function readChallengerTransport(
  env: Record<string, string | undefined> = process.env,
): ChallengerTransport {
  const raw = env[CHALLENGER_TRANSPORT_ENV]?.trim();
  if (!raw) return DEFAULT_CHALLENGER_TRANSPORT;
  if (raw === "direct" || raw === "acp") return raw;
  console.warn(
    `[research-runtime] ${CHALLENGER_TRANSPORT_ENV}=${raw} 不认识——只有 direct / acp，本次按缺省 ${DEFAULT_CHALLENGER_TRANSPORT} 跑`,
  );
  return DEFAULT_CHALLENGER_TRANSPORT;
}

/** 超时毫秒数。非正数与非数字一律回缺省，不接受"0 = 永不超时"那种读法。 */
export function readChallengerAcpTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env[CHALLENGER_ACP_TIMEOUT_ENV]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ACP_TIMEOUT_MS;
}

/** 探查跳的产出。两条路径都给这一份，收口跳只认它。 */
export interface ExploreResult {
  /** 过程记录：模型这一跳说了什么。收口跳把它原样贴进 prompt。 */
  text: string;
  /** 走了几步工具循环。 */
  steps: number;
  /** 步数用满或超时。收口跳据此把 `holds` 强制降成 `inconclusive`。 */
  hitLimit: boolean;
  /** 实际跑的模型名（acp 下来自 pi 的 `.pi/settings.json`）。拿不到就 undefined。 */
  model?: string;
}

/** 探查跳的输入。两条路径共用——`system` 只有 direct 用得上，见文件头的对照表。 */
export interface ExploreInput {
  brief: string;
  /** 判定口径（`composeSystem` 的产物）。acp 下它已在 pi 的系统提示词里。 */
  system: string;
  /** 研究员补的调查角度（C7）。acp 下它进 user 消息第一段。 */
  extraAngle?: string;
}

/** direct 路径要的东西：模型与工具。形状取自 `challenger.ts` 原来那几行。 */
export interface ExploreDirectDeps {
  model: { model: Parameters<typeof generateText>[0]["model"] };
  tools: Parameters<typeof generateText>[0]["tools"];
  maxSteps: number;
}

/**
 * 直连探查：AI SDK 自己跑工具循环。
 *
 * **逐字搬自 `challenger.ts`**（M88-05 之前的 `generateText` 那一跳），
 * 一个参数都没改——它是 ACR-038 的回滚路径，回滚要能靠"切一行环境变量"完成。
 */
export async function exploreDirect(
  input: ExploreInput,
  deps: ExploreDirectDeps,
): Promise<ExploreResult> {
  const explored = await generateText({
    model: deps.model.model,
    system: input.system,
    prompt: input.brief,
    tools: deps.tools,
    maxSteps: deps.maxSteps,
    temperature: 0,
  });

  const steps = explored.steps?.length ?? 1;
  return { text: explored.text, steps, hitLimit: steps >= deps.maxSteps };
}

/** acp 路径要的东西。由 `index.ts` 装配、`challengeOne` 按卡补上 `sessionKey`。 */
export interface ExploreAcpDeps {
  streamer: ChatStreamer;
  /** 这一次挑战的会话键（`challengeSessionKey`）。pi 会话按它索引。 */
  sessionKey: string;
  /** 这个会话键走了几步、有没有撞上界。真相源是 `tools-endpoint`。 */
  stepsOf: (sessionKey: string) => StepState | undefined;
  timeoutMs: number;
  /** 探查跳的用量记账。**直连路径这一跳今天没记**（M85-09 §7 #1），acp 补上。 */
  recordUsage?: (u: ResearchUsage) => Promise<void> | void;
}

/**
 * ACP 探查：给 pi 会话发一次 `session/prompt`，工具由 pi 自己循环。
 *
 * 追问角度接在 brief 前面而不是拼进 system——理由见文件头。
 */
export async function exploreAcp(input: ExploreInput, deps: ExploreAcpDeps): Promise<ExploreResult> {
  const content = [angleBlock(input.extraAngle), input.brief].filter(Boolean).join("\n\n");

  /*
   * 用量在流结束时由底座回调一次（估算值，`EST_TOKENS_PER_CHAR`）。
   * 串成一条链而不是各自 fire-and-forget：两次记账的先后顺序无所谓，
   * 但"记完了没有"必须能等到——否则挑战都写完了用量还在路上。
   */
  let usageDone: Promise<void> = Promise.resolve();
  let model: string | undefined;
  const controller = new AbortController();
  const onUsage = (s: LlmUsageSample): void => {
    model = s.model;
    const u = usageFrom(s);
    usageDone = usageDone.then(() => deps.recordUsage?.(u)).then(
      () => undefined,
      (err: unknown) =>
        console.warn(
          `[research-runtime] 探查跳用量记账失败：${err instanceof Error ? err.message : String(err)}`,
        ),
    );
  };

  const it = deps.streamer([{ role: "user", content }], {
    threadId: deps.sessionKey,
    agent: "challenger",
    signal: controller.signal,
    onUsage,
  })[Symbol.asyncIterator]();

  let text = "";
  let timedOut = false;
  const deadline = Date.now() + deps.timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    const step = await raceWithDeadline(it.next(), remaining);
    if (step === TIMED_OUT) {
      timedOut = true;
      break;
    }
    if (step.done) break;
    text += step.value;
  }

  if (timedOut) {
    console.warn(
      `[research-runtime] 探查超时（${deps.timeoutMs}ms，会话 ${deps.sessionKey}）——` +
        "按步数用满处理，仍然进收口跳",
    );
    controller.abort();
    // 让流自己收尾：底座的 `finally` 就是在这一步回调 `onUsage` 的。
    // 不无限等——流可能已经不说话了，那正是它超时的原因。
    await raceWithDeadline(Promise.resolve(it.return?.(undefined)), TIMEOUT_GRACE_MS);
    text = text ? `${text}\n\n${ACP_TIMEOUT_NOTE}` : ACP_TIMEOUT_NOTE;
  }
  await usageDone;

  const st = deps.stepsOf(deps.sessionKey);
  if (!st) {
    // 一步工具都没调时也会走到这里（模型直接出文字）。两种情况都不该编一个数字。
    console.warn(
      `[research-runtime] 会话 ${deps.sessionKey} 没有步数记录——这一跳按 0 步记` +
        "（模型可能一个工具都没调）",
    );
  }
  return {
    text,
    steps: st?.steps ?? 0,
    hitLimit: timedOut || st?.hitLimit === true,
    ...(model ? { model } : {}),
  };
}

/**
 * 一次挑战的会话键。**追问与它追的那张卡同键**（ACR-038 决策），于是落到同一个
 * pi 会话里，模型带着上一轮的上下文继续查。
 *
 * C6 单卡触发带 `runId`，所以每次点击各起一个会话——一次点击就是一次独立的挑战，
 * 与批量那条路不共享上下文。C7 追问**不传 runId 给本函数**，见 `stages/challenge.ts`。
 */
export function challengeSessionKey(insightId: string, runId?: string): string {
  return runId ? `challenge:${insightId}:${runId}` : `challenge:${insightId}`;
}

/** 追问角度那一段。标题与 `composeSystem` 同一个常量，措辞逐字相同。 */
function angleBlock(extraAngle?: string): string {
  const angle = extraAngle?.trim();
  if (!angle) return "";
  return [
    `── ${EXTRA_ANGLE_HEADING} ──`,
    angle,
    "",
    "上面这一段是**额外要查的角度**，不改变你的判定口径与四问：" +
      "查不出东西就照常判 inconclusive，不要为了回应它而给一个更强的判决。",
  ].join("\n");
}

/** 估算用量 → 研究面的记账形状。`provider` 记 `pi-acp`，与直连那条分得开。 */
function usageFrom(s: LlmUsageSample): ResearchUsage {
  return {
    agent: "research-challenger",
    provider: "pi-acp",
    model: s.model,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    /*
     * 恒 0：pi 那条路拿不到 reasoning 计数，而这一档的思考已经恒关
     * （`research-app.ts` 的 `thinkingFor`）。记一个编出来的数比记 0 糟。
     */
    reasoningTokens: 0,
  };
}

const TIMED_OUT = Symbol("timed-out");

/**
 * 等一个 promise，但最多等这么久。
 *
 * 超时后那个 promise 仍在飞——先接住它的失败，否则它稍后 reject 时是一个
 * 未处理的 rejection，而现场已经走远了。
 */
async function raceWithDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  p.then(
    () => undefined,
    () => undefined,
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((res) => {
        timer = setTimeout(() => res(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
