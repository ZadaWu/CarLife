/**
 * JSON → 表格（2026-09-15，业务视图的入参 / 出参 / 结论）。形状判定在 `json-table-model.ts`。
 *
 * 表头是「中文(英文)」（`json-keys.ts`），查不到的键只给英文。嵌套超过一层的子表折叠起来，
 * 点开才展开——一份三天行程的 JSON 全展开是一屏半的表。表下面永远留一个「原始 JSON」折叠，
 * 研发对账时不用切视图。
 */

import { labelOfKey } from "./json-keys";
import { parseJsonText, shapeOf, type JsonValue } from "./json-table-model";

/** 列表最多直接画这么多行，其余折叠——几百条 POI 全画出来抽屉会卡。 */
const ROW_LIMIT = 60;

function Cell({ value, depth }: { value: JsonValue; depth: number }): JSX.Element {
  const shape = shapeOf(value);
  if (shape.kind === "scalar") {
    return shape.long ? <div className="jt-text">{shape.text}</div> : <>{shape.text}</>;
  }
  if (shape.kind === "empty") return <span className="muted">（空）</span>;
  // 嵌套的表：第一层直接画，再往里折叠——标题说清里面是几条 / 几个字段。
  const summary =
    shape.kind === "rows" ? `${shape.rows.length} 条` : shape.kind === "list" ? `${shape.items.length} 项` : `${shape.entries.length} 个字段`;
  if (depth >= 1) {
    return (
      <details className="jt-nested">
        <summary>{summary}</summary>
        <Node value={value} depth={depth + 1} />
      </details>
    );
  }
  return <Node value={value} depth={depth + 1} />;
}

function Node({ value, depth }: { value: JsonValue; depth: number }): JSX.Element {
  const shape = shapeOf(value);
  switch (shape.kind) {
    case "scalar":
      return <div className="jt-text">{shape.text}</div>;
    case "empty":
      return <span className="muted">（空）</span>;
    case "list":
      return (
        <ul className="jt-list">
          {shape.items.slice(0, ROW_LIMIT).map((it, i) => (
            <li key={i}>
              <Cell value={it} depth={depth} />
            </li>
          ))}
          {shape.items.length > ROW_LIMIT ? <li className="muted">…还有 {shape.items.length - ROW_LIMIT} 项，见原始 JSON</li> : null}
        </ul>
      );
    case "record":
      return (
        <table className="jt jt--record">
          <tbody>
            {shape.entries.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{labelOfKey(k)}</th>
                <td>
                  <Cell value={v} depth={depth} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "rows":
      return (
        <table className="jt jt--rows">
          <thead>
            <tr>
              <th className="jt-no">#</th>
              {shape.columns.map((c) => (
                <th key={c} scope="col">{labelOfKey(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shape.rows.slice(0, ROW_LIMIT).map((row, i) => (
              <tr key={i}>
                <td className="jt-no">{i + 1}</td>
                {shape.columns.map((c) => (
                  <td key={c}>{c in row ? <Cell value={row[c]} depth={depth} /> : <span className="muted">—</span>}</td>
                ))}
              </tr>
            ))}
            {shape.rows.length > ROW_LIMIT ? (
              <tr>
                <td className="muted" colSpan={shape.columns.length + 1}>…还有 {shape.rows.length - ROW_LIMIT} 条，见原始 JSON</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      );
  }
}

/**
 * 入口：吃轨迹里的 JSON 文本。解析不了（截断过的、或本来就是散文）退回 `<pre>` 原样。
 */
export function JsonTable({ text }: { text: string }): JSX.Element {
  const parsed = parseJsonText(text);
  if ("raw" in parsed) return <pre className="bz-pre">{parsed.raw}</pre>;
  return (
    <div className="jt-wrap">
      <Node value={parsed.value} depth={0} />
      <details className="jt-raw">
        <summary>原始 JSON</summary>
        <pre className="bz-pre">{JSON.stringify(parsed.value, null, 2)}</pre>
      </details>
    </div>
  );
}
