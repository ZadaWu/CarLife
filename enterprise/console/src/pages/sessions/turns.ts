/**
 * 会话详情的轮次切分与排序——**纯逻辑，不 import 任何组件或样式**。
 *
 * 从 `index.tsx` 抽出来的理由是可测：那个文件 `import "./sessions.css"`，
 * 而 web 侧测试用 Node 内置 `node:test` + tsx，tsx 不处理 `.css`，
 * 于是测试一 import 它就整个崩掉（`ERR_UNKNOWN_FILE_EXTENSION`），
 * 连带 `pnpm test:web` 与 `check:all` 一起红。
 *
 * 这也是本仓一贯的形状：enterprise/console 下其余测试无一例外只 import 纯逻辑模块
 * （`finance/model`、`workflow/graph-model`、`trace/timeline`、`workflow/projection`…），
 * 页面组件只负责表述。新增"能被单测的页面逻辑"时照这个放，别留在 .tsx 里。
 */

import type { TraceEvent } from "../trace/timeline";

export interface ConsoleMessage {
  messageId: string;
  turnId: string;
  role: "user" | "assistant";
  source: "text" | "voice";
  content: string;
  ts: number;
  redacted?: boolean;
  redactedKinds?: string[];
  /** 这条语音消息由哪个 ASR 档转写（M60-01）。仅 source=voice 的用户消息有值。 */
  asrEngine?: string | null;
  /**
   * 这条助手回复**当时下发给端上的 TTS 档位**（M60-01）。
   * 不是"实际播了什么"——见界面上的措辞与 schema 注释。
   */
  ttsEngine?: string | null;
  /**
   * 服务端已经存下来的音频种类（M60-02）：`asr` = 车主那段原始录音，
   * `tts` = 助手那句的合成音。
   *
   * **`undefined` 与 `[]` 意思不同**：前者是"这套功能没接"（对象存储未配置，
   * 接口根本不带这个字段），界面连播放键都不该出现；后者是"接了，但这条还没有"
   * ——助手消息这时点播放会先补合成一次。
   */
  storedAudio?: string[];
}

export interface TurnView {
  turnId: string;
  messages: ConsoleMessage[];
  /**
   * **真实的时间序号**（第 1 轮是最早那轮），不随显示顺序倒过来。
   *
   * 倒过来编号会让同一轮在这里叫"第 1 轮"、在轨迹与日志里却是最后一条——
   * 两个人对着屏幕说"第 3 轮"时指的不是同一件事，而这种错对不上账才发现。
   */
  index: number;
}

function groupByTurn(messages: ConsoleMessage[]): Array<[string, ConsoleMessage[]]> {
  const map = new Map<string, ConsoleMessage[]>();
  for (const m of messages) {
    const list = map.get(m.turnId) ?? [];
    list.push(m);
    map.set(m.turnId, list);
  }
  return [...map.entries()];
}

/**
 * 按时间**逆序**排列轮次（最近一轮在最上面）。
 *
 * 排障与运营查看时想看的几乎总是"刚才那次"，正序要一路滚到底。
 * 序号仍取自正序位置，见 `TurnView.index`。
 */
export function turnsNewestFirst(messages: ConsoleMessage[]): TurnView[] {
  const grouped = groupByTurn(messages);
  return grouped
    .map(([turnId, list], i) => ({ turnId, messages: list, index: i + 1 }))
    .reverse();
}

/**
 * 把会话轨迹切到某一轮。
 *
 * `orphan` 是**不属于任何轮次**的事件数：`acp.connect`（连接建立在任何一轮之外）、
 * 以及轮次关闭后才落的裁决（确认超时那一类）都没有 `turnId`。
 * 它们在按轮过滤时全都不在——**必须数出来告诉读者**，
 * 不吭声的话读者会以为"这一轮就是这些"，而恰恰是漏掉的那些最慢。
 */
export function eventsOfTurn(
  timeline: TraceEvent[],
  turnId: string,
): { events: TraceEvent[]; orphan: number } {
  return {
    events: timeline.filter((e) => e.turnId === turnId),
    orphan: timeline.filter((e) => !e.turnId).length,
  };
}
