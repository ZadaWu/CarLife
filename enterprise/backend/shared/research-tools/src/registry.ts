/**
 * 研究面的工具注册表（施工单 M88-02，ACR-038 步 2）。
 *
 * # 为什么是一张表，而不是四个 AI SDK `tool()`
 *
 * 搬家之前，这四个工具只有一种存在方式：`research-runtime/src/challenge/tools.ts`
 * 里的 `tool({ description, parameters, execute })`，只被 Challenger 的直连循环用。
 * 上 ACP 之后它们还要经 **pi 扩展**注册（要 JSON Schema）、经 **tools-endpoint**
 * 回调执行（要按名字反查 + 按 Agent 过滤）。两条路要的东西不一样，
 * 但**不能各写一份**——第二份手写清单出现之日就是漂移之始（M23-00 红线同形）。
 * 所以真相源上移成注册项，`createChallengeTools` 退成从这张表拼回 SDK 形状的垫片。
 *
 * # 形状照 `@carlife/tools`，但**刻意不 import 它**
 *
 * 引了它，用研面的模型手里就会多出车主面的全部工具（订单、日历、车控……），
 * 而这件事**零报错**（ADR-011；`pool.ts` 文件头记的是同一类事故）。
 * `check:arch` 的 `research-tools-ro` 与 `research-isolation` 两条规则一起守。
 * 代价是 `assertObjectSchema` / `allowNullOnOptional` / `stripNulls` 三个小函数
 * 在仓里有两份——这是**刻意的重复**，见下面各自的来源注释。
 *
 * # 三条与车主面不同的纪律
 *
 * 1. **全只读、零 sensitive**：研究工具不接权限门（设计稿 §6）。`sensitive` 不进注册项，
 *    `describeForPi` 恒发 `false`；`research-tools-ro` 规则把 `sensitive: true` 当违规。
 * 2. **`execute` 只回派生字段**：返回里不得出现 `content` 键，文本一律来自 `textRedacted`。
 * 3. **`invokeTool` 入参不合法时不抛**，回 `{ ok: false, error }`——它的调用方是一个 HTTP
 *    端点，把 zod 的报错当 500 抛出去，模型看到的是"工具坏了"而不是"参数写错了"。
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { ResearchRepository } from "@carlife/db";

/*
 * 工具定义在 `challenge.ts` / `analyst.ts` / `archivist.ts`，表在这里。
 * 那三个文件反过来引本文件的类型（`import type`），编译后消失，**不成运行时环**。
 */
import { ANALYST_TOOLS } from "./analyst";
import { ARCHIVIST_TOOLS } from "./archivist";
import { CHALLENGE_TOOLS } from "./challenge";

/**
 * 能拿到研究工具的 Agent 名（ACL 的值域）。
 *
 * 四个带工具的 Agent（设计稿 §4）。其余角色——Coder / Embedder / Namer /
 * Synthesizer——仍是一次 `generateObject`，没有工具循环，所以不在这个值域里。
 * **加一个 Agent = 这里多一个名字 + prompts 多一个文件**，别处不用改。
 */
export type ResearchAgentName = "challenger" | "analyst" | "taxonomist" | "archivist";

/**
 * 同一份值域的运行时视图。
 *
 * 存在的理由是**对账**：M89-02 的 `RESEARCH_AGENTS`（名字 → 提示词 / 模型 / 计步）
 * 要逐项与它比对，比不上的那个 Agent 表现为"手里零工具却照样编出像样的答案"
 * （`pool.ts` 文件头记的是同一类事故）。顺序即设计稿 §4 表格的行序。
 */
export const RESEARCH_AGENT_NAMES: readonly ResearchAgentName[] = [
  "analyst",
  "challenger",
  "taxonomist",
  "archivist",
];

/**
 * 一份镜头快照的**投影**（`lensQuery` 的取数口）。
 *
 * `data` 原样透出（五个镜头各有各的形状，类型在 `@carlife/research` 的 `LensDataOf`），
 * 但顶层只留工具要解释这份数据所必需的四样：哪张镜头、哪段窗口、按哪一版码表算的、
 * 什么时候算的。`population` / `gates` / `inputsHash` 不进来——
 * 门的裁决是界面与质量门的事，模型读到它只会拿去当"这个结论可不可信"的依据，
 * 而那正是设计稿 §4 里 analyst「绝不决定」的那一栏。
 */
