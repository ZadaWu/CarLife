/**
 * 一个「应用」在底座眼里长什么样（施工单 M85-09 步 4，变更单 ACR-035）。
 *
 * # 这个描述符解决的是同一件事：底座不许自己去打听
 *
 * 底座要同时服务车主面与用研面，于是凡是**两边不一样的东西**都必须由外面给：
 * 加载哪份 `.pi/extensions`、读哪个 prompts 目录、这个会话能用哪些工具、
 * 轨迹往哪写、prompt 前面要不要贴一行今天几号。
 * 一样也别让它自己推——`piDir` 那一条尤其，见下面 `piDir` 的注释。
 *
 * # 为什么是一个描述符，不是十个构造参数
 *
 * 这十项是一起变的：它们合起来才是"这是哪个应用"。拆成参数的话，
 * 新增一项就要改所有构造点，而漏传一项**不报错**——`toolNamesFor` 漏传时
 * 模型手里零工具，照样编出像样的答案（`pool.ts` 文件头记的就是这个形状）。
 */

import type { ThinkingLevel } from "./thinking";

/** 轨迹记录。底座只知道"要记一笔"，不知道记去哪。 */
export interface AcpTracer {
  /** 包一段异步操作，自动记开始/结束/失败。 */
  span<T>(threadId: string | undefined, name: string, fn: () => Promise<T>, opts?: AcpSpanOptions): Promise<T>;
  /** 记一段已经发生过的耗时（思考分段用它——那几段是事后从 tick 切出来的）。 */
  recordSpan(
    threadId: string | undefined,
    name: string,
    startedAt: number,
    endedAt: number,
    status: AcpSpanStatus,
    opts?: AcpSpanOptions,
  ): void;
  /** 记一次发给模型的 prompt。 */
  recordPrompt(threadId: string | undefined, agent: string, text: string): void;
  /**
   * 造一个「本轮已取消」的错误。
   *
   * 由应用给而不是底座自己定义：调用方要按 `err.cancelled` 把取消与真失败分开，
   * 而那个判据在应用侧（车主面是 `trace` 的 `CancelledError`）。
   * 底座自己 new 一个的话，两边的 `instanceof` 对不上——**而对不上时
   * 取消会被当成失败上报**，看起来像"一取消就报错"。
   */
  cancelled(message: string): Error;
}

export type AcpSpanStatus = "ok" | "failed" | "cancelled";

export interface AcpSpanOptions {
  agent?: string;
  /** **结构性信息**，不含用户原文（AC-44-10）。 */
  detail?: string;
}

export interface AcpApp {
  /** 哪个应用。只用于日志与进程池的键前缀，底座不按它分支。 */
  id: "cockpit" | "research";

  /**
   * `session/new` 的 `cwd`，决定 pi 加载哪份 `.pi/extensions` 与 `settings.json`。
   *
   * **这一项是本包禁用 `import.meta.url` 的全部理由。**
   * 搬家前后目录层数恰好一样（`agent-runtime/src/acp-client/` 与
   * `shared/acp/src/` 上溯三级都到 `enterprise/backend/`），所以把
   * `resolve(HERE, "../../../pi-agents")` 照搬进来，**回归会全绿、smoke:acp 也会过**
   * ——因为车主面本来就该指向 `pi-agents/`。
   *
   * 缺陷要等第二个应用接上来才发作，形态是「用研面加载了车主面的扩展与提示词」：
   * 工具表和提示词都是别人的，而且没有任何报错。
   */
  piDir: string;

  /**
   * pi 的**二进制**在哪：`node_modules/.bin/pi-acp` 与 `bin/pi-approved.sh` 所在目录。
   * **缺省等于 `piDir`**，车主面不传，行为逐字等于从前。
   *
   * 与 `piDir` 分开是因为这两件事本来就不是一件事：
   * `piDir` 是 pi 的**项目**（`session/new` 的 `cwd` 决定加载哪份 `.pi/extensions`
   * 与 `settings.json`），`binDir` 只是"从哪儿启动那个进程"。
   *
   * 用研面借车主面的 pi 安装：`piDir = pi-research/`（自己的扩展与提示词），
   * `binDir = pi-agents/`（共用那一份 pi-acp / pi / 模型覆盖 / 凭据）。
   * 各装一份的话两份 devDependencies 要人肉同步，漂一次就是"一个底座面对两个
   * 协议版本"；见 ACR-038 关键决策的对照表。
   */
  binDir?: string;

  /** prompts 目录。同上，不靠 `import.meta.url` 推。 */
  promptsDir: string;

  /** 这个应用有哪些 Agent。底座不认识具体名字，只拿它做进程池的键。 */
  agents: readonly string[];

  /**
   * 工具端点（`.pi/extensions` 里的扩展回调它）。
   *
   * 底座把它按 `CARLIFE_TOOLS_ENDPOINT` 注进子进程环境（`connection.ts` 的
   * `spawnEnvFor`）。声明了却没人消费的那阵子，用研面的扩展只能照抄车主面读
   * `AGENT_RUNTIME_URL`——于是回调到**车主面的**工具端点，`listForAgent` 对未知
   * Agent 回空表，模型手里零工具却照样编出像样的答案（ACR-038 实施陷阱 1）。
   */
  toolsEndpoint: string;

  /** 这个会话的业务 prompt。读盘与缓存都在应用侧。 */
  promptFor(agent: string): Promise<string>;

  /** 这个会话的思考档。默认规则在 `defaultThinkingFor`，应用可以叠自己的例外。 */
  thinkingFor(agent: string): ThinkingLevel;

  /**
   * 这个会话能用哪些工具，拼给 `--tools`。
   *
   * **注入而不是 import**：底座引 `@carlife/tools` 就等于让用研面间接拿到
   * 车主面的全部工具（订单、日历、车控……），而那不报错。
   * `check:arch` 的 `acp-substrate-pure` 守着这条。
   *
   * ⚠️ pi 对 `--tools` 里的未知名**静默忽略**（2026-08-25 实测 T4）：
   * 名字拼错不会报错，只会让那个工具无声消失。所以这个清单必须与
   * 扩展注册的名字同源，别在应用侧另手写一份。
   */
  toolNamesFor(agent: string): readonly string[];

  tracer: AcpTracer;

  /**
   * 给一轮 prompt 前置"模型手里没有、又必须准"的事实。
   *
   * 车主面传 `withDateline`（今天几号 + 接下来的节假日）；**用研面不传**——
   * 它分析的是一段已经发生过的对话窗，"今天"对它没有意义，
   * 贴上去只会让模型把窗外的今天当成分析基准。
   */
  decoratePrompt?(text: string, now: number): string;
}
