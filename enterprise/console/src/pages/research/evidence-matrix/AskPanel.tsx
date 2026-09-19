/**
 * 「问它」面板：问句输入 → 运行流 → 一条 `AgentNote`（施工单 M89-04）。
 *
 * 措辞与判定都在 `ask-model.ts`，笔记的版式在 `AgentNoteView.tsx`，这里只管
 * 一次提问的**生命周期**。四个在这个文件里的决定：
 *
 * ① **点能力条上的「问分析师」不发请求，只把面板打开。**
 *    `💬` 层与 `✎` 层的差别就在这里：写类能力点下去就该跑，而问类能力还缺
 *    最要紧的那个入参——问题本身。点一下就带着空问题发出去，服务端会回
 *    400 `question_rejected`，而用户什么都还没做。
 *
 * ② **历史轮次留在组件状态里，不落库、不回填输入框。**
 *    笔记是研究员的草稿（M89-00 决策 5：不落库）。关抽屉即失，这是刻意的——
 *    半持久的东西会被当成留底，而它在服务端一行都没有。
 *
 * ③ **追问建议点了只是填进输入框，不直接发出去。**
 *    一轮要烧十几秒模型时间，且额度只有 5 轮。"点一下就跑"的按钮会让人
 *    在读完之前先点掉两轮。
 *
 * ④ **400 / 503 就地显示，不弹窗。**
 *    弹窗关掉之后，"为什么没跑"这件事在页面上就不留痕迹了。
 */

import { useState } from "react";

import { ApiError } from "../../../api";
import {
  capabilityErrorText,
  isLookup,
  runCapability,
  type SelectionScope,
} from "../../../api/research-capability";
import { AgentNoteView } from "./AgentNoteView";
import {
  ASK_MAX_ROUNDS,
  ASK_ROLES,
  MAX_QUESTION_CHARS,
  askExtra,
  askQuota,
  noteOf,
  questionIssue,
  type AgentNote,
  type AskCapabilityKey,
} from "./ask-model";
import { RunPanel } from "./RunPanel";

/** 已经答完的一轮。问句与笔记成对留着——单看笔记认不出它答的是哪一问。 */
interface AskedRound {
  round: number;
  question: string;
  note: AgentNote | null;
}