export interface LensSnapshotView {
  lens: string;
  windowFrom: number;
  windowTo: number;
  codebookVersion: string;
  computedAt?: number;
  /** 镜头快照的 `data` 原样。工具只读不算——抑制格尤其不能在这一层被复原。 */
  data: unknown;
}

/** 码表里的一个码。`counterExamples` 用 camelCase：YAML 的 `counter_examples` 在投影时改名。 */
export interface CodebookCodeView {
  id: string;
  label: string;
  definition: string;
  include: string;
  exclude: string;
  examples: readonly string[];
  counterExamples: readonly string[];
}

export interface CodebookAxisView {
  id: string;
  label: string;
  /** `single` | `multi`。多选轴的 `max` 不投影——那是编码器的约束，不是查表的人要看的。 */
  cardinality: string;
  codes: readonly CodebookCodeView[];
}

/**
 * 码表的结构化视图。
 *
 * **不 import research-runtime 的 `Codebook`**：那个类型带着 `filePath` 与解析细节，
 * 而工具表被 research-runtime 依赖，反向引一次就成了环。由 research-runtime
 * 在 `challenge/deps.ts` 里投影成这个形状喂进来。
 */
export interface CodebookView {
  version: string;
  /** ISO 时刻；未锁版为 null。锁没锁版决定 taxonomist 的提案能不能落。 */
  lockedAt: string | null;
  axes: readonly CodebookAxisView[];
}

/**
 * 复编码一致率的视图（形状同 `@carlife/db` 的 `CodebookAgreement`）。
 *
 * **两层各报各的**：`human*` 回答"这套码表说得清吗"，`model*` 回答"这个模型编得准吗"。
 * 没有人工参照集时 `humanPercent` 就是 null——不拿 `modelPercent` 顶替（M82-10 纪律）。
 */
export interface CodebookAgreementView {
  humanPercent: number | null;
  humanAlpha: number | null;
  modelPercent: number | null;
  modelAlpha: number | null;
  n: number;
  at: string;
  source: string;
}

/**
 * 一条证据单元能给模型看的全部字段（`evidenceById` 的取数口）。
 *
 * 这是一份 **allowlist**，不是"整行去掉几个键"：`research_evidence_units` 整行带
 * `userId` / `vin` / `sessionId` / `turnId` / `messageId` / `tripId`，
 * 用黑名单的话，库里新加一列的那天它就静默漏出去了——而这些字节要穿过
 * pi 的会话 jsonl 落到磁盘上。投影发生在 research-runtime 的 deps 里，
 * 工具表这一侧连整行都拿不到。
 */
export interface UnitView {
  id: string;
  kind: string;
  sourceId: string;
  occurredAt: number;
  textRedacted: string | null;
  displayLevel: string;
  /** 车主撤回授权后为 true。撤回的单元不删行（历史快照的分母要对得上）。 */
  withdrawn: boolean;
  fingerprint: string;
}

/** `unitsByCode` 能按哪一轴查。与码表的轴 id 一一对应（`needPain` ↔ `need_pain`）。 */
export type CodedAxis = "needPain" | "scene" | "job" | "emotion" | "polarity";

/** 一条按码查出来的编码轮次。文本不在这里——要正文另走 `unitTexts`。 */
export interface CodedUnitBrief {
  unitId: string;
  kind: string;
  occurredAt: number;
  scene: string | null;
  needPains: readonly string[];
  polarity: string | null;
  resolved: boolean;
}

/**
 * 四个工具共用的取数注入（M88-02 从 `research-runtime/src/challenge/tools.ts`
 * 的 `ChallengeToolDeps` 原样搬入，字段逐字不变）。
 *
 * 生产实现仍在 `research-runtime/src/challenge/deps.ts`（`createChallengeToolDeps`）——
 * 它要读 codebook、镜头与分群，那些都是用研进程的东西，不该进这个只有工具表的包。
 */
