/**
 * 系统变更事件（施工单 M82-01）。
 *
 * # 趋势图上的每一个拐点，先问是不是我们自己干的
 *
 * 「本周低温续航的抱怨涨了 40%」——是天冷了，还是我们上周把 ASR 从 ark 换成了
 * aliyun、识别率变了？没有这条时间轴，第二种解释根本不会被想起来，
 * 而它恰好是最容易发生的一种（我们改自己的系统比车主改用车习惯频繁得多）。
 *
 * 所以趋势镜头把这些事件画成竖线，Challenger 也从这里取"系统变更替代解释"。
 *
 * # 密钥类只写"变更过"
 *
 * `config_item_revisions` 里有 `class: "secret"` 的项。把新旧值写进 summary，
 * 等于把密钥抄进一张会显示在控制台上的表。所以本函数对密钥类只产出事实
 * （某时刻某项变更过），不产出值——**这个判断在这里做，不留给调用方**。
 */

import type { ResearchSystemEvent } from "./types";

/**
 * `config_item_revisions` 的子集。
 *
 * ⚠️ 两个值都可空，而且**空的语义是"没记"不是"是空串"**：那张表只落 `prevValue`，
 * 新值在配置存储里。取数层能从同 key 的下一条修订倒推出新值，窗内最后一条倒推不出，
 * 于是 `newValue` 为 null。渲染成「（空）」会把"没记"说成"改成了空"——
 * 这是两件完全不同的事，后者在 `RESEARCH_RUNTIME_URL` 这种"空 = 关闭"的项上尤其致命。
 */
export interface ConfigRevisionRow {
  id: string;
  key: string;
  /** 变更时刻，毫秒。 */
  at: number;
  oldValue: string | null;
  newValue: string | null;
  /** 该配置项是不是密钥类（`config_item_revisions.is_secret`）。 */
  secret: boolean;
}

/** `guard_setting_revisions` 的子集。 */
export interface GuardRevisionRow {
  id: string;
  key: string;
  at: number;
  summary: string;
}

/** `job_runs` 里知识库同步那一类。 */
export interface KbSyncRunRow {
  id: string;
  job: string;
  at: number;
  /** 同步了哪个数据集；说不清就留空。 */
  dataset: string | null;
  ok: boolean;
}

/** 手工发布标记。仓库里没有部署表，这一类由人在 review 页登记。 */
export interface DeployMark {
  id: string;
  at: number;
  summary: string;
}

/** codebook 锁版。锁版即口径变更，跨版本的数字不能连成一条线。 */
export interface CodebookLockMark {
  version: string;
  at: number;
}

export interface DeriveSystemEventsInput {
  configRevisions?: readonly ConfigRevisionRow[];
  guardRevisions?: readonly GuardRevisionRow[];
  kbSyncRuns?: readonly KbSyncRunRow[];
  deployMarks?: readonly DeployMark[];
  codebookLocks?: readonly CodebookLockMark[];
}

const shorten = (v: string | null): string => {
  // "没记"与"是空串"必须分开，理由见 ConfigRevisionRow 的说明。
  if (v === null) return "（未记录）";
  if (v === "") return "（空）";
  return v.length <= 40 ? v : `${v.slice(0, 40)}…`;
};

export function deriveSystemEvents(input: DeriveSystemEventsInput): ResearchSystemEvent[] {
  const out: ResearchSystemEvent[] = [];

  for (const r of input.configRevisions ?? []) {
    out.push({
      kind: "config-change",
      at: r.at,
      key: r.key,
      summary: r.secret
        ? `${r.key} 变更过`
        : `${r.key}：${shorten(r.oldValue)} → ${shorten(r.newValue)}`,
      sourceRef: `config_item_revisions:${r.id}`,
    });
  }

  for (const r of input.guardRevisions ?? []) {
    out.push({
      kind: "guard-policy-change",
      at: r.at,
      key: r.key,
      summary: `护栏策略 ${r.key}：${r.summary}`,
      sourceRef: `guard_setting_revisions:${r.id}`,
    });
  }

  for (const r of input.kbSyncRuns ?? []) {
    out.push({
      kind: "kb-sync",
      at: r.at,
      key: r.dataset,
      summary: `知识库同步 ${r.dataset ?? r.job}${r.ok ? "" : "（失败）"}`,
      sourceRef: `job_runs:${r.id}`,
    });
  }

  for (const m of input.deployMarks ?? []) {
    out.push({ kind: "deploy", at: m.at, key: null, summary: m.summary, sourceRef: `deploy_mark:${m.id}` });
  }

  for (const m of input.codebookLocks ?? []) {
    out.push({
      kind: "codebook-lock",
      at: m.at,
      key: m.version,
      summary: `codebook ${m.version} 锁版——此前的编码口径与之后不可直接比较`,
      sourceRef: `research_codebooks:${m.version}`,
    });
  }

  // 按时刻升序；同刻按 sourceRef 稳定排序，两次生成的快照才逐字节相同。
  out.sort((a, b) => a.at - b.at || a.sourceRef.localeCompare(b.sourceRef));
  return out;
}
