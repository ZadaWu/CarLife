/**
 * 挑战记录的读取面（施工单 M85-07）。
 *
 * # 不新开端点，借 `GET insights/:id`
 *
 * 上游的 `insights.byId` 本来就 `include: { challenges: true }`，而网关那条
 * `/console/research/insights/:id` 早就在。新开一条的话要动网关——
 * 而网关是本单的红线，且它在这条链上只做鉴权与透传，多一条路由不换来任何东西。
 *
 * # verdict 是**四态**，不是三态
 *
 * `holds | weakened | refuted | inconclusive`。设计稿 §5.4 漏了 `weakened`、
 * Prisma 的列注释曾漏了 `inconclusive`，两份文档各错一半——**代码是权威**
 * （`challenger.ts` 的 `challengeSchema`）。按三态渲染的界面遇到第四态
 * 会掉进默认分支：不报错，只显示成别的东西。
 */

import { api } from "./index";

export interface ChallengeRecord {
  id: string;
  /** counter-evidence | alternative-explanation | sensitivity。**没有"追问"这一类。** */
  kind: string;
  /** holds | weakened | refuted | inconclusive。 */
  verdict: string;
  /**
   * `{ summary, steps }`；追问产生的那些另有 `angle`，C6/C7 写的那些另有 `runId`。
   *
   * `runId` 是**追问轮数的计数单位**：一轮追问会写好几条记录，
   * 按条数数的话第一次追问就用光三次额度（2026-09-14 真跑踩到）。
   */
  payload: { summary?: string; steps?: number; angle?: string; runId?: string } | null;
  contradictedUnitIds: string[];
  /** 模型名——挑战是谁做的，跨模型版本要能分辨。 */
  createdBy: string;
  createdAt: string;
}

/**
 * 一张卡的挑战记录，按时间正序（上游 `orderBy: createdAt asc`）。
 *
 * **顺序不在这里重排**：追问产生的记录要接在它追问的那一次后面，
 * 而"哪一次在前"只有落库时间答得出。前端按 verdict 或 kind 分组重排的话，
 * 一条追问出来的记录会跑到它追问的对象前面去。
 */
export async function fetchChallenges(insightId: string): Promise<ChallengeRecord[]> {
  const res = await api.get<{ insight: { challenges?: ChallengeRecord[] } | null }>(
    `/console/research/insights/${encodeURIComponent(insightId)}`,
  );
  return res.insight?.challenges ?? [];
}
