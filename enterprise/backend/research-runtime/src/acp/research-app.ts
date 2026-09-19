/**
 * 用研面的 `AcpApp` 描述符（施工单 M88-04，ACR-038 步 4）。
 *
 * # 为什么目录由这个文件给，而不是底座自己推
 *
 * `@carlife/acp` 里禁用 `import.meta.url`（`check:arch` 的 `acp-substrate-pure` 守着）。
 * 理由在底座的 `app.ts` 文件头写全了，这里只补第二个应用这一侧的那一半：
 * 车主面与用研面**上溯的层数恰好一样**，所以底座里任何一句
 * `resolve(HERE, "../../../pi-agents")` 对两边都"算得出结果"，回归也全绿——
 * 只是用研面拿到的是车主面的 `.pi/extensions` 与提示词，**零报错**。
 * 于是路径成了描述符的一部分：谁是这个应用，谁就说清自己的目录在哪。
 *
 * # `piDir` 与 `binDir` 是两件事
 *
 * - `piDir = enterprise/backend/pi-research`：`session/new` 的 `cwd`，决定 pi 加载
 *   哪份 `.pi/settings.json` 与 `.pi/extensions/`——那是用研面自己的。
 * - `binDir = enterprise/backend/pi-agents`：**借车主面的 pi 安装**（ACR-038 关键决策）。
 *   借的只是 `node_modules/.bin/pi-acp` 与 `bin/pi-approved.sh`，外加那份共用的
 *   `.pi/agent/models.json` 与凭据。各装一份的话两处 devDependencies 要人肉同步，
 *   漂一次就是"一个底座面对两个协议版本"。
 *
 * 车主面的 `createCockpitApp()` 不传 `binDir`，走缺省等于 `piDir`——它的行为逐字不变。
 *
 * # 本单只造描述符，不建进程池
 *
 * `AcpClientPool` 与 Challenger 的 transport 开关是 M88-05。装配点见 `src/index.ts`：
 * 这里产出的 `toolsEndpoint` 会被底座按 `CARLIFE_TOOLS_ENDPOINT` 注进 pi 子进程，
 * 而回调落在 `./tools-endpoint.ts`。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { canonicalAgent, type AcpApp, type AcpTracer, type ThinkingLevel } from "@carlife/acp";
import { listForAgent, type ResearchAgentName } from "@carlife/research-tools";

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
/** `src/acp/` 上溯两级。`index.ts` 的 `PKG_ROOT` 是同一个目录，只是它在 `src/` 下。 */
const PKG_ROOT = resolve(HERE, "../..");

/** pi 的**项目**目录：扩展与提示词都是用研面自己的。 */
export const RESEARCH_PI_DIR = resolve(PKG_ROOT, "../pi-research");
/** pi 的**二进制**目录：借车主面那一份安装（ACR-038 关键决策）。 */
export const RESEARCH_BIN_DIR = resolve(PKG_ROOT, "../pi-agents");

/**
 * 用研面有哪些 Agent（M89-02 扩到四个，设计稿 §4 表的全部带工具角色）。
 *
 * `satisfies` 是编译期的钉子：这份运行期清单的每个名字都必须是
 * `@carlife/research-tools` 的 `ResearchAgentName`——ACL 的值域与池键清单同源，
 * 不许在这里手写第二份名单。加一个 Agent = 工具表那边多一个名字 +
 * `pi-research/prompts/` 多一份同名 `.md`，漏了后者 `loadResearchPrompt` 当场炸。
 *
 * 顺序与 `RESEARCH_AGENT_NAMES` 不必逐字相同（那边按设计稿表行序），
 * 但**集合必须相同**：少一个名字的表现是那个 Agent 起不来，
 * 多一个则是它手里零工具却照样编出像样的答案。`research-app.test.ts` 按集合对账。
 */
export const RESEARCH_AGENTS = [
  "challenger",
  "analyst",
  "taxonomist",
  "archivist",
] as const satisfies readonly ResearchAgentName[];

/**
 * 用研面的轨迹实现：只打 console。
 *
 * 车主面那份接的是 OTel 与 `trace/span`；用研进程没有那一套，也**不引**
 * `@opentelemetry`——为几行日志给一个后台进程加一条观测链不划算，
 * 与 `internal-api` 不引 express 是同一条取舍。
 *
 * `recordPrompt` **只记结构性信息（长度），不记原文**：这些字节是从证据单元拼出来的，
 * 而"原文不出研究面"是 `internal-api` 文件头那条红线（AC-44-10 同一口径）。
 */
