/**
 * 一轮的执行流程图（施工单 TD-08 追加，F-44-04）。
 *
 * # 它回答的是瀑布图与耗时表都回答不了的问题
 *
 * 那两个能说"哪一跳慢"，但说不清**"它是怎么流过去的"**——
 * 先审核还是先解析意图、检索在应答之前还是之中、哪两跳是并排跑的。
 *
 * # 竖着排，不是横着
 *
 * 抽屉是竖长的。横向流程图在 900px 宽里塞五六个阶段，每个只剩 140px，
 * 耗时数字得缩到看不清；竖排则每个阶段有整行可用，子调用还能按比例画出条来。
 *
 * # 条长按耗时占比，但**有下限**
 *
 * 5ms 的一跳按比例画出来是 0.3px，视觉上等于不存在——而"这一跳很快"和
 * "这一跳没发生"必须能区分。所以给一个最小可见宽度，并把数字直接写在旁边：
 * **图形负责一眼看出比例，数字负责准确**。
 */

import { cancelLabel, type TurnFlow as TurnFlowModel } from "./timeline";

/** 低于这个宽度百分比的条看不见了，给个下限。 */
const MIN_BAR_PCT = 1.5;

export function TurnFlowChart({ flow }: { flow: TurnFlowModel }): JSX.Element {
  if (flow.stages.length === 0) {
    return <p className="muted">这一轮没有可画的阶段。</p>;
  }

  const scale = Math.max(1, flow.totalMs);
  const pct = (ms: number): number => Math.max(MIN_BAR_PCT, (ms / scale) * 100);

  return (
    <div className="flow">
      {flow.stages.map((s, i) => (
        <div className="flow-stage" key={`${s.name}-${s.startedAt}`}>
          {/* 阶段之间的连接线：它表达的是"接着往下走"，不是数据依赖 */}
          {i > 0 ? <div className="flow-arrow" aria-hidden="true" /> : null}

          <div className={`flow-box${s.status === "failed" ? " flow-box--failed" : ""}`}>
            <div className="flow-box-head">
              <span className="flow-label">{s.label}</span>
              {/*
                被折叠掉的那次 LLM 调用要留个名：`node.answer` 底下只有一个
                `llm.trip` 且几乎等长，那一行不带信息、只多一层缩进，折掉；
                但"这一轮是谁答的"不能跟着丢。
              */}
              <span className="muted tiny mono">
                {s.name}
                {s.collapsedFrom ? ` › ${s.collapsedFrom}` : ""}
              </span>
              {/* 取消≠失败：被掐的流（提交收工/超时/打断）不画红，标出原因。 */}
              {s.status === "cancelled" ? (
                <span className="flow-tag flow-tag--muted">{cancelLabel(s.detail)}</span>
              ) : null}
              <span className="spacer" />
              <strong className="flow-ms">{s.durationMs}ms</strong>
            </div>

            <div className="flow-track" title={`${s.durationMs}ms`}>
              <div
                className={`flow-bar${s.status === "failed" ? " flow-bar--failed" : ""}${s.status === "cancelled" ? " flow-bar--cancelled" : ""}`}
                style={{ width: `${pct(s.durationMs)}%` }}
              />
            </div>

            {s.children.length > 0 ? (
              <ul className="flow-children">
                {s.children.map((c, j) => (
                  // 缩进按嵌套深度：`acp.session_new` 套在 `llm.*` 里，
                  // 平铺的话会被读成"两件并列的事"。
                  <li key={`${c.name}-${j}`} style={{ marginLeft: `${c.depth * 14}px` }}>
                    <div className="flow-child-head">
                      <span className="flow-child-name mono">{c.name}</span>
                      {/* 并行是这张图最该说清楚的事：两条同时在跑，耗时不能相加 */}
                      {c.parallel ? <span className="flow-tag">并行</span> : null}
                      {c.status === "failed" ? (
                        <span className="flow-tag flow-tag--bad">失败{c.detail ? `·${c.detail}` : ""}</span>
                      ) : null}
                      {c.status === "cancelled" ? (
                        <span className="flow-tag flow-tag--muted">{cancelLabel(c.detail)}</span>
                      ) : null}
                      <span className="spacer" />
                      <span className="flow-ms">{c.durationMs}ms</span>
                    </div>
                    {/*
                      同名工具在一轮里被调多次时，**这一行是唯一能把它们区分开的东西**
                      （五次 weather 是五个点，还是同一个点查了五遍？）。
                      内容由工具自己声明，见 registry 的 `traceSummary`。
                      失败时 detail 已经在上面的标签里，不重复。
                    */}
                    {c.status === "ok" && c.detail ? (
                      <div className="flow-child-detail">{c.detail}</div>
                    ) : null}
                    {/* 左边距按起始偏移，右边长度按耗时——并行的两条因此在视觉上叠着 */}
                    <div className="flow-track flow-track--child">
                      <div
                        className={`flow-bar flow-bar--child${c.status === "failed" ? " flow-bar--failed" : ""}${c.status === "cancelled" ? " flow-bar--cancelled" : ""}`}
                        style={{
                          marginLeft: `${(c.offsetMs / scale) * 100}%`,
                          width: `${pct(c.durationMs)}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
                {/*
                  末尾两行是"剩下的时间去哪了"，**分开写**：
                  吐字是量出来的（总时长 − 首 token），没埋点覆盖的那段是余数。
                  合成一行会把后者说成生成时间——实测应答阶段那两个数是
                  852ms 与 3279ms，差了近四倍。
                */}
                {s.tail.textMs !== null ? (
                  <li className="flow-self">
                    <div className="flow-child-head">
                      <span>生成文本</span>
                      <span className="spacer" />
                      <span className="flow-ms">{s.tail.textMs}ms</span>
                    </div>
                  </li>
                ) : null}
                <li className="flow-self">
                  <div className="flow-child-head">
                    <span className="muted">
                      {s.tail.kind === "llm" ? "无埋点覆盖（prefill / 框架开销）" : "编排自身开销"}
                    </span>
                    <span className="spacer" />
                    <span className="flow-ms muted">{s.tail.uncoveredMs}ms</span>
                  </div>
                </li>
              </ul>
            ) : null}
          </div>
        </div>
      ))}

      <p className="muted tiny">
        条长按占本轮总时长（{flow.totalMs}ms）的比例，太短的给了最小宽度——
        <strong>比例看图，准确看数字</strong>。标「并行」的两条同时在跑，耗时不能相加。
      </p>
    </div>
  );
}
