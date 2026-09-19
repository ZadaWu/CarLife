/**
 * 能力端点的受理逻辑（施工单 M85-03）。
 *
 * # 这里是 G1 在服务端的落点
 *
 * 界面上的能力条由 `capabilitiesFor(scope)` 决定长什么样，而本模块用**同一个函数**
 * 决定受不受理。两处分开写的话，被抑制的格上界面不给按钮、后端却照收——
 * 绕过界面直接 POST 一次就穿了，而 G1 要防的恰恰是"AI 按钮成为小单元抑制的侧门"。
 * 所以下面第一件事就是调它，任何能力都不例外。
 *
 * # 没做的能力回 501，不回 404
 *
 * 404 分不出"没有这个能力"和"这个能力还没做"。前者是调用方拼错了名字，
 * 后者是我们的进度——把它们混成一个码，前端就只能靠猜。
 * 501 的 body 里点名它属于哪张工单：看到这个响应的人下一步该去读那张单。
 *
 * # 一条假数据都不给
 *
 * 未实现的能力**不返回空结果、不返回示例结构**。返回一个形状正确的空对象，
 * 界面会把它渲染成"跑过了，没发现什么"——那是一句假话，而且看不出来。
 */

import {
  ASK_AGENT_OF,
  ASK_MAX_ROUNDS,
  CAPABILITIES,
  askSessionKey,
  capabilitiesFor,
  redTeamChecklist,
  type AskCapabilityKey,
  type Capability,
  type CapabilityId,
  type RedTeamInput,
  type SelectionScope,
} from "@carlife/research";

import {
  DEFAULT_DELTAS,
  findCounterEvidence,
  sliceBySegment,
  systemEventsFor,
  thresholdSensitivity,
  type LookupDeps,
} from "../capabilities/lookup";
import { startSummarizeCell, type SummarizeCellDeps } from "../capabilities/summarize-cell";
import { startChallengeCard, type ChallengeCardDeps } from "../capabilities/challenge-card";
import { FOLLOW_UP_MAX_ROUNDS, screenAngle } from "../capabilities/follow-up";
import { askRoundsUsed, recordAskRound, startAskAgent, type AskAgentDeps } from "../capabilities/ask-agent";
import { CATCH_ALL_CODE, startProposeCode, type ProposeCodeDeps } from "../capabilities/propose-code";
import type { CapabilityRuns } from "../capabilities/runs";

export interface CapabilityDeps {
  /**
   * C9 的输入：当前窗口的证据矩阵快照 + 窗内系统事件 + codebook 锁态。
   *
   * 取数放在装配处而不是这里，是因为本模块不该认识仓储——它只认识
   * "能力目录"和"红队规则"两个纯函数。快照不存在时返回 null。
   */
  redTeamInput(contractId: string): Promise<RedTeamInput | null>;

  /**
   * C2–C5 的取数（M85-05）。**按合同装配**：四条查类能力与 Challenger 的工具
   * 共用同一个窗口与同一份回调，而那个窗口只有合同说了算。合同不存在时返回 null。
   */
  lookup(contractId: string): Promise<LookupDeps | null>;

  /**
   * `✎` 层的运行台账（M85-06）。缺省时 C1 回 503——
   * **不回一个假的 runId**：界面会去订阅一条永远不存在的流，
   * 看起来像"跑了很久还没动静"。
   */
  runs?: CapabilityRuns;
  /** C1 的取数与落库。与 `runs` 同进同退。 */
  summarizeCell?: SummarizeCellDeps;
  /** C6 / C7 的取数与落库（M85-07）。同上，缺就回 503 而不是假的 runId。 */
  challengeCard?: ChallengeCardDeps;
  /** C8 的取数与落库（M85-08）。同上。 */
  proposeCode?: ProposeCodeDeps;
  /**
   * C10–C12「问它」的取数与两跳（M89-03）。
   *
   * **缺省时三条 ask 回 503 `agents_not_available`**，不给假 runId：
   * 这三条只有 ACP 一条路（`RESEARCH_CHALLENGER_TRANSPORT=direct` 或没 key 时
   * `index.ts` 根本不建池），此时界面去订阅一条永远不存在的流，
   * 看起来像"问了很久还没动静"。
   */
  askAgent?: AskAgentDeps;
}

