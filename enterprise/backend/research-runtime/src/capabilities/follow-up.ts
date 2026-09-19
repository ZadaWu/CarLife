/**
 * 追问（C7）的两条硬规则：**几轮封顶** 与 **这段文字准不准进 system**（施工单 M85-07）。
 *
 * # 两个上限不在同一层，混了就会出怪事
 *
 * | 上限 | 值 | 管什么 | 超了怎么样 |
 * |---|---|---|---|
 * | `CHALLENGE_MAX_STEPS` | 8 | 一次挑战里模型能调几次工具 | 判 `inconclusive` |
 * | `FOLLOW_UP_MAX_ROUNDS` | 3 | 同一张卡能被追问几次 | 端点回 400 |
 *
 * 拿步数当轮数的表现是「追问第二次就说超限了」——一次挑战往往一步就走完
 * （模型直接出文字不调工具），于是两个数字碰巧都在个位数上，看不出是哪一个在拦。
 *
 * # 「这一条是追问产生的」记在 payload 里，不新增 kind
 *
 * `kind` 直接来自 `challengeSchema` 的 enum，而那个 schema 是 M85-07 的红线——
 * 加一个取值就是改判定口径。`payload.angle` 还顺带答得出"顺着哪个角度追的"。
 *
 * # 追问文本过内容管线的**规则筛**那一层
 *
 * 它是用户输入，而且会进模型的 **system 侧**——inj-06「系统提示词探测」
 * 这类规则正是为这个位置准备的。`@carlife/guardrails` 早在
 * `research-runtime` 的依赖里（不是本单新引的边），所以直接复用，
 * 不在这里另写一套长度与字符集校验。
 *
 * ⚠️ **审核层（模型侧）今天没有注入**：`runInputPipeline` 不给 `moderation`
 * 就只跑规则筛，并在结果里标 `moderationSkipped`。这里如实把它带出去，
 * 不假装审核跑过——验收里记了这一层的现状。
 */

import { runInputPipeline } from "@carlife/guardrails";

/** 同一张卡最多追问几次。设计稿 §5.4 已定，不是可配置项。 */
export const FOLLOW_UP_MAX_ROUNDS = 3;

export interface AngleVerdict {
  ok: boolean;
  /** 不通过时给调用方的原因。**原样是规则筛给的那句**，不另编。 */
  reason?: string;
  /** 命中的规则 id，写进日志用。 */
  ruleId?: string;
  /** 审核层跑没跑。没跑就是没跑，别在别处把它读成"审核通过"。 */
  moderationSkipped: boolean;
}

/**
 * 追问文本准不准用。
 *
 * 空串单独判：规则筛放行空串（它既不超长也不命中注入），
 * 而一次没有角度的"追问"等于白烧一次 token，还会在库里留下一条
 * 带 `angle: ""` 的记录——看起来是追问产生的，其实什么也没追。
 */
export async function screenAngle(raw: unknown): Promise<AngleVerdict> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return { ok: false, reason: "追问要说清追的是什么，空的问不出东西", moderationSkipped: true };
  }

  const v = await runInputPipeline(text);
  return v.allowed
    ? { ok: true, moderationSkipped: v.moderationSkipped === true }
    : {
        ok: false,
        reason: v.reason ?? "这条追问没法处理",
        ...(v.ruleId ? { ruleId: v.ruleId } : {}),
        moderationSkipped: v.stage !== "moderation",
      };
}

/** 这条挑战记录是不是追问产生的。判据只有一条：payload 里有 `angle`。 */
export function isFollowUp(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const angle = (payload as { angle?: unknown }).angle;
  return typeof angle === "string" && angle.trim().length > 0;
}

/**
 * 这张卡被追问过**几轮**。
 *
 * ⚠️ **一轮追问会写好几条记录，所以数记录条数是错的。**
 * `challengeSchema` 允许一次返回 1–6 条挑战，实测一次追问写了 3 条——
 * 按条数算的话，第一次追问就把三次额度全用光了，而用户看到的是
 * 「这张卡已经追问过 3 次」：数字对得上，只是那三次里有两次他没问过。
 * 2026-09-14 真跑踩到这一条；单测里假实现每次只写一条，看不出来。
 *
 * 一轮的标识是 `payload.runId`（一次点击一个），拿不到就退回 `angle`
 * ——本单之前写下的那几条没有 runId，而同一轮里它们的 angle 必然相同。
 */
export function followUpRounds(
  records: readonly { payload?: unknown }[],
): number {
  const rounds = new Set<string>();
  for (const r of records) {
    if (!isFollowUp(r.payload)) continue;
    const p = r.payload as { runId?: unknown; angle?: string };
    rounds.add(typeof p.runId === "string" && p.runId ? `run:${p.runId}` : `angle:${p.angle!.trim()}`);
  }
  return rounds.size;
}
