/**
 * 一张卡的挑战记录与追问框（施工单 M85-07）。
 *
 * 措辞与判定都在 `challenge-model.ts`，这里只摆版式。三个在这个文件里的决定：
 *
 * ① **追问结果接在同一列表里，不另开聊天区。**
 *    设计稿明写：新开一块聊天日志会造出第二个真相源，而它和抽屉里的正文会各说各的。
 *    追问产生的记录与 C6 产生的长得几乎一样，只多一行"顺着这个角度追的"。
 *
 * ② **判决四态各有渲染分支，没有默认兜底。**
 *    表外的取值走 `unknown` 档并把"这是表外的"显示出来——静默显示成别的，
 *    就是"模型返回了个新判决而没人知道"。
 *
 * ③ **到顶之后输入框禁用、按钮禁用，且说清为什么。**
 *    留着可点、让服务端回 400 的话，用户会以为是自己写得不对，改措辞再试。
 */

import { useState } from "react";

import type { ChallengeRecord } from "../../../api/research-challenge";
import {
  angleIssue,
  challengeRows,
  followUpState,
  MAX_ANGLE_CHARS,
  type ChallengeRow,
} from "./challenge-model";

function Row({ row }: { row: ChallengeRow }): JSX.Element {
  const v = row.verdict;
  return (
    <li className={`rm-chal is-${v.tone}${v.unknown ? " is-unknown" : ""}${row.angle ? " is-followup" : ""}`}>
      <div className="rm-chal-head">
        <span className={`uz-chip rm-chal-verdict is-${v.tone}`}>{v.label}</span>
        <span className="rm-dim rm-chal-kind">{row.kind}</span>
      </div>
      {/* 追问的角度排在摘要**前面**：先说这一条是顺着什么问的，再看它答了什么 */}
      {row.angle ? <p className="rm-chal-angle">顺着这个角度追的：{row.angle}</p> : null}
      <p className="rm-chal-summary">{row.summary}</p>
      <p className="rm-dim rm-chal-meta">
        {row.steps === null ? "没记走了几步" : `查了 ${row.steps} 步`} · 矛盾证据 {row.contradicted} 条 ·{" "}
        {row.createdBy}
      </p>
      {/* 判决**意味着要做什么**，不是复述它的英文名 */}
      <p className="rm-dim rm-chal-meaning">{v.meaning}</p>
    </li>
  );
}

export function ChallengePanel({
  insightId,
  records,
  onChallenge,
  onFollowUp,
  busy = null,
}: {
  insightId: string;
  records: ChallengeRecord[];
  /** 点「再挑战一次」。由上层去调 C6 并开运行态面板。 */
  onChallenge: (insightId: string) => void;
  /** 点「追问」。由上层去调 C7。 */
  onFollowUp: (insightId: string, angle: string) => void;
  /** 这张卡正在跑的能力名；非 null 时两个按钮都按不动。 */
  busy?: string | null;
}): JSX.Element {
  const [angle, setAngle] = useState("");
  const rows = challengeRows(records);
  const fu = followUpState(records);
  const issue = angleIssue(angle);
  const running = busy !== null;

  return (
    <div className="rm-chal-panel">
      <h5>
        挑战记录{rows.length > 0 ? `（${rows.length}）` : ""}
      </h5>

      {rows.length === 0 ? (
        /*
         * 「还没挑过」与「挑过了没挑出东西」是两件事。后者在库里是一条
         * verdict 为 holds 的记录，会走上面那条分支——这里只说前者。
         */
        <p className="rm-dim">这张卡还没有被挑战过。点下面那个按钮，Challenger 会带四个只读工具去找反例。</p>
      ) : (
        <ul className="rm-chal-list">
          {rows.map((r) => (
            <Row key={r.id} row={r} />
          ))}
        </ul>
      )}

      <div className="rm-chal-ask">
        <label className="rm-dim" htmlFor={`angle-${insightId}`}>
          追问（只作为额外的调查角度，不改判定口径）
        </label>
        <textarea
          id={`angle-${insightId}`}
          className="rm-chal-input"
          rows={2}
          maxLength={MAX_ANGLE_CHARS}
          value={angle}
          disabled={!fu.can || running}
          placeholder={fu.can ? "这会不会只是冬天那一个季度的事？" : "已经问到上限了"}
          onChange={(e) => setAngle(e.target.value)}
        />
        <p className={`rm-dim rm-chal-quota${fu.can ? "" : " is-spent"}`}>{fu.note}</p>

        <div className="rm-chal-foot">
          <button
            type="button"
            className="btn-secondary"
            disabled={running}
            title={running ? "这张卡上还有一次挑战在跑" : "带四个只读工具再找一遍反例，不带任何额外角度"}
            onClick={() => onChallenge(insightId)}
          >
            再挑战一次
          </button>
          <button
            type="button"
            className="btn"
            disabled={!fu.can || running || issue !== null}
            title={!fu.can ? fu.note : (issue ?? "顺着这个角度再挑一次，产出仍是一条挑战记录")}
            onClick={() => onFollowUp(insightId, angle.trim())}
          >
            追问
          </button>
        </div>
      </div>
    </div>
  );
}
