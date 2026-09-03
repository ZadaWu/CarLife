/**
 * 配置项注册表（施工单 M3-02）—— **单一真相源**。
 *
 * 这张表同时驱动四件事，所以新增一项配置**只改这里**：
 *   1. 配置视图渲染（M3-03）
 *   2. 写入校验
 *   3. 启动期必填校验（缺失即快速失败）
 *   4. `.env.example` 一致性检查（`pnpm check:env-example`）
 *
 * 分类（US-35 的四分类在本表中的投影）：
 *   A 密钥类   `class: "secret"`   → 只写不读，全链路掩码
 *   B 接入面类 `class: "endpoint"` → 可读可改，热生效
 *   C 策略值类 → **不在本表**：等 Guardrails 落地后归运营控制台（§8.2 字段级分权）
 *   D 红线类   → **永远不在本表**：硬禁清单、capability 白名单、omni 端到端开关
 *
 * `registryHasNoPolicyOrRedline()` 把后两条做成了可断言的不变量。
 */

import { DEFAULT_DEEPSEEK_MODEL } from "@carlife/shared";

/**
 * 开发环境的 JWT 签名密钥缺省值（施工单 M49-01）。**这是仓库里唯一一份字面量**——
 * `.env.example` 的注释、`enterprise/backend/gateway/src/auth/jwt.ts` 的兜底都引用它 / 由它派生。
 * 三处各写一份的话，改一处漏两处是必然的，而漏了的表现是"我明明改了默认值还是老的"。
 *
 * 名字里的 `insecure` 与 `changeme` 都是有意的：前者让它在任何一次代码审查里刺眼，
 * 后者命中 `scripts/dev/check/check-secrets.ts` 的放行表（否则明文密钥扫描会把它报出来）。
 * 生产环境永远拿不到这个值——见 `startup.ts` 的 `isProductionEnv`。
 */
export const DEV_JWT_SECRET = "carlife-dev-insecure-jwt-secret-changeme";

/*
 * 后台两个角色的开发默认 token。值与 `auth/console.ts` 里原来硬编码的那两个
 * 一字不差——换个新值会让所有本地脚本、走查书签、runbook 里贴的 curl 一起失效，
 * 而这次要改的是"生产能不能用默认值"，不是"默认值叫什么"。
 */
export const DEV_CONSOLE_ADMIN_TOKEN = "admin-token";
export const DEV_CONSOLE_OPS_TOKEN = "ops-token";

export type ConfigClass = "secret" | "endpoint";
/**
 * 三种存储模式（ACR-017 起）：
 *  - `db`：后台为主，env 兜底（绝大多数配置）。
 *  - `env-only`：只能由部署层注入，后台只读——它们在配置层自身可用之前就被需要。
 *  - `env-override`：**env 优先**，其次 db，最后默认——部署层可"钉死"该项；
 *    钉死期间后台写入被拒（不是落库不生效——那会在删掉 env 后冒出一个
 *    早已忘记的旧值）。配置页 `source` 字段如实显示 env/db/default，
 *    "被 .env 盖住却毫无提示"的隐形覆盖（2026-09-01 踩到）就是它要消灭的。
 */
export type ConfigScope =
  | "llm"
  | "asr"
  | "tts"
  | "runtime"
  | "bootstrap"
  | "memory"
  | "rag"
  | "docparse"
  | "storage"
  | "map";
export type ConfigStorage = "db" | "env-only" | "env-override";

export interface ConfigDef {
  key: string;
  class: ConfigClass;
  scope: ConfigScope;
  /**
   * `db`：可在后台热改（A/B 类的正常形态）。
   * `env-only`：只能由部署层注入、后台只读展示——**它们在配置层自身可用之前就被需要**
   *   （DATABASE_URL 要先连上库，主密钥要先能解密），做成可热改是循环依赖。
   */
  storage: ConfigStorage;
  envFallback: string;
  default?: string;
  /** 启动期必填：缺失或非法即快速失败并指明具体项（AC-35-11） */
  required?: boolean;
  /**
   * **开发能用、生产必须显式覆盖**的缺省值（施工单 M49-01）。
   *
   * 与上面的 `default` 分工不同，别混：
   *  - `default` 是"哪里都能用的缺省"（如模型名），生产吃它没问题；
   *  - `devDefault` 是"为了让新克隆的仓库起得来"，生产吃它是**安全事故**。
   *
   * 语义由 `startup.ts` 实现：非生产时把它写回 env 并打一行醒目告警；
   * `NODE_ENV=production` 时**当它不存在**——必填项缺失照旧启动失败。
   * 只给"泄露影响面止于本机可伪造"的项用；保护落盘密文的主密钥**不许**加这个字段
   * （仓库里的钥匙能解开任何一台机器上的库，与"能伪造 token"不是一个量级）。
   */
  devDefault?: string;
  /** 只读展示：当前形态下不接受后台写入（如 fake 开关，切换归 FL-39） */
  readOnly?: boolean;
  /**
   * 取值是个闭集。有它的项在后台渲染成下拉而不是文本框。
   *
   * 不是"顺手做得好看点"：引擎名这类闭集项用自由文本框，第一个错字要到
   * **端上不出声**才被发现，而那时没人会想到是后台多打了一个空格。
   * `validate` 会照着这张表兜底，两者都在——界面挡的是手滑，校验挡的是 API 直调。
   */
  options?: readonly string[];
  description: string;
  howToObtain?: string;
  /** 返回错误信息；返回 null 表示合法 */
  validate?: (value: string) => string | null;
}

