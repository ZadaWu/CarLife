/**
 * review 端点的处理逻辑（施工单 M82-06）。
 *
 * 从 `internal-api` 里分出来，是因为这几条是**唯一会改变状态**的端点：
 * 其余全是只读。混在一个 900 行的路由文件里，"哪几条能写"这个问题
 * 就要靠通读来回答。
 */

import type { ResearchRepository } from "@carlife/db";
import type { Gates } from "@carlife/research";

import { PROPOSAL_DECIDED, PROPOSAL_RAISED } from "../capabilities/propose-code";

import {
  appealAftersales,
  approveAftersales,
  promoteBlockers,
  type DecisionDeps,
  type DecisionKind,
} from "./decisions";

export interface ReviewDeps extends DecisionDeps {
  repo: ResearchRepository;
  /** 图里挂起的项。没有图在跑时返回空。 */
  pendingInterrupts: () => Promise<Array<{ threadId: string; kind: string; subject: string; missing: string }>>;
  /** 恢复一条挂起的图执行。 */
  resumeThread: (threadId: string, payload: unknown) => Promise<void>;
  /** 锁 codebook。 */
  lockCodebook: (version: string) => Promise<void>;
  codebookVersion: string;
}

export interface ResumeBody {
  kind: DecisionKind;
  decision?: string;
  rationale?: string;
  payload?: Record<string, unknown>;
}

export interface ReviewResult {
  status: number;
  body: unknown;
}

const bad = (error: string, extra: Record<string, unknown> = {}): ReviewResult => ({
  status: 400,
  body: { error, ...extra },
});

/**
 * 处理一次人工决定。
 *
 * **每一条都要 rationale**：没有理由的不是决定，是随手点了一下。
 * 半年后回看"为什么把这条升级了"，唯一的答案就在这个字段里。
 */
export async function handleResume(
  threadId: string,
  body: ResumeBody,
  actor: string,
  deps: ReviewDeps,
): Promise<ReviewResult> {
  const rationale = (body.rationale ?? "").trim();
  if (rationale.length === 0) {
    return bad("rationale_required", { hint: "没有理由的不是决定，是随手点了一下" });
  }

  switch (body.kind) {
    case "codebook-lock": {
      await deps.lockCodebook(deps.codebookVersion);
      await deps.repo.decisions.record({
        kind: "codebook-lock",
        subjectId: deps.codebookVersion,
        decidedBy: actor,
        rationale,
        payload: { threadId },
      });
      await deps.resumeThread(threadId, { decision: "locked" });
      return { status: 200, body: { ok: true, codebookVersion: deps.codebookVersion } };
    }

    case "promote": {
      const insightId = String(body.payload?.insightId ?? "");
      if (!insightId) return bad("insight_id_required");

      const insight = (await deps.repo.insights.byId(insightId)) as
        | { id: string; level: string; confidence?: { c?: number }; challenges?: Array<{ verdict: string }> }
        | null;
      if (!insight) return { status: 404, body: { error: "insight_not_found" } };

      const gates = (body.payload?.gates ?? {}) as Gates;
      const blockers = promoteBlockers({
        gates,
        confidence: insight.confidence?.c ?? 0,
        challenges: insight.challenges ?? [],
      });
      // 拒绝时**列出缺什么**——只说"被拒了"的话，人只能靠猜。
      if (blockers.length > 0) return bad("promote_blocked", { blockers });

      await deps.repo.insights.setLevel(insightId, "candidate");
      await deps.repo.decisions.record({
        kind: "promote",
        subjectId: insightId,
        decidedBy: actor,
        rationale,
        payload: { from: insight.level, to: "candidate" },
      });
      return { status: 200, body: { ok: true, insightId, level: "candidate" } };
    }

    case "decision-record": {
      const subjectId = String(body.payload?.subjectId ?? "");
      if (!subjectId) return bad("subject_id_required");
      const row = await deps.repo.decisions.record({
        kind: "decision-record",
        subjectId,
        decidedBy: actor,
        rationale,
        payload: body.payload ?? {},
      });
      return { status: 200, body: { ok: true, decisionId: row.id } };
    }

    case "aftersales-approve": {
      const p = body.payload ?? {};
      /*
       * **没有批量放行。** 售后线索是对个体的差异化触达，逐条是它的前提，
       * 不是流程摩擦。带 `vins` 数组的请求直接拒——不要"顺手支持一下"。
       */
      if (Array.isArray(p.vins)) {
        return bad("no_batch_approval", {
          hint: "一次只能放行一个 vin。售后线索是对个体的差异化触达，逐条放行是它的前提",
        });
      }
      const vin = String(p.vin ?? "");
      const userId = String(p.userId ?? "");
      const opportunityId = String(p.opportunityId ?? "");
      const message = String(p.message ?? "");
      if (!vin || !userId || !opportunityId || !message) {
        return bad("aftersales_fields_required", { need: ["opportunityId", "vin", "userId", "message"] });
      }
      const out = await approveAftersales(
        { opportunityId, vin, userId, message, decidedBy: actor, rationale },
        deps,
      );
      return { status: 200, body: { ok: true, ...out } };
    }

    case "aftersales-appeal": {
      const reminderId = String(body.payload?.reminderId ?? "");
      const vin = String(body.payload?.vin ?? "");
      if (!reminderId) return bad("reminder_id_required");
      const out = await appealAftersales({ reminderId, vin, decidedBy: actor, rationale }, deps);
      return { status: 200, body: { ok: true, ...out } };
    }

    /**
     * 码提案的采纳 / 驳回（C8，施工单 M85-08）。
     *
     * 写的是**第二条**记录，第一条（`code-proposal-raised`）由 C8 写。
     * 两条都在，因为两条的 `decidedBy` 都是真值：提出来是一个决定，
     * 采纳是另一个。旧那条一行不改——这张表只追加。
     */
    case "code-proposal-decided": {
      const proposalId = String(body.payload?.proposalId ?? "");
      if (!proposalId) return bad("proposal_id_required");

      const decision = String(body.payload?.decision ?? body.decision ?? "");
      if (decision !== "accept" && decision !== "reject") {
        return bad("decision_required", { hint: "只有 accept 与 reject 两种，不设第三种" });
      }

      /*
       * 提案得真的存在，且**还没被决定过**。
       *
       * 不查的话，重复 POST 会写出两条互相矛盾的 decided 记录（一条采纳、一条驳回），
       * 而这张表只追加、没有谁覆盖谁——半年后读的人答不出"这条到底采纳了没有"。
       */
      const rows = (await deps.repo.decisions.forSubject(proposalId)) as Array<{ kind: string }>;
      if (!rows.some((r) => r.kind === PROPOSAL_RAISED)) {
        return { status: 404, body: { error: "proposal_not_found", proposalId } };
      }
      if (rows.some((r) => r.kind === PROPOSAL_DECIDED)) {
        return bad("proposal_already_decided", {
          proposalId,
          hint: "这条提案已经被决定过了。这张表只追加，改主意要新提一条，不覆盖旧的",
        });
      }

      const row = await deps.repo.decisions.record({
        kind: PROPOSAL_DECIDED,
        subjectId: proposalId,
        decidedBy: actor,
        rationale,
        payload: { decision },
      });
      return {
        status: 200,
        body: {
          ok: true,
          decisionId: row.id,
          proposalId,
          decision,
          /*
           * **这句话必须回给界面。** 采纳只是记下"决定采纳"——
           * codebook 一行未动，开新版本是一个单独的人工动作。
           * 不说的话，人点完采纳会以为这个码已经生效了，而下一次 run 用的还是旧码表。
           */
          note:
            decision === "accept"
              ? "已记下「决定采纳」。codebook 一行未动——下一步是开一个新的 codebook 版本，那是一个单独的人工动作"
              : "已记下「决定驳回」。提案仍留在台账里：被驳回的提案证明了这件事被考虑过",
        },
      };
    }

    default:
      return bad("unknown_decision_kind", {
        kinds: [
          "codebook-lock", "promote", "decision-record",
          "aftersales-approve", "aftersales-appeal", "code-proposal-decided",
        ],
      });
  }
}

