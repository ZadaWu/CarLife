/**
 * 能力条的调用面（施工单 M85-03）。
 *
 * 本文件**只出函数与类型**，不画界面（能力条是 M85-04）。
 *
 * # 能力条上出现哪几个按钮，前端不自己判
 *
 * `capabilitiesFor` 是 `@carlife/research` 里的纯函数，前后端引的是同一份：
 * 界面拿它决定渲染什么，服务端拿它决定受不受理。前端另写一套判断的话，
 * 被抑制的格上会出现一个按得动、但一按就 400 的按钮——
 * 而那看起来像后端坏了。
 *
 * # 运行流不新起一套重连
 *
 * `openEventStream` 已经处理了带 `Authorization` 的重连与退避。这里只包一层：
 * 收到终态事件就**主动关掉**——否则那一层会把"运行正常结束"当成断线，
 * 每隔几秒重连一次，而每次重连都收到同一条 `done`。
 */

import { api } from "./index";
import { openEventStream, type StreamHandle, type StreamState } from "./stream";

/*
 * ⚠️ 引的是**子路径**，不是包名。
 *
 * `@carlife/research` 的桶文件把 `fingerprint.ts` 一起导出，而那个文件
 * `import { createHash } from "node:crypto"`——浏览器侧打包会直接失败
 * （实测 Rollup 报 `"createHash" is not exported by "__vite-browser-external"`，
 * 而 vite 在那之前只给一句 externalized 的**警告**，很容易被当成没事）。
 * 子路径入口在包的 `exports` 里声明，纯函数照样是同一份。
 */
import { capabilitiesFor, type Capability, type SelectionScope } from "@carlife/research/capabilities";
import { ASK_MAX_ROUNDS, type AgentNote } from "@carlife/research/agent-note";
import type { RedTeamFinding } from "@carlife/research/red-team";

export type { AgentNote, Capability, RedTeamFinding, SelectionScope };
export { ASK_MAX_ROUNDS };

/** 能力条上这一刻该出现哪几个按钮。与服务端的闸门是同一个函数。 */
export const railFor = (scope: SelectionScope): readonly Capability[] => capabilitiesFor(scope);

/** `🔍` 层：同步回结果。 */
export interface LookupResult<T = unknown> {
  capability: string;
  tier: "lookup";
  result: T;
}

/** `✎` / `💬` 层：立刻回运行 id，进度经 SSE。 */
export interface RunAccepted {
  capability: string;
  tier: "write" | "dialog";
  runId: string;
  /**
   * `💬` 层的有界轮次：这一次是第几轮、上界是多少（M85-07 的 C7、M89-04 的 C10–C12）。
   *
   * 可选而不是必填：`✎` 层的能力不带这两个字段，写成必填会让它们的调用处
   * 被迫编两个数出来——而编出来的那两个数在界面上和真的长得一模一样。
   */
  round?: number;
  limit?: number;
}

export type CapabilityResponse<T = unknown> = LookupResult<T> | RunAccepted;

export const isLookup = <T>(r: CapabilityResponse<T>): r is LookupResult<T> => r.tier === "lookup";

/**
 * 调一次能力。
 *
 * 不在这里做"这条能力在不在能力条上"的预检——**闸门在服务端**，
 * 前端再判一次只会多一处可能与它分叉的判断。前端的职责是不把
 * 按不到的按钮画出来。
 */
export function runCapability<T = unknown>(
  capability: string,
  scope: SelectionScope,
  contractId: string,
  /**
   * 这条能力自己的入参（M85-07：C7 的 `angle`；M89-04：C10–C12 的 `question`）。
   *
   * 不铺成一堆具名可选参数：十二条能力各有各的入参，铺开之后这个签名
   * 会长成一串 `limit?, deltas?, angle?, question?, …`，而调用处传错位置不报错。
   */
  extra: Record<string, unknown> = {},
): Promise<CapabilityResponse<T>> {
  return api.post<CapabilityResponse<T>>(`/console/research/capabilities/${capability}`, {
    scope,
    contractId,
    ...extra,
  });
}

/**
 * 能力调用会回哪些业务错误码，以及它们在界面上该说成什么（M89-04）。
 *
 * # 为什么留一张表，而不是把服务端的 `hint` 显示出来
 *
 * `ApiError` 只带 `code`（`api/index.ts` 从错误体里取 `error` 那一个字段），
 * 拿不到 `hint` / `reason`。要拿到它得改所有页面共用的那一层——
 * 而本单的红线之一是不动它。
 *
 * # 表外的码**原样显示**
 *
 * 换成一句"操作失败"等于把唯一能排查的线索删掉。尤其
 * `capability_not_available`：它意味着这一格在服务端看来是抑制的，
 * 而界面把按钮画出来了——那是两侧判据分叉的唯一现象。
 */
