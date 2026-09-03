/**
 * 等待期垫场话在会话页的呈现（施工单 M18-07，US-45）。
 *
 * # 为什么它不是气泡
 *
 * 垫场话**按设计不入对话历史**（AC-45-7），M18-04 花了一整张单去保证这件事：
 * 不进①图状态、不进记忆、不进 `Last-Event-ID` 补发窗口，三处都有断言。
 *
 * 把它渲染成和助手气泡一样的东西，等于在页面上**重新制造**"垫场进了历史"的错觉。
 * 所以它是**旁注**：只出现在轨迹抽屉里，并明写它不在对话记录中。
 *
 * # 文本从哪来
 *
 * `sidecar.filler` 这条 span 的 `detail` 形如 `l0 · retrieval`，**不含文本**——
 * M18-05 刻意如此：文本是用户可见内容，轨迹里再存一份等于多一处要脱敏的地方。
 *
 * 而 L0 的文案是代码常量，phase 与句子一一对应，所以这里由 `phase` **还原**它，
 * 零额外传输。
 *
 * **L1（M18-09 的导游式闲聊）还原不出来**：它是模型现生成的句子，而轨迹里
 * 按设计不存文本。这里就只显示发生过与时刻，**不猜**——控制台显示的必须与
 * 用户真听到的一致，编一句从没播过的话出来，排障时会拿着它去对因果。
 *
 * ⚠️ 已知代价：M18-09 之后大多数句子是 L1，回放页因此看不到具体说了什么。
 * 要改的话得先决定"用户可见文本进不进轨迹"，那是 M18-05 定的边界，不在本单范围内。
 */

import type { JSX } from "react";

import { parseFillerDetail } from "@carlife/shared";

import type { TraceEvent } from "../trace/timeline";

export interface FillerNoteItem {
  at: number;
  source?: string;
  phase?: string;
  /** 这是该阶段的第几句（1 起，M18-08）。 */
  ordinal?: number;
  phrase?: string;
}

/** 从一轮的轨迹事件里挑出垫场话。**从轨迹取，不是从历史取。** */
export function fillersOfTurn(events: TraceEvent[]): FillerNoteItem[] {
  return events
    .filter((e) => (e.data as { name?: string } | undefined)?.name === "sidecar.filler")
    .map((e) => ({
      at: e.at,
      ...parseFillerDetail((e.data as { detail?: string } | undefined)?.detail),
    }));
}

export function FillerNote({ fillers }: { fillers: FillerNoteItem[] }): JSX.Element {
  return (
    <div className="filler-note">
      <h3>
        等待期垫场 <span className="muted tiny">×{fillers.length}</span>
      </h3>
      <p className="muted tiny">
        旁路闲聊 Agent 在等待期播给车主听的话。<strong>不在对话记录里</strong>
        ——它是等待期的瞬时填充，不进历史、不进记忆、不进断线补发。
      </p>
      <ul className="filler-list">
        {fillers.map((f, i) => (
          <li key={`${f.at}-${i}`}>
            <span className="muted tiny mono">{new Date(f.at).toLocaleTimeString()}</span>{" "}
            {f.phrase ? (
              <span className="filler-phrase">「{f.phrase}」</span>
            ) : (
              <span className="muted">
                （L1 是模型现生成的，轨迹里按设计不留文本——只知道它发生过）
              </span>
            )}
            {f.phase ? (
              <span className="muted tiny">
                {" "}
                · {f.phase}
                {f.ordinal && f.ordinal > 1 ? `#${f.ordinal}` : ""}
              </span>
            ) : null}
            {f.source ? <span className="muted tiny"> · {f.source}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
