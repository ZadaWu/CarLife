/**
 * 研究面仓储（施工单 M82-01，ARCH-001 / ACR-034）。
 *
 * # 全仓第二处允许无键读的地方——只注入 worker 与 research-runtime
 *
 * `identity-console.ts` 是第一处（M68-01，只给 `/console/*`）。这一处的理由不同：
 * 研究面**本质上是跨用户聚合**，"这一百台车里有多少台在低温下抱怨过续航"
 * 这个问题没有用户键可带。
 *
 * 所以它必须住在 `agent-runtime` 之外——那个进程里每个仓储都刻意带
 * `userId` / `vin`（M7-01 纪律：少一个条件读到的是别人家的数据），
 * 混进一个无键仓储等于给端上路径顺手留一条无键入口，而漏用的那一次没有任何现象。
 *
 * **注入白名单：`enterprise/backend/worker`（取数）与
 * `enterprise/backend/research-runtime`（分析）。**
 * gateway / agent-runtime / 任何端上代码 import 本文件都是错的，
 * 而且是能被 review 一眼看出来的错——这正是它单独一个文件的意义。
 *
 * # 原文不进库，靠结构性守卫而不是靠自觉
 *
 * `units.upsertMany` 对每条 `textRedacted` 跑一遍 `guardrails` 的 PII 检测，
 * **命中即抛 `research_pii_leak`，不静默脱敏**。
 *
 * 静默脱敏看起来更友好，实际后果是"写入方忘了脱敏"这件事永远不被发现：
 * 数据是干净的，但下一个写入路径（造数脚本、手工回填、另一个服务）不会有人想起
 * 还有这一步。抛错让漏脱敏在第一次就停下来。
 *
 * # 向量列走 raw SQL
 *
 * `research_embeddings.embedding` 是 `Unsupported("vector(1024)")`，
 * 生成的 Client 不认识它——读写全走 `$queryRawUnsafe` / `$executeRawUnsafe`，
 * 向量以 `'[…]'::vector` 字面量传参，与 `icon-embedding.ts` / `manual-figure.ts` 同形态。
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { redact } from "@carlife/guardrails";

// ── 取数用的无键读：入参与出参 ─────────────────────────────

/** 时间窗，Unix 毫秒。左闭右开——相邻两个小时窗不会把边界那一轮算两遍。 */
export interface ResearchWindow {
  from: number;
  to: number;
}

/** 一轮：用户消息 + 助手消息 + 该轮的 trace 事件。 */
export interface RawTurn {
  sessionId: string;
  turnId: string;
  userId: string;
  vin: string | null;
  userMessage: {
    id: string;
    sessionId: string;
    turnId: string;
    role: string;
    source: string;
    content: string;
    ts: number;
    cancelled: boolean;
    asrEngine: string | null;
    /**
     * 这句话有没有留下原始录音（`message_audio.kind='asr'`，M82-02 补）。
     *
     * 决定证据单元的 `display_level`：有录音的那条是 `replay-audited`
     * ——能回放，但每次都记审计（护照里 `message_audio` 就是这一档）。
     * 在取数这一次 join 出来，比之后逐条回查便宜得多。
     */
    hasAudio: boolean;
  };
  assistantMessage: RawTurn["userMessage"] | null;
  trace: Array<{ kind: string; at: number; data: unknown }>;
}

export interface RawTrip {
  id: string;
  userId: string;
  vin: string | null;
  startedAt: Date;
  endedAt: Date;
  distanceKm: number | null;
  roadType: string | null;
  ambientTempC: number | null;
  observedRangeKm: number | null;
  chargeStartSoc: number | null;
  chargeEndSoc: number | null;
  /**
   * 这趟是谁开的（M82-05 补，分群的 `memberCount` 变量要它）。
   * **空 ≠ 车主开的**——空的语义是"不知道谁开的"（M17-02 边界），
   * 按人聚合时跳过、不计入任何人。
   */
  driverMemberId: string | null;
}

/** 我们自己的变更，交给 `@carlife/research` 的 `deriveSystemEvents` 派生成事件。 */
export interface RawSystemChanges {
  /** 形状对齐 `@carlife/research` 的 `ConfigRevisionRow`（含 `secret`，密钥类只派生"变更过"）。 */
  configRevisions: Array<{
    id: string;
    key: string;
    at: number;
    oldValue: string | null;
    newValue: string | null;
    secret: boolean;
  }>;
  guardRevisions: Array<{ id: string; key: string; at: number; summary: string }>;
  kbSyncRuns: Array<{ id: string; job: string; at: number; dataset: string | null; ok: boolean }>;
}

// ── 写入用的行形状 ────────────────────────────────────────

export interface EvidenceUnitInput {
  contractId?: string | null;
  kind: "utterance" | "behavior";
  sourceId: string;
  userId: string;
  vin?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  messageId?: string | null;
  tripId?: string | null;
  occurredAt: number;
  /** **必须已脱敏**。命中 PII 检测直接抛，见文件头。 */
  textRedacted?: string | null;
  features?: unknown;
  context: unknown;
  fingerprint: string;
  displayLevel: string;
  role: string;
}

/**
 * 复编码一致率（M82-10 量出来的那一行）。
 *
 * **两层各报各的**：`human*` 是两名研究者独立编同一批的一致程度——
 * 它回答"这套码表说得清吗"，是 measurement 门读的那个数；
 * `model*` 是 Coder 与仲裁结果的一致程度——它回答"这个模型编得准吗"。
 * 合成一个数会让"码表模糊"与"模型不准"变得分不开，而两者的处置完全不同
 * （前者改码表，后者改提示词或换模型）。
 *
 * `alpha` 是 Krippendorff α（名义尺度）。它同时报出但**不设门槛**：
 * 多标签轴上 α 的解释还没有共识，拿它当闸门会闸错东西。
 */
export interface CodebookAgreement {
  /** 人 vs 人，0–1。没有人工编码时为 null——**不拿模型顶替**。 */
  humanPercent: number | null;
  humanAlpha: number | null;
  /** 模型 vs 仲裁结果，0–1。 */
  modelPercent: number | null;
  modelAlpha: number | null;
  /** 参与计算的单元数。 */
  n: number;
  /** 测量时刻，ISO。 */
  at: string;
  /** 用的哪一份参照集，如 `gold.jsonl@<sha8>`。写清楚才复现得了。 */
  source: string;
}