export const researchTracer: AcpTracer = {
  async span(threadId, name, fn, opts) {
    const startedAt = Date.now();
    try {
      const out = await fn();
      console.log(`[research-acp] ${name} ok ${Date.now() - startedAt}ms${suffix(threadId, opts?.agent)}`);
      return out;
    } catch (err) {
      console.warn(
        `[research-acp] ${name} failed ${Date.now() - startedAt}ms${suffix(threadId, opts?.agent)}：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  },
  recordSpan(threadId, name, startedAt, endedAt, status, opts) {
    console.log(`[research-acp] ${name} ${status} ${endedAt - startedAt}ms${suffix(threadId, opts?.agent)}`);
  },
  recordPrompt(threadId, agent, text) {
    // 只记长度：prompt 里是证据单元拼出来的正文，落进日志等于开了第二个出口。
    console.log(`[research-acp] prompt agent=${agent} ${text.length} 字${suffix(threadId)}`);
  },
  /**
   * 取消错误带 `cancelled = true`。
   *
   * 形状必须与调用方的判据一致（底座 `app.ts` 记的：两边 `instanceof` 对不上时，
   * 取消会被当成失败上报）。用研面没有自己的 `CancelledError` 类，
   * 判据就是这个字段——M88-05 接取消时按它分流。
   */
  cancelled: (message) => Object.assign(new Error(message), { cancelled: true as const }),
};

const suffix = (threadId?: string, agent?: string): string =>
  `${agent ? ` agent=${agent}` : ""}${threadId ? ` thread=${threadId}` : ""}`;

export interface ResearchAppOptions {
  /** 扩展回调地址。装配层给 `http://127.0.0.1:<RESEARCH_RUNTIME_PORT>`（本进程只绑回环）。 */
  toolsEndpoint: string;
  /** 覆盖 pi 项目目录。只有测试会传。 */
  piDir?: string;
  /** 覆盖 pi 二进制目录。只有测试会传。 */
  binDir?: string;
}

export function createResearchApp(opts: ResearchAppOptions): AcpApp {
  const piDir = opts.piDir ?? RESEARCH_PI_DIR;
  const promptsDir = join(piDir, "prompts");
  return {
    id: "research",
    piDir,
    binDir: opts.binDir ?? RESEARCH_BIN_DIR,
    promptsDir,
    agents: RESEARCH_AGENTS,
    toolsEndpoint: opts.toolsEndpoint,
    promptFor: async (agent) => loadResearchPrompt(promptsDir, agent),
    /*
     * 恒 `off`，不走 `defaultThinkingFor`。
     *
     * 那个默认只对 `-task` / `-intent` 后缀关思考，而研究面的 Agent 名没有后缀，
     * 落到它手里会得到 `high`。Challenger 的产出是**给代码解析的判决**
     * （收口跳是 `generateObject` + `challengeSchema`），思考只会把预算烧在
     * 没人读的地方——`ownership-task` 曾思考 49.5 秒、一个工具没调
     * （内部开发指引「四条会咬人的命名规则」第二条）。
     */
    thinkingFor: (): ThinkingLevel => "off",
    /*
     * ACL 的单一真相源是注册表的 `agents` 数组：describe 端裁剪、invoke 端 403、
     * 本清单三处**必须同源**，第四份手写清单出现之日就是它们漂移之始。
     * 归一后缀与 `promptFor` 同口径：会话隔离靠会话键，不靠后缀。
     */
    toolNamesFor: (agent) =>
      listForAgent(canonicalAgent(agent) as ResearchAgentName).map((t) => t.name),
    tracer: researchTracer,
    /*
     * **不实现 `decoratePrompt`**。车主面前置"今天几号 + 接下来的节假日"；
     * 用研面分析的是一段**已经发生过的**对话窗，贴上今天只会让模型把窗外的
     * 今天当成分析基准（底座 `app.ts` 的 `decoratePrompt` 注释写的就是这件事）。
     * 追问角度不走这里——它拼进 system / 同会话再 prompt 一次，由 M88-05 决定。
     */
  };
}

/**
 * 读这个 Agent 的业务提示词，读不到就抛。
 *
 * 与车主面 `loadAgentPrompt` 同纪律：**缺文件必须当场炸**。
 * 回一段空字符串的话，pi 照样起得来、模型照样答得出，只是没有判定口径——
 * 而"没有口径的挑战记录"看起来与正常记录一模一样（`trip-task.md` 那次的形状）。
 */
export async function loadResearchPrompt(promptsDir: string, agent: string): Promise<string> {
  const file = join(promptsDir, `${canonicalAgent(agent)}.md`);
  if (!existsSync(file)) {
    throw new Error(`[research-acp] Agent ${agent} 的提示词不存在：${file}`);
  }
  return readFileSync(file, "utf8");
}
