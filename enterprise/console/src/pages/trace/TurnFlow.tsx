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

import { cancelLabel, type FlowGap, type FlowStage, type TurnFlow as TurnFlowModel } from "./timeline";


/** 低于这个宽度百分比的条看不见了，给个下限。 */
const MIN_BAR_PCT = 1.5;

/**
 * 低于这个毫秒数的"排队"不画。
 *
 * 取票本身要过一次 promise 链（闸门把并发取票排成一条链），实测量到 0~2ms 的一跳——
 * 那是调度不是排队。画出来是每条工具都挂一截无意义的浅色，
 * 反而把真排了两秒的那几条淹掉。**数仍然如实落库**，只是不上图。
 */
const WAIT_MIN_MS = 5;

/** 这一跳里值得画出来的排队时长；没量过（老轨迹）与没排队都返回 0。 */
export function shownWaitMs(waitMs: number | undefined): number {
  return waitMs !== undefined && waitMs >= WAIT_MIN_MS ? waitMs : 0;
}

/**
 * 排队的**严重程度**分档。
 *
 * # 为什么要分档，而不是一律画成同一种浅色
 *
 * 一轮行程规划有二三十条工具，实测的排队从 6ms 到 5385ms 都有
 * （turn-9281ab92：`transit_route` 等了 5.4 秒、`spot_search` 3.7 秒，
 * 而 `destination_highlights` 只有 6ms）。同一种颜色画出来，
 * 得挨条读数字才知道哪条严重——这张图存在的理由恰恰是"不用读也能看出来"。
 *
 * # 档位是按实测分布切的，不是等分
 *
 * | 档 | 区间 | 它意味着什么 |
 * |---|---|---|
 * | 无 | < 500ms | 至多排在一两个请求后面，闸门本来就这么设计 |
 * | 轻 | 0.5–2s | 前面压着几个请求，值得知道但还不是问题 |
 * | 重 | 2–5s | 这一跳的时间已经**大半在排队**，上游没那么慢 |
 * | 危 | ≥ 5s | 一跳里五秒以上纯等——首波撞车的典型样子 |
 *
 * 500ms 这个起点是用户定的口径：低于它不值得占用注意力。
 */
export type WaitLevel = "none" | "mild" | "heavy" | "severe";

export function waitLevel(waitMs: number | undefined): WaitLevel {
  const ms = shownWaitMs(waitMs);
  if (ms >= 5_000) return "severe";
  if (ms >= 2_000) return "heavy";
  if (ms >= 500) return "mild";
  return "none";
}

/** 排队时长的人读法：秒级的读秒，毫秒级的读毫秒——`5385ms` 得心算一下才知道是五秒。 */
export function waitText(waitMs: number): string {
  return waitMs >= 1_000 ? `${(waitMs / 1_000).toFixed(1)}s` : `${waitMs}ms`;
}

/**
 * 空白那一行该叫什么（M77 走查追修）。
 *
 * 这一行是**这张图里最容易被误读的一段**——图上它是空的，读起来像"什么都没发生"，
 * 而真跑 turn-d3372ed7 的 `llm.tour-task` 里，最后那段空白是 9.5 秒**模型在写三天行程 JSON**，
 * 占整个 20 秒分支的将近一半。所以文案要说"它在干什么"，不能说"这里没数据"。
 *
 * 末尾那一段与中间那几段不是一回事：LLM 阶段的收尾空白就是在出最终那段文本，
 * 中间的空白是收到工具结果之后、发下一轮之前的那段思考。
 */