/** 每条能力属于哪张工单。501 的 body 要点名它，否则那个响应只是一句"没做"。 */
const WORKORDER_OF: Record<CapabilityId, string> = {
  c1: "M85-06",
  c2: "M85-05",
  c3: "M85-05",
  c4: "M85-05",
  c5: "M85-05",
  c6: "M85-07",
  c7: "M85-07",
  c8: "M85-08",
  c9: "M85-03",
  c10: "M89-03",
  c11: "M89-03",
  c12: "M89-03",
};

/*
 * 哪几条**已经实现**。这一行是前端那张可用性表的对账基准
 * （`console/test/capability-rail.test.ts` 逐字读它），所以它必须留在一行上、
 * 把全部 id 写成字面量：拆成多行或改用 `CAPABILITIES.filter(...)` 推导，
 * 那条对账就读不出 id，于是"后端做完了、界面按钮还是灰的"这个不报错的故障
 * 又变回没人检出。
 */
const IMPLEMENTED: ReadonlySet<CapabilityId> = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"]);

export interface CapabilityJson {
  status: number;
  body: unknown;
}

const byKeyOrId = new Map<string, Capability>();
for (const c of CAPABILITIES) {
  byKeyOrId.set(c.id, c);
  byKeyOrId.set(c.key, c);
}

/**
 * 把请求体里的 `scope` 收成 `SelectionScope`。
 *
 * **宁可拒收也不补默认值**：`suppressed` 缺省成 `false` 的话，
 * 一个漏传字段的调用方就绕过了 G1——而它看起来完全正常。
 */
export function parseScope(v: unknown): SelectionScope | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);
  const bool = (k: string): boolean | null => (typeof o[k] === "boolean" ? (o[k] as boolean) : null);

  switch (o.kind) {
    case "cell": {
      const needPainCode = str("needPainCode");
      const sceneCode = str("sceneCode");
      const suppressed = bool("suppressed");
      const catchAll = bool("catchAll");
      const hasDirection = bool("hasDirection");
      if (needPainCode === null || sceneCode === null || suppressed === null) return null;
      return {
        kind: "cell",
        needPainCode,
        sceneCode,
        suppressed,
        catchAll: catchAll ?? false,
        hasDirection: hasDirection ?? false,
      };
    }
    case "row": {
      const needPainCode = str("needPainCode");
      const suppressed = bool("suppressed");
      if (needPainCode === null || suppressed === null) return null;
      return { kind: "row", needPainCode, suppressed, catchAll: bool("catchAll") ?? false };
    }
    case "col": {
      const sceneCode = str("sceneCode");
      return sceneCode === null ? null : { kind: "col", sceneCode };
    }
    case "card": {
      const insightId = str("insightId");
      return insightId === null ? null : { kind: "card", insightId };
    }
    case "page":
      return { kind: "page" };
    default:
      return null;
  }
}

export interface CapabilityBody {
  scope?: unknown;
  contractId?: unknown;
  /** C2 一次取几条反例。缺省 10，`findCounterEvidence` 会再按 `TOOL_LIMIT_MAX` 封顶。 */
  limit?: unknown;
  /** C5 探哪几个 delta。缺省 `DEFAULT_DELTAS`。 */
  deltas?: unknown;
  /** C7 的追问角度。只进 Challenger 的 system 侧，不改 schema、不改判定口径。 */
  angle?: unknown;
  /**
   * C10–C12 的问句（M89-03）。必填字符串，过 `screenAngle` 同一道门。
   *
   * 与 `angle` 分开而不是复用它：两者的落点不同（角度进 Challenger 的调查方向，
   * 问句是研究员真正要的答案），复用一个字段会让"这次点的是追问还是提问"
   * 只能靠能力名反推，而错了不报错。
   */
  question?: unknown;
  /**
   * 决定人（C8）。**由路由从 `?actor=` 填进来，不是客户端在 body 里带的**——
   * 客户端自己写 `actor` 等于自证身份，随手改一个字就换了人。
   */
  actor?: unknown;
}

