/**
 * `research-runtime` 服务入口（施工单 M82-04，ARCH-001 / ACR-034）。
 *
 * # 它为什么是另一个进程
 *
 * 研究面**本质上是跨用户聚合**。`agent-runtime` 里每个仓储都刻意带用户键
 * （M7-01：少一个条件读到的是别人家的数据），把无键读混进那个进程，
 * 等于给端上路径顺手留一条无键入口，而漏用的那一次没有任何现象。
 *
 * # 三个 Agent 直连、一个经 ACP——判据是有没有工具循环（ACR-038 / M88）
 *
 * Coder / Namer / Synthesizer 各是一次 `generateObject`：产出**给代码解析的结构化
 * 结果**，schema 约束恰恰是 pi 给不了的，ACP 那一整套（会话、流式 token）在它们
 * 这里没有消费者，所以直连。Challenger 不同：它的探查跳是模型自己循环调只读工具，
 * 与车主面的 A 型 Agent 同形——这一跳走 `@carlife/acp` 的底座（`AcpApp.id = "research"`，
 * pi 目录 `pi-research/`、借 `pi-agents/` 的 pi 安装，工具经 `/internal/research/tools/*`
 * 回调到本进程），收口跳仍是一次 `generateObject`。开关 `RESEARCH_CHALLENGER_TRANSPORT`
 * 缺省 `acp`，`direct` 是回滚值（`challenge/acp-transport.ts`）。
 *
 * # 启动顺序里有一处不能颠倒
 *
 * codebook 的 hash 对账必须在**注册队列消费者之前**：锁过版的码表被改过时
 * 进程要起不来，而不是先开始消费、编出一批按新口径的标签再报错。
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { AcpClientPool, createAcpStreamer } from "@carlife/acp";
import { createConfigStore, createResearchRepository, createUsageRepository, getPrisma } from "@carlife/db";
import { SOURCE_PASSPORTS } from "@carlife/research";
import type {
  AskAgentName,
  EvidenceCell,
  EvidenceMatrixData,
  ResearchSystemEvent,
  SelectionScope,
} from "@carlife/research";

import { assertCodebookConsistent, loadLatestCodebook } from "./codebook/load";
import { createInternalApi } from "./internal-api";
import { createResearchApp } from "./acp/research-app";
import { createResearchToolsEndpoint } from "./acp/tools-endpoint";
import { createResearchModel, type ResearchUsage } from "./llm";
import { handleCodeJob, type CodeJobPayload } from "./queue/code-handler";
import { handleEmbedJob, type EmbedJobPayload } from "./queue/embed-handler";
import { nameTheme } from "./ontology/namer";
import { runResearch, type RunOptions } from "./runs/run";
import { buildResearchGraph, researchThreadId } from "./graph/research-graph";
import { createChallengeToolDeps } from "./challenge/deps";
import { createChallengeTools, type ChallengeToolDeps } from "./challenge/tools";
import type { ChallengeDeps } from "./challenge/challenger";
import { readChallengerAcpTimeoutMs, readChallengerTransport } from "./challenge/acp-transport";
import { createCapabilityRuns } from "./capabilities/runs";
import { followUpRounds } from "./capabilities/follow-up";
import { CATCH_ALL_CODE, PROPOSAL_RAISED } from "./capabilities/propose-code";
import { ask, type AskContext } from "./stages/ask";
import { synthesizeAll, synthesizeOne } from "./stages/synthesize";
import { challengeAll, challengeOne } from "./stages/challenge";
import { gateAll } from "./stages/gate";
import type { ReviewDeps } from "./review/endpoints";

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const PKG_ROOT = join(HERE, "..");

/** 三条队列。名字与 worker 侧的 `RESEARCH_CODE_QUEUE` 同源，改一处要改两处。 */
export const QUEUES = {
  code: "research.code",
  embed: "research.embed",
  snapshot: "research.snapshot",
} as const;

