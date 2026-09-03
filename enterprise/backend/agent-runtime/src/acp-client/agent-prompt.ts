/**
 * 子 Agent 业务 prompt 的加载与投递（施工单 M5-05 / M8-02 / M8-05 / M9-02）。
 *
 * # 为什么需要这个文件
 *
 * `enterprise/backend/pi-agents/prompts/*.md` 一直存在，但**没有任何代码读它们**——
 * 走查时六份文件里有五份是"占位骨架，业务 prompt 归 M5-05"，
 * 而模型手上只有 pi 的默认提示词，于是自由发挥写长文：
 * 出行分支平均 72 秒，超过 60 秒的汇聚超时阈值，整轮拿不到结果。
 * **"prompt 文件在仓库里"与"模型读到了它"是两件事**，中间这一段此前是断的。
 *
 * # 投递方式的两代（历史脉络，别再退回去）
 *
 * 第一代（M5-05 ~ M23-02 前）：**首轮前置**——新会话第一条 `session/prompt` 里
 * 把职责说明拼在车主原话前面，用 `====` 边界线隔开。当时的理由是"pi 没有
 * system prompt 钩子"，那在早期版本成立。代价也真实：职责说明混在对话流里，
 * 会被 compaction 当普通对话压缩，模型偶尔把 prompt 例句当车主提问回答。
 *
 * 第二代（M23-02 起）：**`--append-system-prompt` 启动参数**。0.84.1 的 pi 有
 * 完整的系统提示词入口（2026-08-25 实测：一次性与 `--mode rpc` 都生效，
 * 特殊字符逐字透传）。注入点在 `connection.ts` 的 `connect()`：
 * `CARLIFE_PI_APPEND_PROMPT = loadAgentPrompt(agent)` → 包装脚本转 CLI 参数。
 * 为什么不用 `.pi/APPEND_SYSTEM.md`：十个 Agent 共用同一个 cwd，
 * 文件注入区分不了 Agent，按进程差异化只有参数一条路。
 * 本文件于是只剩**加载与规范名**两职：读盘、缓存、抛错语义、后缀家族。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import type { AgentName } from "@carlife/tools";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(HERE, "../../../pi-agents/prompts");

/**
 * 占位文件的特征串。
 *
 * **在 CI 里当断言用**：一份写着"占位骨架"的 prompt 上线，
 * 表现不是报错而是"回答很啰嗦""偶尔跑题"——没人会把它归因到 prompt 没写。
 */
export const PLACEHOLDER_MARKER = "占位骨架";

const cache = new Map<string, string>();

/**
 * 会话身份 → 规范 Agent 名。
 *
 * 同一个 Agent 会有**多个 ACP 会话**，用后缀区分：
 *  - `-task`：fan-out 的分支（`trip-task`），与直达路由不共享上下文
 *  - `-voice`：表述路径（`trip-voice`，TD-08 第三步）。分支已交出求解结果时，
 *    应答改由直连非推理模型讲出来，**正常不经过本文件**。
 *    列在这里是因为后缀家族必须在一处说全：漏掉它的话，哪天有人把这条路
 *    接回 ACP，`loadAgentPrompt` 会去找 `trip-voice.md` 并抛错，
 *    而外部症状只是"应答失败"——`trip-task.md` 那次踩的就是这个坑。
 *  - `-intent`：意图抽取（`supervisor-intent`），**必须与应答分开**——
 *    共用一个会话时，模型刚被要求输出四要素 JSON，紧接着的应答就继续输出 JSON，
 *    用户看到的回答是一段 `{"goal":…}`。走查时这个现象 6 次里出现 1 次，
 *    接上按 Agent 分进程后变成必现。
 *
 * 这三样东西按这个规范名走：pi 进程（工具表）、prompt 文件、工具 ACL。
 * 会话隔离靠的是会话键，不是进程或工具表——所以后缀只影响前者，不影响后三者。
 *
 * 后缀踩过一次：接上 prompt 投递的当天，两条分支双双 1.6 秒内 `failed`——
 * `trip-task.md` 不存在，`loadAgentPrompt` 抛错，而外部症状只是"分支失败"。
 */
