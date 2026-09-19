/**
 * 一条 `AgentNote` 的渲染（施工单 M89-04）。
 *
 * 从 `AskPanel` 里拆出来的理由不是行数，是**这个组件不许有状态**：
 * 笔记的四段全部来自服务端那一次 `done` 帧，界面不加工、不补默认值。
 * 有了状态就会有"上一轮的引用还留在屏幕上"这类没人看得出来的错。
 *
 * # 空的那几段照样出标题，并说清"空"是什么意思
 *
 * 一条**零引用**的笔记是个强信号：模型答了一整段，却一条证据都没引用到。
 * 整段不渲染的话，它和"有引用"在页面上长得一样，只是短一点。
 *
 * # 引用只到 id
 *
 * 服务端没有"按 unitId 单查一条原声"的接口（能力目录里没有这条），所以点一条
 * 引用走的是这一格既有的 `🔍 找反例`——它列的是这一格的证据原声（已脱敏）。
 * 范围上没有这条能力时（卡片 / 整屏）`onCiteUnit` 不传，id 就以文本出现，
 * 并在旁边说明为什么点不了：一个看起来能点、点了没反应的按钮更糟。
 */

import type { ReactNode } from "react";

import type { AgentNote } from "./ask-model";

/** 一段答案按空行拆段。模型的换行是它自己的分段意图，不要压成一坨。 */
const paragraphsOf = (answer: string): string[] =>
  answer
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="rm-note-sec">
      <h6 className="rm-note-title">{title}</h6>
      {children}
    </div>
  );
}

export function AgentNoteView({
  note,
  onCiteUnit,
  onPickQuestion,
}: {
  note: AgentNote;
  /**
   * 点一条引用的证据单元。不传 = 这个范围上没有可用的就地查，id 以文本出现。
   */
  onCiteUnit?: (unitId: string) => void;
  /** 点一条追问建议。上层把它填进输入框，**不直接发出去**——那一下要由人按。 */
  onPickQuestion?: (question: string) => void;
}): JSX.Element {
  const paragraphs = paragraphsOf(note.answer);

  return (
    <div className="rm-note">
      <Section title="答案">
        {paragraphs.length === 0 ? (
          <p className="rm-dim">这一轮没有答案正文。</p>
        ) : (
          paragraphs.map((p, i) => (
            <p key={`${i}-${p.slice(0, 12)}`} className="rm-note-answer">
              {p}
            </p>
          ))
        )}
      </Section>

      <Section title={`引用的证据单元（${note.citedUnitIds.length}）`}>
        {note.citedUnitIds.length === 0 ? (
          /* 零引用是强信号，不是"这一段没有内容"。措辞要说得出这个区别。 */
          <p className="rm-dim">一条证据单元都没引用到——这段答案没有可回溯的出处。</p>
        ) : (
          <ul className="rm-note-cites">
            {note.citedUnitIds.map((id) =>
              onCiteUnit ? (
                <li key={id}>
                  <button
                    type="button"
                    className="rm-note-cite"
                    title="就地查这一格的证据原声（已脱敏）"
                    onClick={() => onCiteUnit(id)}
                  >
                    {id}
                  </button>
                </li>
              ) : (
                <li key={id}>
                  <span className="rm-note-cite is-flat">{id}</span>
                </li>
              ),
            )}
          </ul>
        )}
        {note.citedUnitIds.length > 0 && !onCiteUnit ? (
          <p className="rm-dim">这个范围上没有「找反例」，点不开原声——请回到具体的格或整行再查。</p>
        ) : null}
      </Section>

      <Section title={`引用的主题（${note.citedThemeIds.length}）`}>
        {note.citedThemeIds.length === 0 ? (
          <p className="rm-dim">没有引用到主题。</p>
        ) : (
          /* 主题只出文本：主题详情不在这一页，做成按钮会指向一个不存在的落点。 */
          <p className="rm-note-themes">{note.citedThemeIds.join("、")}</p>
        )}
      </Section>

      <Section title={`保留意见（${note.caveats.length}）`}>
        {note.caveats.length === 0 ? (
          /*
           * "没有保留意见"不等于"这条结论没有问题"——最容易被读反的一段，
           * 所以这句话必须把区别说出来。
           */
          <p className="rm-dim">它没有提出保留意见。这不等于这段答案没有问题。</p>
        ) : (
          <ul className="rm-note-caveats">
            {note.caveats.map((c, i) => (
              <li key={`${i}-${c.slice(0, 12)}`}>{c}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`接着问什么（${note.nextQuestions.length}）`}>
        {note.nextQuestions.length === 0 ? (
          <p className="rm-dim">它没有给出下一步的问法。</p>
        ) : (
          <ul className="rm-note-next">
            {note.nextQuestions.map((q, i) => (
              <li key={`${i}-${q.slice(0, 12)}`}>
                <button
                  type="button"
                  className="uz-chip rm-note-chip"
                  disabled={!onPickQuestion}
                  title={onPickQuestion ? "填进输入框，改不改都行——发不发由你按" : "这一轮问不了了"}
                  onClick={onPickQuestion ? () => onPickQuestion(q) : undefined}
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