export interface CodingInput {
  unitId: string;
  codebookVersion: string;
  axis: string;
  code: string;
  confidence: number;
  rationale: string;
  competingCode?: string | null;
  uncertain?: boolean;
  coder: string;
  promptHash: string;
}

export interface EmbeddingInput {
  unitId?: string | null;
  themeId?: string | null;
  model: string;
  embedding: number[];
}

export interface EmbeddingNearestQuery {
  vector: number[];
  k: number;
  model?: string;
  /** 只找单元向量（`unit`）还是只找主题质心（`theme`）。 */
  target?: "unit" | "theme";
}

export interface EmbeddingNearestRow {
  id: string;
  unitId: string | null;
  themeId: string | null;
  model: string;
  /** 余弦距离（`<=>`），相似度 = 1 − distance。 */
  distance: number;
}

export interface LensSnapshotInput {
  contractId: string;
  lens: string;
  windowFrom: number;
  windowTo: number;
  codebookVersion: string;
  inputsHash: string;
  population: unknown;
  gates: unknown;
  data: unknown;
}

export interface SystemEventInput {
  kind: string;
  at: number;
  key?: string | null;
  summary: string;
  sourceRef: string;
}

/**
 * 一轮编码后的拍平形状（M82-05）。形状与 `research-runtime` 的 `CodedTurn` 对齐——
 * 改一边另一边在调用处编译报错。
 */
export interface CodedTurnRow {
  unitId: string;
  turnId: string | null;
  vin: string | null;
  occurredAt: number;
  scene: string | null;
  needPains: string[];
  job: string | null;
  emotion: string | null;
  emotionIntensity: number | null;
  polarity: string | null;
  deliverability: string | null;
  resolved: boolean;
}

/** 期望的嵌入维度。与 `RESEARCH_EMBEDDING_DIM` 缺省值、`vector(1024)` 列同源。 */
export const RESEARCH_EMBEDDING_DIM = 1024;

const json = (v: unknown): Prisma.InputJsonValue => (v ?? null) as Prisma.InputJsonValue;