/**
 * `GET /internal/research/review`：挂起中的人工决定。
 *
 * **码提案也在这里出**（M85-08），不另开端点。两条理由：
 *  ① 一条待审的提案就是一件"等着人决定的事"，与图里挂起的 `interrupt()` 同类；
 *  ② 网关是那一单的红线，`/console/research/review` 这条代理早就在——
 *     另开端点要动网关，而网关在这条链上只做鉴权与透传，多一条路由不换来任何东西。
 *
 * 待审的判据是**有没有对应的 `code-proposal-decided`**，不是提案自己的状态字段：
 * 这张表只追加，没有可以被改成"已处理"的列。
 */
export async function listReview(deps: ReviewDeps): Promise<ReviewResult> {
  const rows = (await deps.repo.decisions.byKinds([PROPOSAL_RAISED, PROPOSAL_DECIDED])) as Array<{
    kind: string; subjectId: string; decidedBy: string; decidedAt: Date; rationale: string; payload: unknown;
  }>;
  const decided = new Map(rows.filter((r) => r.kind === PROPOSAL_DECIDED).map((r) => [r.subjectId, r]));

  return {
    status: 200,
    body: {
      pending: await deps.pendingInterrupts(),
      codeProposals: rows
        .filter((r) => r.kind === PROPOSAL_RAISED)
        .map((r) => {
          const d = decided.get(r.subjectId);
          return {
            proposalId: r.subjectId,
            // 提出者是**点按钮的那个研究员**，不是模型——他决定了把这件事提上议程。
            raisedBy: r.decidedBy,
            raisedAt: r.decidedAt,
            proposal: r.payload,
            // 已决的那条原样带上，**不折叠成一个布尔**——谁、什么时候、为什么才是台账的价值。
            decided: d
              ? {
                  decision: (d.payload as { decision?: string } | null)?.decision ?? "unknown",
                  decidedBy: d.decidedBy,
                  decidedAt: d.decidedAt,
                  rationale: d.rationale,
                }
              : null,
          };
        }),
    },
  };
}
