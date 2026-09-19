/**
 * 挑战记录与追问的判定（施工单 M85-07）。纯函数，不画界面。
 *
 * # verdict 四态各有措辞，**没有默认兜底**
 *
 * 给一个 `default:` 分支是这一页最容易犯的错：遇到第五种取值时它会显示成
 * "未知"或者干脆显示成第一种，而不报错。这里改用一张穷举表 + `VERDICTS`
 * 白名单，表外的取值走 `unknownVerdict()` 并**在界面上说出它是表外的**——
 * 那句话本身就是检出点。
 *
 * # 「还能追问几次」不是「还剩几次调用」
 *
 * 上限管的是**同一张卡**被追问的次数（3），不是工具步数（8，`CHALLENGE_MAX_STEPS`）。
 * 两个上限不在同一层，界面上混了就会显示"还能问 5 次"而服务端第 4 次就拒。
 * 所以这里只数 `payload.angle` 非空的记录，与服务端 `isFollowUp` 同一条判据。
 */

import type { ChallengeRecord } from "../../../api/research-challenge";

/** 同一张卡最多追问几次。与服务端 `FOLLOW_UP_MAX_ROUNDS` 同一个值。 */
export const FOLLOW_UP_MAX_ROUNDS = 3;

/** 追问框的字数上限。与规则筛的 `MAX_INPUT_CHARS` 同一个值——超了服务端会拒。 */
export const MAX_ANGLE_CHARS = 500;

export type VerdictKind = "holds" | "weakened" | "refuted" | "inconclusive";

export const VERDICTS: readonly VerdictKind[] = ["holds", "weakened", "refuted", "inconclusive"];

export interface VerdictView {
  kind: string;
  label: string;
  /** 一句话说清这个判决**意味着要做什么**，不是复述它的英文名。 */
  meaning: string;
  /** 样式档：`ok` / `warn` / `bad` / `dim`。 */
  tone: "ok" | "warn" | "bad" | "dim";
  /** 表外的取值。界面要把这件事说出来，不能静默显示成别的。 */
  unknown?: true;
}

const TABLE: Record<VerdictKind, Omit<VerdictView, "kind">> = {
  holds: {
    label: "站得住",
    // "认真找过了没找到反例"——它的价值全在"认真找过"上，所以要点出查了几步。
    meaning: "带着四个只读工具找过反例，没找到能推翻它的证据",
    tone: "ok",
  },
  weakened: {
    label: "被削弱",
    meaning: "找到了与它矛盾的证据，结论还在但边界要收窄",
    tone: "warn",
  },
  refuted: {
    label: "被推翻",
    // 明说这一条：一条 refuted 不会自动把卡降级，降级与升级一样是人工决定。
    meaning: "证据不支持这个结论。卡片不会因此自动降级——降级是人工决定",
    tone: "bad",
  },
  inconclusive: {
    label: "没查清",
    /*
     * 这一条最容易被读成 holds，而那正是 Challenger 要防的那类错误：
     * "没查完"不是"查过了没问题"。措辞必须把这个区别说出来。
     */
    meaning: "工具步数用满了还没查清楚。这不等于它没问题，只等于这一轮没问出来",
    tone: "dim",
  },
};

/** 表外的取值。**不并进任何一档**——并进去就看不出模型返回了个新东西。 */
const unknownVerdict = (kind: string): VerdictView => ({
  kind,
  label: kind,
  meaning: "这个判决不在四态里（holds / weakened / refuted / inconclusive）——界面没有对应的措辞，回去核对 challengeSchema",
  tone: "dim",
  unknown: true,
});

export function verdictOf(kind: string): VerdictView {
  return VERDICTS.includes(kind as VerdictKind)
    ? { kind, ...TABLE[kind as VerdictKind] }
    : unknownVerdict(kind);
}

/**
 * 三类挑战的中文名。**表外的取值原样显示**，不换成"其他"——
 * 换掉之后，模型返回了一个新 kind 这件事就再也看不见了。
 */
const KIND_LABEL: Record<string, string> = {
  "counter-evidence": "反例",
  "alternative-explanation": "替代解释",
  sensitivity: "敏感性",
};

