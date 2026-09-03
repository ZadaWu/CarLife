/**
 * events —— 会话事件构造（施工单 M2-02）。
 *
 * 产出 M2-01 契约的 `SessionEvent`（ACP 语义投影，§3）。
 * 封套（eventId/ts/sessionId）由网关侧统一包裹——事件序号是
 * 会话事件日志的属性，归持有 SSE 缓冲区的一侧（gateway）管理。
 *
 * AvatarState 提示的约定（与 M2-04 映射表一致）：
 *  - 受理即发 `thinking`；
 *  - `speaking` 不由服务端下发——它与端上 TTS 播报起止对齐（M2-05 约束 2），
 *    由端侧在 turn_end + 播报开始时本地驱动；
 *  - `turn_end` 后端侧回落 `idle`（或进入播报态）。
 */

import type {
  FillerSource,
  MessageSource,
  SessionEvent,
} from "@carlife/shared";

/**
 * 受理回执。`transcript` 是**用户这句话的原文**——语音是 ASR 识别结果，文字就是打的那句。
 * 两种来源都带：端上只靠它追加用户气泡（`fanout.rs`），不带就是一句隐形的话。
 * 类型仍是 `string | null` 只为契约兼容，调用方不该再传 null。
 */
export function promptAccepted(
  turnId: string,
  source: MessageSource,
  transcript: string | null,
): SessionEvent {
  return { type: "prompt", turnId, source, transcript };
}

export function stateThinking(): SessionEvent {
  return { type: "update", kind: "state", state: "thinking" };
}

export function delta(turnId: string, text: string): SessionEvent {
  return { type: "update", kind: "delta", turnId, text };
}

export function turnEnd(turnId: string, messageId: string): SessionEvent {
  return { type: "update", kind: "turn_end", turnId, messageId };
}

/**
 * 并行分支起止（F-13-07）。
 *
 * `note` 是给端上直接显示的一句话，**不是分支的完整结果**——
 * 完整结果等汇聚后由应答节点表述（F-13-02：求解不在表述层做）。
 */
export function branch(
  turnId: string,
  e: { agent: string; status: "started" | "ok" | "failed" | "timeout"; durationMs?: number },
): SessionEvent {
  return {
    type: "update",
    kind: "branch",
    turnId,
    agent: e.agent,
    status: e.status,
    durationMs: e.durationMs ?? null,
    note: BRANCH_NOTE[e.status](e.agent),
  } as SessionEvent;
}

/** 端上直接显示的措辞。失败与超时**分开说**：一个是出错，一个是没等到。 */
const BRANCH_NOTE: Record<string, (agent: string) => string> = {
  started: (a) => `${branchLabel(a)}开始`,
  ok: (a) => `${branchLabel(a)}已完成`,
  failed: (a) => `${branchLabel(a)}失败了`,
  timeout: (a) => `${branchLabel(a)}超时未返回`,
};

/**
 * 分支会话名 → 端上人话（M37-01 导出供单测钉住覆盖面）。
 * 漏一个的症状是端上标识显示裸会话名（"hotel-task失败了"）——不报错，只是难看且吓人。
 * 新增 fanout 分支时同步补这里（events.test.ts 断言现役分支全覆盖）。
 */
export function branchLabel(agent: string): string {
  const names: Record<string, string> = {
    "trip-task": "路线规划",
    "ownership-task": "续航评估",
    "hotel-task": "酒店安排",
    "tour-task": "景点安排",
    "transit-task": "大交通",
    "drive-task": "自驾路线",
    "guide-access-task": "到达与停车",
    "guide-spots-task": "必玩点位",
    "guide-comfort-task": "休憩与避雷",
    // 出发导航规划（M66-02）：点「开始行程」触发的单分支。
    "nav-task": "出发导航规划",
    // 双路检索的逻辑分支（M37-02）：不是分支会话，但失败同样走 branch 事件。
    // 用车与售后共用（一个查说明书、一个查维修库），措辞取两者的公约数。
    "ownership-rag": "知识库检索",
    "ownership-usage": "用车数据读取",
  };
  return names[agent] ?? agent;
}

/**
 * 工具调用进展（F-08-05）。
 *
 * # 它回答的是"这十几秒里到底在干什么"
 *
 * 一次出行规划实测能空白十几秒。空白期间端上只有一个 thinking 状态，
 * 而"没有反应"与"坏了"在用户那里是同一件事——垫场话填的是气氛，
 * 这条填的是**事实**：正在查天气、正在算路线。
 *
 * # 三条边界
 *
 *  - **不带入参**。人话来自一张常量表（`tool-display.ts`），
 *    工具入参里有用户原文，而这条通道不走脱敏（AC-44-10 同源）。
 *  - **不进历史**。它与垫场话同属"此刻信息"：网关的补发窗口不收它
 *    （`session-bus.ts` 的 `isEphemeral`），端上也不写进对话缓存
 *    （`fanout::project` 不碰 `acc`）。重连后补一句"正在查天气"，
 *    而那次查询早就结束了。
 *  - **`toolCallId` 必须能配对**。同一轮里同一个工具会被调好几次
 *    （出行 fan-out 里 weather 实测五次），按名字配对会把完成记到别人头上。
 */
export function toolCall(
  toolCallId: string,
  toolName: string,
  displayName: string,
  status: "started" | "succeeded" | "failed",
): SessionEvent {
  return { type: "tool_call", toolCallId, toolName, displayName, status } as SessionEvent;
}

/**
 * 撤回本轮已流出的内容（F-26-06，施工单 TD-07）。
 *
 * 端上收到它就丢弃本轮已聚合的 delta，用 `replacement` 整段替换。
 * **`reason` 不带命中的具体标签**——那是审计里的东西，摆给用户看
 * 等于告诉他换个说法就能绕过去。
 */
export function retract(turnId: string, replacement: string, reason: string): SessionEvent {
  return { type: "update", kind: "retract", turnId, replacement, reason } as SessionEvent;
}

/**
 * 等待期垫场话（M18-01，F-45-06）。
 *
 * **它不是 `delta`**，两条治理约定挂在这个区别上：
 *  - 不聚合进本轮助手全文 → 不入对话历史（`fanout::project` 的 filler 分支不碰 `acc`）；
 *  - 不入网关的 `Last-Event-ID` 补发窗口 → 重连不会重复寒暄（M18-04 接）。
 *
 * `interruptible` 恒传 `true`：L0 的垫场话必须能被正文句中打断。
 * 不设默认值是刻意的——"忘了传"与"就是 false"混在一起时，
 * 后者意味着一句垫场话把正文的音轨占住，正是本功能最不该有的失败形态。
 */
export function filler(
  turnId: string,
  text: string,
  source: FillerSource,
  interruptible: boolean,
): SessionEvent {
  return { type: "update", kind: "filler", turnId, text, source, interruptible } as SessionEvent;
}
