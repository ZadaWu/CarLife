/**
 * Agent 发起的对话交互卡片（施工单 M106-04，FL-20 F-20-08 / F-20-15）：单选 / 多选（都可带「其他」）/ 开放题 /
 * 操作引导 / 拍照。挂在对话列表末尾（`DialogScreen.trailing`），取代 M104 的补拍卡与追问卡。
 *
 * 内容**只来自 `report.prompts`**——服务端的预算器已经裁决过（放行哪几张、什么顺序），端上不造题、不排序、
 * 不解析回答文本。回传一律是一轮用户消息（`onAnswer`）；拍照那张回到拍照页（`onCapture`）。
 *
 * # 它不是确认弹窗
 *
 * `ConfirmDialog` 是跨层 overlay：那笔动作挂着，不答就不做。这些卡在列表里、属于那一轮：
 * 不答照样继续，车主可以直接打字绕过。所以这里没有遮罩、没有 busy 态、没有「知道了」。
 */
import { useState } from "react";

import { INTERACTION_OTHER_LABEL, isAskPrompt, type InteractionCapture, type InteractionChoice, type InteractionGuidance, type InteractionPrompt } from "@carlife/shared";

import { EMPTY_ASK, composeAnswers, composeOutcome, sendsOnPick, togglePick, type AskPrompt, type AskState } from "./prompt-answers";

import "./diagnosis.css";

/** iOS 键盘顶起来之后卡片可能被盖住：聚焦时滚到可见处。`nearest` = 已经看得见就不动。 */
function keepVisible(el: HTMLElement) {
  el.scrollIntoView?.({ block: "nearest" });
}

function ChoiceRow({ ask, state, disabled, onPick, onOther }: { ask: InteractionChoice; state: AskState; disabled: boolean; onPick: (opt: string) => void; onOther: (text: string) => void }) {
  const multi = ask.kind === "multi";
  const options = ask.allowOther ? [...ask.options, INTERACTION_OTHER_LABEL] : ask.options;
  const otherOpen = state.picked.includes(INTERACTION_OTHER_LABEL);
  return (
    <div className="dx-q" data-kind={ask.kind}>
      <span className="dx-q__text">
        {ask.text}
        {multi && <span className="dx-q__tag">可多选</span>}
      </span>
      <span className="dx-q__opts" role={multi ? "group" : "radiogroup"} aria-label={ask.text}>
        {options.map((opt) => {
          const picked = state.picked.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              role={multi ? "checkbox" : "radio"}
              aria-checked={picked}
              disabled={disabled}
              className={`dx-opt${multi ? " dx-opt--multi" : ""}${picked ? " is-picked" : ""}`}
              onClick={() => onPick(opt)}
            >
              {opt}
            </button>
          );
        })}
      </span>
      {otherOpen && (
        <input
          className="dx-other"
          type="text"
          value={state.other}
          disabled={disabled}
          placeholder="说说是什么情况"
          aria-label={`${ask.text} 其他`}
          onFocus={(e) => keepVisible(e.currentTarget)}
          onChange={(e) => onOther(e.currentTarget.value)}
        />
      )}
    </div>
  );
}