export interface ResearchToolDeps {
  repo: ResearchRepository;
  codebookVersion: string;
  /** 主题 → 成员单元 id。图那一层已经查过，不让工具再查一遍。 */
  themeMembers: (themeId: string) => Promise<{ memberUnitIds: string[]; counterUnitIds: string[] }>;
  /** 阈值敏感性：换一个阈值，这个码还在同一象限吗。 */
  thresholdSensitivity: (code: string, delta: number) => Promise<{ flips: boolean; detail: string }>;
  /** 按分群切这个主题的分布。 */
  sliceBySegment: (themeId: string) => Promise<Array<{ segment: string; n: number; share: number }>>;

  /*
   * ── 以下六项是 M89-01 为 analyst / taxonomist / archivist 补的取数口 ──────
   *
   * 全部必填：可选字段的代价不是多写一个 `?`，而是某个 Agent 手里的工具在
   * 第一次调用时静默退化成"查不到"，**而模型照样会编出一段像样的回答**。
   * 生产实现在 `research-runtime/src/challenge/deps.ts`。
   */

  /** 一张镜头的最新快照。合同未算过这张镜头时回 null，不抛。 */
  lensSnapshot: (lens: string) => Promise<LensSnapshotView | null>;
  /** 当前码表的结构化视图（含锁版时刻）。 */
  codebook: () => Promise<CodebookView>;
  /** 复编码一致率。没测过时 `agreement` 为 null——这与"测了但值很低"是两件事。 */
  agreement: () => Promise<{ lockedAt: string | null; agreement: CodebookAgreementView | null }>;
  /** 按某一轴的某个码查编码轮次。`limit` 由工具按 `TOOL_LIMIT_MAX` 截过再传进来。 */
  unitsByCode: (q: {
    code: string;
    axis?: CodedAxis;
    polarity?: string | null;
    limit: number;
  }) => Promise<CodedUnitBrief[]>;
  /** 单条证据单元的 allowlist 投影。取不到回 null。 */
  unitById: (unitId: string) => Promise<UnitView | null>;
  /** 一批单元的脱敏文本。取不到文本的单元**不出现在 Map 里**，不要填空串。 */
  unitTexts: (unitIds: readonly string[]) => Promise<Map<string, string>>;
}

/**
 * 一个研究工具的注册项。
 *
 * 两个泛型参数是**入参**与**返回**的类型，不是 schema 类型：注册表数组按
 * `<never, unknown>` 收口，而 `never` 是底类型、`unknown` 是顶类型，
 * 具名的 `execute` 因逆变/协变正好放得进去，于是每个工具各自保留精确类型、
 * 表本身又是同构的。（`@carlife/tools` 的 `ExternalTool<never, unknown>` 是同一招。）
 *
 * `R` 不能省：证据矩阵的四条查类能力**不经模型直调** `execute`
 * （`research-runtime/src/capabilities/lookup.ts`，M85-05），它们读的是
 * `out.count` / `out.events` 这些具体字段。丢了 `R` 那一侧会退化成 `any`，
 * 于是「返回形状逐字不变」这条红线在类型上不再有任何检出点。
 */
export interface ResearchToolRegistration<A = never, R = unknown> {
  /**
   * 工具名。
   *
   * ⚠️ 这里是 **camelCase**，与 `@carlife/tools` 的 snake_case 不同。
   * 不是随手写的：直连路径 `createChallengeTools(deps)` 返回的对象**以工具名为键**，
   * 而那些键是 Challenger 与既有用例逐字依赖的（`tools.findCounterEvidence`）。
   * 改成 snake_case 等于在搬家的同时改了直连路径的形状——那正是本单红线禁止的事。
   */
  name: string;
  description: string;
  /** 入参 schema。**顶层必须是 `z.object`**，理由见 `assertObjectSchema`。 */
  schema: z.ZodObject<z.ZodRawShape>;
  /** ACL：哪些 Agent 拿得到它。`listForAgent` 是唯一读法，不许另写第二份清单。 */
  agents: readonly ResearchAgentName[];
  /** 进系统提示词 `Available tools` 节的一行简介——不填 pi 就不会提它。 */
  promptSnippet: string;
  /** 工具纪律 bullets，**每条以 `` `工具名` `` 开头**（pi 把它们平铺，没有分组前缀）。 */
  promptGuidelines?: readonly string[];
  execute: (args: A, deps: ResearchToolDeps) => Promise<R>;
}

