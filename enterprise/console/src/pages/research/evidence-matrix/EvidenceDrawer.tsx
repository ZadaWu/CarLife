/**
 * 证据栏（Brief `evidence-matrix.brief.md` §3⑦）。
 *
 * # 节的顺序照设计稿，缺数据的节**保留标题、写清在等什么**
 *
 * 不渲染的话，下次数据接上还要再排一次版，而且读的人不知道这一页本该有这些东西。
 * 但也**绝不用示例数字占位**——这一页是给研发看真实证据的，编一个 0.42 出来，
 * 它和真的长得一模一样。
 *
 * # 三种选中共用一个抽屉
 *
 * 格 / 整行 / 整列的差别只在「口径」那一行与「分解」那一节，其余节相同。
 * 拆成三个组件会让"允许用途"这类合规文案出现三份，而它们必须逐字一致。
 */

import { useEffect, useState } from "react";

import type { SelectionScope } from "@carlife/research/capabilities";
import type { RedTeamFinding } from "@carlife/research/red-team";

import {
  isLookup,
  railFor,
  runCapability,
  type CounterEvidenceList,
  type SegmentSlice,
  type SystemEventOverlap,
  type ThresholdSensitivity,
} from "../../../api/research-capability";
import { ApiError } from "../../../api";
import { LevelChip } from "../shell/LevelChip";
import type { MatrixDetail } from "../shell/model";
import type { ResearchInsight } from "../../../api/research-insight";
import { fetchChallenges, type ChallengeRecord } from "../../../api/research-challenge";
import { decideProposal, fetchProposals, type ProposalRow } from "../../../api/research-proposal";
import { AskPanel } from "./AskPanel";
import { isAskCapability, type AskCapabilityKey } from "./ask-model";
import { CapabilityRail } from "./CapabilityRail";
import { InsightList } from "./InsightCards";
import { behaviouralNote, confidenceRows, upgradeNeedsOf } from "./insight-model";
import { CounterEvidence, SegmentSlices, SystemEvents, Thresholds } from "./LookupPanels";
import { ProposalQueue } from "./ProposalQueue";
import { RunPanel } from "./RunPanel";

/** 置信 C 的五个分量，顺序与 `@carlife/research` 的 `confidenceOf` 一致。 */
const CONFIDENCE_FACTORS = ["Coverage", "Quality", "Agreement", "Triangulation", "Freshness"] as const;

/** 合规文案。**逐字与 Brief 一致**，不要在这里改措辞。 */
const USAGE_NOTE = "内部排序 · 原声已本地脱敏 · 禁止对外展示原文 · 回放记入操作审计";

function Pending({ what }: { what: string }): JSX.Element {
  return <p className="rm-dim rm-pending">{what}</p>;
}

/** 红队清单就地渲染。**不做成弹窗**：它回答的是"这一屏有什么问题"，该和数字待在一起。 */
function RedTeamList({ findings }: { findings: RedTeamFinding[] }): JSX.Element {
  if (findings.length === 0) {
    // 空数组是"五条规则一条都没触发"，不是"查过了没事"——文案要说得出这个区别。
    return <p className="rm-dim">五条规则都没触发。这不等于这一屏没问题，只等于这五条问不出问题。</p>;
  }
  return (
    <ul className="rm-redteam">
      {findings.map((x) => (
        <li key={x.rule} className={`is-${x.severity}`}>
          <p className="rm-redteam-msg">{x.message}</p>
          <p className="rm-dim rm-redteam-ev">{x.evidence}</p>
        </li>
      ))}
    </ul>
  );
}

/** 一次能力调用的界面状态。 */
type CapabilityRun =
  | { kind: "idle" }
  | { kind: "busy"; key: string }
  /**
   * `🔍` 层的结果。`result` 的形状由 `key` 决定——五条能力五个形状，
   * 联合类型得在这里再抄一遍它们。**按 key 分派时逐个断言**（下面的 `lookupOf`），
   * 而不是给一个 `any` 一路传下去：形状对不上时那样会渲染成空白而不报错。
   */
  | { kind: "lookup"; key: string; result: unknown }
  | { kind: "run"; key: string; runId: string }
  | { kind: "error"; key: string; message: string };