export function canonicalAgent(agent: string): string {
  return agent.replace(/-(task|intent|voice)$/, "");
}

/**
 * 这个会话的产出**给谁看**——决定它需不需要思考。
 *
 * | 会话 | 产出给谁 | 思考 |
 * |---|---|---|
 * | `supervisor-intent` | 代码解析成四要素 JSON | ❌ |
 * | `*-task`（fan-out 分支） | 代码解析成结构化字段（`merge.ts`） | ❌ |
 * | 应答（`trip` / `ownership` / …） | **车主直接读** | ✅ |
 *
 * 实测依据：整轮 85 秒里 `think.*` 占 60~100%，而把思考关掉那次
 * （29s vs 78s）**答案明显退化**——退化的是应答那一段，不是被代码解析的那两类。
 * 所以刀要落在后缀会话上，不是一刀切。
 *
 * turn-eccbd8c3 是最直接的例子：`ownership-task` 思考 49.5 秒、18253 字、
 * 一个工具没调，到 60 秒汇聚超时都没吐出第一个 token。它的输出本来就只被
 * `parseTripDraft` 拿正则抠一个 JSON 出来——那 49.5 秒没有任何人看得到。
 */
export function thinkingLevelFor(agent: string): "off" | "high" {
  return /-(task|intent)$/.test(agent) ? "off" : "high";
}

/**
 * 车主对她的称呼。
 *
 * **唯一真相源在端上**——`clients/shared/rust/carlife-voice/src/wake.rs` 的唤醒词表，
 * 那才是决定"喊什么能叫醒她"的地方。这里只让模型知道自己叫这个名字。
 *
 * 起因是 turn-211274d1：车主说"暖暖播放音乐"，唤醒词没被剥掉就进了模型，
 * 而模型的提示词里从没出现过这两个字——于是它只能把「暖暖」读成曲名，
 * 回了一句"曲库里没有《暖暖》这首"。**这里补的是"她认得自己的名字"，
 * 不是漏剥唤醒词的修复**：那条在网关，两件事分开修。
 */
export const IDENTITY_PROMPT = `## 你是谁

你叫**暖暖**。车主用「暖暖」「你好暖暖」叫你。`;

export class MissingAgentPromptError extends Error {
  constructor(agent: string, reason: string) {
    super(`Agent ${agent} 的业务 prompt ${reason}（${PROMPTS_DIR}/${agent}.md）`);
    this.name = "MissingAgentPromptError";
  }
}

/**
 * 读取某个 Agent 的业务 prompt。
 *
 * 读不到时**抛错而不是返回空**：静默降级到"没有业务 prompt"正是此前那半年的状态，
 * 而它的症状（啰嗦、跑题、超时）看起来完全像是模型能力问题。
 */
export function loadAgentPrompt(agent: AgentName | string): string {
  const name = canonicalAgent(agent);
  const raw = cache.get(name) ?? readPromptFile(name);

  /*
   * 身份段按**传入的会话名**拼，不按规范名——所以它不能进缓存
   * （`cabin` 与 `cabin-task` 读的是同一个文件，拿到的却该是两份东西）。
   *
   * 判据与 `thinkingLevelFor` 是同一条："产出给谁看"。`-task` / `-intent`
   * 的输出被代码正则解析（`merge.ts`、意图四要素 JSON），塞人设只会污染字段；
   * 剩下的那些车主直接读，才需要知道自己是谁。`-voice` 属于后者。
   */
  return /-(task|intent)$/.test(agent) ? raw : `${IDENTITY_PROMPT}\n\n${raw}`;
}

/** 读盘 + 缓存。缓存的是**文件原文**，见 `loadAgentPrompt` 里那段。 */
function readPromptFile(name: string): string {
  let raw: string;
  try {
    raw = readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8");
  } catch {
    throw new MissingAgentPromptError(name, "文件不存在");
  }
  if (raw.trim().length === 0) throw new MissingAgentPromptError(name, "是空文件");

  cache.set(name, raw);
  return raw;
}

/** 仅供测试：清掉缓存，让下一次 `loadAgentPrompt` 重新读盘。 */
export function resetAgentPromptCache(): void {
  cache.clear();
}