/**
 * 这个范围说的是哪个需求码。
 *
 * C2 / C4 / C5 都是"按码找主题再查"，而只有格与整行带码。
 * 返回 null 时调用方必须拒收，**不能退回到"全部码"**——
 * 那会把一次针对某一格的提问悄悄换成一次全表扫描，而结果看起来一样合理。
 */
const codeOf = (scope: SelectionScope): string | null =>
  scope.kind === "cell" || scope.kind === "row" ? scope.needPainCode : null;

const readLimit = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 10);

/** body 里给了 deltas 就用它，否则跑缺省那一组。非数字一律丢掉，不静默当 0。 */
function readDeltas(v: unknown): readonly number[] {
  if (!Array.isArray(v)) return DEFAULT_DELTAS;
  const ns = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return ns.length > 0 ? ns : DEFAULT_DELTAS;
}

/**
 * 受理一次能力调用。
 *
 * 顺序不能改：**先认得这条能力 → 再看得懂范围 → 再过闸门 → 最后才分发**。
 * 把闸门放到分发之后的话，未实现的能力会先回 501，于是"被抑制的格上
 * 任何能力都调不动"这句话在八条能力上都是假的——而它们迟早会实现。
 */
export async function handleCapability(
  name: string,
  body: CapabilityBody,
  deps: CapabilityDeps | undefined,
  defaultContractId: string | null,
): Promise<CapabilityJson> {
  const capability = byKeyOrId.get(name);
  if (!capability) {
    return {
      status: 400,
      body: { error: "unknown_capability", hint: `能力只有这十二条：${CAPABILITIES.map((c) => c.key).join("、")}` },
    };
  }

  const scope = parseScope(body.scope);
  if (!scope) {
    return { status: 400, body: { error: "bad_scope", hint: "scope 缺字段或 kind 不认识；被抑制与否必须显式传" } };
  }

  // ── G1 的闸门。任何能力、任何时候，都从这里过。 ──
  const available = capabilitiesFor(scope).some((c) => c.id === capability.id);
  if (!available) {
    return {
      status: 400,
      body: {
        error: "capability_not_available",
        capability: capability.key,
        scope: scope.kind,
        hint:
          (scope.kind === "cell" || scope.kind === "row") && scope.suppressed
            ? "这一格被小单元抑制：明细已在快照阶段清空，任何能力都没有可读的输入"
            : "这条能力不在当前选中范围的能力条上",
      },
    };
  }

  if (!IMPLEMENTED.has(capability.id)) {
    return {
      status: 501,
      body: {
        error: "capability_not_implemented",
        capability: capability.key,
        workorder: WORKORDER_OF[capability.id],
        hint: `${capability.title} 由 ${WORKORDER_OF[capability.id]} 落地`,
      },
    };
  }

  if (!deps) return { status: 503, body: { error: "capabilities_not_available", hint: "缺 DATABASE_URL，取不到快照" } };

  const contractId = typeof body.contractId === "string" && body.contractId ? body.contractId : defaultContractId;
  if (!contractId) return { status: 400, body: { error: "contract_required" } };

  const ok = (result: unknown): CapabilityJson => ({
    status: 200,
    body: { capability: capability.key, tier: capability.tier, result },
  });

  if (capability.id === "c9") {
    const input = await deps.redTeamInput(contractId);
    if (!input) {
      // 没快照与"这一屏没问题"是两件事，别让它们回同一个 200 空数组。
      return { status: 404, body: { error: "snapshot_not_found", hint: "这个合同还没算过证据矩阵，先 POST /runs" } };
    }
    return ok(redTeamChecklist(input));
  }

  /*
   * C1 是 `✎` 层：**立刻回 runId，活儿在后台跑**（M85-03 定下的异步契约）。
   * `tier` 照回 `write`，前端据它决定开运行态面板还是就地渲染结果。
   */
  if (capability.id === "c1") {
    if (!deps.runs || !deps.summarizeCell) {
      return { status: 503, body: { error: "synthesis_not_available", hint: "缺 DEEPSEEK_API_KEY 或 DATABASE_URL" } };
    }
    const code = codeOf(scope);
    if (code === null) {
      return { status: 400, body: { error: "bad_scope", hint: "归纳的对象是一格，范围里必须有需求码" } };
    }
    const { runId } = startSummarizeCell(deps.runs, deps.summarizeCell, { contractId, needPainCode: code });
    return { status: 202, body: { capability: capability.key, tier: capability.tier, runId } };
  }

  if (capability.id === "c6" || capability.id === "c7") {
    return runChallenge(capability, scope, body, deps);
  }

  if (capability.id === "c10" || capability.id === "c11" || capability.id === "c12") {
    return runAsk(capability, scope, body, deps, contractId);
  }

  if (capability.id === "c8") {
    return runProposeCode(capability, scope, body, deps);
  }

  return runLookup(capability, scope, body, deps, contractId, ok);
}