export function AskPanel({
  capability,
  scope,
  contractId,
  onCiteUnit,
}: {
  capability: AskCapabilityKey;
  scope: SelectionScope;
  contractId: string;
  /**
   * 点一条引用的证据单元。由抽屉接到它既有的 `🔍 找反例` 上——
   * 服务端没有"按 unitId 单查"的接口，不为这一下新开一条路径。
   * 这个范围上没有那条能力时不传，引用就以文本出现（见 `AgentNoteView`）。
   */
  onCiteUnit?: (unitId: string) => void;
}): JSX.Element {
  const role = ASK_ROLES[capability];
  const [question, setQuestion] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [limit, setLimit] = useState(ASK_MAX_ROUNDS);
  const [note, setNote] = useState<AgentNote | null>(null);
  /** 已答完的前几轮，折叠着。最新的那一轮不在这里，它在 `note` 上。 */
  const [history, setHistory] = useState<AskedRound[]>([]);
  /** 这一轮问的是哪一句。运行面板上要说得出来。 */
  const [asked, setAsked] = useState("");
  const [error, setError] = useState<string | null>(null);

  const quota = askQuota(round, limit);
  const issue = questionIssue(question);
  const running = runId !== null && note === null && error === null;
  const blocked = !quota.can || running;

  const ask = (): void => {
    const text = question.trim();
    if (questionIssue(text) !== null || blocked) return;

    // 上一轮的笔记在发出新一问的那一刻收进历史——留在原地会让人以为它是新答案。
    if (note) setHistory((prev) => [...prev, { round, question: asked, note }]);
    setNote(null);
    setError(null);
    setAsked(text);
    setRunId(null);

    void runCapability(capability, scope, contractId, askExtra(text))
      .then((res) => {
        if (isLookup(res)) {
          // `💬` 层不会走到这里；真走到了说明目录与端点分叉了，如实说出来。
          setError(`${capability} 回的是即时结果，不是一次运行——回去核对能力目录的 tier`);
          return;
        }
        setRunId(res.runId);
        setRound(res.round ?? round + 1);
        setLimit(res.limit ?? limit);
        setQuestion("");
      })
      .catch((err: unknown) => {
        /*
         * 三条业务码各有自己的话：`ask_limit_reached` 说的是"次数到头了"，
         * 换成一句"操作失败"的话，人会以为是自己写得不对，改措辞再试几次。
         */
        setError(
          err instanceof ApiError
            ? capabilityErrorText(err.code)
            : err instanceof Error
              ? err.message
              : String(err),
        );
        setAsked("");
      });
  };

  return (
    <div className="rm-ask-panel">
      <div className="rm-ask-head">
        <h5>问{role.name}</h5>
        {/* 「它准备什么 / 它绝不决定什么」同时出现。只写前半句等于把这个面板的前提删掉。 */}
        <p className="rm-dim rm-ask-role">
          它准备：{role.prepares}；它<b>绝不决定</b>：{role.neverDecides}
        </p>
      </div>

      {history.length > 0 ? (
        /* 折叠着：读的人此刻要看的是最新那一轮，前几轮是需要时才翻的上下文。 */
        <details className="rm-ask-history">
          <summary>前 {history.length} 轮（关掉这个抽屉就没了，服务端没有留底）</summary>
          {history.map((h) => (
            <div key={`${h.round}-${h.question.slice(0, 12)}`} className="rm-ask-past">
              <p className="rm-ask-q">第 {h.round} 轮问：{h.question}</p>
              {h.note ? (
                <AgentNoteView note={h.note} onCiteUnit={onCiteUnit} />
              ) : (
                <p className="rm-dim">这一轮没拿到笔记。</p>
              )}
            </div>
          ))}
        </details>
      ) : null}

      <div className="rm-ask-input">
        <label className="rm-dim" htmlFor={`ask-${capability}`}>
          问一个问题（查什么由它自己定，工具全只读）
        </label>
        <textarea
          id={`ask-${capability}`}
          className="rm-chal-input"
          rows={3}
          maxLength={MAX_QUESTION_CHARS}
          value={question}
          disabled={blocked}
          placeholder={quota.can ? "这一格的冷车续航抱怨，主要出在充电前还是充电后？" : "已经问满了"}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <p className={`rm-dim rm-ask-quota${quota.can ? "" : " is-spent"}`}>
          {quota.note} · {question.trim().length} / {MAX_QUESTION_CHARS} 字
        </p>

        <div className="rm-ask-foot">
          <button
            type="button"
            className="btn"
            disabled={blocked || issue !== null}
            title={
              !quota.can
                ? quota.note
                : running
                  ? "这一轮还在跑"
                  : (issue ?? "它会自己循环调只读工具去查，最多 8 步，产出一条带引用的笔记")
            }
            onClick={ask}
          >
            问
          </button>
        </div>
      </div>

      {error ? (
        // 原样就地显示。这是"为什么没跑成"在页面上唯一的落点。
        <p className="rm-run-err rm-ask-err">没问成：{error}</p>
      ) : null}

      {runId ? (
        <RunPanel
          key={runId}
          runId={runId}
          title={`问${role.name}：${asked}`}
          /*
           * 笔记只从**归约后的** `state.result` 取一次。收不成形状就置 null，
           * 由 `AgentNoteView` 那几段如实说空——静默留着上一轮的笔记更糟。
           */
          onDone={(result) => setNote(noteOf(result))}
        />
      ) : null}

      {note ? (
        <AgentNoteView
          note={note}
          onCiteUnit={onCiteUnit}
          // 问满了就不让点建议——点了只会填进一个按不动的输入框。
          onPickQuestion={quota.can ? (q) => setQuestion(q) : undefined}
        />
      ) : null}
    </div>
  );
}
