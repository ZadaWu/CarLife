/**
 * 运行态面板的**状态归约**（施工单 M85-04）。纯函数，没有 React。
 *
 * # 阶段文案来自图的 `notes[]`，这里没有一份自己的阶段名表
 *
 * 研究图每个节点都往 `notes[]` 推一句人话（`1482 轮 / 36 主题`、`21 张洞察卡`）。
 * 面板再维护一份 `{frame: "取数", analyze: "分析中"}` 这样的映射，
 * 就会出现两份对同一次运行的描述——而它们分叉时不报错，只是界面上的说法
 * 和日志里的说法对不上。所以这里**只把收到的句子按顺序排成行**。
 */

import type { RunStreamEvent } from "../../../api/research-capability";

/** 一行的状态。最后一行在跑，前面的都已完成。 */
export type StepStatus = "done" | "running" | "waiting";

export interface RunStep {
  text: string;
  status: StepStatus;
}

export interface RunPanelState {
  runId: string;
  steps: RunStep[];
  /** `running` / `done` / `failed`。 */
  phase: "running" | "done" | "failed";
  stage: string;
  /** 失败原因**原样保留**，不换成"运行失败请重试"——那句话不含任何可排查的信息。 */
  error: string | null;
  usage: { totalTokens: number; models: string[] } | null;
  /**
   * `done` 帧带回来的终态载荷（M89-04）。没跑完、或者这条能力不带产物时是 `null`。
   *
   * # 为什么留在这里，而 `RunPanel` 不渲染它
   *
   * 产物的形状因能力而异（C10–C12 是 `{ note: AgentNote, … }`，C1 是卡），
   * 面板自己按形状分派的话，每加一条能力都要回来改这个公共组件。
   * 所以它只把归约后的 `state.result` 经 `onDone` 交给上层，由上层收窄。
   *
   * 归约时丢掉它的表现最难查：运行一路跑到"跑完了"，而结果那一段永远空着——
   * 面板与流都没有任何异常。
   */
  result: unknown;
  /** 人还在看吗。`false` = 已经"停止查看"，与运行是否结束无关。 */
  watching: boolean;
}

export const initialRunState = (runId: string): RunPanelState => ({
  runId,
  steps: [],
  phase: "running",
  stage: "",
  error: null,
  usage: null,
  result: null,
  watching: true,
});

/** 把 `n` 行里最后一行标成在跑、其余标完成。 */
const marked = (texts: string[], running: boolean): RunStep[] =>
  texts.map((text, i) => ({
    text,
    status: running && i === texts.length - 1 ? "running" : "done",
  }));

/**
 * 收一条事件，给出新状态。
 *
 * `state` 帧带的是**全量** `notes`（晚连上的客户端靠它把面板画全），
 * `progress` 帧带的是增量一句。两者都往同一个数组里落。
 */
export function reduceRun(prev: RunPanelState, e: RunStreamEvent): RunPanelState {
  const texts = prev.steps.map((s) => s.text);

  switch (e.event) {
    case "state": {
      const all = e.notes ?? [];
      return {
        ...prev,
        steps: marked(all, true),
        stage: e.stage ?? prev.stage,
        usage: e.usage ?? prev.usage,
      };
    }
    case "progress":
      return {
        ...prev,
        steps: marked(e.note ? [...texts, e.note] : texts, true),
        stage: e.stage ?? prev.stage,
      };
    case "stage":
      return { ...prev, stage: e.stage ?? prev.stage, usage: e.usage ?? prev.usage };
    case "done":
      // 结束后**每一行都是完成态**，不留一个转着的圈。
      return {
        ...prev,
        steps: marked(texts, false),
        phase: "done",
        stage: e.stage ?? prev.stage,
        usage: e.usage ?? prev.usage,
        // `??` 而不是 `||`：不带产物的能力发的是 `undefined`，那与"产物是 0/空串"不同。
        result: e.result ?? prev.result,
      };
    case "failed":
      return {
        ...prev,
        steps: marked(texts, false),
        phase: "failed",
        // 服务端给了什么就显示什么；没给才退到一句"没说原因"，而那本身也是个信息。
        error: e.error ?? "服务端没说原因",
      };
    default:
      return prev;
  }
}

export const STEP_GLYPH: Record<StepStatus, string> = { done: "✓", running: "⟳", waiting: "·" };

/** 底行那句代价。**一个能一键烧 token 的按钮必须显示代价**（G7）。 */
export function costLine(usage: RunPanelState["usage"]): string {
  if (!usage) return "用量还没回来";
  const models = usage.models.length > 0 ? usage.models.join("、") : "（未记录模型名）";
  return `已用 ${usage.totalTokens.toLocaleString("zh-CN")} tokens · ${models}`;
}