/**
 * 注册表本体：新增工具在 `challenge.ts` / `analyst.ts` / `archivist.ts` 里定义，
 * 然后加进这里。**文件名是按定义归属分的，不是按 ACL 分的**——
 * 一个工具属于哪几个 Agent 只看它自己的 `agents`，`listForAgent` 是唯一读法。
 */
const REGISTRY: readonly ResearchToolRegistration[] = [
  ...CHALLENGE_TOOLS,
  ...ANALYST_TOOLS,
  ...ARCHIVIST_TOOLS,
];

/** 全表（测试与 catalog 用）。 */
export function listAll(): readonly ResearchToolRegistration[] {
  return REGISTRY;
}

/** ACL 的唯一读法：M88-04 的 `toolNamesFor` 与 describe 端都从这里取。 */
export function listForAgent(agent: ResearchAgentName): readonly ResearchToolRegistration[] {
  return REGISTRY.filter((t) => t.agents.includes(agent));
}

/** 按名取工具，供 tools-endpoint 与单测使用。 */
export function getTool(name: string): ResearchToolRegistration | undefined {
  return REGISTRY.find((t) => t.name === name);
}

/**
 * 注册给 pi 用的工具描述（形状与 `@carlife/tools` 的 `PiToolDescriptor` 一致）。
 *
 * pi 的 `registerTool({ parameters })` 收 **JSON Schema**，而我们的真相源是 zod，
 * 这里做一次转换——**不维护两份 schema**。
 */
export interface PiToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 研究工具恒 `false`：全只读，不接权限门（设计稿 §6）。扩展的类型要这个字段。 */
  sensitive: boolean;
  promptSnippet: string;
  promptGuidelines?: readonly string[];
}

export function describeForPi(agent: ResearchAgentName): PiToolDescriptor[] {
  return listForAgent(agent).map((t) => ({
    name: t.name,
    description: t.description,
    // 可选字段允许填 null（见 allowNullOnOptional）——不放宽的话模型填个 null 就要重来一轮。
    parameters: allowNullOnOptional(
      assertObjectSchema(t.name, zodToJsonSchema(t.schema, { target: "jsonSchema7" })),
    ) as Record<string, unknown>,
    sensitive: false,
    promptSnippet: t.promptSnippet,
    ...(t.promptGuidelines ? { promptGuidelines: t.promptGuidelines } : {}),
  }));
}

/** `invokeTool` 的结果。成功与失败都是**返回值**，不是异常——理由见文件头第 3 条。 */
export type ResearchInvokeResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * 统一执行入口：pi 经 tools-endpoint 打进来，与直连垫片走的是同一段代码。
 *
 * **不做权限裁决**：研究工具全只读、零 sensitive，这里没有门可过（设计稿 §6）。
 * `execute` 自己抛出的异常照常透出——那是"取数坏了"，与"参数写错了"是两件事，
 * 调用方要分得开才能决定是回给模型还是记一条错误。
 */