const nonEmpty = (label: string) => (v: string): string | null =>
  v.trim().length === 0 ? `${label}不能为空` : null;

const httpUrl = (v: string): string | null =>
  /^https?:\/\/.+/.test(v) ? null : "必须是 http(s):// 开头的 URL";

export const CONFIG_REGISTRY: readonly ConfigDef[] = [
  // ── LLM（§0 / §5.1：Vercel AI SDK + DeepSeek）
  {
    key: "DEEPSEEK_API_KEY",
    class: "secret",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_API_KEY",
    description: "DeepSeek API Key；缺省时 runtime 使用确定性 Fake 模型",
    howToObtain: "https://platform.deepseek.com 控制台 → API Keys",
    validate: nonEmpty("API Key"),
  },
  {
    key: "DEEPSEEK_MODEL",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_MODEL",
    default: DEFAULT_DEEPSEEK_MODEL,
    description: "对话模型名。按 Agent 的档位映射（FL-33 F-33-05）在多 Agent 落地后扩展为映射表",
    validate: nonEmpty("模型名"),
  },
  {
    key: "DEEPSEEK_BASE_URL",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_BASE_URL",
    description:
      "OpenAI 兼容端点。切自托管代理（§5.1 可选二阶段 LiteLLM）时只改这里，llm/ 以外零代码改动",
    validate: httpUrl,
  },
  {
    key: "DEEPSEEK_ANTHROPIC_BASE_URL",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_ANTHROPIC_BASE_URL",
    default: "https://api.deepseek.com/anthropic",
    description:
      "DeepSeek 的 **Anthropic 兼容**端点（M32-01）。目的地推荐的联网搜索走它声明服务端工具 web_search；" +
      "与上面 OpenAI 兼容的 DEEPSEEK_BASE_URL 是两条腿，不要互相顶替",
    validate: httpUrl,
  },
  {
    key: "DEEPSEEK_SEARCH_MODEL",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_SEARCH_MODEL",
    default: "deepseek-v4-flash",
    description:
      "联网搜索用的模型名（M32-01）。**刻意不回落到 DEEPSEEK_MODEL**：后者是对话链路调档用的，" +
      "共用一个来源会让调对话模型的人连坐搜索；且 Anthropic 端点对不认识的模型名是静默映射，出事时对不上账",
    validate: nonEmpty("模型名"),
  },
  {
    key: "CARLIFE_LLM_FAKE_TAG",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "CARLIFE_LLM_FAKE_TAG",
    description:
      "Fake 模型回复前缀（仅离线开发/测试可见）。真实 provider 下无效——它与 DEEPSEEK_MODEL 走同一条热生效路径，e2e 用它证明该路径不需要重启",
  },

  {
    key: "LLM_PRICE_PROMPT_PER_1K",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "LLM_PRICE_PROMPT_PER_1K",
    default: "0.003",
    description:
      "输入 token 单价（元/1K），用于成本估算。**单价是配置不是硬编码**——涨价时改这里，不发版。" +
      `默认取 ${DEFAULT_DEEPSEEK_MODEL}（非思考）` +
      "2026-08-17 起高峰未命中价 3 元/1M；" +
      "闲时减半、缓存命中更低，这里按保守上界记",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "必须是非负数"),
  },
  {
    key: "LLM_PRICE_COMPLETION_PER_1K",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "LLM_PRICE_COMPLETION_PER_1K",
    default: "0.009",
    description:
      "输出 token 单价（元/1K），用于成本估算。默认取 V4-Flash 2026-08-17 起高峰输出价 9 元/1M（闲时减半）",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "必须是非负数"),
  },
  {
    key: "TTS_PRICE_PER_10K_CHARS",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "TTS_PRICE_PER_10K_CHARS",
    default: "6.5",
    description:
      "语音合成单价（元/万字符），用于成本估算。默认取火山豆包 seed-tts 2.0 超自然音色按量价 6.5 元/万字符" +
      "（梯度计价日用量大可到 4.9）。计费量 = 应答 delta + 垫场话的下发字符数（turn_end.answerChars）",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "必须是非负数"),
  },

  // ── ASR（§0：豆包 omni，火山方舟 Ark）
  {
    key: "ASR_PRICE_INPUT_PER_1K",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ASR_PRICE_INPUT_PER_1K",
    default: "0.003",
    description:
      "ASR 输入 token 单价（元/1K），用于成本估算。默认取豆包 seed-2.0-mini 音频输入价 3 元/1M" +
      "（文本输入 0.2 元/1M，识别请求几乎全是音频，按高的记）",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "必须是非负数"),
  },
  {
    key: "ASR_PRICE_OUTPUT_PER_1K",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ASR_PRICE_OUTPUT_PER_1K",
    default: "0.002",
    description: "ASR 输出 token 单价（元/1K）。默认取豆包 seed-2.0-mini 输出价 2 元/1M",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "必须是非负数"),
  },
  {
    key: "ASR_DAILY_CALL_LIMIT",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ASR_DAILY_CALL_LIMIT",
    default: "0",
    description:
      "云 ASR 每日调用次数上界（ACR-016）。**0 = 不限**（默认）。超限后自动落到本地档" +
      "（免费，需 local-asr 在跑）；本地档不可用则明确失败，不返回假文本。" +
      "**不是账单上限**——它只挡我们这一侧的调用，供应商那边的钱仍要看余额。" +
      "量的大头是哨兵唤醒词转写（车内每段语音都送），设这个数前先看几天实际用量",
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? null : "必须是非负整数"),
  },
  {
    key: "ARK_API_KEY",
    class: "secret",
    scope: "asr",
    storage: "db",
    envFallback: "ARK_API_KEY",
    description: "火山方舟 Ark API Key；缺省时使用 Fake ASR",
    howToObtain: "火山引擎控制台 → 方舟 → API Key",
    validate: nonEmpty("API Key"),
  },
  {
    key: "ARK_BASE_URL",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ARK_BASE_URL",
    default: "https://ark.cn-beijing.volces.com/api/v3",
    description: "Ark 服务端点",
    validate: httpUrl,
  },
  {
    key: "ARK_ASR_MODEL",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ARK_ASR_MODEL",
    default: "doubao-seed-2-0-mini-260428",
    description: "omni 模型名。**只当 ASR 用**（音频→文本），端到端能力不启用（§0 语音链选型说明）",
    validate: nonEmpty("模型名"),
  },
  {
    key: "ASR_ENGINE",
    class: "endpoint",
    scope: "asr",
    storage: "env-override",
    envFallback: "ASR_ENGINE",
    default: "ark",
    options: ["ark", "aliyun", "mock"],
    description:
      "语音识别 vendor（ACR-015 立，ACR-017 收成唯一开关）。ark=火山方舟豆包 omni（默认）｜" +
      "aliyun=百炼 qwen3-asr-flash｜mock=本机 local-asr 容器（llama.cpp llama-server + Qwen3-ASR，" +
      "见 LOCAL_ASR_URL，需先 `dev.sh start local-asr`）。" +
      "⚠️ **与 TTS_ENGINE=mock 不是同一个服务**：那个是 mocks/tts（本机 say 包装成豆包协议，" +
      "8794），是假的；这个跑的是真模型，只是在本机、不花钱。热生效约 30s。" +
      "**.env 写了本项即钉死**（source 显示 env，" +
      "后台只读）——要热切就别在 .env 里写它。另有 fake 档仅供测试脚本经 env 注入，不进本闭集",
    validate: (v) =>
      ["ark", "aliyun", "mock"].includes(v.trim()) ? null : "只能是 ark / aliyun / mock",
  },
  {
    key: "DASHSCOPE_API_KEY",
    class: "secret",
    scope: "asr",
    storage: "db",
    envFallback: "DASHSCOPE_API_KEY",
    description:
      "阿里云百炼（DashScope）API Key，ASR 与 TTS 的 aliyun 档共用一把（ACR-015）。" +
      "缺省时两个 aliyun 档都不可用。**它不下发到端上**——aliyun TTS 走网关门面，密钥只在服务端",
    howToObtain: "https://bailian.console.aliyun.com → API-KEY 管理",
    validate: nonEmpty("API Key"),
  },
  {
    key: "DASHSCOPE_BASE_URL",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "DASHSCOPE_BASE_URL",
    default: "https://dashscope.aliyuncs.com/api/v1",
    description: "百炼服务端点（ASR 与 TTS 共用）。新加坡地域或业务空间隔离时才需要改",
    validate: httpUrl,
  },
  {
    key: "ALIYUN_ASR_MODEL",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ALIYUN_ASR_MODEL",
    default: "qwen3-asr-flash",
    description:
      "百炼 ASR 模型名。选同步档（base64 直传、按秒计费）；" +
      "**别换成 -filetrans 后缀的异步档**——那条路要公网音频 URL，我们的哨兵段没有",
    validate: nonEmpty("模型名"),
  },
  {
    key: "LOCAL_ASR_URL",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "LOCAL_ASR_URL",
    default: "http://127.0.0.1:8795/v1/audio/transcriptions",
    description:
      "本机 llama.cpp `llama-server` + Qwen3-ASR 的 OpenAI 风格转写端点（ACR-007）。" +
      "仅 ASR_ENGINE=mock 时使用；需先启动 infra/scripts/dev.sh 的 local-asr 目标。",
    validate: httpUrl,
  },

  // ── TTS（§0：豆包 seed-tts-2.0）
  {
    key: "BYTEDANCE_TTS_API_KEY",
    class: "secret",
    scope: "tts",
    storage: "db",
    envFallback: "BYTEDANCE_TTS_API_KEY",
    description:
      "字节 openspeech API Key。「仅 TTS_ENGINE=doubao 时使用」——mock 档不需要它。" +
      "**自 ACR-018 起只在服务端使用**：端上不再持有任何 vendor 密钥，合成经网关" +
      "`/v1/tts/speech` 转发。没配而切到豆包时，网关拒绝合成并回 NDJSON 错误行，" +
      "端上据此降级系统 TTS（不会拿占位值去打计费接口）",
    validate: nonEmpty("API Key"),
  },
  {
    key: "BYTEDANCE_TTS_RESOURCE_ID",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "BYTEDANCE_TTS_RESOURCE_ID",
    default: "seed-tts-2.0",
    description: "TTS 资源 ID",
  },
  {
    key: "BYTEDANCE_TTS_SPEAKER",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "BYTEDANCE_TTS_SPEAKER",
    default: "zh_female_vv_uranus_bigtts",
    description: "音色。手机/车机分端配置归 FL-38 F-38-06，本 Sprint 单值",
  },
  {
    key: "TTS_ENGINE",
    class: "endpoint",
    scope: "tts",
    storage: "env-override",
    envFallback: "TTS_ENGINE",
    // **默认 mock**：开发期的默认值不该是计费的那个。2026-08-26 那次
    // （INC-0030）烧掉的字数，起因就是"默认走云端"加上一个播报链路的 bug。
    // 演示真实音色是一次明确的动作——在这里切成 doubao/aliyun，一次点击的事。
    default: "mock",
    options: ["mock", "doubao", "aliyun"],
    description:
      "语音合成引擎。mock=本机 say 包装成豆包协议（mocks/tts，8794，不计费但走完整网络链）——" +
      "⚠️ **与 ASR_ENGINE=mock 不是同一个服务**（那个是跑真模型的 local-asr 容器）；" +
      "doubao=豆包 seed-tts-2.0（按合成字数计费）；aliyun=百炼 qwen3-tts-flash（按字符计费）。" +
      "**三档一律经网关 `/v1/tts/speech` 合成，密钥不下端**（ACR-018；aliyun 的协议转换见 ACR-015）。" +
      "切换后约 30s 内端上自动生效，不必重启客户端。" +
      "**.env 写了本项即钉死**（source 显示 env，后台只读，ACR-017）",
    validate: (v) =>
      ["mock", "doubao", "aliyun"].includes(v) ? null : "只能是 mock / doubao / aliyun",
  },
  {
    key: "TTS_DAILY_CHAR_LIMIT",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "TTS_DAILY_CHAR_LIMIT",
    // ACR-018 起默认非 0。理由见 description：那一单把 doubao 档也收进了网关，
    // 于是这个闸第一次真的能挡住最贵的一档；同一单也让 doubao 档在真机上
    // 从"静默降级 say、不花钱"变成"真的出声、按字计费"，默认不限就没有兜底了。
    default: "80000",
    description:
      "云 TTS 每日合成字符上界（ACR-016）。字符数是这一档的计费量，所以按字符不按次数计。" +
      "**0 = 不限**；默认 80000（豆包 seed-tts 约 6.5 元/万字符，即约 52 元/天封顶）。" +
      "**自 ACR-018 起三档全部经网关，这个闸对 doubao 也生效**——" +
      "改之前 doubao 是端上直连供应商，网关看不见也拦不住。超限后端上降级系统 say。" +
      "参照 INC-0030：一上午重复播报烧掉几十万字当量，正是这个闸要挡的形状",
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? null : "必须是非负整数"),
  },
  {
    key: "ALIYUN_TTS_MODEL",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "ALIYUN_TTS_MODEL",
    default: "qwen3-tts-flash",
    description:
      "百炼 TTS 模型名（仅 TTS_ENGINE=aliyun 时使用）。按字符计费约 1 元/万字符（豆包 6.5）",
    validate: nonEmpty("模型名"),
  },
  {
    key: "ALIYUN_TTS_VOICE",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "ALIYUN_TTS_VOICE",
    default: "Cherry",
    description: "百炼 TTS 音色（仅 TTS_ENGINE=aliyun 时使用）。音色闭集见百炼「系统音色」文档",
  },
  {
    key: "MOCK_TTS_URL",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "MOCK_TTS_URL",
    default: "http://localhost:8794/api/v3/tts/unidirectional",
    description:
      "mock 引擎的合成端点（mocks/tts）。它与豆包「同一套请求体与 NDJSON 响应」，" +
      "所以切换只换 URL，端上客户端一行不动",
    validate: httpUrl,
  },

  // ── 运行时开关（只读展示；切换归 FL-39 的 Mock 三态开关）
  {
    key: "CARLIFE_LLM",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CARLIFE_LLM",
    readOnly: true,
    description: '=fake 时强制离线 Fake 模型。**处于 Fake 模式时视图会高亮提示**——演示前最怕没注意到',
  },
  // CARLIFE_ASR / CARLIFE_TTS 已随 ACR-017 退休（2026-09-01）：选档只剩
  // ASR_ENGINE / TTS_ENGINE 一套（env-override，.env 写死即钉档且 source 可见）；
  // 出声与否归端上播报开关（M3-07）。发现旧变量时网关/车机启动会打废弃告警。

  {
    key: "HISTORY_RETENTION_DAYS",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "HISTORY_RETENTION_DAYS",
    default: "0",
    description:
      "对话历史保留天数；0 = 长期保留（默认）。**与记忆衰减无耦合**——历史表只服务「可翻阅」，衰减是 Mem0 那一侧的事（FL-03 存储分层对齐）。承接 M2-06 F-03-11",
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? null : "必须是非负整数"),
  },

  // ── 引导层（配置层自身可用之前就被需要，因此只能由部署层注入）
  {
    key: "DATABASE_URL",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "DATABASE_URL",
    required: true,
    readOnly: true,
    description: "PostgreSQL 连接串（含口令，故按密钥类掩码）",
  },
  {
    key: "CARLIFE_CONFIG_MASTER_KEY",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "CARLIFE_CONFIG_MASTER_KEY",
    required: true,
    readOnly: true,
    description:
      "配置加密主密钥（§13-12）。**不与密文同库**，缺失或过短即启动失败——不允许降级成明文存储",
    validate: (v) => (v.length >= 16 ? null : "主密钥至少 16 字符"),
  },
  {
    key: "CARLIFE_PII_MASTER_KEY",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "CARLIFE_PII_MASTER_KEY",
    required: true,
    readOnly: true,
    description:
      "PII 落盘加密主密钥（M42-01）。与配置主密钥**独立两把钥匙**（轮换周期与泄露影响面不同）；" +
      "不与密文同库，缺失或过短即启动失败——不允许降级成明文存储",
    validate: (v) => (v.length >= 16 ? null : "主密钥至少 16 字符"),
  },
  {
    key: "CARLIFE_JWT_SECRET",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "CARLIFE_JWT_SECRET",
    required: true,
    readOnly: true,
    devDefault: DEV_JWT_SECRET,
    description:
      "端上 JWT 签名密钥（M48-02，F-07-01；M49-01 加开发默认值）。开发环境留空时自动用" +
      "内置默认密钥并每次启动告警；**生产必须显式配置，缺失即启动失败**——一个仓库里写着的" +
      "签名密钥等于没有鉴权，而且不会以任何现象暴露（token 照常签发、照常通过）。过短同样失败",
    validate: (v) => (v.length >= 16 ? null : "签名密钥至少 16 字符"),
  },
  /*
   * 后台两个角色 token 与 `CARLIFE_JWT_SECRET` 同一条纪律（2026-09-01）：
   * 开发有默认值、生产缺失即启动失败。
   *
   * 改之前它们没有 `required`，`auth/console.ts` 自己兜底成 `admin-token` /
   * `ops-token` 并打一行 warn。那行 warn 在生产里挡不住任何事——**默认值写在
   * 公开仓库里，等于运营后台的全权凭证是公开的**：配置读写、会话浏览、
   * 审计查询、记忆浏览全在 admin 名下。而它同样不会以任何现象暴露
   * （token 照常通过、日志上一切正常），与 JWT 密钥那次是同一种错。
   */
  {
    key: "CARLIFE_ADMIN_TOKEN",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "CARLIFE_ADMIN_TOKEN",
    required: true,
    readOnly: true,
    devDefault: DEV_CONSOLE_ADMIN_TOKEN,
    description:
      "后台 admin 角色 token（POC 简化形态，退出条件见 FL-07 F-07-01）。" +
      "开发环境留空时自动用内置默认值并每次启动告警；**生产必须显式配置，缺失即启动失败**" +
      "——admin 是运营后台的全权角色，一个仓库里写着的默认值等于后台没有鉴权",
  },
  {
    key: "CARLIFE_OPS_TOKEN",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "CARLIFE_OPS_TOKEN",
    required: true,
    readOnly: true,
    devDefault: DEV_CONSOLE_OPS_TOKEN,
    description: "后台 ops 角色 token（同上；ops 只读，但会话与审计都在它名下）",
  },

  // ── 对象存储（§9 / M8-04）。S3 兼容；本地是 MinIO，生产可换任意 S3。
  //
  // 凭证**不得出现在端上、日志、前端响应中**（M8-04 边界）——
  // 所以端上从来拿不到这些值，它只与网关打交道。
  {
    key: "S3_ENDPOINT",
    class: "endpoint",
    scope: "storage",
    storage: "db",
    envFallback: "S3_ENDPOINT",
    default: "http://localhost:59000",
    description: "S3 兼容端点。**留空表示上传未接入**——此时上传接口明确返回未接入，不假装成功",
    validate: (v) => (v.trim() === "" ? null : httpUrl(v)),
  },
  {
    key: "S3_ACCESS_KEY_ID",
    class: "secret",
    scope: "storage",
    storage: "db",
    envFallback: "S3_ACCESS_KEY_ID",
    description: "对象存储 Access Key",
  },
  {
    key: "S3_SECRET_ACCESS_KEY",
    class: "secret",
    scope: "storage",
    storage: "db",
    envFallback: "S3_SECRET_ACCESS_KEY",
    description: "对象存储 Secret Key",
  },
  {
    key: "S3_BUCKET",
    class: "endpoint",
    scope: "storage",
    storage: "db",
    envFallback: "S3_BUCKET",
    default: "carlife-attachments",
    description: "附件桶名。**与知识库分开**：用户上传的内容不得进入知识库（M8-01 约束 5-②）",
  },

  // ── MinerU（PDF 版面解析，M8-01）。
  //
  // **它不在检索链路上**：只在把 PDF 转成 markdown 时用一次，产物进 RAGFlow。
  // 所以它挂了不影响线上问答，只影响"能不能加新文档"。
  {
    key: "MINERU_API_TOKEN",
    class: "secret",
    scope: "docparse",
    storage: "db",
    envFallback: "MINERU_API_TOKEN",
    description:
      "MinerU API Token。**多栏 PDF 必须经它转换**——RAGFlow 云端的 DeepDOC 会把三栏" +
      "按行横着串读（实测于迈锐宝用户手册），每行通顺、关键词也在，所以检索照样命中出处，" +
      "只是拼起来讲的不是一件事。留空则只能传单栏 PDF",
    howToObtain: "https://mineru.net 控制台 → API",
  },

  // ── RAGFlow Cloud（§6 / M8-01）。**本仓不自建向量库**，检索全托管。
  //
  // 三个 dataset id 分开配：数据集隔离靠 id 在调用层强制（AC-24-8），
  // 不是靠 prompt。少配一个只会让那一类检索报"未配置"，不会串到别的集。
  {
    key: "RAGFLOW_BASE_URL",
    class: "endpoint",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_BASE_URL",
    description:
      "RAGFlow Cloud 端点。**留空表示未接入**——此时双路检索只剩⑥那一路，" +
      "回答会显式标注「本次未引用说明书出处」，不假装查过",
    validate: (v) => (v.trim() === "" ? null : httpUrl(v)),
  },
  {
    key: "RAGFLOW_API_KEY",
    class: "secret",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_API_KEY",
    description: "RAGFlow API Key",
    howToObtain: "RAGFlow Cloud 控制台 → API Keys",
  },
  {
    key: "RAGFLOW_DATASET_VEHICLE_MANUALS",
    class: "endpoint",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_DATASET_VEHICLE_MANUALS",
    description: "车辆说明书数据集 id（消费方：用车助手）",
  },
  {
    key: "RAGFLOW_DATASET_REPAIR_KB",
    class: "endpoint",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_DATASET_REPAIR_KB",
    description:
      "维修知识库数据集 id（消费方：售后）。**内容是模拟数据**，" +
      "展示时须标注来源，不冒充真实厂商资料（F-24-11）",
  },
  {
    key: "RAGFLOW_DATASET_CAR_CATALOG",
    class: "endpoint",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_DATASET_CAR_CATALOG",
    description: "车型参数库数据集 id（消费方：购车顾问）",
  },

  // ── Mem0 记忆存储（§7 ②③⑥ / M7-01）。
  //
  // 注意这里**没有 MEM0_URL 之类的服务地址**：`mem0ai` 的 TS OSS 形态是进程内库，
  // 不是服务（M7-01 实测）。要配的是它的两个后端——向量库落哪、embedding 用谁。
  {
    key: "MEM0_VECTOR_PROVIDER",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_VECTOR_PROVIDER",
    default: "pgvector",
    description:
      "Mem0 向量库落点（§13-11 方案 A 取 pgvector：复用现有 PG，备份归入同一条 pg_dump）。" +
      "**改成 memory 会落到本地 sqlite 文件，那份数据在备份面之外**，仅供离线实验",
    validate: (v) =>
      ["pgvector", "memory", "qdrant", "redis"].includes(v.trim())
        ? null
        : "只支持 pgvector / memory / qdrant / redis",
  },
  {
    key: "MEM0_DATABASE_URL",
    class: "secret",
    scope: "memory",
    storage: "env-only",
    envFallback: "MEM0_DATABASE_URL",
    readOnly: true,
    description:
      "Mem0 向量库的连接串。**留空即回落到 DATABASE_URL**（同一台 PG，方案 A 的常态）。" +
      "与 DATABASE_URL 同为引导层性质：含口令、由部署层注入，不接受后台热改",
    validate: (v) => (v.trim() === "" ? null : nonEmpty("连接串")(v)),
  },
  {
    key: "MEM0_COLLECTION",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_COLLECTION",
    default: "carlife_memories",
    description: "向量集合名（pgvector 下即表名）。恢复演练脚本按它选表，改名要同步演练脚本",
  },
  {
    key: "MEM0_EMBEDDING_BASE_URL",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_EMBEDDING_BASE_URL",
    default: "http://localhost:11434",
    description:
      "embedding 端点。默认指向本地 Ollama——**不出网、无 API key**。" +
      "DeepSeek 没有 embedding 接口，所以这条不能复用 LLM 的端点",
    validate: httpUrl,
  },
  {
    key: "MEM0_EMBEDDING_MODEL",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_EMBEDDING_MODEL",
    default: "nomic-embed-text",
    description:
      "embedding 模型名。**换模型必须同步改 MEM0_EMBEDDING_DIMS**——维度对不上时" +
      "写入会失败或检索结果全错，且不一定报错",
  },
  {
    key: "MEM0_EMBEDDING_DIMS",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_EMBEDDING_DIMS",
    default: "768",
    description:
      "向量维度，必须与 embedding 模型一致（nomic-embed-text=768，bge-m3=1024）。" +
      "**已有数据的集合改维度需要重建并重新 embedding**，不是改个数字的事",
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "必须是正整数"),
  },

  // ── 内容审核（§8.2 / M6-03）。**接入面归系统管理员**，策略值归运营（FL-30 F-30-01 的三分边界）。
  {
    key: "GUARD_MODEL",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "GUARD_MODEL",
    default: "qwen3guard-gen",
    description:
      "内容审核模型名。**协议按名自动切换**：含 qwen3guard-gen 用 assistant-turn 协议，否则用通用 system+user（§8.2）",
  },
  {
    key: "GUARD_BASE_URL",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "GUARD_BASE_URL",
    description:
      "审核模型的 OpenAI 兼容端点。换云端/换本地 Ollama 只改这里（§8.2）。**留空表示审核层未接入**——此时规则筛与脱敏照常生效，且结果显式标注未审核，不假装跑过",
    validate: (v) => (v.trim() === "" ? null : httpUrl(v)),
  },
  {
    key: "GUARD_API_KEY",
    class: "secret",
    scope: "runtime",
    storage: "db",
    envFallback: "GUARD_API_KEY",
    description: "审核端点凭证（本地 Ollama 可留空）",
  },
  {
    key: "GUARD_TIMEOUT_MS",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "GUARD_TIMEOUT_MS",
    default: "10000",
    description: "审核调用超时（§8.2 默认 10s）。审核层挂着不返回比它判错更糟",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? null : "必须是正整数毫秒"),
  },

  // ── 内容审核：阿里云 AI 安全护栏（TD-04 起为默认供应商）。
  //
  // 与上面的 GUARD_* 是**两套并存的接入面**，由 GUARD_PROVIDER 选：
  // 阿里云是托管服务（判得更全、含提示词攻击与敏感内容），
  // OpenAI 兼容那套留着是为了能换回自建/本地模型——审核层是安全边界，
  // 不该被单一供应商的可用性绑死。
  {
    key: "GUARD_PROVIDER",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "GUARD_PROVIDER",
    default: "aliyun",
    description:
      "内容审核供应商：aliyun（阿里云 AI 安全护栏，默认）/ openai-compat（自建或本地模型）/ none（不接入，规则筛与脱敏仍生效且结果标注未审核）",
    validate: (v) =>
      ["aliyun", "openai-compat", "none"].includes(v.trim())
        ? null
        : "只能是 aliyun / openai-compat / none",
  },
  {
    key: "ALIYUN_GUARD_ENDPOINT",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "ALIYUN_GUARD_ENDPOINT",
    default: "https://green-cip.cn-shanghai.aliyuncs.com",
    description:
      "阿里云 green-cip 接入地址。**跨地域会明显加延迟**，选离部署最近的那个；VPC 内用 green-cip-vpc.* 走内网",
    validate: (v) => (v.trim() === "" ? null : httpUrl(v)),
  },
  {
    key: "Aliyun_AccessKey_ID",
    class: "secret",
    scope: "runtime",
    storage: "env-only",
    envFallback: "Aliyun_AccessKey_ID",
    description:
      "阿里云 RAM 用户 AccessKey ID（需授权 AliyunYundunGreenWebFullAccess）。**env-only**：它同时是其它阿里云服务的凭据，不该被后台改写",
  },
  {
    key: "Aliyun_AccessKey_Secret",
    class: "secret",
    scope: "runtime",
    storage: "env-only",
    envFallback: "Aliyun_AccessKey_Secret",
    description: "阿里云 RAM 用户 AccessKey Secret。同上，env-only",
  },
  {
    key: "ALIYUN_GUARD_PRO",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "ALIYUN_GUARD_PRO",
    default: "true",
    description:
      "用 _pro 版审核服务。**实测 sensitiveData（敏感内容检测）只在 _pro 上返回**——关掉它，控制台开的那个维度会一条都不回且无报错。pro 计费更高，要省钱得同时接受输入侧个人信息检测消失",
    validate: (v) => (["true", "false"].includes(v.trim()) ? null : "只能是 true / false"),
  },
  {
    key: "ALIYUN_GUARD_TIMEOUT_MS",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "ALIYUN_GUARD_TIMEOUT_MS",
    default: "5000",
    description:
      "阿里云审核超时。**比自建那套短**（5s vs 10s）：输入侧审核挡在图执行之前，用户在等第一个 token；超时后果由 fail 模式接管，不是把人晾着",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? null : "必须是正整数毫秒"),
  },

  // ── 工具层（§5 工具表 / FL-39 F-39-02：Mock 三态，与 CARLIFE_LLM/ASR/TTS 同源的开关风格）
  {
    key: "CARLIFE_TOOLS",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "CARLIFE_TOOLS",
    default: "real",
    description:
      "工具层 Mock 三态全局默认：real 走真实依赖 / mock 走内置固定数据（结果标注为模拟）/ off 返回明确的未接入。不是布尔——off 与 mock 的区别是「明说没有」与「假装成功」，后者更危险",
    validate: (v) => (["real", "mock", "off"].includes(v) ? null : "只能是 real / mock / off"),
  },
  {
    key: "CARLIFE_WEATHER_CMA",
    class: "endpoint",
    scope: "map",
    storage: "db",
    envFallback: "CARLIFE_WEATHER_CMA",
    default: "on",
    description:
      "中国气象局天气增强（M10-02）。on = 在高德/Open-Meteo 的基础预报之上补体感、湿度、" +
      "降水实况、气压、风与气象预警，并把预报窗口从 4 天拉到 7 天；off = 只留基础预报。" +
      "它无 key、大陆可达，默认开；留这个开关是为了接口改版时能一键止血，而不必发版",
    validate: (v) => (["on", "off"].includes(v) ? null : "只能是 on / off"),
  },

  // ── ⑤环境缓存（§7⑤ / M11-04）。
  //
  // **非必填**：没配就是"不缓存"——天气与路线全部直连上游，功能不受影响，
  // 只是慢且费配额。连不上也一样，不会让任何请求失败（降级会计数上报）。
  {
    key: "REDIS_URL",
    class: "endpoint",
    // scope 归 memory：⑤是六类记忆之一（虽然它严格说是缓存不是记忆，§7⑤）。
    // storage 用 env-only：连接串属于部署形态，不该能在后台页面上改——
    // 改错了整个缓存层静默失效，而那正是最难被发现的一类。
    scope: "memory",
    storage: "env-only",
    envFallback: "REDIS_URL",
    description:
      "⑤环境缓存的 Redis 地址。缓存天气预报（30min）、逆地理（24h）、路线（3min）——" +
      "**TTL 各自不同**：路线缓存久了等于给过期路况。留空即不缓存",
    howToObtain: "本机见 infra/docker-compose.yml（宿主端口 56379）：redis://localhost:56379",
  },

  // ── 高德开放平台（§5 工具表「地图 API」/ M10-01）。
  //
  // **两把 key 属于两种高德应用类型，不能互换**：Web 服务（REST）的 key 在浏览器里
  // 调会被拒，Web 端（JS API）的 key 在服务端调同样不行。分成两项而不是一项，
  // 就是为了让填错的人在配置页上看见区别，而不是在调用失败时才发现。
  //
  // 三项都**非必填**：没配就是"地图与天气未接入"——天气回退 Open-Meteo，
  // 车机地图回退程序化底图，服务照常起。
  {
    key: "AMAP_SERVER_KEY",
    class: "secret",
    scope: "map",
    storage: "db",
    envFallback: "AMAP_SERVER_KEY",
    description:
      "高德 **Web 服务** key（服务端用）：weather 沿途天气与 map_route 路径规划走它。" +
      "留空则 weather 退回 Open-Meteo（无中文天气现象）、map_route 明确返回未接入",
    howToObtain: "https://console.amap.com → 应用管理 → 新建应用 → 添加 key，服务平台选「Web 服务」",
  },
  {
    key: "AMAP_JS_KEY",
    class: "endpoint",
    scope: "map",
    storage: "db",
    envFallback: "AMAP_JS_KEY",
    description:
      "高德 **Web 端（JS API）** key（车机/客户端显示地图用）。它会随前端产物下发，" +
      "安全性靠高德控制台的域名白名单，不靠保密。留空则 HUD 回退程序化底图",
    howToObtain: "https://console.amap.com → 应用管理 → 添加 key，服务平台选「Web 端(JS API)」",
  },
  {
    key: "AMAP_JS_SECURITY_CODE",
    class: "secret",
    scope: "map",
    storage: "db",
    envFallback: "AMAP_JS_SECURITY_CODE",
    description:
      "JS API 安全密钥。**POC 期直填进前端（window._AMapSecurityConfig）是已知取舍**——" +
      "高德对生产环境的建议是用代理服务器中转，不把它发到浏览器。上线前须改代理形态",
    howToObtain: "与 AMAP_JS_KEY 同一个应用，key 列表里的「安全密钥」",
  },
];

