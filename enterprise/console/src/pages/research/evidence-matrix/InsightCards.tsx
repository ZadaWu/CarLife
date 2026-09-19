/**
 * 洞察卡的渲染（施工单 M85-06）。
 *
 * 措辞与判定都在 `insight-model.ts`，这里只摆版式。
 * 唯一在这个文件里的决定是**徽章紧贴标题**——它必须与卡片正文一起被看见，
 * 放到卡片末尾的话，读完六栏才发现"这张卡的口径已经变了"，那时人已经信了。
 */

import type { ResearchInsight } from "../../../api/research-insight";
import type { ChallengeRecord } from "../../../api/research-challenge";
import { ChallengePanel } from "./ChallengePanel";
import {
  CARD_FIELDS,
  confidenceRows,
  freshnessOf,
  type FreshnessView,
} from "./insight-model";

/**
 * 挑战面的接线（M85-07）。三个回调一起给或一起不给——
 * 只给一半的话卡片下面会出现一个按了没反应的按钮。
 */
export interface ChallengeWiring {
  /** 每张卡的挑战记录，按 insightId 索引。没这一项就是"还没取到"。 */
  byInsight: Record<string, ChallengeRecord[]>;
  onChallenge: (insightId: string) => void;
  onFollowUp: (insightId: string, angle: string) => void;
  /** 正在跑的那张卡的 id。非本卡时两个按钮照常可点。 */
  busyInsightId?: string | null;
}

/** 口径徽章。一致时不渲染——不给"正常"状态留占位。 */
function FreshnessBadge({ v }: { v: FreshnessView }): JSX.Element | null {
  if (v.badge === null) return null;
  return (
    <span className={`uz-chip uz-chip--warn rm-freshness is-${v.kind}`} title={v.detail ?? undefined}>
      {v.badge}
    </span>
  );
}

/** 置信五分量。**最低那一项高亮**——卡上真正有用的是它，不是 c。 */
function Confidence({ insight }: { insight: ResearchInsight }): JSX.Element {
  const rows = confidenceRows(insight.confidence);
  return (
    <>
      <ul className="rm-conf">
        {rows.map((r) => (
          <li key={r.key} className={r.lowest ? "is-lowest" : undefined}>
            <span className="rm-conf-k">{r.label}</span>
            <span className="uz-bar rm-conf-bar">
              <i style={{ width: `${Math.round(r.value * 100)}%` }} />
            </span>
            <span className="rm-conf-v">{r.value.toFixed(2)}</span>
          </li>
        ))}
      </ul>
      <p className="rm-dim">
        C={insight.confidence.c.toFixed(2)}（几何平均）· 最低项 <b>{insight.confidence.lowest}</b>
      </p>
      {/* 这一句是固定映射不是模型生成——让模型编，它会写「建议收集更多数据」 */}
      <p className="rm-dim">{insight.confidence.suggestion}</p>
    </>
  );
}

export function InsightCard({
  insight,
  currentInputsHash,
  challenge,
}: {
  insight: ResearchInsight;
  currentInputsHash: string | null;
  /** 挑战面。不给就整块不渲染——接线之前这张卡与 M85-06 逐字相同。 */
  challenge?: ChallengeWiring;
}): JSX.Element {
  const fresh = freshnessOf(insight.inputsHash, currentInputsHash);
  return (
    <div className={`rm-insight is-${fresh.kind}`}>
      <div className="rm-insight-head">
        <strong className="rm-insight-theme">{insight.themeName || insight.themeId}</strong>
        <span className="uz-chip rm-insight-level">{insight.level}</span>
        <FreshnessBadge v={fresh} />
      </div>
      {fresh.detail ? <p className="rm-warn rm-insight-warn">{fresh.detail}</p> : null}

      <dl className="rm-card">
        {CARD_FIELDS.map(([key, label]) => (
          <div key={key} className="rm-card-row">
            <dt>{label}</dt>
            <dd>{insight.card[key]}</dd>
          </div>
        ))}
      </dl>

      <div className="rm-insight-sec">
        <h5>置信构成</h5>
        <Confidence insight={insight} />
      </div>

      <div className="rm-insight-sec">
        <h5>升级到 Candidate 还缺</h5>
        <ul className="rm-needs">
          {insight.upgradeNeeds.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>

      {/*
        挑战记录与追问（M85-07）。**排在升级申请之前**：
        「这张卡被推翻过没有」是决定要不要提它去评审的前提，
        排在按钮后面的话，人点完申请才看见下面有一条 refuted。
      */}
      {challenge ? (
        <div className="rm-insight-sec">
          <ChallengePanel
            insightId={insight.id}
            records={challenge.byInsight[insight.id] ?? []}
            onChallenge={challenge.onChallenge}
            onFollowUp={challenge.onFollowUp}
            busy={challenge.busyInsightId === insight.id ? insight.id : null}
          />
        </div>
      ) : null}

      <div className="rm-insight-foot">
        {/*
          「升级申请」只发起人工评审，**不直接改 level**——改它的唯一路径是
          `review/:threadId/resume`。口径不一致时连申请都不许发起（G5）：
          基于旧口径的卡，人工评审时看到的数字已经不是它写成时的那些了。
        */}
        <button
          type="button"
          className="btn-secondary"
          disabled
          title={
            fresh.canRequestUpgrade
              ? "升级申请要走人工评审（review/:threadId/resume），本单只做卡片展示"
              : `${fresh.badge}：${fresh.detail ?? ""}`
          }
        >
          申请升级为 Candidate
        </button>
        <span className="rm-dim rm-insight-owner">
          {insight.owner} · {new Date(insight.createdAt).toISOString().slice(0, 10)}
        </span>
      </div>
    </div>
  );
}

export function InsightList({
  insights,
  currentInputsHash,
  challenge,
}: {
  insights: ResearchInsight[];
  currentInputsHash: string | null;
  challenge?: ChallengeWiring;
}): JSX.Element {
  if (insights.length === 0) {
    // 「还没归纳过」与「归纳出来是空的」是两件事，文案要说得出这个区别。
    return <p className="rm-dim">这一格还没有洞察卡。点能力条上的「归纳这一格」出一张。</p>;
  }
  return (
    <>
      {insights.map((i) => (
        <InsightCard key={i.id} insight={i} currentInputsHash={currentInputsHash} challenge={challenge} />
      ))}
    </>
  );
}
