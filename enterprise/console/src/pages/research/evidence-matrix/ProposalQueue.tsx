/**
 * 码提案的待审队列（施工单 M85-08）。
 *
 * 判定与措辞在 `proposal-model.ts`，这里只摆版式。三个在这个文件里的决定：
 *
 * ① **「codebook 一行未动」那句话排在采纳按钮旁边，不是点完才出现的提示。**
 *    点完才说的话，人已经以为自己把码开好了。
 * ② **理由填不出来就提交不了**，两个按钮一起禁用——没有理由的不是决定。
 * ③ **已决的提案不从界面上消失**，另起一组显示。只留待审的话，
 *    一条被驳回的提案会彻底消失，下个季度同一件事原样再提一遍。
 */

import { useState } from "react";

import type { ProposalRow } from "../../../api/research-proposal";
import {
  ACCEPTED_NOTE,
  cannibalView,
  decideIssue,
  decidedView,
  splitProposals,
} from "./proposal-model";

/** 「它会从哪几个现有码里吸走多少」。**这张表由服务端用代码算，不是模型填的。** */
function Cannibal({ p }: { p: NonNullable<ProposalRow["proposal"]> }): JSX.Element {
  const v = cannibalView(p.cannibalization, p.candidateUnits);
  return (
    <div className="rm-prop-cannibal">
      <h6>它会从哪几个现有码里吸走多少</h6>
      {v.rows.length > 0 ? (
        <table className="rm-break">
          <tbody>
            {v.rows.map((r) => (
              <tr key={r.code}>
                <td className="rm-break-label">{r.code}</td>
                <td className="rm-break-val">{r.units}</td>
                <td className="rm-break-pct">{Math.round(r.share * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {/* 零重叠不是「这个码很干净」，也不是「算错了」——文案要说得出这个区别 */}
      <p className="rm-dim">{v.note}</p>
    </div>
  );
}

function Proposal({
  row,
  onDecide,
  busy,
}: {
  row: ProposalRow;
  onDecide: (proposalId: string, decision: "accept" | "reject", rationale: string) => void;
  busy: boolean;
}): JSX.Element {
  const [rationale, setRationale] = useState("");
  const p = row.proposal;
  const issue = decideIssue(rationale);
  const settled = row.decided !== null;
  const view = row.decided ? decidedView(row.decided.decision) : null;

  return (
    <div className={`rm-prop${settled ? " is-settled" : ""}`}>
      <div className="rm-prop-head">
        <strong className="rm-prop-name">{p ? `「${p.codeName}」` : row.proposalId}</strong>
        {view ? <span className={`uz-chip rm-prop-verdict is-${view.tone}`}>{view.label}</span> : null}
        <span className="rm-dim rm-prop-by">
          {row.raisedBy} 提于 {String(row.raisedAt).slice(0, 10)}
        </span>
      </div>

      {p ? (
        <>
          <dl className="rm-card">
            <div className="rm-card-row">
              <dt>定义</dt>
              <dd>{p.definition}</dd>
            </div>
            <div className="rm-card-row">
              <dt>算进来</dt>
              <dd>{p.include}</dd>
            </div>
            <div className="rm-card-row">
              <dt>不算</dt>
              <dd>{p.exclude}</dd>
            </div>
            <div className="rm-card-row">
              <dt>来自</dt>
              <dd>
                兜底桶主题「{p.themeName}」· {p.candidateUnits} 个候选单元
              </dd>
            </div>
          </dl>

          <div className="rm-prop-sec">
            <h6>代表句（已脱敏）</h6>
            <ul className="rm-quotes">
              {p.exemplars.map((e, i) => (
                <li key={`${i}-${e.slice(0, 12)}`}>{e}</li>
              ))}
            </ul>
          </div>

          <Cannibal p={p} />
        </>
      ) : (
        // payload 读不出来时如实说，不渲染一张空卡——空卡看起来像"这条提案没内容"。
        <p className="rm-warn">这条提案的正文读不出来（台账里 payload 不是预期的形状）。</p>
      )}

      {settled && view ? (
        <div className="rm-prop-decided">
          <p className="rm-dim">
            {row.decided!.decidedBy} 于 {String(row.decided!.decidedAt).slice(0, 10)}：{row.decided!.rationale}
          </p>
          <p className="rm-dim">{view.next}</p>
        </div>
      ) : (
        <div className="rm-prop-ask">
          <label className="rm-dim" htmlFor={`why-${row.proposalId}`}>
            为什么（必填——没有理由的不是决定）
          </label>
          <textarea
            id={`why-${row.proposalId}`}
            className="rm-chal-input"
            rows={2}
            value={rationale}
            disabled={busy}
            onChange={(e) => setRationale(e.target.value)}
          />
          {/*
            这句话排在按钮**上面**，不是点完才出现的提示。
            点完才说的话，人已经以为自己把码开好了。
          */}
          <p className="rm-dim rm-prop-note">{ACCEPTED_NOTE}</p>
          <div className="rm-prop-foot">
            <button
              type="button"
              className="btn"
              disabled={busy || issue !== null}
              title={issue ?? ACCEPTED_NOTE}
              onClick={() => onDecide(row.proposalId, "accept", rationale.trim())}
            >
              采纳（记入台账，不改 codebook）
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || issue !== null}
              title={issue ?? "驳回也留在台账里：被驳回的提案证明了这件事被考虑过"}
              onClick={() => onDecide(row.proposalId, "reject", rationale.trim())}
            >
              驳回
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProposalQueue({
  rows,
  onDecide,
  busy = false,
}: {
  rows: ProposalRow[];
  onDecide: (proposalId: string, decision: "accept" | "reject", rationale: string) => void;
  busy?: boolean;
}): JSX.Element {
  const { pending, settled } = splitProposals(rows);

  if (rows.length === 0) {
    return (
      <p className="rm-dim">
        还没有码提案。点兜底桶那一行的「从兜底桶提码」——它产出的是「提案」，不是新码。
      </p>
    );
  }

  return (
    <div className="rm-prop-queue">
      <h5>待审（{pending.length}）</h5>
      {pending.length === 0 ? (
        <p className="rm-dim">没有待审的提案。</p>
      ) : (
        pending.map((r) => <Proposal key={r.proposalId} row={r} onDecide={onDecide} busy={busy} />)
      )}

      {settled.length > 0 ? (
        <>
          <h5>已决定（{settled.length}）</h5>
          {settled.map((r) => (
            <Proposal key={r.proposalId} row={r} onDecide={onDecide} busy={busy} />
          ))}
        </>
      ) : null}
    </div>
  );
}