const BY_KEY = new Map(CONFIG_REGISTRY.map((d) => [d.key, d]));

export function findConfigDef(key: string): ConfigDef | undefined {
  return BY_KEY.get(key);
}

/**
 * 可由后台写入的项：db / env-override 存储且非只读。
 *
 * env-override 的"可写"是**原则上的**——env 实际在场时写入仍会被 store 拒绝
 * （那是运行时状态，纯函数看不见，判定在 `store.write()` 里）。
 */
export function isWritable(def: ConfigDef): boolean {
  return (def.storage === "db" || def.storage === "env-override") && def.readOnly !== true;
}

/**
 * 不变量：注册表中**不存在 C 类（策略值）与 D 类（红线）**。
 * 做成可断言的函数而不是口头约定——见 M3-02 任务 1。
 */
const FORBIDDEN_KEY_PATTERNS = [
  /hard[_-]?block/i, // 硬禁清单
  /capabilit/i, // Tauri capability 白名单
  /end[_-]?to[_-]?end|omni[_-]?e2e/i, // omni 端到端开关
  /threshold|fail[_-]?mode|disclaimer/i, // Guard 策略值
];

export function registryHasNoPolicyOrRedline(): string[] {
  return CONFIG_REGISTRY.filter((d) =>
    FORBIDDEN_KEY_PATTERNS.some((p) => p.test(d.key)),
  ).map((d) => d.key);
}