const vectorLiteral = (v: readonly number[]): string =>
  `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

/**
 * PII 结构性守卫。`redact` 的 `hits` 任一非零即认为写入方没脱过。
 *
 * 不在这里顺手脱敏——理由见文件头。错误信息带上命中的类别与单元指纹，
 * 但**不带原文**：把泄露的原文抄进异常栈，等于换个地方泄露一次。
 */
function assertRedacted(text: string, fingerprint: string): void {
  const { hits } = redact(text);
  const kinds = Object.entries(hits)
    .filter(([, n]) => n > 0)
    .map(([k]) => k);
  if (kinds.length > 0) {
    throw new Error(
      `research_pii_leak: 证据单元 ${fingerprint} 的 text_redacted 仍含未脱敏信息（${kinds.join(", ")}）。` +
        "写入方必须先经 guardrails/output/pii.ts 脱敏——本层只检测不代脱",
    );
  }
}

export interface ResearchRepository {
  contracts: {
    create(input: {
      title: string;
      decision: string;
      populationTarget: string;
      populationObserved: unknown;
      object: string;
      horizon: string;
      evidenceBar: string;
      exclusions: unknown;
      freshness: string;
      actionRule: string;
      windowFrom: number;
      windowTo: number;
      codebookVersion: string;
      createdBy: string;
    }): Promise<{ id: string }>;
    list(status?: string): Promise<Array<{ id: string; title: string; status: string }>>;
    byId(id: string): Promise<unknown | null>;
    setStatus(id: string, status: string): Promise<void>;
  };
  sourcePassports: {
    /** 用代码常量覆盖表里的副本。表只是可查询副本，判断不读它（文件头）。 */
    sync(rows: readonly Record<string, unknown>[]): Promise<number>;
    list(): Promise<Array<Record<string, unknown>>>;
  };
  units: {
    upsertMany(rows: readonly EvidenceUnitInput[]): Promise<number>;
    byId(id: string): Promise<unknown | null>;
    /** 还没有指定 codebook 版本编码的单元，按时间升序。 */
    listForCoding(codebookVersion: string, limit: number): Promise<Array<{ id: string; kind: string; textRedacted: string | null; context: unknown }>>;
    knownFingerprints(window: ResearchWindow): Promise<Set<string>>;
    /**
     * 指纹 → 单元 id（M82-02 补）。
     *
     * 建话语↔行为关联时要拿到对端单元的 id，而调用方手里只有指纹——
     * `upsertMany` 只回行数，逐条 `byId` 是 N+1。
     */
    idsByFingerprints(fingerprints: readonly string[]): Promise<Map<string, string>>;
    /**
     * 证据栏的分页读（M82-04 补）。
     *
     * 游标是**复合**的（`occurredAt|id`）：`occurred_at` 精确到毫秒，
     * 造数一次插上千行会撞同一毫秒，单列游标在同毫秒下会**静默丢行**
     * （`identity-console.ts` 已经踩过一次，那里的注释写着同一件事）。
     */
    listForApi(q: {
      kind: string | null;
      /** 按 `polarity` 轴的某个码过滤（证据栏的"只看反例"）。 */
      polarity: string | null;
      codebookVersion: string;
      cursorAt: number | null;
      cursorId: string | null;
      limit: number;
    }): Promise<Array<Record<string, unknown>>>;
    /**
     * 一轮编码后的样子，喂给五个镜头（M82-05 补）。
     *
     * `research_codings` 是一行一码（多标签多行）。五个镜头要的都是"这一轮是什么"——
     * 各自去 join 一遍等于把同一段拼装逻辑写五份，而**它们迟早会不一致**，
     * 那时两个页面对同一件事给出两个数，各自都能自圆其说。
     */
    codedTurns(window: ResearchWindow, codebookVersion: string): Promise<CodedTurnRow[]>;
    /**
     * 一批单元的脱敏文本。Namer 要拿它当代表句，主题聚类要按它取例句。
     *
     * 逐个 `byId` 也能拿到，但那是 1,482 次往返；这一步在每次 run 里都跑，
     * 值得一条批量读。**只回脱敏文本**——这一层根本拿不到原文。
     */
    textsByIds(unitIds: readonly string[]): Promise<Map<string, string>>;
    withdraw(userId: string): Promise<number>;
    countByKind(window: ResearchWindow): Promise<Record<string, number>>;
  };
  links: {
    upsertMany(rows: readonly { utteranceUnitId: string; behaviorUnitId: string; basis: string; windowDays: number }[]): Promise<number>;
  };
  codebooks: {
    upsert(input: { version: string; hash: string; axes: unknown; filePath: string }): Promise<void>;
    lock(version: string): Promise<void>;
    byVersion(
      version: string,
    ): Promise<{ version: string; hash: string; lockedAt: Date | null; axes: unknown; agreement: unknown } | null>;
    /**
     * 写回复编码一致率（M82-10）。
     *
     * **唯一写入方是 `eval:research-coding` 的 runner**——一致率是"量出来的"，
     * 不是运行时顺手更新的状态。锁版之后也允许写：锁的是码表内容，
     * 不是"这份码表编得准不准"这个测量结果。
     */
    setAgreement(version: string, agreement: CodebookAgreement): Promise<void>;
  };
  codings: {
    insertMany(rows: readonly CodingInput[]): Promise<number>;
    forUnits(unitIds: readonly string[], codebookVersion: string): Promise<Array<CodingInput & { id: string }>>;
  };
  themes: {
    upsert(input: { id?: string; codebookVersion: string; needPainCode: string; name: string; definition: string; include: string; exclude: string; memberUnitIds: string[]; counterUnitIds: string[]; status?: string }): Promise<{ id: string }>;
    /**
     * 一个 codebook 版本下的全部主题。
     *
     * `needPainCode` 与 `definition` 都要回：Synthesizer 的 `SynthesizeInput` 两样都要，
     * 而"按需求码找这一格的主题"是证据矩阵每条能力的第一步。
     * **`needPainCode` 为 null 是"码未知"**（本列之前写下的行），调用方应当跳过而不是猜——
     * 见 schema 里这一列的注释。
     */
    list(codebookVersion: string): Promise<Array<{ id: string; needPainCode: string | null; name: string; definition: string; status: string; memberUnitIds: string[]; counterUnitIds: string[] }>>;
  };
  segments: {
    upsert(input: { id?: string; name: string; method: string; features: unknown; memberVins: string[]; size: number; minCell: number; status?: string }): Promise<{ id: string }>;
    list(): Promise<Array<{ id: string; name: string; size: number; status: string; memberVins: string[] }>>;
  };
  embeddings: {
    upsertMany(rows: readonly EmbeddingInput[]): Promise<number>;
    nearest(q: EmbeddingNearestQuery): Promise<EmbeddingNearestRow[]>;
    /**
     * 已编码、有脱敏文本、但**还没有向量**的话语单元 id。
     *
     * 存在的理由是一个真实顺序问题：嵌入任务只在 `research.code` 消费完那一刻排
     * （`index.ts` 的 `if (!out.skipped && dashscopeKey)`）。**key 比语料晚到**时，
     * 那批单元早就编码完了，`out.skipped` 恒真，于是永远不会有人给它们排嵌入——
     * 现象是「key 配好了、队列也起来了，主题却始终是 0」。
     */
    missingUnitIds(model: string, limit: number): Promise<string[]>;
    /**
     * 一批单元的向量，`unitId → vector`。主题聚类的输入。
     *
     * 没有向量的单元**不出现在结果里**（不是给零向量）——零向量会被 k-means
     * 当成一个真实的、离所有簇都一样远的点，静默把聚类结果拉偏。
     */
    forUnits(model: string, unitIds: readonly string[]): Promise<Map<string, number[]>>;
  };
  snapshots: {
    upsert(input: LensSnapshotInput): Promise<{ id: string }>;
    latest(contractId: string, lens: string): Promise<unknown | null>;
  };
  insights: {
    /**
     * `inputsHash` 是**这张卡基于哪份快照写成**（G5，M85-06），不是卡片内容的 hash。
     * 缺省 null，含义是「口径未知」——读取侧必须把它与「口径一致」分开显示。
     */
    create(input: { contractId: string; themeId: string; level: string; card: unknown; confidence: unknown; upgradeNeeds: string[]; owner: string; inputsHash?: string | null }): Promise<{ id: string }>;
    byId(id: string): Promise<unknown | null>;
    list(contractId: string): Promise<Array<{ id: string; level: string; themeId: string }>>;
    /**
     * 一个合同下的卡**连正文一起**回（M85-06）。
     *
     * 与 `list` 分开而不是给它加字段：`list` 的三列形状被 `GET insights` 与
     * review 面用着，那里只要 id 和等级。抽屉要的是六栏 + 置信 + upgradeNeeds +
     * 口径 hash，一次全取回来——分两跳查的话，卡片与它的口径徽章会在两个时刻读到。
     */
    forContract(contractId: string): Promise<Array<{
      id: string;
      themeId: string;
      /**
       * 这张卡挂在哪个需求码上——**从主题连出来的，不是卡上的列**。
       *
       * 界面按「格」取卡，而格的坐标是需求码；没有这一列的话，
       * 前端只能拿 `themeId` 去猜属于哪一格，而主题 id 的形状
       * （`theme-<version>-<code>-<index>`）切不出唯一解，M85-01 的文件头记着这件事。
       */
      needPainCode: string | null;
      themeName: string;
      level: string;
      card: unknown;
      confidence: unknown;
      upgradeNeeds: string[];
      inputsHash: string | null;
      owner: string;
      reviewAt: Date | null;
      createdAt: Date;
    }>>;
    setLevel(id: string, level: string): Promise<void>;
  };
  opportunities: {
    create(input: { insightId: string; hypothesis: unknown; ods: unknown; profileVersion: string; outlet: string }): Promise<{ id: string }>;
    list(outlet?: string): Promise<Array<{ id: string; insightId: string; outlet: string; status: string; ods: unknown }>>;
    setStatus(id: string, status: string): Promise<void>;
  };
  challenges: {
    create(input: { insightId: string; kind: string; payload: unknown; contradictedUnitIds: string[]; verdict: string; createdBy: string }): Promise<{ id: string }>;
    forInsight(insightId: string): Promise<Array<{ id: string; kind: string; verdict: string; payload: unknown }>>;
  };
  decisions: {
    record(input: { kind: string; subjectId: string; decidedBy: string; rationale: string; payload: unknown }): Promise<{ id: string }>;
    forSubject(subjectId: string): Promise<Array<{ id: string; kind: string; decidedBy: string; decidedAt: Date }>>;
    /**
     * 按 kind 取决定记录（M85-08）。码提案的待审队列靠它。
     *
     * **一次把 raised 与 decided 两种都取回来**，在内存里配对——
     * 分两跳查的话，两个结果来自两个时刻，中间刚好有人决定了一条，
     * 那条就会既不在待审里、也不在已决里，而它看起来只是"少了一条"。
     */
    byKinds(
      kinds: readonly string[],
      limit?: number,
    ): Promise<Array<{ id: string; kind: string; subjectId: string; decidedBy: string; decidedAt: Date; rationale: string; payload: unknown }>>;
  };
  systemEvents: {
    upsertMany(rows: readonly SystemEventInput[]): Promise<number>;
    inWindow(window: ResearchWindow): Promise<Array<SystemEventInput & { id: string }>>;
  };
  /** 无键读取数源。**只在这一组里出现对既有表的读**。 */
  sources: {
    turns(window: ResearchWindow, excludedUserIds: readonly string[]): Promise<RawTurn[]>;
    trips(window: ResearchWindow, excludedUserIds: readonly string[]): Promise<RawTrip[]>;
    systemChanges(window: ResearchWindow): Promise<RawSystemChanges>;
    /** 带 `research_excluded` 的账号。取数每轮先查它。 */
    excludedUserIds(): Promise<string[]>;
  };
}

export function createResearchRepository(prisma: PrismaClient): ResearchRepository {
  return {
    contracts: {
      async create(input) {
        const row = await prisma.researchContract.create({
          data: {
            title: input.title,
            decision: input.decision,
            populationTarget: input.populationTarget,
            populationObserved: json(input.populationObserved),
            object: input.object,
            horizon: input.horizon,
            evidenceBar: input.evidenceBar,
            exclusions: json(input.exclusions),
            freshness: input.freshness,
            actionRule: input.actionRule,
            windowFrom: BigInt(input.windowFrom),
            windowTo: BigInt(input.windowTo),
            codebookVersion: input.codebookVersion,
            status: "draft",
            createdBy: input.createdBy,
          },
          select: { id: true },
        });
        return row;
      },
      list(status) {
        return prisma.researchContract.findMany({
          where: status ? { status } : undefined,
          select: { id: true, title: true, status: true },
          orderBy: { createdAt: "desc" },
        });
      },
      byId(id) {
        return prisma.researchContract.findUnique({ where: { id } });
      },
      async setStatus(id, status) {
        await prisma.researchContract.update({ where: { id }, data: { status } });
      },
    },

    sourcePassports: {
      async sync(rows) {
        let n = 0;
        for (const r of rows) {
          const { id, ...rest } = r as { id: string } & Record<string, unknown>;
          await prisma.researchSource.upsert({
            where: { id },
            create: { id, ...rest, syncedAt: new Date() } as never,
            update: { ...rest, syncedAt: new Date() } as never,
          });
          n += 1;
        }
        return n;
      },
      list() {
        return prisma.researchSource.findMany({ orderBy: { id: "asc" } }) as Promise<Array<Record<string, unknown>>>;
      },
    },

    units: {
      async upsertMany(rows) {
        // 先全量检查再写：一批里有一条漏脱敏就整批不写。
        // 逐条写到一半再抛，会留下"一半脏一半干净"的状态，而重跑会因为
        // 指纹去重跳过已写的那一半——脏数据从此固化。
        for (const r of rows) {
          if (r.textRedacted) assertRedacted(r.textRedacted, r.fingerprint);
        }
        let n = 0;
        for (const r of rows) {
          const data = {
            contractId: r.contractId ?? null,
            kind: r.kind,
            sourceId: r.sourceId,
            userId: r.userId,
            vin: r.vin ?? null,
            sessionId: r.sessionId ?? null,
            turnId: r.turnId ?? null,
            messageId: r.messageId ?? null,
            tripId: r.tripId ?? null,
            occurredAt: BigInt(r.occurredAt),
            textRedacted: r.textRedacted ?? null,
            features: json(r.features),
            context: json(r.context),
            displayLevel: r.displayLevel,
            role: r.role,
          };
          await prisma.researchEvidenceUnit.upsert({
            where: { fingerprint: r.fingerprint },
            create: { ...data, fingerprint: r.fingerprint },
            // 重跑只刷新派生字段（脱敏规则升级、角色判据调整），
            // 不动 fingerprint 与 occurredAt——那两个是身份。
            update: { textRedacted: data.textRedacted, features: data.features, context: data.context, role: data.role },
          });
          n += 1;
        }
        return n;
      },
      byId(id) {
        return prisma.researchEvidenceUnit.findUnique({ where: { id } });
      },
      async listForCoding(codebookVersion, limit) {
        return prisma.researchEvidenceUnit.findMany({
          where: {
            withdrawnAt: null,
            kind: "utterance",
            codings: { none: { codebookVersion } },
          },
          select: { id: true, kind: true, textRedacted: true, context: true },
          orderBy: { occurredAt: "asc" },
          take: limit,
        });
      },
      async knownFingerprints(window) {
        const rows = await prisma.researchEvidenceUnit.findMany({
          where: { occurredAt: { gte: BigInt(window.from), lt: BigInt(window.to) } },
          select: { fingerprint: true },
        });
        return new Set(rows.map((r) => r.fingerprint));
      },
      async idsByFingerprints(fingerprints) {
        if (fingerprints.length === 0) return new Map();
        const rows = await prisma.researchEvidenceUnit.findMany({
          where: { fingerprint: { in: [...fingerprints] } },
          select: { id: true, fingerprint: true },
        });
        return new Map(rows.map((r) => [r.fingerprint, r.id]));
      },
      async listForApi(q) {
        const rows = await prisma.researchEvidenceUnit.findMany({
          where: {
            withdrawnAt: null,
            ...(q.kind ? { kind: q.kind } : {}),
            ...(q.polarity
              ? { codings: { some: { axis: "polarity", code: q.polarity, codebookVersion: q.codebookVersion } } }
              : {}),
            // 复合游标：同一毫秒内按 id 续接，不丢行。
            ...(q.cursorAt !== null && q.cursorId
              ? {
                  OR: [
                    { occurredAt: { lt: BigInt(q.cursorAt) } },
                    { occurredAt: BigInt(q.cursorAt), id: { lt: q.cursorId } },
                  ],
                }
              : {}),
          },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: Math.max(1, Math.min(500, q.limit)),
        });
        return rows as unknown as Array<Record<string, unknown>>;
      },
      async codedTurns(window, codebookVersion) {
        const rows = await prisma.researchEvidenceUnit.findMany({
          where: {
            kind: "utterance",
            withdrawnAt: null,
            occurredAt: { gte: BigInt(window.from), lt: BigInt(window.to) },
            codings: { some: { codebookVersion } },
          },
          select: {
            id: true, turnId: true, vin: true, occurredAt: true, context: true,
            codings: { where: { codebookVersion }, select: { axis: true, code: true, rationale: true } },
          },
          orderBy: { occurredAt: "asc" },
        });

        return rows.map((r) => {
          const ctx = (r.context ?? {}) as {
            followUp?: boolean; cancelled?: boolean; interrupted?: boolean; guardHit?: boolean;
          };
          const single = (axis: string): string | null =>
            r.codings.find((c) => c.axis === axis)?.code ?? null;
          const emotionRow = r.codings.find((c) => c.axis === "emotion");
          // 强度存在 rationale 的 `[强度N]` 前缀里（M82-04 的取舍：不为一轴加列）。
          const intensity = emotionRow ? /^\[强度(\d)\]/.exec(emotionRow.rationale)?.[1] : undefined;

          return {
            unitId: r.id,
            turnId: r.turnId,
            vin: r.vin,
            occurredAt: Number(r.occurredAt),
            scene: single("scene"),
            needPains: r.codings.filter((c) => c.axis === "need_pain").map((c) => c.code),
            job: single("job"),
            emotion: single("emotion"),
            emotionIntensity: intensity === undefined ? null : Number(intensity),
            polarity: single("polarity"),
            deliverability: single("deliverability"),
            // 表现度的启发式口径（M82-00）：无追问、无打断、无拦截。
            resolved: ctx.followUp !== true && ctx.cancelled !== true && ctx.interrupted !== true && ctx.guardHit !== true,
          };
        });
      },
      async textsByIds(unitIds) {
        const out = new Map<string, string>();
        if (unitIds.length === 0) return out;
        const CHUNK = 1_000;
        for (let i = 0; i < unitIds.length; i += CHUNK) {
          const rows = await prisma.researchEvidenceUnit.findMany({
            where: { id: { in: [...unitIds.slice(i, i + CHUNK)] }, withdrawnAt: null },
            select: { id: true, textRedacted: true },
          });
          for (const r of rows) if (r.textRedacted) out.set(r.id, r.textRedacted);
        }
        return out;
      },
      async withdraw(userId) {
        // 置位不删行：删了会让历史快照的分母对不上，而快照是已经发出去的结论。
        const r = await prisma.researchEvidenceUnit.updateMany({
          where: { userId, withdrawnAt: null },
          data: { withdrawnAt: new Date() },
        });
        return r.count;
      },
      async countByKind(window) {
        const rows = await prisma.researchEvidenceUnit.groupBy({
          by: ["kind"],
          where: { occurredAt: { gte: BigInt(window.from), lt: BigInt(window.to) } },
          _count: { _all: true },
        });
        return Object.fromEntries(rows.map((r) => [r.kind, r._count._all]));
      },
    },

    links: {
      async upsertMany(rows) {
        let n = 0;
        for (const r of rows) {
          await prisma.researchLink.upsert({
            where: { utteranceUnitId_behaviorUnitId: { utteranceUnitId: r.utteranceUnitId, behaviorUnitId: r.behaviorUnitId } },
            create: { ...r, linkability: "deterministic" },
            update: { basis: r.basis, windowDays: r.windowDays },
          });
          n += 1;
        }
        return n;
      },
    },

    codebooks: {
      async upsert(input) {
        const existing = await prisma.researchCodebook.findUnique({ where: { version: input.version } });
        // 锁版后只增不改（总览已定决策 12）：同版本换了 hash 说明有人改了锁过的码表。
        if (existing?.lockedAt && existing.hash !== input.hash) {
          throw new Error(
            `research_codebook_locked: ${input.version} 已于 ${existing.lockedAt.toISOString()} 锁版，` +
              "内容不可再改。新增概念请开下一版",
          );
        }
        await prisma.researchCodebook.upsert({
          where: { version: input.version },
          create: { version: input.version, hash: input.hash, axes: json(input.axes), filePath: input.filePath },
          update: { hash: input.hash, axes: json(input.axes), filePath: input.filePath },
        });
      },
      async lock(version) {
        await prisma.researchCodebook.update({ where: { version }, data: { lockedAt: new Date() } });
      },
      byVersion(version) {
        return prisma.researchCodebook.findUnique({
          where: { version },
          select: { version: true, hash: true, lockedAt: true, axes: true, agreement: true },
        });
      },
      async setAgreement(version, agreement) {
        await prisma.researchCodebook.update({ where: { version }, data: { agreement: json(agreement) } });
      },
    },

    codings: {
      async insertMany(rows) {
        if (rows.length === 0) return 0;
        const r = await prisma.researchCoding.createMany({
          data: rows.map((c) => ({
            unitId: c.unitId,
            codebookVersion: c.codebookVersion,
            axis: c.axis,
            code: c.code,
            confidence: c.confidence,
            rationale: c.rationale,
            competingCode: c.competingCode ?? null,
            uncertain: c.uncertain ?? false,
            coder: c.coder,
            promptHash: c.promptHash,
          })),
        });
        return r.count;
      },
      forUnits(unitIds, codebookVersion) {
        return prisma.researchCoding.findMany({
          where: { unitId: { in: [...unitIds] }, codebookVersion },
          orderBy: [{ unitId: "asc" }, { axis: "asc" }, { code: "asc" }],
        }) as unknown as Promise<Array<CodingInput & { id: string }>>;
      },
    },

    themes: {
      async upsert(input) {
        const data = {
          codebookVersion: input.codebookVersion,
          needPainCode: input.needPainCode,
          name: input.name,
          definition: input.definition,
          include: input.include,
          exclude: input.exclude,
          memberUnitIds: input.memberUnitIds,
          counterUnitIds: input.counterUnitIds,
          status: input.status ?? "draft",
        };
        /*
         * 给了 id 就**真 upsert**，不是 update。
         *
         * 原实现是「有 id → update，没 id → create」。`runResearch` 从来不给 id，
         * 于是每跑一次 run 就把全部主题**再建一遍**：实测两次 run 后 68 行，
         * 其中「电池电耗疑问」与「电池和电耗的疑问」是同一簇的两次命名
         * （成员数都是 285）。下游每一张图都会把它们当两个主题各算一次。
         *
         * 聚类本身是确定性的（`kmeans` 用等距抽样取初始质心，无随机），所以
         * 「同一个码下的第 j 簇」在同样输入下稳定 —— 调用方据此给一个确定性 id，
         * 重跑就是覆盖而不是堆积。update 分支保留给"按 id 改已有主题"的场景。
         */
        const row = input.id
          ? await prisma.researchTheme.upsert({
              where: { id: input.id },
              create: { id: input.id, ...data },
              update: data,
              select: { id: true },
            })
          : await prisma.researchTheme.create({ data, select: { id: true } });
        return row;
      },
      list(codebookVersion) {
        return prisma.researchTheme.findMany({
          where: { codebookVersion },
          select: {
            id: true,
            needPainCode: true,
            name: true,
            definition: true,
            status: true,
            memberUnitIds: true,
            counterUnitIds: true,
          },
          orderBy: { name: "asc" },
        });
      },
    },

    segments: {
      async upsert(input) {
        const data = {
          name: input.name,
          method: input.method,
          features: json(input.features),
          memberVins: input.memberVins,
          size: input.size,
          minCell: input.minCell,
          status: input.status ?? "draft",
        };
        return input.id
          ? prisma.researchSegment.update({ where: { id: input.id }, data, select: { id: true } })
          : prisma.researchSegment.create({ data, select: { id: true } });
      },
      list() {
        return prisma.researchSegment.findMany({
          select: { id: true, name: true, size: true, status: true, memberVins: true },
          orderBy: { size: "desc" },
        });
      },
    },

    embeddings: {
      async upsertMany(rows) {
        let n = 0;
        for (const r of rows) {
          if (r.embedding.length !== RESEARCH_EMBEDDING_DIM) {
            // 维度不对时 PG 会报一句离根因很远的话；这里先拦下并说清是哪一条。
            throw new Error(
              `research_embedding_dim: 期望 ${RESEARCH_EMBEDDING_DIM} 维，实际 ${r.embedding.length}（` +
                `unit=${r.unitId ?? "-"} theme=${r.themeId ?? "-"}）`,
            );
          }
          if ((r.unitId == null) === (r.themeId == null)) {
            throw new Error("research_embedding_target: unitId 与 themeId 必须且只能给一个");
          }
          // 唯一约束是 (unit_id, model) / (theme_id, model) 两条，
          // 一次 upsert 只可能命中其中一条——按给了哪个键选。
          const conflict = r.unitId ? `("unit_id","model")` : `("theme_id","model")`;
          n += await prisma.$executeRawUnsafe(
            `INSERT INTO "research_embeddings" ("id","unit_id","theme_id","model","dim","embedding","created_at")
             VALUES ($1,$2,$3,$4,$5,$6::vector,NOW())
             ON CONFLICT ${conflict} DO UPDATE SET "embedding" = EXCLUDED."embedding", "dim" = EXCLUDED."dim"`,
            `emb_${r.unitId ?? r.themeId}_${r.model}`.replace(/[^A-Za-z0-9_.#-]/g, "_").slice(0, 160),
            r.unitId ?? null,
            r.themeId ?? null,
            r.model,
            r.embedding.length,
            vectorLiteral(r.embedding),
          );
        }
        return n;
      },
      async missingUnitIds(model, limit) {
        // 只取话语单元：行为单元没有文本，嵌它没有意义（`text_redacted` 恒 null）。
        // 撤回的不取——撤回后它不该再进任何一张图。
        const rows = await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT u."id"
            FROM "research_evidence_units" u
       LEFT JOIN "research_embeddings" e
              ON e."unit_id" = u."id" AND e."model" = ${model}
           WHERE u."kind" = 'utterance'
             AND u."text_redacted" IS NOT NULL
             AND u."text_redacted" <> ''
             AND u."withdrawn_at" IS NULL
             AND e."id" IS NULL
           ORDER BY u."occurred_at" DESC
           LIMIT ${Math.max(1, Math.min(20_000, limit))}`;
        return rows.map((r) => r.id);
      },
      async forUnits(model, unitIds) {
        const out = new Map<string, number[]>();
        if (unitIds.length === 0) return out;
        // `embedding` 是 Unsupported("vector(1024)")，Prisma 的类型层看不见它，
        // 回来是 pgvector 的文本形态 `[0.1,0.2,…]`，得自己解一次。
        const CHUNK = 1_000;
        for (let i = 0; i < unitIds.length; i += CHUNK) {
          const slice = unitIds.slice(i, i + CHUNK);
          const rows = await prisma.$queryRaw<Array<{ unit_id: string; embedding: string }>>`
            SELECT "unit_id", "embedding"::text AS "embedding"
              FROM "research_embeddings"
             WHERE "model" = ${model}
               AND "unit_id" IN (${Prisma.join(slice)})`;
          for (const r of rows) {
            const vec = r.embedding
              .replace(/^\[|\]$/g, "")
              .split(",")
              .map(Number);
            if (vec.length === RESEARCH_EMBEDDING_DIM && vec.every(Number.isFinite)) {
              out.set(r.unit_id, vec);
            }
          }
        }
        return out;
      },
      async nearest(q) {
        const rows = await prisma.$queryRawUnsafe<
          Array<{ id: string; unit_id: string | null; theme_id: string | null; model: string; distance: number }>
        >(
          `SELECT "id","unit_id","theme_id","model", ("embedding" <=> $1::vector)::float8 AS "distance"
             FROM "research_embeddings"
            WHERE ($2::text IS NULL OR "model" = $2)
              AND ($3::text IS NULL
                   OR ($3 = 'unit'  AND "unit_id"  IS NOT NULL)
                   OR ($3 = 'theme' AND "theme_id" IS NOT NULL))
            ORDER BY "embedding" <=> $1::vector
            LIMIT $4`,
          vectorLiteral(q.vector),
          q.model ?? null,
          q.target ?? null,
          Math.max(1, Math.min(200, q.k)),
        );
        return rows.map((r) => ({
          id: r.id,
          unitId: r.unit_id,
          themeId: r.theme_id,
          model: r.model,
          distance: Number(r.distance),
        }));
      },
    },

    snapshots: {
      async upsert(input) {
        const key = {
          contractId: input.contractId,
          lens: input.lens,
          windowFrom: BigInt(input.windowFrom),
          windowTo: BigInt(input.windowTo),
          codebookVersion: input.codebookVersion,
          inputsHash: input.inputsHash,
        };
        const payload = { population: json(input.population), gates: json(input.gates), data: json(input.data) };
        return prisma.researchLensSnapshot.upsert({
          where: {
            contractId_lens_windowFrom_windowTo_codebookVersion_inputsHash: key,
          },
          create: { ...key, ...payload },
          // 同 inputsHash 必须同内容（Sprint 完成判定 5）。这里仍然写一遍是为了
          // 让"算法改了但输入没变"的情况能刷新——那时 inputsHash 应当也变，
          // 没变说明 inputsHash 的取材漏了东西，值得在 diff 里看见。
          update: payload,
          select: { id: true },
        });
      },
      latest(contractId, lens) {
        return prisma.researchLensSnapshot.findFirst({
          where: { contractId, lens },
          orderBy: { computedAt: "desc" },
        });
      },
    },

    insights: {
      create(input) {
        return prisma.researchInsight.create({
          data: {
            contractId: input.contractId,
            themeId: input.themeId,
            level: input.level,
            card: json(input.card),
            confidence: json(input.confidence),
            upgradeNeeds: input.upgradeNeeds,
            owner: input.owner,
            inputsHash: input.inputsHash ?? null,
          },
          select: { id: true },
        });
      },
      byId(id) {
        return prisma.researchInsight.findUnique({ where: { id }, include: { challenges: true, opportunities: true } });
      },
      list(contractId) {
        return prisma.researchInsight.findMany({
          where: { contractId },
          select: { id: true, level: true, themeId: true },
          orderBy: { createdAt: "desc" },
        });
      },
      async forContract(contractId) {
        const rows = await prisma.researchInsight.findMany({
          where: { contractId },
          select: {
            id: true,
            themeId: true,
            level: true,
            card: true,
            confidence: true,
            upgradeNeeds: true,
            inputsHash: true,
            owner: true,
            reviewAt: true,
            createdAt: true,
            theme: { select: { needPainCode: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
        });
        // 把主题那两列摊平进来：调用方要的是"这张卡属于哪一格、叫什么"，
        // 而不是一个嵌套对象——嵌套会让前端多一层可选链，而那层永远为真。
        return rows.map(({ theme, ...r }) => ({
          ...r,
          needPainCode: theme?.needPainCode ?? null,
          themeName: theme?.name ?? "",
        }));
      },
      async setLevel(id, level) {
        await prisma.researchInsight.update({ where: { id }, data: { level } });
      },
    },

    opportunities: {
      create(input) {
        return prisma.researchOpportunity.create({
          data: {
            insightId: input.insightId,
            hypothesis: json(input.hypothesis),
            ods: json(input.ods),
            profileVersion: input.profileVersion,
            outlet: input.outlet,
          },
          select: { id: true },
        });
      },
      list(outlet) {
        return prisma.researchOpportunity.findMany({
          where: outlet ? { outlet } : undefined,
          select: { id: true, insightId: true, outlet: true, status: true, ods: true },
          orderBy: { createdAt: "desc" },
        });
      },
      async setStatus(id, status) {
        await prisma.researchOpportunity.update({ where: { id }, data: { status } });
      },
    },

    challenges: {
      create(input) {
        return prisma.researchChallenge.create({
          data: {
            insightId: input.insightId,
            kind: input.kind,
            payload: json(input.payload),
            contradictedUnitIds: input.contradictedUnitIds,
            verdict: input.verdict,
            createdBy: input.createdBy,
          },
          select: { id: true },
        });
      },
      forInsight(insightId) {
        return prisma.researchChallenge.findMany({
          where: { insightId },
          select: { id: true, kind: true, verdict: true, payload: true },
          orderBy: { createdAt: "asc" },
        });
      },
    },

    decisions: {
      record(input) {
        // 只追加，没有 update / delete——能改的决定记录证明不了任何事。
        return prisma.researchDecision.create({
          data: {
            kind: input.kind,
            subjectId: input.subjectId,
            decidedBy: input.decidedBy,
            rationale: input.rationale,
            payload: json(input.payload),
          },
          select: { id: true },
        });
      },
      forSubject(subjectId) {
        return prisma.researchDecision.findMany({
          where: { subjectId },
          select: { id: true, kind: true, decidedBy: true, decidedAt: true },
          orderBy: { decidedAt: "asc" },
        });
      },
      byKinds(kinds, limit = 200) {
        // `@@index([kind, decidedAt])` 正好覆盖这条查询——加取值是这张表设计里预留的动作。
        return prisma.researchDecision.findMany({
          where: { kind: { in: [...kinds] } },
          select: {
            id: true, kind: true, subjectId: true,
            decidedBy: true, decidedAt: true, rationale: true, payload: true,
          },
          orderBy: { decidedAt: "desc" },
          take: limit,
        });
      },
    },

    systemEvents: {
      async upsertMany(rows) {
        let n = 0;
        for (const r of rows) {
          await prisma.researchSystemEvent.upsert({
            where: { sourceRef: r.sourceRef },
            create: { kind: r.kind, at: BigInt(r.at), key: r.key ?? null, summary: r.summary, sourceRef: r.sourceRef },
            update: { summary: r.summary, kind: r.kind, at: BigInt(r.at) },
          });
          n += 1;
        }
        return n;
      },
      async inWindow(window) {
        const rows = await prisma.researchSystemEvent.findMany({
          where: { at: { gte: BigInt(window.from), lt: BigInt(window.to) } },
          orderBy: { at: "asc" },
        });
        return rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          at: Number(r.at),
          key: r.key,
          summary: r.summary,
          sourceRef: r.sourceRef,
        }));
      },
    },

    sources: {
      async excludedUserIds() {
        const rows = await prisma.userFlag.findMany({
          where: { flag: "research_excluded" },
          select: { userId: true },
        });
        return rows.map((r) => r.userId);
      },

      async turns(window, excludedUserIds) {
        /*
         * 一次取整窗的消息 + 该窗的 trace，在内存里按 turn_id 归拢。
         *
         * 不逐轮查 trace：一个小时窗几百到几千轮，逐轮就是几千次往返（N+1）。
         * 归拢在内存里做，代价是这一窗的 trace 全进内存——按 `trace_events`
         * 的行宽估算，一小时的量在几 MB 级，可接受；真的撑不住时改成分批取窗，
         * 而不是改回逐轮查。
         */
        const excluded = new Set(excludedUserIds);
        const messages = await prisma.message.findMany({
          where: { ts: { gte: BigInt(window.from), lt: BigInt(window.to) } },
          orderBy: { ts: "asc" },
          select: {
            id: true, sessionId: true, turnId: true, role: true, source: true,
            content: true, ts: true, cancelled: true, asrEngine: true,
            session: { select: { userId: true } },
            // 只要"有没有"，不要内容：take 1 让它不随一条消息的音频条数增长。
            audio: { where: { kind: "asr" }, select: { messageId: true }, take: 1 },
          },
        });
        if (messages.length === 0) return [];

        const sessionIds = [...new Set(messages.map((m) => m.sessionId))];
        const traces = await prisma.traceEvent.findMany({
          where: { sessionId: { in: sessionIds }, turnId: { not: null } },
          orderBy: { at: "asc" },
          select: { turnId: true, kind: true, at: true, data: true },
        });
        const traceByTurn = new Map<string, Array<{ kind: string; at: number; data: unknown }>>();
        for (const t of traces) {
          if (!t.turnId) continue;
          const list = traceByTurn.get(t.turnId) ?? [];
          list.push({ kind: t.kind, at: Number(t.at), data: t.data });
          traceByTurn.set(t.turnId, list);
        }

        // 车主 → 车：一人多车时取任一台。研究面的分群按 vin 走，
        // 但话语单元挂哪台车本来就说不准（他可能在说另一台）——
        // 所以这里给的是"这个账号名下的车"，口径写在快照里。
        const userIds = [...new Set(messages.map((m) => m.session.userId).filter((u): u is string => u !== null))];
        const vehicles = await prisma.vehicle.findMany({
          where: { ownerId: { in: userIds } },
          select: { ownerId: true, vin: true },
        });
        const vinByUser = new Map<string, string>();
        for (const v of vehicles) if (!vinByUser.has(v.ownerId)) vinByUser.set(v.ownerId, v.vin);

        const byTurn = new Map<string, RawTurn>();
        for (const m of messages) {
          const userId = m.session.userId;
          // 访客会话没有账号：它不属于任何人，也就没有"这位车主"可言，跳过。
          if (!userId || excluded.has(userId)) continue;
          const shaped = {
            id: m.id, sessionId: m.sessionId, turnId: m.turnId, role: m.role, source: m.source,
            content: m.content, ts: Number(m.ts), cancelled: m.cancelled, asrEngine: m.asrEngine,
            hasAudio: m.audio.length > 0,
          };
          const existing = byTurn.get(m.turnId);
          if (m.role === "user") {
            if (existing) existing.userMessage = shaped;
            else
              byTurn.set(m.turnId, {
                sessionId: m.sessionId,
                turnId: m.turnId,
                userId,
                vin: vinByUser.get(userId) ?? null,
                userMessage: shaped,
                assistantMessage: null,
                trace: traceByTurn.get(m.turnId) ?? [],
              });
          } else if (existing) {
            existing.assistantMessage = shaped;
          }
          // 只有助手消息、没有用户消息的轮不建条目：那不是车主说的话。
        }
        return [...byTurn.values()];
      },

      async trips(window, excludedUserIds) {
        const rows = await prisma.trip.findMany({
          where: {
            endedAt: { gte: new Date(window.from), lt: new Date(window.to) },
            userId: { notIn: [...excludedUserIds] },
          },
          orderBy: { endedAt: "asc" },
          select: {
            id: true, userId: true, vin: true, startedAt: true, endedAt: true, distanceKm: true,
            roadType: true, ambientTempC: true, observedRangeKm: true,
            chargeStartSoc: true, chargeEndSoc: true, driverMemberId: true,
          },
        });
        return rows;
      },

      async systemChanges(window) {
        const from = new Date(window.from);
        const to = new Date(window.to);
        const [configRevisions, guardRevisions, kbSyncRuns] = await Promise.all([
          prisma.configItemRevision.findMany({
            where: { changedAt: { gte: from, lt: to } },
            orderBy: { changedAt: "asc" },
            select: { id: true, key: true, changedAt: true, isSecret: true, prevValue: true },
          }),
          prisma.guardSettingRevision.findMany({
            where: { at: { gte: from, lt: to } },
            orderBy: { at: "asc" },
            select: { id: true, key: true, at: true, prevValue: true, nextValue: true, actor: true },
          }),
          prisma.jobRun.findMany({
            // 知识库同步类任务。job 名的口径归 worker，这里只按前缀捞
            where: { createdAt: { gte: from, lt: to }, job: { contains: "kb" } },
            orderBy: { createdAt: "asc" },
            select: { id: true, job: true, createdAt: true, failures: true },
          }),
        ]);

        /*
         * `config_item_revisions` **只记 `prevValue`，不记新值**——新值在配置存储里。
         * 但同一个 key 的下一条修订的 `prevValue` 就是这一条的新值，
         * 所以在窗内能补上；窗内最后一条补不上，`newValue` 留 null，
         * 派生层如实渲染成「（未记录）」而不是编一个空串。
         */
        const nextPrevByKey = new Map<string, string | null>();
        const configAscending = [...configRevisions];
        const withNewValue = configAscending
          .slice()
          .reverse()
          .map((r) => {
            const newValue = nextPrevByKey.has(r.key) ? (nextPrevByKey.get(r.key) ?? null) : null;
            nextPrevByKey.set(r.key, r.prevValue);
            return {
              id: r.id,
              key: r.key,
              at: r.changedAt.getTime(),
              oldValue: r.prevValue,
              newValue,
              secret: r.isSecret,
            };
          })
          .reverse();

        return {
          configRevisions: withNewValue,
          guardRevisions: guardRevisions.map((r) => ({
            id: r.id,
            key: r.key,
            at: r.at.getTime(),
            summary: `${r.actor} 改了 ${r.key}`,
          })),
          kbSyncRuns: kbSyncRuns.map((r) => ({
            id: r.id,
            job: r.job,
            at: r.createdAt.getTime(),
            // `job_runs` 不记数据集名；job 名里带的话由派生层显示 job 名兜底。
            dataset: null,
            ok: r.failures.length === 0,
          })),
        };
      },
    },
  };
}