/**
 * C6「挑战这张卡」与 C7「追问」的受理（M85-07）。
 *
 * 两条能力只差一个 `angle`，所以共用一个函数——与 `challengeOne` 同一条理由：
 * 拆开之后"追问不改 schema、不改判定口径"要靠两处各自守住。
 *
 * **`contractId` 在这里用不上**：挑战的对象是一张已经产出的卡，
 * 窗口取自卡片所属合同（装配处读的），不是调用方说了算。
 * 传了也不读——读它就意味着可以拿 A 合同的窗口去挑 B 合同的卡。
 */
async function runChallenge(
  capability: Capability,
  scope: SelectionScope,
  body: CapabilityBody,
  deps: CapabilityDeps,
): Promise<CapabilityJson> {
  if (!deps.runs || !deps.challengeCard) {
    return { status: 503, body: { error: "challenge_not_available", hint: "缺 DEEPSEEK_API_KEY 或 DATABASE_URL" } };
  }
  /*
   * `capabilitiesFor` 已经把 c6/c7 限定在 `card` 上，所以走到这里必然是 card。
   * 但仍然显式判一次并拒收：闸门那条判据是"这条能力在不在能力条上"，
   * 它未来会变（目录改一行就变），而这里要的是"我有没有 insightId"。
   */
  if (scope.kind !== "card") {
    return {
      status: 400,
      body: { error: "bad_scope", capability: capability.key, hint: "挑战与追问的对象是一张已产出的洞察卡" },
    };
  }
  const insightId = scope.insightId;

  if (capability.id === "c6") {
    const { runId } = startChallengeCard(deps.runs, deps.challengeCard, { insightId });
    return { status: 202, body: { capability: capability.key, tier: capability.tier, runId } };
  }

  /*
   * ── C7：两道门，顺序不能反 ──
   *
   * 先数轮数、再看文本：反过来的话，第 4 次追问会先因为文本被拒（或先过一遍规则筛），
   * 而用户看到的错是"这条追问没法处理"——他会改写措辞再试，而真正的原因是次数到头了。
   */
  const used = await deps.challengeCard.countFollowUps(insightId);
  if (used >= FOLLOW_UP_MAX_ROUNDS) {
    return {
      status: 400,
      body: {
        error: "follow_up_limit_reached",
        capability: capability.key,
        used,
        limit: FOLLOW_UP_MAX_ROUNDS,
        hint:
          `同一张卡最多追问 ${FOLLOW_UP_MAX_ROUNDS} 次，这张已经追过 ${used} 次。` +
          "再问下去多半不是证据不够，而是这张卡本身该被重写",
      },
    };
  }

  const angle = typeof body.angle === "string" ? body.angle.trim() : "";
  const screened = await screenAngle(body.angle);
  if (!screened.ok) {
    return {
      status: 400,
      body: {
        error: "angle_rejected",
        capability: capability.key,
        ...(screened.ruleId ? { ruleId: screened.ruleId } : {}),
        hint: screened.reason,
      },
    };
  }

  const { runId } = startChallengeCard(deps.runs, deps.challengeCard, { insightId, angle });
  return {
    status: 202,
    body: {
      capability: capability.key,
      tier: capability.tier,
      runId,
      round: used + 1,
      limit: FOLLOW_UP_MAX_ROUNDS,
      /*
       * 审核层跑没跑，如实带出去（G7 同一条纪律的另一面）。
       * 不带的话，界面上"这条追问过了审核"与"这条追问只过了规则筛"长得一模一样。
       */
      moderationSkipped: screened.moderationSkipped,
    },
  };
}