export const CAPABILITY_ERROR_TEXT: Readonly<Record<string, string>> = {
  /* M89-03 的三条。前两条是 400，最后一条是 503。 */
  question_rejected: "这个问题没能通过输入规则筛，服务端没让它进模型。换个问法再试",
  ask_limit_reached: `已问满 ${ASK_MAX_ROUNDS} 轮，换个范围再问`,
  agents_not_available: "研究 Agent 未启用（RESEARCH_CHALLENGER_TRANSPORT=direct 或缺 DEEPSEEK_API_KEY）",
};

/** 认识的码翻成人话，不认识的原样带出来（同 `identity/model.ts` 的 `errorText`）。 */
export const capabilityErrorText = (code: string): string => CAPABILITY_ERROR_TEXT[code] ?? code;

/*
 * ── 四条 `🔍` 查类能力的返回形状（M85-05）──
 *
 * ⚠️ 这是后端 `research-runtime/src/capabilities/lookup.ts` 的**第二份类型声明**。
 *
 * 不能直接引那边：控制台是浏览器包，`check:arch` 的 `research-isolation` 不允许它
 * 依赖 research-runtime。把类型搬进 `@carlife/research` 也不对——那个包是纯函数，
 * 这四个形状是服务端端点的响应体，不是共享领域模型。
 *
 * 两份就有漂移的可能，所以 `console/test/lookup-result.test.ts` 读后端源码逐字段对账：
 * 后端改了字段名而这里没跟上，表现是界面上那一栏**静默变空**——不报错。
 */

export interface CounterEvidenceList {
  themes: Array<{ id: string; name: string }>;
  themeTotal: number;
  truncated: boolean;
  count: number;
  units: Array<{ unitId: string; text: string; themeId: string; themeName: string }>;
  perTheme: Array<{ themeId: string; themeName: string; count: number }>;
}

export interface SystemEventOverlap {
  window: { from: number; to: number };
  count: number;
  events: Array<{ at: number; kind: string; summary: string; inRecentHalf: boolean }>;
}

export interface SegmentSlice {
  themes: Array<{ id: string; name: string }>;
  themeTotal: number;
  truncated: boolean;
  perTheme: Array<{
    themeId: string;
    themeName: string;
    slices: Array<{ segment: string; n: number; share: number }>;
    topShare: number;
    topSegment: string | null;
  }>;
}

export interface ThresholdSensitivity {
  code: string;
  probes: Array<{ delta: number; flips: boolean; detail: string }>;
  anyFlips: boolean;
  minFlipDelta: number | null;
}

/** C9 的返回就是 findings 数组，单独给一个有类型的入口。 */
export async function fetchRedTeam(contractId: string): Promise<RedTeamFinding[]> {
  const res = await runCapability<RedTeamFinding[]>("red-team", { kind: "page" }, contractId);
  return isLookup(res) ? res.result : [];
}

export interface RunStreamEvent {
  event: "state" | "progress" | "stage" | "done" | "failed";
  runId: string;
  stage?: string;
  note?: string;
  notes?: string[];
  pending?: unknown[];
  usage?: { totalTokens: number; models: string[] } | null;
  error?: string;
  /**
   * 终态载荷（M89-04）。`done` 帧带，别的帧不带。
   *
   * 形状由跑的是哪条能力决定（C10–C12 是 `{ note: AgentNote, agent, round, steps, … }`），
   * 所以这里是 `unknown`：给一个联合类型的话，每加一条能力都要回来改这个公共文件，
   * 而漏改的表现是界面把结果静默渲染成空白。由各自的面板在用的地方收窄。
   */
  result?: unknown;
}

/**
 * 订阅一次运行的进度。
 *
 * ⚠️ `openEventStream` 只认 `data:` 行，不认 `event:` 行——所以事件类型
 * 由载荷自己带（上游两处都发）。这不是冗余：改成解析 `event:` 行的话，
 * 要动的是所有页面共用的那一层。
 */
export function openRunStream(
  runId: string,
  handlers: {
    onEvent: (e: RunStreamEvent) => void;
    onState?: (s: StreamState, detail?: string) => void;
  },
): StreamHandle {
  let handle: StreamHandle | undefined;
  let done = false;

  handle = openEventStream<RunStreamEvent>(`/console/research/runs/${encodeURIComponent(runId)}/stream`, {
    onState: handlers.onState,
    onEvent: (e) => {
      handlers.onEvent(e);
      // 终态：主动收线。不收的话重连层会把正常结束当断线，一直重连。
      if (!done && (e.event === "done" || e.event === "failed")) {
        done = true;
        handle?.close();
      }
    },
  });

  return {
    close() {
      done = true;
      handle?.close();
    },
  };
}