/** 提问型的几张合进一张卡：车主面对的是「先回答 N 个小问题」，不是 N 张各带一个发送键的卡。 */
export function AskGroup({ asks, onAnswer }: { asks: AskPrompt[]; onAnswer: (text: string) => void }) {
  const [state, setState] = useState<Record<string, AskState>>({});
  // 发出去之后锁住：下一轮的报告回来之前卡还在屏上，别让同一份答案发两遍。
  const [sent, setSent] = useState(false);
  if (asks.length === 0) return null;

  const send = (next: Record<string, AskState>) => {
    const text = composeAnswers(asks, next);
    if (text === null) return;
    setSent(true);
    onAnswer(text);
  };
  const pick = (ask: InteractionChoice, opt: string) => {
    const next = { ...state, [ask.id]: togglePick(ask, state[ask.id], opt) };
    setState(next);
    if (sendsOnPick(asks, opt)) send(next);
  };
  const type = (id: string, text: string) => setState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_ASK), other: text } }));

  const ready = composeAnswers(asks, state) !== null;
  // 只有一道单选且不带「其他」：选中即发，整张卡不需要发送键。
  const needsSend = !(asks.length === 1 && asks[0]!.kind === "single" && !asks[0]!.allowOther);
  const allChips = asks.every((a) => a.kind !== "open");

  return (
    <section className="dx-card" data-testid="dx-asks">
      <b className="dx-card__title">{asks.length === 1 ? "先回答一个小问题" : `先回答 ${asks.length} 个小问题`}</b>
      {asks.map((ask) =>
        ask.kind === "open" ? (
          <div className="dx-q" data-kind="open" key={ask.id}>
            <span className="dx-q__text">{ask.text}</span>
            <input
              className="dx-other"
              type="text"
              value={state[ask.id]?.other ?? ""}
              disabled={sent}
              placeholder={ask.placeholder ?? "说说看"}
              aria-label={ask.text}
              onFocus={(e) => keepVisible(e.currentTarget)}
              onChange={(e) => type(ask.id, e.currentTarget.value)}
            />
          </div>
        ) : (
          <ChoiceRow key={ask.id} ask={ask} state={state[ask.id] ?? EMPTY_ASK} disabled={sent} onPick={(opt) => pick(ask, opt)} onOther={(text) => type(ask.id, text)} />
        ),
      )}
      <footer className="dx-card__foot">
        <span className="dx-card__caption">{sent ? "已发送" : allChips ? "点一下就行，不用打字" : "也可以直接在下面打字说"}</span>
        {needsSend && (
          <button type="button" className="dx-secondary" disabled={!ready || sent} onClick={() => send(state)}>
            发送
          </button>
        )}
      </footer>
    </section>
  );
}

/** 操作引导：步骤 + 出处 + 结果回执。**不记做到第几步**——Agent 要的是结果，车主也未必按顺序做。 */
export function GuidanceCard({ guidance, onAnswer }: { guidance: InteractionGuidance; onAnswer: (text: string) => void }) {
  const [sent, setSent] = useState<string | null>(null);
  return (
    <section className="dx-card dx-card--guidance" data-testid="dx-guidance">
      <b className="dx-card__title">{guidance.title}</b>
      <ol className="dx-steps">
        {guidance.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {guidance.source && <p className="dx-source">出处：{guidance.source}</p>}
      <span className="dx-q__opts" role="group" aria-label="做完之后怎么样了">
        {guidance.outcomes.map((o) => (
          <button
            key={o}
            type="button"
            className={`dx-opt${sent === o ? " is-picked" : ""}`}
            disabled={sent !== null}
            onClick={() => {
              setSent(o);
              onAnswer(composeOutcome(guidance, o));
            }}
          >
            {o}
          </button>
        ))}
      </span>
      <p className="dx-card__caption">{sent ? "已发送" : "做完点一下结果；不方便做也没关系，点「做不了」或直接打字说"}</p>
    </section>
  );
}

/** 拍照请求。版式沿用 M104 的补拍卡；标题与说明由服务端给（观察层的补拍指引，或模型想看的部位）。 */
export function CaptureCard({ capture, onCapture }: { capture: InteractionCapture; onCapture: () => void }) {
  return (
    <section className="dx-card dx-card--retake" data-testid="dx-capture">
      <b className="dx-card__title">{capture.title}</b>
      <p className="dx-card__body">{capture.hint}</p>
      <button type="button" className="dx-primary" onClick={onCapture}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h2l1.2-2h4.6l1.2 2h2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" />
          <circle cx="12" cy="12.5" r="3.5" />
        </svg>
        去拍一张
      </button>
    </section>
  );
}

export interface PromptCardsProps {
  prompts: readonly InteractionPrompt[];
  onAnswer: (text: string) => void;
  onCapture: () => void;
}

/**
 * 按服务端给的顺序渲染（拍照 → 引导 → 提问）；提问型的合进一张卡，落在**第一道题**所在的位置。
 * 调用方用 `key={report.at}` 重挂来清选中态（新一轮的报告 = 新的一组卡）。
 */
export function PromptCards({ prompts, onAnswer, onCapture }: PromptCardsProps) {
  if (prompts.length === 0) return null;
  const asks = prompts.filter(isAskPrompt);
  const firstAsk = asks[0]?.id;
  return (
    <>
      {prompts.map((p) => {
        if (p.kind === "capture") return <CaptureCard key={p.id} capture={p} onCapture={onCapture} />;
        if (p.kind === "guidance") return <GuidanceCard key={p.id} guidance={p} onAnswer={onAnswer} />;
        return p.id === firstAsk ? <AskGroup key="asks" asks={asks} onAnswer={onAnswer} /> : null;
      })}
    </>
  );
}