async function main(): Promise<void> {
  const prisma = getPrisma();
  const config = createConfigStore(prisma);
  const values = await config.runtimeValues();

  const port = Number(values.get("RESEARCH_RUNTIME_PORT") ?? 8800);
  const apiKey = values.get("DEEPSEEK_API_KEY") ?? "";
  const dashscopeKey = values.get("DASHSCOPE_API_KEY") ?? "";
  const repo = createResearchRepository(prisma);

  // ① codebook：先载入、先对账。锁过版而文件被改过时**这里就该起不来**。
  const book = loadLatestCodebook(join(PKG_ROOT, "codebooks"));
  const stored = await repo.codebooks.byVersion(book.version);
  assertCodebookConsistent(book, stored);
  await repo.codebooks.upsert({
    version: book.version,
    hash: book.hash,
    axes: book.axes,
    filePath: book.filePath,
  });
  console.log(`[research-runtime] codebook v${book.version}（${stored?.lockedAt ? "已锁版" : "未锁版"}）`);

  // ② 来源护照 → 表。判断读的永远是代码常量，这张表只是可查询副本。
  await repo.sourcePassports.sync(SOURCE_PASSPORTS as unknown as Record<string, unknown>[]);

  /*
   * 用量记账。`llm_usage` **没有 reasoning_tokens 这一列**（实测 `\d llm_usage`），
   * 而 M82-04 红线是不改那张表——所以"思考确实关了"这件事不由 SQL 证明，
   * 由 `test/thinking.test.ts` 的源码扫描 + 一次抓包实测证明（见 README 与验收 §3）。
   *
   * 研究面没有会话与轮次，`sessionId` 固定 `research`、`turnId` 记批次时刻：
   * 成本要能按 agent 归因，而这张表的键是为对话设计的，只能这么落。
   *
   * **声明在队列块外**：Namer 跑在 run 里（`POST /runs` 同步调），不在队列里，
   * 但它一样要计费——漏掉它的话 `llm_usage` 按 agent 分组会少一整档。
   */
  const usage = createUsageRepository(prisma);
  let recordUsage: ((u: ResearchUsage) => Promise<void>) | undefined;

  // ③ 队列。只 work 自己的三条，绝不碰 guide.*（那是 agent-runtime 的）。
  const registered: Record<string, boolean> = { code: false, embed: false, snapshot: false };

  /**
   * Namer 的依赖，在队列块里装配（那里才有 `apiKey`），给 `startRun` 用。
   *
   * 提到块外来是因为**主题命名发生在 run 里，不在队列里**：`runResearch` 聚完簇
   * 之后要给每一簇起名，而 run 是由 `POST /runs` 同步调的。缺 key 时留 null，
   * `runResearch` 那边会退回 `${code}#${i}` 这种占位名——聚类照做，只是没有名字。
   */
  let namer: { model: ReturnType<typeof createResearchModel>; systemPrompt: string } | null = null;
  /**
   * Synthesizer 与 Challenger 的依赖（M85-01 起真的被调用）。
   *
   * 与 `namer` 同一个理由提到块外：它们跑在**图里**，而图是在这个块之后建的。
   * 缺 key 时留 null，两个阶段整段跳过并各打一句话——
   * 不是让每个主题各失败一次把日志刷满（形状与"缺 key 就不注册消费者"一致）。
   */
  let agents: {
    synthesizer: { model: ReturnType<typeof createResearchModel>; systemPrompt: string };
    challenger: { model: ReturnType<typeof createResearchModel>; systemPrompt: string };
  } | null = null;
  /** 嵌入模型名。主题聚类按它取向量——取错模型等于取到空集，主题恒 0。 */
  const embedModel = values.get("RESEARCH_EMBEDDING_MODEL") ?? "text-embedding-v4";
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) {
    console.warn("[research-runtime] 缺 DATABASE_URL——队列不起，只有只读端点可用");
  } else if (!apiKey) {
    console.warn("[research-runtime] 缺 DEEPSEEK_API_KEY——编码队列不起（只读端点照常）");
  } else {
    const { PgBoss } = await import("pg-boss");
    const boss = new PgBoss(dbUrl);
    boss.on("error", (err: unknown) => console.warn("[research-runtime] pg-boss 报错", err));
    await boss.start();

    const model = createResearchModel("coder", {
      apiKey,
      coderModel: values.get("RESEARCH_CODER_MODEL") ?? "deepseek-flash",
      synthModel: values.get("RESEARCH_SYNTH_MODEL") ?? "deepseek",
    });
    const systemPrompt = readFileSync(join(PKG_ROOT, "prompts", "coder.md"), "utf8");

    // Namer 走 synth 档（更强的那个模型）：给主题起名要读懂一簇例句，
    // 而 coder 档是为「填满受控字段」调的，不是为概括调的。
    namer = {
      model: createResearchModel("synth", {
        apiKey,
        coderModel: values.get("RESEARCH_CODER_MODEL") ?? "deepseek-flash",
        synthModel: values.get("RESEARCH_SYNTH_MODEL") ?? "deepseek",
      }),
      systemPrompt: readFileSync(join(PKG_ROOT, "prompts", "namer.md"), "utf8"),
    };

    /*
     * 两个都走 synth 档（更强的那个模型）：一个要把一簇例句写成能被反驳的判断，
     * 一个要读懂这个判断再去找能推翻它的证据。coder 档是为「填满受控字段」调的。
     */
    const synthModel = (): ReturnType<typeof createResearchModel> =>
      createResearchModel("synth", {
        apiKey,
        coderModel: values.get("RESEARCH_CODER_MODEL") ?? "deepseek-flash",
        synthModel: values.get("RESEARCH_SYNTH_MODEL") ?? "deepseek",
      });
    agents = {
      synthesizer: {
        model: synthModel(),
        systemPrompt: readFileSync(join(PKG_ROOT, "prompts", "synthesizer.md"), "utf8"),
      },
      challenger: {
        model: synthModel(),
        /*
         * Challenger 的提示词搬去了 `pi-research/prompts/`（M88-03，ACR-038 步 3）：
         * ACP 路径经 `--append-system-prompt` 下发，走的是 pi 项目目录里的那一份。
         * 直连路径**读同一个文件**，否则两套口径长得一模一样却可能不同（M85-07 的纪律）。
         * coder / namer / synthesizer 三份留在本包 `prompts/`——它们不走 ACP。
         */
        systemPrompt: readFileSync(resolve(PKG_ROOT, "../pi-research/prompts/challenger.md"), "utf8"),
      },
    };

    recordUsage = async (u: ResearchUsage): Promise<void> => {
      if (u.reasoningTokens > 0) {
        // 恒应为 0。不为 0 说明关思考没生效（换了 SDK / baseURL / 有人绕过 llm/index.ts）。
        console.warn(`[research-runtime] ⚠️ reasoning_tokens=${u.reasoningTokens}——思考没关掉，编码会变慢且可能填不满字段`);
      }
      usage.record({
        sessionId: "research",
        turnId: `code-${Date.now()}`,
        agent: u.agent,
        // 经 pi 的那一跳记 `pi-acp`（token 是估算值，口径不同，不能与直连混算）。
        provider: u.provider ?? "deepseek",
        model: u.model,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        costEstimate: 0,
        durationMs: 0,
        status: "ok",
      });
    };

    await boss.createQueue(QUEUES.code);
    await boss.createQueue(QUEUES.embed);
    await boss.work(QUEUES.code, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        const payload = job.data as CodeJobPayload;
        const out = await handleCodeJob(payload, { repo, model, systemPrompt, book, recordUsage });
        console.log(`[research-runtime] ${QUEUES.code}：${out.units} 单元 → ${out.codings} 行编码${out.skipped ? "（跳过）" : ""}`);
        // 编完就排嵌入：主题聚类吃的是向量，而向量只对编过的单元才有意义
        // （没编码的单元进不了任何一个码的分组）。
        if (!out.skipped && dashscopeKey) await boss.send(QUEUES.embed, { unitIds: payload.unitIds });
      }
    });
    registered.code = true;

    /*
     * 嵌入队列。缺 DASHSCOPE_API_KEY 时**不注册**——注册一个必然失败的消费者，
     * 表现是每个任务重试到失败态、日志刷屏，比"没接"更难排查。
     */
    if (dashscopeKey) {
      const embedConfig = {
        apiKey: dashscopeKey,
        model: values.get("RESEARCH_EMBEDDING_MODEL") ?? "text-embedding-v4",
        dimensions: Number(values.get("RESEARCH_EMBEDDING_DIM") ?? 1024),
      };
      await boss.work(QUEUES.embed, { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          const out = await handleEmbedJob(job.data as EmbedJobPayload, { repo, config: embedConfig, recordUsage });
          console.log(`[research-runtime] ${QUEUES.embed}：${out.embedded} 个向量${out.skipped ? "（跳过）" : ""}`);
        }
      });
      registered.embed = true;
    } else {
      console.warn("[research-runtime] 缺 DASHSCOPE_API_KEY——嵌入队列不起，主题聚类没有向量可用");
    }

    /*
     * 快照队列：M82-05 的快照由 `POST /internal/research/runs` 同步算，
     * 排进队列的路径留给 M82-06 的图。**仍然注册一个 handler**——
     * 不注册的话，提前排进来的任务会停在 created 态而没人知道。
     */
    await boss.createQueue(QUEUES.snapshot);
    await boss.work(QUEUES.snapshot, { batchSize: 1 }, async (jobs) => {
      console.log(`[research-runtime] ${QUEUES.snapshot}：收到 ${jobs.length} 个任务；本版快照走 POST /runs，图在 M82-06 接管`);
    });
    registered.snapshot = true;
  }

  /**
   * 一次 run 要的全部「主题材料」：单元向量 + 脱敏文本 + Namer。
   *
   * # 为什么单拎一个函数
   *
   * `startRun`（`POST /runs`）与图里的 `analyze` 节点曾是**两个**调用 `runResearch`
   * 的地方。M82-05 落地时两处都没传 `embeddings` / `texts` / `nameTheme`，于是
   * `runResearch` 里那句 `opts.embeddings ?? new Map()` 恒取空 Map，主题聚类
   * **整段被跳过**——日志还会打一句「缺 DASHSCOPE_API_KEY 时是预期行为」，
   * 于是 key 配好之后现象一模一样：向量在库里躺着 1,482 条，主题依然是 0。
   * 装配写两份迟早又只补一份，所以并成一处。
   *
   * **M85-01 起调用方只剩一个**（图的 `analyze`）：`startRun` 改走图，
   * 那条绕过图的路径已经删掉。这段注释保留是因为它记的那次事故
   * 正是"同一段装配存在两份"的代价——再开第二个调用方之前先读它。
   */
  const themeMaterials = async (
    window: { from: number; to: number },
  ): Promise<Pick<RunOptions, "embeddings" | "texts" | "nameTheme">> => {
    const turns = await repo.units.codedTurns(window, book.version);
    const unitIds = turns.map((t) => t.unitId);
    const [embeddings, texts] = await Promise.all([
      repo.embeddings.forUnits(embedModel, unitIds),
      repo.units.textsByIds(unitIds),
    ]);
    if (unitIds.length > 0 && embeddings.size === 0) {
      console.warn(
        `[research-runtime] ${unitIds.length} 个已编码单元一个向量都没有——` +
          `主题会是 0。补排：corepack pnpm research:embed-backfill`,
      );
    }
    const n = namer;
    return {
      embeddings,
      texts,
      ...(n
        ? {
            /**
             * 单簇命名失败**不拖垮整个 run**。
             *
             * 一次 run 有几十个簇，每个簇一次受控生成。任何一次 schema 不匹配、
             * 限流或超时如果直接抛，整个 run 连已经聚好的簇一起丢——而下一次重跑
             * 会命中同一个簇、同样失败。退回占位名的代价只是「这一个主题没名字」，
             * 比「这一窗没有主题」小得多，且日志点名了是哪个码，可以单独复查。
             */
            nameTheme: async (input) => {
              try {
                const r = await nameTheme(input, { model: n.model, systemPrompt: n.systemPrompt });
                await recordUsage?.({
                  agent: n.model.agent,
                  model: n.model.modelName,
                  promptTokens: r.usage.promptTokens,
                  completionTokens: r.usage.completionTokens,
                  reasoningTokens: r.usage.reasoningTokens,
                });
                return r.theme;
              } catch (err) {
                console.warn(
                  `[research-runtime] Namer 在码 ${input.needPainCode} 上失败，退占位名：` +
                    `${err instanceof Error ? err.message : String(err)}`,
                );
                // 名字里带码 + 「未命名」：图上一眼看得出这不是模型起的名，
                // 而不是一个看起来正常、实际没人读过的标签。
                return {
                  name: `${input.needPainCode}·未命名`,
                  definition: "",
                  include: "",
                  exclude: "",
                };
              }
            },
          }
        : {}),
    };
  };

  /*
   * ④ POC 缺省合同（M82-05）。没有合同就没有快照可挂——而合同的八个字段
   * 是"这次研究要回答什么"，先声明再分析这条顺序不能反：
   * 没有事先声明的行动规则，事后总能从任何一张图里读出一个支持既定结论的方向。
   */
  const defaultContractId = await ensureDefaultContract(repo, book.version);

  /**
   * 当前证据矩阵快照的 `inputs_hash`——**这一刻的口径**（G5，M85-06）。
   *
   * 洞察卡落库时抄一份，界面拿卡上那份与这一份比：不等就是
   * "这张卡基于旧口径写成，上面的数字可能不再支持它"。
   * 没有快照时回 null（合同还没算过矩阵），卡片标「口径未知」。
   */
  const currentInputsHash = async (contractId: string): Promise<string | null> => {
    const snap = (await repo.snapshots.latest(contractId, "evidence-matrix")) as { inputsHash?: string } | null;
    return snap?.inputsHash ?? null;
  };

  /**
   * 一个需求码下的全部主题。**C1–C5 共用这一个口径**（M85-05 决策 1）。
   *
   * 各写一份的代价不是重复几行，而是 C2 找反例查了四个主题、C1 归纳只出一张卡——
   * 两个数字都对，只是不在同一组主题上，而界面上看不出来。
   */
  const themesByCode = async (code: string): Promise<Array<{ id: string; name: string }>> =>
    (await repo.themes.list(book.version))
      .filter((t) => t.needPainCode === code)
      .map((t) => ({ id: t.id, name: t.name }));

  /*
   * ACP 面（M88-04 接上回调面与描述符，M88-05 起真的跑）。
   *
   * "扩展到底加载了没有"的观测点是 `/health` 的 `acp.describeCalls`：
   * 它 ≥ 1 才说明 `pi-research/.pi/extensions/` 生效了。pi 对未信任项目**静默忽略**
   * 扩展目录——模型手里零工具却照样编出像样的答案，没有任何报错。
   *
   * `toolsEndpoint` 必须是 `127.0.0.1`：本进程没有鉴权（见 `internal-api` 文件头），
   * 这两条路径也只该被本机的 pi 子进程打到。
   */
  const challengerTransport = readChallengerTransport(process.env);
  const researchApp = createResearchApp({ toolsEndpoint: `http://127.0.0.1:${port}` });

  /*
   * **`direct` 下不建池**（M88-05）。建了就是多起一个 pi 子进程：它会去拉工具表、
   * 占着一个 node 进程，而这条路上没有任何人给它发 prompt。
   * 开关翻不翻由 `RESEARCH_CHALLENGER_TRANSPORT` 说了算，本单缺省仍是 `direct`。
   *
   * 凭据由父进程注入，与车主面同纪律：pi 子进程不自己读配置 DB
   * （否则系统里会出现第三份配置缓存，热生效语义当场失效）。
   */
  const acpPool =
    challengerTransport === "acp"
      ? new AcpClientPool({
          app: researchApp,
          env: {
            ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {}),
            ...(dashscopeKey ? { DASHSCOPE_API_KEY: dashscopeKey } : {}),
          },
        })
      : undefined;

  /*
   * 反解注入给回调面：工具调用从 pi 侧回来时只带 pi 会话 id，而取数是按**挑战键**挂的。
   * 没有它，端点只剩"库里恰好挂着一个会话"那条确定性回落——并发两张卡时一律回
   * "挑战会话已结束"，模型手里的工具全部失灵而它照样编得出答案。
   */
  const researchTools = createResearchToolsEndpoint(
    acpPool ? { resolveSession: (id) => acpPool.resolveSession(id) } : {},
  );

  /** Challenger 探查跳的 ACP 接线。`sessionKey` 由 `challengeOne` 按卡补。 */
  const challengerAcp = acpPool
    ? {
        streamer: createAcpStreamer(
          acpPool.clientFor("challenger"),
          // 会话键即 thread id（`exploreAcp` 按 `hooks.threadId` 传下来）：
          // 一个挑战键一个 pi 会话，追问因此落回同一个会话继续查。
          (hooks) => ({ carlifeSessionId: hooks?.threadId ?? "challenge:unknown", agent: "challenger" }),
          researchApp.piDir,
        ),
        stepsOf: (key: string) => researchTools.stepsForKey(key),
        timeoutMs: readChallengerAcpTimeoutMs(process.env),
      }
    : undefined;

  /** 登记与摘除挑战会话。两个调用点（图批量、C6/C7）共用这一份。 */
  const acpSessions = acpPool
    ? {
        register: (key: string, deps: ChallengeToolDeps) =>
          researchTools.registerChallengeSession(key, deps),
        release: (key: string) => researchTools.release(key),
      }
    : undefined;

  if (acpPool) {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => acpPool.dispose());
  }

  console.log(
    `[research-runtime] ACP 描述符已装配：agents=${researchApp.agents.join(",")} ` +
      `piDir=${researchApp.piDir} binDir=${researchApp.binDir}；` +
      `Challenger 探查跳 transport=${challengerTransport}`,
  );

  /**
   * `✎` 层的运行台账（M85-06）。进程内，不落库——理由在 `capabilities/runs.ts` 文件头。
   */
  const capabilityRuns = createCapabilityRuns();

  /**
   * Challenger 的一整套注入件（模型 + 提示词 + 四个只读工具的取数）。
   *
   * **整 run 批量与单卡触发（C6/C7，M85-07）共用这一个装配**。各装一份的代价不是
   * 多几十行：`measurementPassed: false` 与 `minCellVehicles` 这两个口径迟早只在
   * 一边跟着改，而那时同一张卡在两条路径上会被挑出不同的结论，两边都不报错。
   */
  const challengeDepsFor = (window: { from: number; to: number }): ChallengeDeps | null =>
    agents
      ? {
          model: agents.challenger.model,
          systemPrompt: agents.challenger.systemPrompt,
          repo,
          codebookVersion: book.version,
          // 三个取数回调的真实现。之前只有 test/challenge.test.ts 里的假实现，
          // 于是模型手里四个工具有三个会在第一次调用时炸——而它照样会编出答案。
          ...createChallengeToolDeps({
            repo,
            book,
            window,
            minCellVehicles: Number(values.get("RESEARCH_MIN_CELL_VEHICLES") ?? 10),
            // 一致率未测 → measurement 门必 fail → 象限底色关着。
            measurementPassed: false,
          }),
          /*
           * 探查跳跑在哪儿（M88-05）。**装配层只给"跑法"，不给"这一次是谁"**——
           * 会话键由 `challengeOne` 按卡补上，装配层这里拿不到 insightId。
           */
          transport: challengerTransport,
          ...(challengerAcp ? { acp: challengerAcp } : {}),
        }
      : null;

  /**
   * 「问它」三个 Agent 各自的探查跳接线（M89-03）。
   *
   * # 为什么每个 Agent 各一条 streamer，而不是共用 Challenger 那一条
   *
   * 选哪个 pi 进程由两处决定，**都不在 `exploreAcp` 的入参里**：
   * `acpPool.clientFor(agent)` 决定进程（工具表是进程级的），
   * `createAcpStreamer` 的 `resolve` 回调决定这一轮算在哪个 Agent 头上
   * （会话键、用量归因）。共用 Challenger 那一条的话，analyst 的问题会被发进
   * challenger 的进程——它手里是另外四个工具，而模型照样编得出像样的答案
   * （`pool.ts` 文件头记的就是这一类事故）。
   *
   * 惰性建、建了就存着：`clientFor` 本身按 Agent 记忆化，这里再记一层是为了
   * 不让每次提问都新造一个闭包（会话映射回调里带着 agent 名，它必须稳定）。
   */
  const askStreamers = new Map<AskAgentName, ReturnType<typeof createAcpStreamer>>();
  const askAcpFor = (agent: AskAgentName) => {
    if (!acpPool) return null;
    let streamer = askStreamers.get(agent);
    if (!streamer) {
      streamer = createAcpStreamer(
        acpPool.clientFor(agent),
        // 会话键即 thread id（`exploreAcp` 按 `hooks.threadId` 传下来）：
        // 一个 ask 键一个 pi 会话，同一范围的追问因此落回同一个会话继续查。
        (hooks) => ({ carlifeSessionId: hooks?.threadId ?? `ask:${agent}:unknown`, agent }),
        researchApp.piDir,
      );
      askStreamers.set(agent, streamer);
    }
    return streamer;
  };

  /**
   * 一次提问的工具取数。**必须带 `contractId`**（M89-01 §7 #1）。
   *
   * 不带的话 `lensSnapshot` 恒回 null，analyst 的 `lensQuery` 会把它读成
   * "这张镜头还没算过"——一次**静默失效**：模型手里的第一号工具永远说没有数据，
   * 而它照样会顺着问题编出一段像样的分析。
   */
  const askToolDepsFor = (contractId: string, window: { from: number; to: number }): ChallengeToolDeps => ({
    repo,
    codebookVersion: book.version,
    ...createChallengeToolDeps({
      repo,
      book,
      window,
      minCellVehicles: Number(values.get("RESEARCH_MIN_CELL_VEHICLES") ?? 10),
      // 与 challengeAll / lookup 两处同一个理由：一致率未测 → measurement 门必 fail。
      measurementPassed: false,
      contractId,
    }),
  });

  /** 一个合同的时间窗。窗口只有合同说了算（同 `lookup`）。 */
  const contractWindow = async (contractId: string): Promise<{ from: number; to: number } | null> => {
    const row = (await repo.contracts.byId(contractId)) as
      | { windowFrom?: bigint; windowTo?: bigint }
      | null;
    if (!row) return null;
    return { from: Number(row.windowFrom ?? 0), to: Number(row.windowTo ?? Date.now()) };
  };

  /**
   * 「问它」的备料：把范围翻成模型看得懂的一句话 + 几行已知数字。
   *
   * **被抑制的格只给"样本不足"**：明细在快照阶段就清空了，在这里补一个数字
   * 等于给 G1 开一道侧门（能力条上 ask 本来就不该出现在抑制格上，这是第二道）。
   */
  const askContextFor = async (scope: SelectionScope, contractId: string): Promise<AskContext | null> => {
    const facts: string[] = [];
    const needPainOf = (code: string): string =>
      book.axes.find((a) => a.id === "need_pain")?.codes.find((c) => c.id === code)?.definition ?? "";

    if (scope.kind === "cell" || scope.kind === "row") {
      const definition = needPainOf(scope.needPainCode);
      if (definition) facts.push(`需求码 ${scope.needPainCode} 的定义：${definition}`);
    }

    if (scope.kind === "cell") {
      if (scope.suppressed) {
        facts.push("这一格被小单元抑制：明细已在快照阶段清空，没有 n / N / pct 可读");
      } else {
        const snap = (await repo.snapshots.latest(contractId, "evidence-matrix")) as
          | { data?: EvidenceMatrixData }
          | null;
        if (!snap?.data) return null;
        const row = snap.data.rows.find((r) => r.code === scope.needPainCode);
        /*
         * 被抑制的格在快照里是 `{ suppressed: true, reason }`——**连 scene 都没有**，
         * 所以按场景根本找不到它。找不到与被抑制在这里合成同一句话：
         * 两者对模型的意义相同（这一格没有可读的数字），而编一个数字才是有害的。
         */
        let cell: EvidenceCell | undefined;
        // 用循环而不是 `find`：`find` 的谓词不给类型收窄，抑制格与正常格在
        // `MaybeSuppressed<EvidenceCell>` 上是两个分支，收窄要发生在 `if` 里。
        for (const c of row?.cells ?? []) {
          if (c.suppressed !== true && c.scene === scope.sceneCode) cell = c;
        }
        if (cell) {
          facts.push(
            `这一格：n=${cell.n}、N=${cell.N}、pct=${(cell.pct * 100).toFixed(1)}%、` +
              `反例 ${cell.counter} 条、方向 ${cell.direction}`,
          );
          facts.push(`这一行（${row?.label ?? scope.needPainCode}）证据总量 ${row?.total ?? 0}`);
        } else {
          facts.push("这一格在最新快照里没有可读的明细（被抑制或这一格是空的）");
        }
      }
      return {
        headline: `证据矩阵上 ${scope.needPainCode} × ${scope.sceneCode} 这一格（研究合同 ${contractId}）`,
        facts,
      };
    }

    if (scope.kind === "row") {
      const themes = (await repo.themes.list(book.version)).filter((t) => t.needPainCode === scope.needPainCode);
      facts.push(
        themes.length > 0
          ? `这一行下的主题：${themes.map((t) => `${t.name}（${t.id}）`).join("、")}`
          : "这一行下还没有聚出主题",
      );
      return { headline: `证据矩阵上 ${scope.needPainCode} 这一整行（研究合同 ${contractId}）`, facts };
    }

    if (scope.kind === "card") {
      const row = (await repo.insights.byId(scope.insightId)) as
        | { themeId?: string; level?: string; card?: { claim?: string; evidence?: string; boundary?: string } | null }
        | null;
      if (!row) return null;
      const card = row.card ?? {};
      facts.push(`命题：${card.claim ?? ""}`);
      if (card.evidence) facts.push(`它给的证据：${card.evidence}`);
      if (card.boundary) facts.push(`它声明的边界：${card.boundary}`);
      if (row.themeId) facts.push(`主题 id：${row.themeId}`);
      if (row.level) facts.push(`等级：${row.level}（等级由人决定，不在你这一跳里改）`);
      return { headline: `洞察卡 ${scope.insightId}（研究合同 ${contractId}）`, facts };
    }

    /*
     * 整屏（与理论上到不了这里的整列）：只给合同与码表版本。
     * 把整屏的数字全铺进来的话，brief 会比模型真正查到的东西还长，
     * 而它会照着 brief 讲话、一次工具都不调。
     */
    const locked = (await repo.codebooks.byVersion(book.version))?.lockedAt != null;
    facts.push(`码表版本 v${book.version}（${locked ? "已锁版" : "未锁版"}）`);
    return { headline: `研究合同 ${contractId} 的这一屏`, facts };
  };

  /*
   * ⑤ 研究图与 review（M82-06）。
   *
   * 图只在**真的需要人**的时候停（codebook 未锁）。升级与售后放行不占着一条图的执行——
   * 它们是对已经产出的洞察做的决定，走独立端点。
   *
   * 检查点与 agent-runtime 共表，靠 `thread_id` 的 `research:` 前缀隔开；
   * `setup()` 幂等，实测前后既有 387 条检查点一行不变。
   */
  const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
  const checkpointer = dbUrl ? PostgresSaver.fromConnString(dbUrl) : null;
  if (checkpointer) await checkpointer.setup();

  const graphApp = checkpointer
    ? buildResearchGraph({
        analyze: async ({ contractId, windowFrom, windowTo }) => {
          const out = await runResearch({
            repo, book, contractId, windowFrom, windowTo,
            minCellVehicles: Number(values.get("RESEARCH_MIN_CELL_VEHICLES") ?? 10),
            agreement: null,
            codebookLocked: stored?.lockedAt != null,
            ...(await themeMaterials({ from: windowFrom, to: windowTo })),
          });
          return { turns: out.turns, themes: out.themes };
        },
        /*
         * Synthesizer 按主题出卡；没有主题（缺嵌入 key）时就是 0 张——
         * 不按需求码硬凑，那正是 M82-05 拒绝的那种"看起来齐全"。
         *
         * 缺 key 时 `agents` 为 null：**整段跳过并明说**，而不是让每个主题
         * 各失败一次、日志刷几十行。形状与队列那边"缺 key 就不注册消费者"一致。
         */
        synthesizeAll: async ({ contractId, windowFrom, windowTo }) => {
          if (!agents) {
            console.warn("[research-runtime] 缺 DEEPSEEK_API_KEY——Synthesizer 跳过，本次 0 张洞察卡");
            return [];
          }
          return synthesizeAll({
            repo,
            book,
            contractId,
            window: { from: windowFrom, to: windowTo },
            deps: agents.synthesizer,
            recordUsage,
            /*
             * 这批卡基于哪份快照（G5，M85-06）。此刻 `analyze` 已经写完快照，
             * 所以读回来的就是这次 run 的那一份。读不到就落 null = 口径未知——
             * 比落一个"看起来对"的值安全。
             */
            inputsHash: await currentInputsHash(contractId),
            // 一致率还没测（M82-10 才有 gold set）——据实传 null，不拿好看的数字顶上。
            agreement: null,
            maxThemes: Number(values.get("RESEARCH_SYNTH_MAX_THEMES") ?? 0) || undefined,
          });
        },
        challengeAll: async (insightIds, { windowFrom, windowTo }) => {
          const deps = challengeDepsFor({ from: windowFrom, to: windowTo });
          if (!deps) {
            console.warn("[research-runtime] 缺 DEEPSEEK_API_KEY——Challenger 跳过，本次 0 条挑战记录");
            return 0;
          }
          return challengeAll(insightIds, {
            repo,
            window: { from: windowFrom, to: windowTo },
            deps,
            recordUsage,
            ...(acpSessions ? { acpSessions } : {}),
          });
        },
        gate: async (insightIds, { contractId }) => {
          const out = await gateAll(insightIds, { repo, contractId });
          console.log(`[research-runtime] gate：${out.note}`);
          return { note: out.note };
        },
        isCodebookLocked: async () => (await repo.codebooks.byVersion(book.version))?.lockedAt != null,
      }).compile({ checkpointer })
    : null;

  /** 运行 id → thread。`GET runs/:id` 与 resume 都按它找。 */
  const threads = new Map<string, string>();

  const reviewDeps: ReviewDeps | undefined = graphApp
    ? {
        repo,
        codebookVersion: book.version,
        lockCodebook: async (v) => repo.codebooks.lock(v),
        createReminder: async (r) => {
          const row = await prisma.vehicleReminder.create({
            data: {
              id: `rem-research-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              userId: r.userId, vin: r.vin, kind: r.kind, message: r.message,
              basis: r.basis, degraded: false,
            },
            select: { id: true },
          });
          return row;
        },
        invalidateReminder: async (id) => {
          await prisma.vehicleReminder.update({ where: { id }, data: { invalidatedAt: new Date() } });
        },
        pendingInterrupts: async () => {
          const out: Array<{ threadId: string; kind: string; subject: string; missing: string }> = [];
          /*
           * 线程清单**从检查点表读，不从内存的 `threads` 读**。
           *
           * `threads` 是进程内的 Map，重启就空——而挂起项本身活在 PG 的
           * `checkpoints` 里，好端端地等着人。只认内存的话，`GET review`
           * 在每次重启后又变回 `{"pending":[]}`，也就是这一单要修的那个现象
           * 本身，只是换成了"重启前有、重启后没有"，更难发现。
           *
           * 顺带解决别名重复：`threads` 里一条线程有两个键（`inputsHash` 与
           * `<窗口>`），遍历 values 会让同一个挂起项出现两次而两条一模一样。
           */
          const rows = await prisma.$queryRaw<Array<{ thread_id: string }>>`
            SELECT DISTINCT thread_id FROM checkpoints WHERE thread_id LIKE 'research:%'
          `;
          for (const { thread_id: threadId } of rows) {
            const st = await graphApp.getState({ configurable: { thread_id: threadId } });
            for (const task of st.tasks ?? []) {
              for (const it of task.interrupts ?? []) {
                const v = it.value as { kind?: string; subject?: string; missing?: string };
                out.push({
                  threadId,
                  kind: v?.kind ?? "unknown",
                  subject: v?.subject ?? "",
                  missing: v?.missing ?? "",
                });
              }
            }
          }
          return out;
        },
        resumeThread: async (threadId, payload) => {
          const { Command } = await import("@langchain/langgraph");
          await graphApp.invoke(new Command({ resume: payload }), { configurable: { thread_id: threadId } });
        },
      }
    : undefined;


  // ⑥ 只绑 127.0.0.1：本进程没有鉴权，鉴权由网关代理负责（M82-07）。
  const startedAt = Date.now();
  const server = createInternalApi({
    repo,
    book,
    startedAt,
    tools: researchTools,
    /*
     * `configured` 如实说：**池建了才算接上**（direct 下回调面在、但没有 pi 进程会来打它）。
     * 冒烟脚本按它等服务就绪，所以它不能在 direct 下也报 true。
     */
    acpHealth: () => ({
      configured: acpPool !== undefined,
      ...(acpPool ? { processes: acpPool.getHealth().processes } : {}),
      describeCalls: researchTools.stats().describeCalls,
      invokeCalls: researchTools.stats().invokeCalls,
    }),
    queues: () => ({ ...registered }),
    codebookLocked: () => stored?.lockedAt != null,
    currentInputsHash,
    defaultContractId: () => defaultContractId,
    review: reviewDeps,
    runState: async (runId) => {
      /*
       * **能力运行先查**（M85-06）。它们在内存里，不在检查点表里。
       * 顺序反过来也能跑对（能力的 runId 带 `cap-` 前缀，图那边查不到），
       * 但那要多走一趟数据库才得出"不认识"。
       */
      const cap = capabilityRuns.state(runId);
      if (cap) return cap;

      const threadId = threads.get(runId) ?? runId;
      if (!graphApp) return null;
      const st = await graphApp.getState({ configurable: { thread_id: threadId } });
      if (!st.createdAt) return null;
      const values = st.values as { stage?: string; notes?: string[] };
      return {
        stage: values?.stage ?? "unknown",
        notes: values?.notes ?? [],
        pending: (st.tasks ?? []).flatMap((t) => (t.interrupts ?? []).map((i) => i.value)),
      };
    },

    /**
     * 这次运行烧了多少 token（G7，M85-03）。
     *
     * 口径：**这条线程的检查点建立之后**、`sessionId = "research"` 的那些用量行。
     * `llm_usage` 没有 run 这一列（M82-04 红线不改那张表），所以只能按时间圈。
     * 同一时刻并发两个窗口的话，两条流会各自报出两次运行的合计——
     * POC 下 `thread_id` 由合同 + 窗口定、一次只跑一个窗，先接受这个窟窿，
     * 而不是给界面编一个看起来精确的数。
     */
    runUsage: async (runId) => {
      /*
       * 能力运行的用量是**它自己累加的**，不按时间圈 `llm_usage`（M85-06）。
       * 一次 C1 只有几秒到一分钟，按时间圈必然把同窗口里别的调用一起算进来——
       * 而这里恰好拿得到准数：每次 `synthesize` 的 usage 都经过本进程。
       */
      const cap = capabilityRuns.get(runId);
      if (cap) return cap.usage;

      if (!graphApp) return null;
      const threadId = threads.get(runId) ?? runId;
      const config = { configurable: { thread_id: threadId } };
      const st = await graphApp.getState(config);
      if (!st.createdAt) return null;

      /*
       * 起点要取**最早**那个检查点，不是 `getState()` 给的那个。
       *
       * `getState()` 回的是最新检查点，而最新那个是这次运行**结束时**写的——
       * 拿它当 since 求和，得到的恒是 0。真跑时就是这个现象：一次跑了 14 分钟、
       * 烧掉几十万 token 的运行，界面上写着 `0 tokens`，而且看起来完全正常。
       */
      let since = new Date(st.createdAt);
      for await (const snap of graphApp.getStateHistory(config)) {
        if (snap.createdAt) since = new Date(snap.createdAt);
      }

      const out = await usage.summary({
        dimension: "model",
        since,
        sessionId: "research",
      });
      return {
        totalTokens: out.total.promptTokens + out.total.completionTokens,
        models: out.buckets.map((b) => b.key),
      };
    },

    /**
     * C9 的取数（M85-03）。矩阵快照、窗内系统事件、codebook 锁态三样，
     * 全从库里读回**已经算好的那一份**——红队规则不重算任何数字，
     * 重算一份就意味着同一个窗上有两套读数，而它们分叉时不会报错。
     */
    capabilities: {
      redTeamInput: async (contractId) => {
        const snap = (await repo.snapshots.latest(contractId, "evidence-matrix")) as {
          data?: unknown;
          windowFrom?: bigint;
          windowTo?: bigint;
          codebookVersion?: string;
        } | null;
        if (!snap?.data) return null;
        const from = Number(snap.windowFrom ?? 0);
        const to = Number(snap.windowTo ?? Date.now());
        const version = snap.codebookVersion ?? book.version;
        const events = (await repo.systemEvents.inWindow({ from, to })) as Array<{
          kind: string;
          at: number | bigint;
          key: string | null;
          summary: string;
          sourceRef: string;
        }>;
        const row = await repo.codebooks.byVersion(version);
        return {
          matrix: snap.data as EvidenceMatrixData,
          window: { from, to },
          systemEvents: events.map((e) => ({ ...e, at: Number(e.at) })) as ResearchSystemEvent[],
          codebookLockedAt: row?.lockedAt ? row.lockedAt.getTime() : null,
          codebookVersion: version,
        };
      },

      /**
       * C2–C5 的取数（M85-05）。**按合同装配**，因为这四条要的窗口只有合同说了算。
       *
       * 三个回调直接来自 `createChallengeToolDeps`——与 Challenger 手里那四个工具
       * 是同一份实现。另写一份的代价不是多几十行，而是 `thresholdSensitivity`
       * 的象限口径会有两套：分叉时不报错，只让同一个码在两个页面上属于不同象限。
       */
      lookup: async (contractId) => {
        const row = (await repo.contracts.byId(contractId)) as {
          windowFrom?: bigint;
          windowTo?: bigint;
          codebookVersion?: string;
        } | null;
        if (!row) return null;

        const lookupWindow = { from: Number(row.windowFrom ?? 0), to: Number(row.windowTo ?? Date.now()) };
        const version = row.codebookVersion ?? book.version;
        if (version !== book.version) {
          /*
           * 今天到不了这里（启动时 `assertCodebookConsistent` 已核对过，库里只有一版）。
           * 真到了的话，主题按合同版本查、而象限口径只能用进程里加载的这一版——
           * 两个版本混着算不会报错，所以这里必须喊出来而不是默默继续。
           */
          console.warn(
            `[research-runtime] 合同 ${contractId} 的 codebook 是 v${version}，进程加载的是 v${book.version}——` +
              "主题按前者查、阈值象限按后者算，两者不同源",
          );
        }

        return {
          window: lookupWindow,
          tools: createChallengeTools({
            repo,
            codebookVersion: version,
            ...createChallengeToolDeps({
              repo,
              book,
              window: lookupWindow,
              minCellVehicles: Number(values.get("RESEARCH_MIN_CELL_VEHICLES") ?? 10),
              // 与 challengeAll 那处同一个理由：一致率未测 → measurement 门必 fail。
              measurementPassed: false,
            }),
          }),

          /*
           * 一个需求码下的**全部**主题，不取"证据量最大的那个"。
           * 实测 36 个主题落在 10 个码上、每码 2–4 个、零个 null，
           * 所以合并的代价最多是 4 次工具调用，而丢主题的代价是一句看不出错的假话。
           */
          themesByCode: async (code) =>
            (await repo.themes.list(version))
              .filter((t) => t.needPainCode === code)
              .map((t) => ({ id: t.id, name: t.name })),
        };
      },

      /** C1 的运行台账（M85-06）。 */
      runs: capabilityRuns,

      /**
       * C1 的取数与落库。
       *
       * **`writeCard` 直接调 `synthesizeOne`**——与整 run 批量出卡是同一个函数
       * （工单约束 3）。另写一条写入路径的话，`level` 写死 `signal`、
       * `InsightBoundaryError`、`recordUsage` 三样迟早只在一边生效，而都不报错。
       */
      summarizeCell: agents
        ? {
            themesByCode,
            currentInputsHash,
            writeCard: async ({ runId, contractId, themeId, inputsHash }) => {
              const row = (await repo.contracts.byId(contractId)) as {
                windowFrom?: bigint;
                windowTo?: bigint;
              } | null;
              if (!row) throw new Error(`合同 ${contractId} 不在——出卡的窗口取自它`);
              const window = { from: Number(row.windowFrom ?? 0), to: Number(row.windowTo ?? Date.now()) };

              const theme = (await repo.themes.list(book.version)).find((t) => t.id === themeId);
              if (!theme) throw new Error(`主题 ${themeId} 不在了——可能上一次 run 重聚过簇`);

              /*
               * 这三张表是 `synthesizeOne` 要的"整窗上下文"。批量出卡时它们算一次给几十个主题用；
               * 单格触发时每张卡各算一次——一格最多四张，实测整窗 1,482 单元，代价可接受。
               * 提前记忆化只会让"这一格的数据什么时候读的"变得不确定。
               */
              const turns = await repo.units.codedTurns(window, book.version);
              const events = await repo.systemEvents.inWindow(window);

              return synthesizeOne({
                repo,
                book,
                contractId,
                window,
                deps: agents.synthesizer,
                // 一致率还没测（M82-10）——据实传 null，不拿好看的数字顶上。
                agreement: null,
                inputsHash,
                /*
                 * 两处都记：`llm_usage` 那一份是长期账（按 agent / 模型分组），
                 * 运行台账那一份是**这次点击花了多少**，运行面板当场要显示（G7）。
                 * 少记后一份的话，面板上恒是"用量还没回来"——一个不报错的空。
                 */
                recordUsage: async (u) => {
                  capabilityRuns.addUsage(runId, u.promptTokens + u.completionTokens, u.model);
                  await recordUsage?.(u);
                },
                theme,
                totalTurns: new Set(turns.map((t) => t.turnId ?? t.unitId)).size,
                vinOf: new Map(turns.map((t) => [t.unitId, t.vin])),
                occurredAt: new Map(turns.map((t) => [t.unitId, t.occurredAt])),
                eventLines: events.map(
                  (e) => `${new Date(Number(e.at)).toISOString().slice(0, 10)} ${e.kind}：${e.summary}`,
                ),
                codeDefinition:
                  book.axes
                    .find((a) => a.id === "need_pain")
                    ?.codes.find((c) => c.id === theme.needPainCode)?.definition ?? "",
              });
            },
          }
        : undefined,

      /**
       * C6 / C7 的取数与落库（M85-07）。
       *
       * **窗口取自卡片所属的合同，不取调用方传的 `contractId`**——
       * 挑战的对象是一张已经产出的卡，它是在某个窗上写成的；
       * 拿另一个窗去挑它，查出来的反例与那张卡说的不是同一批数据，
       * 而两个数字都对，只是不在同一个窗上。
       */
      challengeCard: agents
        ? {
            insightBrief: async (insightId) => {
              const row = (await repo.insights.byId(insightId)) as {
                themeId?: string;
                card?: { claim?: string } | null;
              } | null;
              if (!row) return null;
              const theme = (await repo.themes.list(book.version)).find((t) => t.id === row.themeId);
              return {
                // 取不到主题就用 id：进度里那句话宁可难看，也不能指错对象。
                themeName: theme?.name ?? row.themeId ?? insightId,
                claim: row.card?.claim ?? "",
              };
            },

            /*
             * 追问轮数 = 这张卡下 `payload.angle` 非空的记录数（M85-07 约束 2）。
             * 判据只有 `isFollowUp` 一处，服务端与界面都读它。
             */
            countFollowUps: async (insightId) =>
              followUpRounds(await repo.challenges.forInsight(insightId)),

            runChallenge: async ({ runId, insightId, angle }) => {
              const row = (await repo.insights.byId(insightId)) as { contractId?: string } | null;
              if (!row?.contractId) return { written: 0, steps: 0, verdicts: [], missing: true as const };

              const contract = (await repo.contracts.byId(row.contractId)) as {
                windowFrom?: bigint;
                windowTo?: bigint;
              } | null;
              if (!contract) throw new Error(`合同 ${row.contractId} 不在——挑战的窗口取自它`);
              const window = { from: Number(contract.windowFrom ?? 0), to: Number(contract.windowTo ?? Date.now()) };

              const deps = challengeDepsFor(window);
              if (!deps) throw new Error("缺 DEEPSEEK_API_KEY——Challenger 起不来");

              return challengeOne(insightId, {
                repo,
                window,
                deps,
                // 一次点击一个 runId——追问的轮数按它数，不按记录条数（见 follow-up.ts）。
                runId,
                ...(angle ? { extraAngle: angle } : {}),
                /*
                 * 两处都记（同 C1）：`llm_usage` 那一份是长期账，
                 * 运行台账那一份是这次点击花了多少，面板当场要显示（G7）。
                 */
                recordUsage: async (u) => {
                  capabilityRuns.addUsage(runId, u.promptTokens + u.completionTokens, u.model);
                  await recordUsage?.(u);
                },
                ...(acpSessions ? { acpSessions } : {}),
              });
            },
          }
        : undefined,

      /**
       * C8 的取数与落库（M85-08）。**一行都不写 `research_codebooks`**（G3）——
       * 产出是提案，采纳要开一个新版本，那是人的决定。
       */
      proposeCode: namer
        ? {
            catchAllThemes: async () =>
              (await repo.themes.list(book.version))
                .filter((t) => t.needPainCode === CATCH_ALL_CODE)
                .map((t) => ({
                  id: t.id,
                  name: t.name,
                  memberUnitIds: t.memberUnitIds,
                  counterUnitIds: t.counterUnitIds,
                })),

            textsByIds: (ids) => repo.units.textsByIds(ids),

            /**
             * 「会从哪几个现有码里吸走多少」（约束 3）。**代码算，不问模型。**
             *
             * 判据是这批单元在 `need_pain` 轴上还挂着哪些**别的**码：
             * `other` 自己是分母不是分子，所以剔掉。
             */
            otherCodesFor: async (unitIds) => {
              if (unitIds.length === 0) return [];
              const rows = await repo.codings.forUnits(unitIds, book.version);
              const byCode = new Map<string, Set<string>>();
              for (const r of rows) {
                if (r.axis !== "need_pain" || r.code === CATCH_ALL_CODE) continue;
                // 按**单元**去重：同一个单元在同一个码上有两条 coding 时不该数成两个。
                (byCode.get(r.code) ?? byCode.set(r.code, new Set()).get(r.code)!).add(r.unitId);
              }
              return [...byCode.entries()]
                .map(([code, units]) => ({ code, units: units.size }))
                .sort((a, b) => b.units - a.units);
            },

            nameOne: async ({ runId, examples, counterExamples }) => {
              const out = await nameTheme(
                {
                  needPainCode: CATCH_ALL_CODE,
                  /*
                   * 喂给模型的是**兜底桶自己的定义**，不是别的码的。
                   * 这一条是 C8 与整 run 命名唯一的差别：那边给的是某个真实码的定义，
                   * 而这里要模型看着"归不上现有码的那一堆"去提一个新的。
                   */
                  codeDefinition:
                    book.axes.find((a) => a.id === "need_pain")?.codes.find((c) => c.id === CATCH_ALL_CODE)
                      ?.definition ?? "归不上现有需求码的其它诉求",
                  examples,
                  counterExamples,
                },
                namer,
              );
              // 两处都记用量（同 C1/C6）：长期账一份，这次点击花了多少一份（G7）。
              capabilityRuns.addUsage(
                runId,
                out.usage.promptTokens + out.usage.completionTokens,
                out.usage.model,
              );
              await recordUsage?.(out.usage);
              return out.theme;
            },

            raise: async ({ proposalId, actor, proposal }) => {
              const row = await repo.decisions.record({
                kind: PROPOSAL_RAISED,
                subjectId: proposalId,
                /*
                 * **提出者是点按钮的那个研究员**，不是模型。
                 * 他做的决定是"把这件事提上议程"——那是一个真的决定，只是不是"采纳"。
                 * 填 `system` 或模型名的话，`decided_by` 的语义就从"谁决定的"
                 * 变成"谁生成的"，而 G2 那条治理链正是按这一列查的。
                 */
                decidedBy: actor,
                rationale: `兜底桶下「${proposal.themeName}」有 ${proposal.candidateUnits} 个单元归不上现有码，提议开「${proposal.codeName}」`,
                payload: proposal as unknown as Record<string, unknown>,
              });
              return row.id;
            },
          }
        : undefined,

      /**
       * C10–C12「问它」的取数与两跳（M89-03）。
       *
       * `agents && acpPool` 两个条件缺一不可：收口跳要直连模型（`agents`），
       * 探查跳只有 ACP 一条路（`acpPool`）。缺任何一个都留 undefined，
       * 端点回 503 `agents_not_available`——**不给假 runId**。
       */
      askAgent:
        agents && acpPool
          ? {
              context: async ({ scope, contractId }) => askContextFor(scope, contractId),
              runAsk: async ({ runId, agent, scope, contractId, question, round, sessionKey, context }) => {
                const window = await contractWindow(contractId);
                if (!window) throw new Error(`合同 ${contractId} 不在——提问的窗口取自它`);
                const streamer = askAcpFor(agent);
                if (!streamer) throw new Error("研究 Agent 池没起——「问它」只有 ACP 一条路");
                const toolDeps = askToolDepsFor(contractId, window);

                return ask(
                  { agent, scope, contractId, question, round, context },
                  {
                    streamer,
                    sessionKey,
                    stepsOf: (key) => researchTools.stepsForKey(key),
                    seenIdsOf: (key) => researchTools.seenIdsForKey(key),
                    timeoutMs: readChallengerAcpTimeoutMs(process.env),
                    model: agents.challenger.model,
                    /*
                     * 两处都记（同 C1/C6/C8）：`llm_usage` 那一份是长期账，
                     * 运行台账那一份是这次点击花了多少，面板当场要显示（G7）。
                     */
                    recordUsage: async (u) => {
                      capabilityRuns.addUsage(runId, u.promptTokens + u.completionTokens, u.model);
                      await recordUsage?.(u);
                    },
                    // 登记的是**这一次提问**的取数，与挑战共用同一张会话表（键不同，不会串）。
                    register: (key) => researchTools.registerChallengeSession(key, toolDeps),
                    release: (key) => researchTools.release(key),
                  },
                );
              },
            }
          : undefined,
    },
    /**
     * 一次研究运行。**M85-01 起走整张图**，不再绕过它直接调 `runResearch`。
     *
     * 绕过的代价不是"少走了几个节点"，而是三条都没有现象的缺口
     * （tech-debt「研究图从不被启动」）：`synthesize` / `challenge` / `gate`
     * 三个节点从未执行；`review` 的 `interrupt()` 因此永远不可达，
     * `GET review` 恒空；`threads` 从不被 `.set()`，`GET runs/:id` 恒 `run_not_found`
     * ——即使那次运行确实写了五份快照。
     *
     * `runResearch` 的调用点**收敛到图的 `analyze` 一处**，这里不再留第二条路径。
     */
    startRun: async ({ contractId, windowFrom, windowTo }) => {
      if (!graphApp) {
        throw new Error(
          "research_graph_unavailable: 缺 DATABASE_URL，检查点与图都没起——只读端点可用，但跑不了 run",
        );
      }

      /*
       * thread_id 由合同 + 窗口定，不用随机数：同一个窗重跑就该落回同一条线程，
       * 停在 review 的那次也才接得上。随机 id 会让每次重跑都新开一条，
       * 而挂起项挂在旧线程上、界面上再也找不到。
       */
      const threadId = researchThreadId(contractId, `${windowFrom}-${windowTo}`);
      const config = { configurable: { thread_id: threadId } };

      const before = (await repo.snapshots.latest(contractId, "evidence-matrix")) as
        | { inputsHash?: string }
        | null;

      await graphApp.invoke({ contractId, windowFrom, windowTo }, config);

      const st = await graphApp.getState(config);
      const v = (st.values ?? {}) as {
        stage?: string;
        turns?: number;
        themes?: number;
        insights?: string[];
        challenges?: number;
        notes?: string[];
      };

      /*
       * `inputsHash` 由 `runResearch` 在 analyze 里算并写进快照，图状态里没有它。
       * 从快照读回来，而不是在图状态上加一个字段——它本来就是快照的属性。
       */
      const after = (await repo.snapshots.latest(contractId, "evidence-matrix")) as
        | { inputsHash?: string }
        | null;
      const inputsHash = after?.inputsHash ?? "";
      const reused = before?.inputsHash !== undefined && before.inputsHash === inputsHash;

      /*
       * 端点把 `inputsHash` 当 runId 回给调用方（既有契约，不改），
       * 所以两个键都指向同一条线程——否则 `GET runs/:id` 拿着回给它的那个 id
       * 反而查不到，而那正是修之前的现象。
       */
      threads.set(inputsHash, threadId);
      threads.set(`${windowFrom}-${windowTo}`, threadId);

      console.log(
        `[research-runtime] run ${inputsHash.slice(0, 12)}…（${threadId}）：` +
          `${v.turns ?? 0} 轮 / ${v.themes ?? 0} 主题 / ${v.insights?.length ?? 0} 张卡 / ` +
          `${v.challenges ?? 0} 条挑战，stage=${v.stage ?? "unknown"}` +
          `${reused ? "，命中已有快照未重算" : ""}`,
      );

      // 既有字段 `inputsHash` / `reused` 不删，只增。
      return {
        inputsHash,
        reused,
        threadId,
        stage: v.stage ?? "unknown",
        turns: v.turns ?? 0,
        themes: v.themes ?? 0,
        insights: v.insights?.length ?? 0,
        challenges: v.challenges ?? 0,
        notes: v.notes ?? [],
      };
    },
  });
  server.on("error", (err) => console.error(`[research-runtime] 端口 :${port} 起不来：${err.message}`));
  server.listen(port, "127.0.0.1", () => {
    console.log(`[research-runtime] 内部端点 http://127.0.0.1:${port}/health`);
  });
}

/** 造数窗口是过去 90 天；合同窗口跟着它，否则镜头会算一个空窗。 */
const CONTRACT_WINDOW_DAYS = 90;

/**
 * POC 缺省合同（幂等）。已有 active 合同就用它，不重复建。
 *
 * 八个字段照方法本体 §02 填满——**尤其是 `actionRule`**：
 * 事先声明"出现什么结果就做什么"，事后再写等于没写。
 */
async function ensureDefaultContract(repo: ReturnType<typeof createResearchRepository>, codebookVersion: string): Promise<string> {
  const existing = await repo.contracts.list("active");
  if (existing.length > 0) return existing[0].id;

  const to = Date.now();
  const from = to - CONTRACT_WINDOW_DAYS * 86_400_000;
  const row = await repo.contracts.create({
    title: "已授权车主 · 用车痛点 · 近 90 天",
    decision: "下一个 Sprint 优先改哪一类用车体验（提示词 / 知识库 / 工具 / 售后线索）",
    populationTarget: "国内新能源乘用车车主",
    // 实际观察到的总体由 populationOf 实时算并写进每份快照；这里记的是口径。
    populationObserved: { note: "已授权且未标记 research_excluded 的车主，逐快照实算" },
    object: "需求与痛点主题 × 用车场景",
    horizon: `近 ${CONTRACT_WINDOW_DAYS} 天`,
    evidenceBar: "每格 n/N 双写、分母可显示、反例已检索；观察总体 ≥ 10 台车才出方向",
    exclusions: { userFlags: ["research_excluded"], sources: ["mocks.*", "mem0", "llm_usage", "audit_logs"] },
    freshness: "证据不早于窗口起点；跨 codebook 版本的编码不混算",
    actionRule:
      "某需求码在某场景的提及率 ≥ 10% 且表现度低于中位 → 进候选清单人工评审；" +
      "落在硬禁范畴的一律标不可交付、不进 roadmap；" +
      "分数只排序，不自动触发任何对个体的触达",
    windowFrom: from,
    windowTo: to,
    codebookVersion,
    createdBy: "system:research-runtime",
  });
  await repo.contracts.setStatus(row.id, "active");
  console.log(`[research-runtime] 建了 POC 缺省合同 ${row.id}`);
  return row.id;
}

// 被 import 时（测试）不启动。
const invokedDirectly = process.argv[1]?.endsWith("index.ts") === true;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[research-runtime] 启动失败", err);
    process.exit(1);
  });
}