/** 这次 `🔍` 结果是不是这条能力的。不是就回 null，让调用处什么都不渲染。 */
const lookupOf = <T,>(run: CapabilityRun, ...keys: string[]): T | null =>
  run.kind === "lookup" && keys.includes(run.key) ? (run.result as T) : null;

export function EvidenceDrawer({
  detail,
  onClose,
  scope,
  contractId,
  insights: insightsProp,
  currentInputsHash = null,
  onInsightsChanged,
}: {
  detail: MatrixDetail;
  onClose: () => void;
  /** 语义范围。能力条按它决定长什么样；为 null（越界）时整条不渲染。 */
  scope?: SelectionScope | null;
  contractId?: string;
  /**
   * 这一格的洞察卡（M85-06）。空数组就是"还没归纳过"，页签仍关着。
   *
   * 由页面取、传进来而不是在这里取：抽屉随选中格反复挂载卸载，
   * 在这里取的话每换一格就重查一次全量卡片。
   */
  insights?: ResearchInsight[];
  /** 此刻的口径。与卡上那份比，不等即「口径已变」（G5）。 */
  currentInputsHash?: string | null;
  /** C1 跑完之后回调：页面重取卡片。不回调的话新卡要刷新页面才看得见。 */
  onInsightsChanged?: () => void;
}): JSX.Element {
  const f = detail.facts;
  const insights = insightsProp ?? [];
  const insightCount = insights.length;
  const [run, setRun] = useState<CapabilityRun>({ kind: "idle" });
  /*
   * 「问它」面板**不占 `run` 那一格**（M89-04）。
   *
   * 占了的话，点一条引用去查原声会把面板连同刚问出来的笔记一起顶掉——
   * 而那正是这个按钮唯一的用途。两者在页面上是并存的两块。
   */
  const [ask, setAsk] = useState<AskCapabilityKey | null>(null);
  /** 「证据详情」还是「相关洞察」。一张卡都没有时页签点不动，恒在前者。 */
  const [tab, setTab] = useState<"evidence" | "insights">("evidence");

  /*
   * 这一格每张卡的挑战记录（M85-07）。
   *
   * **按 insightId 索引而不是一个扁平数组**：一格下有几张卡，记录要接在各自
   * 那张卡下面。扁平存的话，追问轮数会按整格数——而上限是按卡算的，
   * 于是第一张卡问三次之后，第二张卡的追问框就灰了。
   */
  const [challenges, setChallenges] = useState<Record<string, ChallengeRecord[]>>({});
  /** 挑战记录重取的计数器。跑完一次 C6/C7 就 +1。 */
  const [chalTick, setChalTick] = useState(0);
  /** 正在被挑战的那张卡。非 null 时那张卡上的两个按钮按不动。 */
  const [busyInsight, setBusyInsight] = useState<string | null>(null);

  /*
   * 码提案队列（M85-08）。**只在兜底桶的行/格上取**——别的格上它恒空，
   * 每换一格查一次是白查；而队列是全局的，不属于某一格。
   */
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [propTick, setPropTick] = useState(0);
  const [propBusy, setPropBusy] = useState(false);
  const isCatchAll = detail.catchAll === true;
  useEffect(() => {
    if (!isCatchAll) return;
    let live = true;
    void fetchProposals()
      .then((rows) => {
        if (live) setProposals(rows);
      })
      .catch(() => {
        // 取不到就留空数组。队列为空与取数失败在界面上长得一样，
        // 但这一页已经有 `run.kind === "error"` 那条在说话了，不再叠一层。
      });
    return () => {
      live = false;
    };
  }, [isCatchAll, propTick]);

  const onDecideProposal = (proposalId: string, decision: "accept" | "reject", rationale: string): void => {
    setPropBusy(true);
    void decideProposal(proposalId, decision, rationale)
      .then(() => setPropTick((n) => n + 1))
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err);
        setRun({ kind: "error", key: "code-proposal-decided", message });
      })
      .finally(() => setPropBusy(false));
  };

  const insightKey = insights.map((i) => i.id).join(",");
  useEffect(() => {
    if (!insightKey) {
      setChallenges({});
      return;
    }
    let live = true;
    const ids = insightKey.split(",");
    void Promise.all(ids.map((id) => fetchChallenges(id).then((rs) => [id, rs] as const).catch(() => [id, []] as const)))
      .then((pairs) => {
        // 卸载后（或换了一格）不再 setState——换格很快，晚到的那一批会覆盖新的一批。
        if (live) setChallenges(Object.fromEntries(pairs));
      });
    return () => {
      live = false;
    };
  }, [insightKey, chalTick]);

  /*
   * C2 的结果不在能力条下面出，它**就地填进「反例」那一节**——
   * 同一个页面上出现两份反例（一份是快照的计数、一份是刚查出来的句子）
   * 是最容易被读成"两次不同的测量"的形状，而它们是同一批证据。
   */
  const counter = lookupOf<CounterEvidenceList>(run, "find-counter-evidence", "c2");
  const events = lookupOf<SystemEventOverlap>(run, "system-events", "c3");
  const slices = lookupOf<SegmentSlice>(run, "slice-by-segment", "c4");
  const thresholds = lookupOf<ThresholdSensitivity>(run, "threshold-sensitivity", "c5");
  const redTeam = lookupOf<RedTeamFinding[]>(run, "red-team", "c9");

  /*
   * 抽屉的 ①⑤⑥⑦⑨ 五节都从卡片取数（M85-06）。
   *
   * 多张卡时**只出第一张的分量并点名它是哪张**：几张卡的五分量平均起来会得到
   * 一组不属于任何一张卡的数，而它看起来完全正常。
   */
  const firstCard = insights[0] ?? null;
  const upgrade = upgradeNeedsOf(insights);
  const behaviour = behaviouralNote(insights);

  const onRun = (key: string): void => {
    if (!scope || !contractId) return;
    /*
     * `💬 问它` 点下去**只开面板，不发请求**：最要紧的入参（问题本身）
     * 此刻还不存在，带着空问题发出去只会换回一个 400。
     */
    if (isAskCapability(key)) {
      setAsk(key);
      return;
    }
    setRun({ kind: "busy", key });
    void runCapability(key, scope, contractId)
      .then((res) => {
        if (isLookup(res)) setRun({ kind: "lookup", key, result: res.result });
        else setRun({ kind: "run", key, runId: res.runId });
      })
      .catch((err: unknown) => {
        /*
         * 服务端的错误码原样带出来。尤其 `capability_not_available`：
         * 它意味着这一格在**后端**看来是抑制的，而界面把按钮画出来了——
         * 那是两侧判据分叉的唯一现象，换成一句"操作失败"就再也看不见了。
         */
        const message = err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err);
        setRun({ kind: "error", key, message });
      });
  };

  /**
   * C6 / C7：范围是**一张卡**，不是当前选中的格（M85-07）。
   *
   * 不复用 `onRun`：它把 `scope` 写死成抽屉当前的选中范围，而挑战的对象
   * 是卡片列表里被点的那一张。复用的话服务端会收到一个 `cell` 范围，
   * 被 G1 的闸门判成 `capability_not_available`——看起来像这一格被抑制了。
   */
  const runOnCard = (key: string, insightId: string, extra: Record<string, unknown> = {}): void => {
    if (!contractId) return;
    setBusyInsight(insightId);
    setRun({ kind: "busy", key });
    void runCapability(key, { kind: "card", insightId }, contractId, extra)
      .then((res) => {
        if (isLookup(res)) setRun({ kind: "lookup", key, result: res.result });
        else setRun({ kind: "run", key, runId: res.runId });
      })
      .catch((err: unknown) => {
        /*
         * `follow_up_limit_reached` 这一条尤其要原样带出来：它说的是"次数到头了"，
         * 换成一句"操作失败"的话，人会以为是自己写得不对，改措辞再试三次。
         */
        const message = err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err);
        setRun({ kind: "error", key, message });
        setBusyInsight(null);
      });
  };

  /** 挑战面的接线。三个回调一起给——只给一半会出现按了没反应的按钮。 */
  const challengeWiring = {
    byInsight: challenges,
    onChallenge: (id: string) => runOnCard("challenge-card", id),
    onFollowUp: (id: string, angle: string) => runOnCard("follow-up", id, { angle }),
    busyInsightId: busyInsight,
  };

  return (
    <div className="rm-drawer">
      <div className="rm-drawer-tabs">
        <span className={`rm-tab${tab === "evidence" ? " is-on" : ""}`} onClick={() => setTab("evidence")}>
          证据详情
        </span>
        {/*
          相关洞察的条数来自洞察卡；**一张都没有时连括号都不出**——
          写一个「（0）」出来，读的人分不清是"查过了没有"还是"还没接上"。
          条数为 0 时这个页签与接线之前逐字相同。
        */}
        <span
          className={`rm-tab${insightCount > 0 ? (tab === "insights" ? " is-on" : "") : " is-off"}`}
          title={insightCount > 0 ? undefined : "这一格还没有洞察卡——点能力条上的「归纳这一格」"}
          onClick={insightCount > 0 ? () => setTab("insights") : undefined}
        >
          相关洞察{insightCount > 0 ? `（${insightCount}）` : ""}
        </span>
        <button type="button" className="rm-drawer-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>

      <div className="rm-drawer-body">
        <div className="rm-drawer-title">
          <strong>{detail.title}</strong>
          <LevelChip level="signal" />
        </div>
        <p className="rm-drawer-scope">{detail.scope}</p>
        {detail.undeliverable ? (
          <p className="rm-drawer-ban">落在硬禁范畴，标为不可交付——证据量照显，但不进 roadmap。</p>
        ) : null}
        {detail.catchAll ? (
          <p className="rm-drawer-ban">
            这是<b>兜底桶</b>，不是一件具体的事——它是「有明确诉求但归不上现有十个码」的合计。
            照着它派活会派出一个没有对象的需求；它真正该触发的动作是<b>补 codebook</b>。
          </p>
        ) : null}

        {detail.suppressedReason ? (
          <div className="rm-drawer-sec">
            <p className="rm-suppress-note">{detail.suppressedReason}</p>
          </div>
        ) : null}

        {/*
          能力条：标题与口径之下、「话语 × 行为」之上（设计稿 §5.1 的版式）。
          被抑制的格上它只出一句话、零按钮——那是 G1 在界面上的落点。
        */}
        {contractId ? (
          <CapabilityRail
            scope={scope ?? null}
            suppressedReason={detail.suppressedReason}
            onRun={onRun}
            busy={run.kind === "busy" ? run.key : null}
          />
        ) : null}

        {ask && scope && contractId ? (
          <div className="rm-drawer-sec rm-cap-out">
            <AskPanel
              /*
               * 换了格就换一个面板：`scope` 变了而组件不重挂的话，上一格的
               * 历史轮次会接在新一格的问答下面，读起来像是同一串对话。
               */
              key={`${ask}:${JSON.stringify(scope)}`}
              capability={ask}
              scope={scope}
              contractId={contractId}
              /*
               * 引用点开走这一格既有的 `🔍 找反例`——服务端没有按 unitId 单查的接口。
               * 这个范围上没有那条能力（卡片 / 整屏）时不传：一个点了没反应的按钮
               * 比一段纯文本更糟。
               */
              onCiteUnit={
                railFor(scope).some((c) => c.key === "find-counter-evidence")
                  ? () => onRun("find-counter-evidence")
                  : undefined
              }
            />
            <button type="button" className="btn-secondary rm-ask-close" onClick={() => setAsk(null)}>
              收起问答
            </button>
          </div>
        ) : null}
        {redTeam ? (
          <div className="rm-drawer-sec rm-cap-out">
            <h4>这一屏的红队清单</h4>
            <RedTeamList findings={redTeam} />
          </div>
        ) : null}
        {events ? (
          <div className="rm-drawer-sec rm-cap-out">
            <h4>这是我们自己干的吗</h4>
            <SystemEvents data={events} />
          </div>
        ) : null}
        {slices ? (
          <div className="rm-drawer-sec rm-cap-out">
            <h4>谁被漏掉了</h4>
            <SegmentSlices data={slices} />
          </div>
        ) : null}
        {thresholds ? (
          <div className="rm-drawer-sec rm-cap-out">
            <h4>换个阈值还成立吗</h4>
            <Thresholds data={thresholds} />
          </div>
        ) : null}
        {run.kind === "run" ? (
          <div className="rm-drawer-sec rm-cap-out">
            <RunPanel
              runId={run.runId}
              title={run.key}
              /*
               * 跑完之后重取什么，**按跑的是哪条能力分**：
               * C1 出的是卡（重取卡），C6/C7 出的是挑战记录（重取记录）。
               * 一律两样都重取的话，一次挑战会把整页的卡重画一遍——
               * 那看起来像"挑战把卡改了"，而它恰恰不该改。
               */
              onDone={() => {
                if (run.key === "summarize-cell") onInsightsChanged?.();
                else if (run.key === "propose-code") setPropTick((n) => n + 1);
                else setChalTick((n) => n + 1);
              }}
              // 成功失败都解锁：只在成功上解的话，一次失败会把那张卡的按钮永久禁用。
              onSettled={() => setBusyInsight(null)}
            />
          </div>
        ) : null}
        {run.kind === "error" ? (
          <div className="rm-drawer-sec rm-cap-out">
            <p className="rm-run-err">{run.key} 没跑成：{run.message}</p>
          </div>
        ) : null}

        {/*
          「相关洞察」页签（M85-06）。能力条留在上面——归纳这一格是从这里发起的，
          切到卡片列表之后还要能再点一次。
        */}
        {tab === "insights" ? (
          <div className="rm-drawer-sec">
            <InsightList
              insights={insights}
              currentInputsHash={currentInputsHash}
              challenge={challengeWiring}
            />
          </div>
        ) : (
        <>
        {/* ① 话语 × 行为 */}
        <div className="rm-drawer-sec">
          <h4>话语 × 行为</h4>
          {f ? (
            <p className="rm-facts">
              话语 / <b>{f.n.toLocaleString("zh-CN")}</b> 条证据单元 · 分母{" "}
              <b>{f.N.toLocaleString("zh-CN")}</b>
              {/* 只有单格的 n/N 才是提及率；整行 / 整列是码次相加，出百分比会被读错 */}
              {f.rateMeaningful ? ` · ${Math.round(f.pct * 100)}%` : null}
              <span className="rm-dir rm-facts-dir">{f.glyph}</span>
              <span className={`rm-counter${f.counter === 0 ? " is-zero" : ""}`}>✗{f.counter}</span>
            </p>
          ) : null}
          {f && !f.rateMeaningful ? (
            <p className="rm-dim">
              这两个数是各格<b>相加</b>得来的：一轮可同时归入多个场景、也可挂多个需求码，
              所以它们都不是去重值，<b>相除不是提及率</b>——要看提及率请点具体的格。
            </p>
          ) : null}
          {/*
            行为侧：M85-06 起由卡片的边界栏填。
            **这一栏今天必然说的是"没有行为侧对证"**——`synthesizeOne` 据实传
            `present: false`（`CodedTurn` 不带行程指标）。显示卡上那句话而不是
            界面另编一句，是因为编出来的那句和真的长得一模一样。
          */}
          {behaviour ? (
            <p className="rm-dim">{behaviour}</p>
          ) : (
            <Pending what="行为侧（对证的行程数与温度—续航对照）要等快照补 utterance / behavior 拆分，本页不自己算比率。归纳这一格之后，卡片的边界栏会说明三角验证成不成立。" />
          )}
        </div>

        {/*
          码提案队列（M85-08）。**只在兜底桶上出**——它是兜底桶那句
          「它真正该触发的动作是补 codebook」的落点，别的格上没有意义。
        */}
        {isCatchAll ? (
          <div className="rm-drawer-sec">
            <h4>码提案</h4>
            <ProposalQueue rows={proposals} onDecide={onDecideProposal} busy={propBusy} />
          </div>
        ) : null}

        {/* ② 逐项分解：只有整行 / 整列选中时才有 */}
        {detail.breakdown.length > 0 ? (
          <div className="rm-drawer-sec">
            <h4>{detail.selection.kind === "row" ? "按场景分解" : "按需求码分解"}</h4>
            <table className="rm-break">
              <tbody>
                {detail.breakdown.map((b) => (
                  <tr key={b.label} className={b.suppressed ? "is-dim" : undefined}>
                    <td className="rm-break-label">{b.label}</td>
                    {b.suppressed ? (
                      <td className="rm-break-val" colSpan={2}>
                        样本不足
                      </td>
                    ) : (
                      <>
                        <td className="rm-break-val">
                          {b.n}/{b.N}
                        </td>
                        <td className="rm-break-pct">{Math.round(b.pct * 100)}%</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/*
          ③ 典型原声：**仍然是 Pending**，而且是有意的。

          C2「找反例」拿回来的只有 `counterUnitIds` 那一批（工具只放行反例，
          而 `challenge/tools.ts` 是本单的红线，不能给它加一个"取典型成员"的分支）。
          把反例填进这一节会让一批**与主流相反**的声音顶着「典型」的标题出现——
          那正是 §18.7「摘要即证据」要防的形状，而且看不出来。
          这一节要的仍然是按「需求码 × 场景」筛的逐条原声。
        */}
        <div className="rm-drawer-sec">
          <h4>典型原声</h4>
          <Pending what="逐条原声要按「需求码 × 场景」筛，而 /console/research/evidence 目前只能按 kind 与 counter 筛。C2「找反例」填不了这一节——它只取反例，顶着「典型」的标题出现会把结论读反。接上之后每条只出脱敏派生文本并带「已脱敏」徽章。" />
        </div>

        {/* ④ 反例：M85-05 起句子是真的了——点「找反例」即时查出来 */}
        <div className="rm-drawer-sec">
          <h4>反例{f ? `（${f.counter}）` : ""}</h4>
          {counter ? (
            <CounterEvidence data={counter} />
          ) : f && f.counter === 0 ? (
            <p className="rm-dim">
              这一格 0 条反例。<b>0 不是好消息</b>——它更可能意味着没去找。
            </p>
          ) : (
            <Pending what="条数来自快照。点能力条上的「找反例」即时查出逐条句子（不写库）。" />
          )}
        </div>

        {/*
          ⑤ 置信构成：M85-06 起由洞察卡填满。
          **多张卡时只出第一张的分量并点名它是哪张**——把几张卡的五分量平均起来
          会得到一组不属于任何一张卡的数，而它看起来完全正常。
        */}
        <div className="rm-drawer-sec">
          <h4>置信构成</h4>
          {firstCard ? (
            <>
              <ul className="rm-conf">
                {confidenceRows(firstCard.confidence).map((r) => (
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
                来自「{firstCard.themeName || firstCard.themeId}」这张卡（C={firstCard.confidence.c.toFixed(2)}，
                最低项 <b>{firstCard.confidence.lowest}</b>）
                {insightCount > 1 ? `；这一格还有另外 ${insightCount - 1} 张卡，各自的分量在「相关洞察」里` : ""}
              </p>
              <p className="rm-dim">{firstCard.confidence.suggestion}</p>
              {/* Agreement 那一层照旧要说明——复编码一致率至今未测，它据实算成 0 */}
              <p className="rm-dim">
                Agreement 另有一层：复编码一致率至今未测（M82-10），<b>据实算作 0</b> 而不是给一个中间值。
              </p>
            </>
          ) : (
            <>
              <ul className="rm-conf">
                {CONFIDENCE_FACTORS.map((k) => (
                  <li key={k}>
                    <span className="rm-conf-k">{k}</span>
                    <span className="uz-bar rm-conf-bar">
                      <i style={{ width: 0 }} />
                    </span>
                    <span className="rm-conf-v">—</span>
                  </li>
                ))}
              </ul>
              <Pending what="五个分量由 confidenceOf() 逐主题算，跟着洞察卡一起落库。这一格还没有卡——点能力条上的「归纳这一格」。" />
            </>
          )}
        </div>

        {/* ⑥ 升级到 Candidate 还缺：M85-06 起来自卡片的 upgrade_needs */}
        <div className="rm-drawer-sec">
          <h4>升级到 Candidate 还缺</h4>
          {upgrade.needs.length > 0 ? (
            <ul className="rm-needs">
              {upgrade.needs.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          {/* 没有卡时如实说没有，不拿一句通用的「证据不足」顶上 */}
          {upgrade.note ? <p className="rm-dim">{upgrade.note}</p> : null}
        </div>

        {/* ⑦ 已知偏差 */}
        <div className="rm-drawer-sec">
          <h4>已知偏差</h4>
          <p className="rm-dim">
            仅覆盖已授权车主——观察总体不等于市场总体，本页结论一律 Signal 级。
          </p>
          {/* 卡片自己写的边界栏。界面不另编一句——卡上写了什么就显示什么 */}
          {behaviour ? <p className="rm-dim">{behaviour}</p> : null}
          <Pending what="其余偏差（如「冬季数据仅一个季度」）要读研究合同的 exclusions / freshness，而合同接口目前只回 id / title / status——洞察卡补不了这一处，它写的是这张卡自己的边界，不是这次研究声明的排除项。" />
        </div>

        {/* ⑧ 允许用途：唯一一节现在就完整，因为它是政策不是数据 */}
        <div className="rm-drawer-sec">
          <h4>允许用途</h4>
          <p className="rm-dim">{USAGE_NOTE}</p>
        </div>

        {/* ⑨ 责任人 / 复查日 */}
        <div className="rm-drawer-sec">
          <h4>责任人 / 复查日</h4>
          {firstCard ? (
            <p className="rm-dim">
              卡片归属：<b>{firstCard.owner}</b>
              {firstCard.reviewAt ? ` · 复查日 ${firstCard.reviewAt.slice(0, 10)}` : " · 还没定复查日"}
            </p>
          ) : null}
          {/*
            **这一节仍是 Pending，而且是有意的**：卡上的 owner 是
            `research:unassigned` 这个常量（研究面没有登录态），
            它回答不了"这一格归谁"。真正的责任人在研究合同上，而合同接口只回
            id / title / status——拿卡上那个常量顶替，页面上就会出现一个
            看起来有人负责、其实没有的名字。
          */}
          <Pending what="这一格归谁、什么时候复查，来自研究合同的 owner 与 reviewAt；合同接口目前只回 id / title / status。卡片上的 owner 是 research:unassigned 这个常量（研究面没有登录态），顶替不了它。" />
        </div>
        </>
        )}
      </div>

      <div className="rm-drawer-foot">
        <button type="button" className="btn" disabled title="逐条证据接口要先支持按码 × 场景筛">
          查看全部证据{f ? `（${f.n.toLocaleString("zh-CN")}）` : ""}
        </button>
        <button type="button" className="btn-secondary" disabled title="要先能定位到具体的证据单元">
          回放原声（记入审计）
        </button>
      </div>
    </div>
  );
}