export async function invokeTool(
  name: string,
  args: unknown,
  deps: ResearchToolDeps,
): Promise<ResearchInvokeResult> {
  const reg = getTool(name);
  // 未注册也是返回值：模型叫错名字不该让一次挑战整个失败，它该看见"没有这个工具"。
  if (!reg) return { ok: false, error: `未注册的研究工具：${name}` };

  // null 当没填（见 allowNullOnOptional / stripNulls）：zod 与下游永远见不到 null。
  const parsed = reg.schema.safeParse(stripNulls(args));
  if (!parsed.success) {
    return {
      ok: false,
      error: `[${name}] 入参不合法：${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }

  return { ok: true, data: await reg.execute(parsed.data as never, deps) };
}

/*
 * ── 下面三个函数从 `@carlife/tools` 的 registry.ts **复制**而来 ─────────────
 *
 * 来源：`enterprise/backend/shared/tools/src/registry.ts`
 *   - `assertObjectSchema`   :2763
 *   - `allowNullOnOptional`  :2725
 *   - `stripNulls`           :2752
 *
 * **刻意不 import**：`research-isolation` 与 `research-tools-ro` 两条 check:arch 规则
 * 都禁 `@carlife/tools`——为了三十行工具函数把车主面的整张工具表引进用研进程，
 * 代价与收益完全不成比例，而且那件事零报错（ADR-011）。
 * 这三个函数是纯的、无状态的、三年没变过，复制的漂移风险低于耦合的风险。
 * 若上游改了它们的语义（尤其 JSON Schema 的口径），这里要跟着改——
 * 两份出两种 JSON Schema 的表现是"同一个 zod schema 在车主面能用、用研面被 pi 拒"。
 */

/**
 * 工具入参的顶层 JSON Schema **必须是 object**。
 *
 * `z.discriminatedUnion` / `z.union` 出来的是 `{anyOf: [...]}`，顶层没有 `type: "object"`，
 * 上游注册工具表时会拒掉——而后果不是"这个工具用不了"，是**持有它的 Agent 整个哑掉**：
 * 每一次 prompt 都返回空字符串，没有任何报错（车主面实测踩过，见来源处的病例）。
 *
 * 所以这条在**取工具表时就炸**，而不是等运行时表现出症状。
 */
export function assertObjectSchema(tool: string, schema: unknown): Record<string, unknown> {
  const s = schema as Record<string, unknown>;
  if (s?.type !== "object") {
    throw new Error(
      `[${tool}] 工具入参的顶层 schema 必须是 object，实际是 ${JSON.stringify(Object.keys(s ?? {}))}。` +
        `union/discriminatedUnion 会生成 anyOf——改成「扁平对象 + refine」。`,
    );
  }
  return s;
}

/**
 * 递归：把 JSON Schema 里所有非必填属性改成可为 null。就地改一份深拷贝，不动入参。
 *
 * 为什么要这一刀：pi 按我们发出去的 JSON Schema 校验，`.optional()` 只接受
 * "这个键不存在"、不接受 `null`，而提示词里"不填"的东西模型常常写成 `null`，
 * 于是**在工具执行之前**整次被拒、模型只能重写一遍。
 */
export function allowNullOnOptional(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(allowNullOnOptional);
  if (!schema || typeof schema !== "object") return schema;
  const s = { ...(schema as Record<string, unknown>) };
  for (const k of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(s[k])) s[k] = (s[k] as unknown[]).map(allowNullOnOptional);
  }
  if (s.items) s.items = allowNullOnOptional(s.items);
  const props = s.properties as Record<string, unknown> | undefined;
  if (props) {
    const required = new Set((Array.isArray(s.required) ? s.required : []) as string[]);
    const out: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(props)) {
      const walked = allowNullOnOptional(sub);
      // 已经允许 null 的（zod 侧本来就 .nullable()）不再套一层。
      const already =
        typeof walked === "object" &&
        walked !== null &&
        JSON.stringify((walked as Record<string, unknown>).anyOf ?? []).includes('"null"');
      out[name] = required.has(name) || already ? walked : { anyOf: [walked, { type: "null" }] };
    }
    s.properties = out;
  }
  return s;
}

/**
 * 递归：删掉所有值为 null 的键（数组里的 null 保留——那是位置，删了会错位）。
 *
 * 与 `allowNullOnOptional` 是**一对**，少一边就白改：一边让 pi 收下 null，
 * 另一边让 zod 永远见不到 null。只放宽发出去的 schema、不在入口清掉 null，
 * 结果是 pi 放行、我们自己的 `safeParse` 拒——报错点从上游挪到了下游而已。
 */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripNulls) as unknown as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null) continue;
    out[k] = stripNulls(v);
  }
  return out as unknown as T;
}