export function gapLabel(gap: FlowGap): string {
  if (gap.kind !== "llm") return "编排自身（无子调用）";
  return gap.trailing ? "模型在写最终输出" : "模型在想（无工具在跑）";
}

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
                {/* 顺序（含空白插在哪）由模型算好，见 `FlowStage.rows`。 */}
                {s.rows.map((row, j) =>
                  row.gap ? (
                    <li
                      className="flow-gap"
                      key={`gap-${j}`}
                      style={{ marginLeft: `${row.gap.depth * 14}px` }}
                    >
                      <div className="flow-child-head">
                        <span className="muted">{gapLabel(row.gap)}</span>
                        <span className="spacer" />
                        <span className="flow-ms muted">{row.gap.durationMs}ms</span>
                      </div>
                      <div className="flow-track flow-track--child">
                        <div
                          className="flow-bar flow-bar--gap"
                          style={{
                            marginLeft: `${(row.gap.offsetMs / scale) * 100}%`,
                            width: `${pct(row.gap.durationMs)}%`,
                          }}
                        />
                      </div>
                    </li>
                  ) : (
                    renderChild(row.child, j, scale, pct)
                  ),
                )}
                {/*
                  末尾这两行是**阶段这一层**的总账（阶段时长 − 直接子调用并集），
                  上面那些空白行是逐层的位置——同一段时间的两种切法，别当成两笔。
                  这两行分开写：吐字是量出来的（总时长 − 首 token），
                  没埋点覆盖的那段是余数。合成一行会把后者说成生成时间——
                  实测应答阶段那两个数是 852ms 与 3279ms，差了近四倍。
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
        <strong>比例看图，准确看数字</strong>。标「并行」的两条同时在跑，耗时不能相加；
        灰色斜纹是那一层<strong>没有任何下级调用在跑</strong>的时间，末尾两行是阶段这一层的合计；
        工具条上颜色不同的前一截是<strong>排我们自己的限速队</strong>，不是上游在算——
        超过 0.5 秒挂黄牌、2 秒起橙、5 秒起红，<strong>越红越是我们自己把自己堵住了</strong>。
      </p>
    </div>
  );
}

function renderChild(
  c: FlowStage["children"][number],
  j: number,
  scale: number,
  pct: (ms: number) => number,
): JSX.Element {
  // 缩进按嵌套深度：`acp.session_new` 套在 `llm.*` 里，平铺的话会被读成"两件并列的事"。
  return (
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
        {/* 排了队就把两个数都写出来：图上看比例，数字才说得准。 */}
        {/*
          排队够得上一档就挂个醒目的牌子，不够的只在条上留一截浅色。
          牌子写秒、条旁边仍写精确毫秒：**扫的时候看牌子，核的时候看数字**。
        */}
        {waitLevel(c.waitMs) !== "none" ? (
          <span
            className={`flow-tag flow-tag--wait flow-tag--wait-${waitLevel(c.waitMs)}`}
            title={`排队 ${c.waitMs}ms`}
          >
            排队 {waitText(c.waitMs!)}
          </span>
        ) : shownWaitMs(c.waitMs) ? (
          // 够不上一档的（几十毫秒）不挂牌，但也不能装作没排过——留一个小字。
          <span className="flow-ms muted">等 {c.waitMs}ms ·</span>
        ) : null}
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
      {/*
        左边距按起始偏移，右边长度按耗时——并行的两条因此在视觉上叠着。
        条里再分两截：**前一截是排我们自己的限速队，后一截才是上游在算**
        （见 `FlowChild.waitMs`）。分色是因为两者的处置相反：
        等上游只能等，排自己的队是并发策略，调得动。
        老轨迹没有这个数（undefined），整条按在途画——不假装它没排过队。
      */}
      <div className="flow-track flow-track--child">
        <div
          className={`flow-bar flow-bar--child${c.status === "failed" ? " flow-bar--failed" : ""}${c.status === "cancelled" ? " flow-bar--cancelled" : ""}`}
          style={{
            marginLeft: `${(c.offsetMs / scale) * 100}%`,
            width: `${pct(c.durationMs)}%`,
          }}
        >
          {shownWaitMs(c.waitMs) ? (
            <div
              className={`flow-bar-wait flow-bar-wait--${waitLevel(c.waitMs)}`}
              title={`排队 ${c.waitMs}ms`}
              // 百分比**相对这一条**，不是相对整轮：条本身已经按比例摆好了。
              style={{ width: `${(shownWaitMs(c.waitMs) / Math.max(1, c.durationMs)) * 100}%` }}
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}