/** 这条记录是不是追问产生的。判据与服务端 `isFollowUp` 逐字相同。 */
export const isFollowUp = (r: ChallengeRecord): boolean =>
  typeof r.payload?.angle === "string" && r.payload.angle.trim().length > 0;

/**
 * 追问过**几轮**。
 *
 * ⚠️ **一轮追问会写好几条记录**（`challengeSchema` 允许一次返回 1–6 条，
 * 实测一次写了 3 条），所以数记录条数是错的：那样第一次追问就把三次额度用光，
 * 而界面会显示「这张卡已经追问过 3 次」——数字对得上，只是那三次里有两次没问过。
 * 2026-09-14 真跑踩到；与服务端 `followUpRounds` 同一条口径。
 */
export const followUpRounds = (records: readonly ChallengeRecord[]): number => {
  const rounds = new Set<string>();
  for (const r of records) {
    if (!isFollowUp(r)) continue;
    // 一次点击一个 runId。老记录没有它，退回 angle——同一轮里 angle 必然相同。
    rounds.add(r.payload!.runId ? `run:${r.payload!.runId}` : `angle:${r.payload!.angle!.trim()}`);
  }
  return rounds.size;
};

export interface ChallengeRow {
  id: string;
  /** 挑的是哪一类：反例 / 替代解释 / 敏感性。**这一列没有"追问"这一类。** */
  kind: string;
  verdict: VerdictView;
  /** 模型给的一句话摘要。没有就如实说没有，不拿 verdict 的措辞顶上。 */
  summary: string;
  /** 走了几步工具循环。`null` 表示这条记录没记（M85-07 之前的老记录）。 */
  steps: number | null;
  /** 追问的角度。非 null 即这条是追问产生的。 */
  angle: string | null;
  /** 矛盾证据单元数。0 与「没查」是两件事，所以这里恒给数字。 */
  contradicted: number;
  createdBy: string;
}

export function challengeRows(records: readonly ChallengeRecord[]): ChallengeRow[] {
  return records.map((r) => ({
    id: r.id,
    kind: KIND_LABEL[r.kind] ?? r.kind,
    verdict: verdictOf(r.verdict),
    summary: r.payload?.summary?.trim() || "（这条记录没有摘要）",
    steps: typeof r.payload?.steps === "number" ? r.payload.steps : null,
    angle: isFollowUp(r) ? r.payload!.angle!.trim() : null,
    contradicted: r.contradictedUnitIds?.length ?? 0,
    createdBy: r.createdBy,
  }));
}

export interface FollowUpState {
  used: number;
  remaining: number;
  /** 还能不能问。到顶了就是 false，输入框与按钮都要按这个禁用。 */
  can: boolean;
  /** 一句话说清现在是什么状况。到顶时说的是"为什么不让问了"。 */
  note: string;
}

export function followUpState(records: readonly ChallengeRecord[]): FollowUpState {
  const used = followUpRounds(records);
  const remaining = Math.max(0, FOLLOW_UP_MAX_ROUNDS - used);
  return {
    used,
    remaining,
    can: remaining > 0,
    note:
      remaining > 0
        ? `还能追问 ${remaining} 次（同一张卡最多 ${FOLLOW_UP_MAX_ROUNDS} 次）`
        : /*
           * 到顶时说的不是"次数用完了"，而是**为什么设这个上限**。
           * 前者会让人去找放开限制的开关，后者指向真正该做的事。
           */
          `这张卡已经追问过 ${FOLLOW_UP_MAX_ROUNDS} 次。再问下去多半不是证据不够，而是这张卡本身该被重写`,
  };
}

/**
 * 这段追问文本发不发得出去。
 *
 * **前端只拦空与超长两样**，不复制那 9 条注入规则——两份规则表必然漂移，
 * 而漂移的表现是前端放行、服务端拒，用户看到一个他改不动的错。
 * 服务端那一份（`@carlife/guardrails` 的规则筛）是唯一的判据。
 */
export function angleIssue(text: string): string | null {
  const t = text.trim();
  if (!t) return "追问要说清追的是什么";
  if (t.length > MAX_ANGLE_CHARS) return `追问请控制在 ${MAX_ANGLE_CHARS} 字以内（现在 ${t.length} 字）`;
  return null;
}