/**
 * C10–C12「问它」的受理（M89-03）。
 *
 * **与 C6/C7 共用一个 `screenAngle`，但错误码不一样。** 那个函数的语义是
 * "这段用户文本准不准进模型"，对问句一样适用；而它的错误码 `angle_rejected`
 * 对问句不合语义——界面拿到它只能说"这条追问没法处理"，而用户问的是一个问题。
 * 所以错误码在这一层换成 `question_rejected`，`ruleId` / `reason` 原样透传。
 *
 * 两道门的顺序与 C7 一致：**先数轮数、再看文本**。反过来的话，第 6 次提问会先
 * 因为文本被拒，而用户看到的错是"这条问题没法处理"——他会改写措辞再试，
 * 而真正的原因是次数到头了。
 */
async function runAsk(
  capability: Capability,
  scope: SelectionScope,
  body: CapabilityBody,
  deps: CapabilityDeps,
  contractId: string,
): Promise<CapabilityJson> {
  if (!deps.runs || !deps.askAgent) {
    return {
      status: 503,
      body: {
        error: "agents_not_available",
        capability: capability.key,
        hint:
          "研究 Agent 池没起——缺 DEEPSEEK_API_KEY，或 RESEARCH_CHALLENGER_TRANSPORT=direct。" +
          "「问它」只有 ACP 一条路，这里不给一个假的 runId（界面会去订阅一条永远不存在的流）",
      },
    };
  }

  const agent = ASK_AGENT_OF[capability.key as AskCapabilityKey];
  /*
   * 会话键在这里算一次，两个用途共用：数轮数、以及 pi 会话的复用键。
   * 两处各算一遍的话，"还剩几轮"与"带不带上一轮的上下文"会说两件事。
   */
  const sessionKey = askSessionKey(agent, scope, contractId);

  const used = askRoundsUsed(sessionKey);
  if (used >= ASK_MAX_ROUNDS) {
    return {
      status: 400,
      body: {
        error: "ask_limit_reached",
        capability: capability.key,
        used,
        limit: ASK_MAX_ROUNDS,
        hint:
          `同一范围最多问 ${ASK_MAX_ROUNDS} 轮，这个范围已经问过 ${used} 轮。` +
          "再问下去多半不是查得不够，而是该换个范围或换个角色问",
      },
    };
  }

  const screened = await screenAngle(body.question);
  if (!screened.ok) {
    return {
      status: 400,
      body: {
        error: "question_rejected",
        capability: capability.key,
        ...(screened.ruleId ? { ruleId: screened.ruleId } : {}),
        reason: screened.reason,
        hint: screened.reason,
      },
    };
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  const round = recordAskRound(sessionKey);
  const { runId } = startAskAgent(deps.runs, deps.askAgent, {
    agent,
    scope,
    contractId,
    question,
    round,
    sessionKey,
  });
  return {
    status: 202,
    body: {
      capability: capability.key,
      tier: capability.tier,
      runId,
      round,
      limit: ASK_MAX_ROUNDS,
      // 审核层跑没跑，如实带出去（同 C7）。不带的话界面分不出"过了审核"与"只过了规则筛"。
      moderationSkipped: screened.moderationSkipped,
    },
  };
}

/**
 * C8「从兜底桶提码」的受理（M85-08）。
 *
 * **产出是提案，不是新码。** codebook 一行不写（G3）——采纳一条提案
 * 等于开一个新版本，那是人的决定。
 */
async function runProposeCode(
  capability: Capability,
  scope: SelectionScope,
  body: CapabilityBody,
  deps: CapabilityDeps,
): Promise<CapabilityJson> {
  if (!deps.runs || !deps.proposeCode) {
    return { status: 503, body: { error: "proposal_not_available", hint: "缺 DEEPSEEK_API_KEY 或 DATABASE_URL" } };
  }

  /*
   * 端点侧再挡一次「这不是兜底桶」。
   *
   * `capabilitiesFor` 已经按 `catchAll` 过滤过，但那条判据是
   * "这条能力在不在能力条上"，而这里要的是"我手上这一堆确实是归不上码的那一堆"。
   * 对一个真实需求码提码，产出的是一条"建议开一个和 charging-speed 几乎一样的码"——
   * 它不会报错，只会在待审队列里看起来像一条正经提案。
   */
  const code = codeOf(scope);
  if (scope.kind !== "row" || code !== CATCH_ALL_CODE) {
    return {
      status: 400,
      body: {
        error: "scope_not_supported",
        capability: capability.key,
        scope: scope.kind,
        hint: `提码的对象只能是兜底桶那一行（needPainCode = ${CATCH_ALL_CODE}）——` +
          "别的行已经有码了，对它提码只会提出一个和现有码几乎一样的",
      },
    };
  }

  /*
   * 决定人。**由网关经 `?actor=` 注入**（M85-03 修好的那条），不由请求体带。
   * 取不到时写 `unknown:unknown` 而不是静默填一个 `system`——
   * 后者会让一条没人负责的提案在待审队列里看起来有人提过。
   */
  const actor = typeof body.actor === "string" && body.actor ? body.actor : "unknown:unknown";
  const { runId } = startProposeCode(deps.runs, deps.proposeCode, { actor });
  return { status: 202, body: { capability: capability.key, tier: capability.tier, runId, actor } };
}

/**
 * C2–C5 的分发（M85-05）。
 *
 * 与 C9 分开写，因为它们的前置不同：红队清单要的是**算好的快照**，
 * 四条查类能力要的是**合同窗口 + 按码找主题**。混在一个函数里的话，
 * "没跑过 run" 与 "合同不存在" 会共用同一个 404，而它们的下一步动作不一样。
 */
async function runLookup(
  capability: Capability,
  scope: SelectionScope,
  body: CapabilityBody,
  deps: CapabilityDeps,
  contractId: string,
  ok: (result: unknown) => CapabilityJson,
): Promise<CapabilityJson> {
  const lk = await deps.lookup(contractId);
  if (!lk) {
    return {
      status: 404,
      body: { error: "contract_not_found", hint: "查类能力的时间窗取自合同，合同不在就编不出一个来" },
    };
  }

  if (capability.id === "c3") return ok(await systemEventsFor(lk));

  const code = codeOf(scope);
  if (code === null) {
    /*
     * 今天只有 C4 落得进这里：能力目录把它也开在整列上，而分群切分是**按主题**做的，
     * 主题只按需求码切、不带场景维度——一整列横跨全部码，用现有工具答不了。
     *
     * 回 400 并说清楚，而不是"把该列的全部主题合起来切一刀"：后者算得出数字，
     * 而那个数字回答的是"全窗的分群分布"，与用户点的那一列无关——
     * 它不会报错，只会看起来很合理。真要答它得给分群查询加场景维度（技术债 TD-32）。
     */
    return {
      status: 400,
      body: {
        error: "scope_not_supported",
        capability: capability.key,
        scope: scope.kind,
        hint: "分群切分按主题做，而主题只按需求码切、不带场景——整列答不了，请点具体的格或整行",
      },
    };
  }

  switch (capability.id) {
    case "c2":
      return ok(await findCounterEvidence(lk, code, readLimit(body.limit)));
    case "c4":
      return ok(await sliceBySegment(lk, code));
    default:
      return ok(await thresholdSensitivity(lk, code, readDeltas(body.deltas)));
  }
}
