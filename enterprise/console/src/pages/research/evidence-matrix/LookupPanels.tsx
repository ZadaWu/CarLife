/**
 * `🔍` 层四条能力的结果渲染（施工单 M85-05）。
 *
 * 就地渲染在抽屉里，**不弹运行态面板、不开新区**——它们零模型、< 1s，
 * 给一个转圈的面板反而让人以为后台在跑什么很贵的东西。
 *
 * 措辞一律来自 `lookup-model.ts`，这里只摆版式。两者分开是因为那些句子
 * （`✗0 不是好消息`、`这是我们看见它的地方`）要被逐条断言，
 * 而渲染快照对着改一行样式就会红。
 */

import type {
  CounterEvidenceList,
  SegmentSlice,
  SystemEventOverlap,
  ThresholdSensitivity,
} from "../../../api/research-capability";
import {
  counterView,
  eventView,
  INSTANT_NOTE,
  REDACTED_BADGE,
  sliceView,
  thresholdView,
} from "./lookup-model";

/** 四条共用的尾注。`🔍` 的产出不落库，页面上必须说出这件事。 */
function InstantNote(): JSX.Element {
  return <p className="rm-dim rm-instant">{INSTANT_NOTE}</p>;
}

/** 反例列表。抽屉「反例」那一节用它，不另起一个区。 */
export function CounterEvidence({ data }: { data: CounterEvidenceList }): JSX.Element {
  const v = counterView(data);
  return (
    <>
      {v.truncated ? <p className="rm-warn">{v.truncated}</p> : null}
      {v.emptyNote ? <p className="rm-dim">{v.emptyNote}</p> : null}
      <ul className="rm-quotes">
        {v.units.map((u) => (
          <li key={u.unitId}>
            <p className="rm-quote-text">{u.text}</p>
            <p className="rm-dim rm-quote-meta">
              <span className="rm-badge">{REDACTED_BADGE}</span>
              <span className="rm-quote-theme">{u.themeName}</span>
              {/* 证据单元 id 要看得见：`🔍` 层的全部价值就在"能回到这一条"上 */}
              <span className="rm-quote-id">{u.unitId}</span>
            </p>
          </li>
        ))}
      </ul>
      {v.silentThemes.length > 0 ? (
        <p className="rm-dim">
          这几个主题一条反例都没有：{v.silentThemes.join("、")}。合并之后看不出是哪一块没去找。
        </p>
      ) : null}
      <InstantNote />
    </>
  );
}

/** C3：窗内我们自己的系统变更。 */
export function SystemEvents({ data }: { data: SystemEventOverlap }): JSX.Element {
  const v = eventView(data);
  return (
    <>
      <p className="rm-dim">{v.windowNote}</p>
      {v.emptyNote ? <p className="rm-dim">{v.emptyNote}</p> : null}
      {v.rows.length > 0 ? (
        <table className="rm-break rm-events">
          <tbody>
            {v.rows.map((e) => (
              <tr key={e.key} className={e.inRecentHalf ? "is-recent" : undefined}>
                <td className="rm-break-label">{e.when}</td>
                <td className="rm-break-val">{e.kind}</td>
                <td>{e.summary}</td>
                {/* 只有近半窗里的变更才可能解释掉这次方向变化——标出来，不让读的人自己算 */}
                <td className="rm-dim">{e.inRecentHalf ? "近半窗" : "前半窗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <InstantNote />
    </>
  );
}

/** C4：按分群切开的分布，每个主题一张小表。 */
export function SegmentSlices({ data }: { data: SegmentSlice }): JSX.Element {
  const v = sliceView(data);
  return (
    <>
      {v.truncated ? <p className="rm-warn">{v.truncated}</p> : null}
      {v.emptyNote ? <p className="rm-dim">{v.emptyNote}</p> : null}
      {v.themes.map((t) => (
        <div key={t.themeId} className="rm-slice">
          <p className="rm-slice-title">{t.themeName}</p>
          <p className="rm-dim">{t.concentration}</p>
          <table className="rm-break">
            <tbody>
              {t.rows.map((s) => (
                <tr key={s.segment}>
                  <td className="rm-break-label">{s.segment}</td>
                  <td className="rm-break-val">{s.n}</td>
                  <td className="rm-break-pct">{s.share}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <InstantNote />
    </>
  );
}

/** C5：逐个 delta 的翻转与否。**不翻的那些也列出来**，只回会翻的是半个答案。 */
export function Thresholds({ data }: { data: ThresholdSensitivity }): JSX.Element {
  const v = thresholdView(data);
  return (
    <>
      <p className="rm-verdict">{v.verdict}</p>
      <table className="rm-break rm-thresholds">
        <tbody>
          {v.rows.map((p) => (
            <tr key={p.key} className={p.flips ? "is-flip" : undefined}>
              <td className="rm-break-label">{p.delta}</td>
              <td className="rm-break-val">{p.flips ? "翻面" : "不变"}</td>
              <td className="rm-dim">{p.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <InstantNote />
    </>
  );
}
