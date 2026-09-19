/**
 * 码提案的读写面（施工单 M85-08）。
 *
 * # 提案不是码
 *
 * codebook 是测量仪器：改一个码的定义，等于让锁版前后所有数字换了含义。
 * 采纳一条提案只是**记下"决定采纳"**——开新版本是一个单独的、人执行的动作。
 * 界面上每一处都要把这句话说全，不然人点完采纳会以为这个码已经生效了，
 * 而下一次 run 用的还是旧码表。
 */

import { api } from "./index";

/** 「它会从哪个现有码里吸走多少」——由服务端**用代码算**，不是模型填的。 */
export interface Cannibalization {
  code: string;
  units: number;
}

export interface CodeProposalBody {
  proposalId: string;
  themeId: string;
  themeName: string;
  codeName: string;
  definition: string;
  include: string;
  exclude: string;
  exemplars: string[];
  candidateUnits: number;
  cannibalization: Cannibalization[];
  /** 重叠合计。空数组时读的人分不清"算过了没有重叠"和"这一栏没算"，所以单独给一个数。 */
  cannibalizedTotal: number;
}

export interface ProposalDecision {
  /** accept | reject。不设第三种。 */
  decision: string;
  decidedBy: string;
  decidedAt: string;
  rationale: string;
}

export interface ProposalRow {
  proposalId: string;
  /** **提出者是点按钮的那个研究员**，不是模型——他决定了把这件事提上议程。 */
  raisedBy: string;
  raisedAt: string;
  proposal: CodeProposalBody | null;
  /** 还没被决定就是 `null`，那就是「待审」。 */
  decided: ProposalDecision | null;
}

/**
 * 待审队列走的是 `GET /console/research/review`——**不另开端点**。
 *
 * 一条待审的提案就是一件"等着人决定的事"，与图里挂起的 `interrupt()` 同类；
 * 而另开端点要动网关，网关在这条链上只做鉴权与透传，多一条路由不换来任何东西。
 */
export async function fetchProposals(): Promise<ProposalRow[]> {
  const res = await api.get<{ codeProposals?: ProposalRow[] }>("/console/research/review");
  return res.codeProposals ?? [];
}

/**
 * 采纳 / 驳回。
 *
 * 走的是既有的 `review/:threadId/resume` 那条人工决定通路——**不另建机制**：
 * 那条路上 `decidedBy` 已经由网关注入真实身份（M85-03 修好的），
 * 另开一条就要把那件事再做一遍，而做漏了不报错。
 *
 * `threadId` 用提案 id：这条决定不属于任何一条图执行，而路由要一个路径段。
 */
export function decideProposal(
  proposalId: string,
  decision: "accept" | "reject",
  rationale: string,
): Promise<{ ok: boolean; decision: string; note: string }> {
  return api.post(`/console/research/review/${encodeURIComponent(proposalId)}/resume`, {
    kind: "code-proposal-decided",
    rationale,
    payload: { proposalId, decision },
  });
}
