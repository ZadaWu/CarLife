/**
 * client — Mem0 OSS 客户端薄封装（施工单 M7-01 / FL-21 F-21-01）
 *
 * 按架构 §7，Mem0 承载 ②Episodic / ③Preference / ⑥UsagePattern 三类。
 * ④车辆档案走 PostgreSQL、⑤环境缓存走 Redis、①短期任务态在图状态里——**都不进这里**。
 *
 * # Mem0 的 TS OSS 形态是"库"，不是"服务"（M7-01 实测）
 *
 * `mem0ai/oss` 导出的 `Memory` 类在**本进程内**实例化，向量库/LLM/embedder 都是它的
 * 可插拔后端。所以架构文档里"部署 Mem0"实际等于"部署它的向量库"——
 * docker-compose 里没有、也不需要 Mem0 容器。
 *
 * # 三条本模块必须守住的性质
 *
 * 1. **降级而非崩溃**（M7-01 约束 5-②）：记忆是增强不是必需。Mem0 挂了，
 *    对话必须照常进行，只是没有个性化。所有读路径返回空结果 + `degraded` 标记，
 *    **不把异常抛到业务层**。
 * 2. **但"没有用户"必须失败**（M7-01 边界）：跨用户泄露是严重事故。
 *    userId 缺失时**抛错**，绝不退化成读全量——这与第 1 条不矛盾：
 *    降级针对的是"后端不可用"，不是"调用方写错了"。
 * 3. **类别过滤两边都做**：filters 传给 Mem0，拿回来再按 `metadata.category` 筛一遍。
 *    冗余是有意的——mem0ai 2.x 的 `getAll` **没有** filters 字段，传进去被静默忽略，
 *    "查情景记忆"于是返回全部类别而不报错。这类无症状故障值得多一次内存过滤。
 *
 * # 版本要求：mem0ai ≥ 3
 *
 * 2.x 的 pgvector 路径**结构性不可用**：`PGVector.initialize()` 不幂等，
 * 而 `Memory._autoInitialize()` 必然调它两次（构造函数一次、显式 await 一次），
 * 第二次在已连接的 pg Client 上 `connect()` 直接抛。3.x 用 `_initPromise`
 * 记忆化修掉了，并原生支持 connectionString。
 */

import { Memory } from "mem0ai/oss";
import { resolveDeepSeekModel } from "@carlife/shared";

import type {
  MemoryConfig,
  AddMemoryOptions,
  SearchResult,
  MemoryItem,
} from "mem0ai/oss";

// ── metadata 约定 ──────────────────────────────────────────
//
// 注意：**入参类型与落库类型分开定义**，不用 `Omit<Meta, "category">`。
// 这三个类型带字符串索引签名（要允许业务扩展字段），而 `Omit` 对带索引签名的类型
// 会把 `keyof T` 算成 `string | number`，结果是**所有具名字段被抹掉**，
// `occurredAt` 这类必填项在编译期形同虚设。踩过一次，别再用 Omit 拆它们。

export interface EpisodicMemoryInput {
  subType?: "trip" | "consultation" | "incident" | "interaction";
  /** ISO 8601 时间戳。②情景记忆按发生时间衰减，缺它就无法定权重（M7-02）。 */
  occurredAt: string;
  /** 关联车辆 VIN（可选）。 */
  vin?: string;
  [key: string]: unknown;
}

export interface PreferenceMemoryInput {
  domain: string;
  /** 0–1。低置信度的偏好不该被当成事实陈述给用户。 */
  confidence: number;
  lastConfirmedAt: string;
  [key: string]: unknown;
}

export interface UsagePatternInput {
  summaryType: "daily" | "weekly" | "monthly";
  periodStart: string;
  periodEnd: string;
  [key: string]: unknown;
}

export type EpisodicMemoryMeta = EpisodicMemoryInput & { category: "episodic" };
export type PreferenceMemoryMeta = PreferenceMemoryInput & { category: "preference" };
export type UsagePatternMeta = UsagePatternInput & { category: "usage_pattern" };

export type CarLifeMemoryMeta =
  | EpisodicMemoryMeta
  | PreferenceMemoryMeta
  | UsagePatternMeta;

/** Mem0 承载的三类；④⑤① 走别的存储，写进来直接拒。 */
const MEM0_CATEGORIES = ["episodic", "preference", "usage_pattern"] as const;

// ── 降级结果 ────────────────────────────────────────────────

/**
 * 读结果。在 Mem0 的 `SearchResult` 上**加字段而不改字段**——
 * 既有调用方读 `.results` 的写法不受影响。
 *
 * `degraded: true` 意味着**这次没查到不代表没有**，调用方不得把空结果
 * 当成"用户没有这个偏好"来用（那会变成"用过期/缺失数据冒充个性化"的反面）。
 */
export interface MemoryReadResult extends SearchResult {
  degraded?: boolean;
  error?: string;
}

// ── 默认配置 ───────────────────────────────────────────────

/**
 * 把 `postgresql://user:pw@host:port/db` 拆成 mem0 要的分立字段。
 *
 * **不能直接给 connectionString**：mem0ai 的 `PGVector` 只读
 * `user / password / host / port / dbname`（实测其构造函数），
 * 传 connectionString 会被完全忽略，然后它按默认值连一个不存在的地方。
 */
function parsePgUrl(url: string): { user?: string; password?: string; host?: string; port?: number; dbname?: string } {
  try {
    const u = new URL(url);
    return {
      user: decodeURIComponent(u.username) || undefined,
      password: decodeURIComponent(u.password) || undefined,
      host: u.hostname || undefined,
      port: u.port ? Number(u.port) : 5432,
      dbname: u.pathname.replace(/^\//, "") || undefined,
    };
  } catch {
    return {};
  }
}

/** 向量库落点。默认 pgvector：备份归入现有 pg_dump（§13-11 方案 A）。 */
function resolveVectorStore(): MemoryConfig["vectorStore"] {
  const provider = process.env.MEM0_VECTOR_PROVIDER ?? "pgvector";
  const collectionName = process.env.MEM0_COLLECTION ?? "carlife_memories";
  const dims = Number(process.env.MEM0_EMBEDDING_DIMS ?? 768);

  if (provider === "pgvector") {
    const url = process.env.MEM0_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
    const conn = parsePgUrl(url);
    return {
      provider,
      config: {
        collectionName,
        // mem0ai ≥3 支持直接给连接串（`useDirectConnection`），此时它连的就是
        // URL 里那个库——也就是我们已经在备份的这个。分立字段作为兜底同时给上，
        // 因为 2.x 只认分立字段（见下方注释）。
        connectionString: url || undefined,
        dimension: dims,
        // 字段名是 embeddingModelDims 不是 dimension。传错的后果很隐蔽：
        // 建表语句变成 `vector(undefined)` 而失败，紧接着 mem0 的
        // `_ensureInitialized` 会**自动重试一次**，重试在同一个已连接的 pg Client 上
        // 再调 connect()，于是报 "Client has already been connected"——
        // 真正的首个错误被这条掩盖掉。踩过一次，记在这里。
        embeddingModelDims: dims,
        ...conn,
        // **必须显式给 dbname**：PGVector 默认 dbname 是 "vector_store"，
        // 且会在库不存在时**自己建一个**。那样记忆就落到我们 pg_dump 范围之外，
        // 正好把 §13-11 方案 A 的全部意义抵消掉。
        dbname: conn.dbname ?? "carlife",
      },
    };
  }

  // 离线兜底：`memory` provider 落 sqlite 文件。**它在备份面之外**，
  // 仅供本地实验，不作为部署形态（这正是 §13-11 要解决的问题本身）。
  return {
    provider,
    config: {
      collectionName,
      dimension: dims,
      dbPath: process.env.MEM0_VECTOR_DB_PATH ?? "./data/mem0-vector.db",
    },
  };
}

function defaultConfig(): MemoryConfig {
  return {
    version: "v1.2",
    // 本地 Ollama embedding：不出网、无 API key。维度必须与向量库 dimension 一致。
    embedder: {
      provider: process.env.MEM0_EMBEDDING_PROVIDER ?? "ollama",
      config: {
        model: process.env.MEM0_EMBEDDING_MODEL ?? "nomic-embed-text",
        baseURL: process.env.MEM0_EMBEDDING_BASE_URL ?? "http://localhost:11434",
        embeddingDims: Number(process.env.MEM0_EMBEDDING_DIMS ?? 768),
      },
    },
    vectorStore: resolveVectorStore(),
    // Mem0 用 LLM 从对话里抽取事实。我们大多数写入走 `infer: false`（自己管
    // metadata），LLM 因此只在少数推断路径上被用到。
    llm: {
      provider: "openai",
      config: {
        apiKey: process.env.DEEPSEEK_API_KEY ?? "",
        model: resolveDeepSeekModel(process.env.MEM0_LLM_MODEL),
        baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
      },
    },
    // history 是"记忆被增删改"的流水，与记忆本身分开存（默认 sqlite 文件）。
    // 它可重建（丢的是审计轨迹，不是记忆），因此不进 §13-11 的备份范围。
    disableHistory: false,
    historyDbPath: process.env.MEM0_HISTORY_DB_PATH ?? "./data/mem0-history.db",
  };
}

// ── 客户端 ──────────────────────────────────────────────────

/**
 * 我们实际用到的 Mem0 面。存在的理由是**可测**：
 * 降级、用户隔离、类别过滤这三条性质必须能在不连任何后端的情况下断言，
 * 否则它们只能靠"部署完手动试一次"来验证——而这三条恰恰是出问题时最不显眼的。
 */
export type Mem0Like = Pick<
  Memory,
  "add" | "search" | "getAll" | "get" | "update" | "delete" | "deleteAll" | "reset"
>;

export class CarLifeMemoryClient {
  private memory: Mem0Like;
  private ready = false;
  /** 最近一次后端故障。用于健康视图，也用于避免每次调用都重试一个已知挂掉的后端。 */
  private lastError?: string;

  constructor(config?: Partial<MemoryConfig>, impl?: Mem0Like) {
    this.memory = impl ?? new Memory({ ...defaultConfig(), ...config });
  }

  /**
   * 触发一次懒初始化（维度探测 + 向量库建表）。
   * **不抛错**——初始化失败等同于"后端不可用"，走降级。
   */
  async ensureReady(): Promise<boolean> {
    if (this.ready) return true;
    try {
      await this.memory.search("__probe__", { topK: 1, filters: { user_id: "__init__" } });
      this.ready = true;
      this.lastError = undefined;
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** 后端是否可用 + 最近一次错误。健康页（M9-05）与后台记忆页读它。 */
  health(): { available: boolean; lastError?: string } {
    return { available: this.ready, lastError: this.lastError };
  }

  // ── ②情景 ────────────────────────────────────────────────

  async addEpisodic(
    userId: string,
    content: string,
    meta: EpisodicMemoryInput,
  ): Promise<MemoryReadResult> {
    return this.add(userId, content, { ...meta, category: "episodic" });
  }

  async searchEpisodic(userId: string, query: string, limit = 10): Promise<MemoryReadResult> {
    return this.search(userId, query, { category: "episodic" }, limit);
  }

  async getAllEpisodic(userId: string, limit = 50): Promise<MemoryReadResult> {
    return this.getAll(userId, { category: "episodic" }, limit);
  }

  /**
   * 落一条②情景，**按事件指纹去重**（M11-03）。
   *
   * 同一件事在几轮对话里被反复提到是常态（"那次空调坏了…" "就是上个月那次…"）。
   * 每提一次写一条的话，②会被同一件事灌满，而衰减是按条数感知重要性的——
   * 一件被反复提起的旧事会因为条数多而显得比新事更重要。
   *
   * 指纹由调用方给（`episodeFingerprint`：发生日 + 子类），不按文本——
   * 同一件事的措辞每次都不一样。
   *
   * 已存在时**只更新内容**（后一次的描述通常更完整），不改 `occurredAt`：
   * 事件发生的时间是客观的，不该因为又提了一次就往后挪。
   */
  async upsertEpisodic(
    userId: string,
    fingerprint: string,
    content: string,
    meta: EpisodicMemoryInput,
  ): Promise<{ written: boolean; merged: boolean }> {
    requireUser(userId);
    const existing = await this.getAll(userId, { category: "episodic", fingerprint }, 20);
    const prior = (existing.results ?? []).find(
      (m) => (m.metadata as { fingerprint?: string } | undefined)?.fingerprint === fingerprint,
    );

    if (prior?.id) {
      if (String(prior.memory ?? "").trim() === content.trim()) {
        return { written: false, merged: true };
      }
      await this.update(prior.id, content).catch(() => undefined);
      return { written: true, merged: true };
    }

    await this.addEpisodic(userId, content, { ...meta, fingerprint });
    return { written: true, merged: false };
  }

  /**
   * 检索②，**按发生时间倒序**并带出时间。
   *
   * 下游要说的是"你三个月前提过一次"，没有时间的情景记忆在售后语境里没有意义——
   * "这个毛病以前有过"与"这个毛病三年前有过"是两个不同的判断。
   */
  async recallEpisodes(
    userId: string,
    query: string,
    limit = 5,
  ): Promise<{
    degraded: boolean;
    episodes: Array<{ id?: string; content: string; occurredAt?: string; subType?: string }>;
  }> {
    const r = await this.searchEpisodic(userId, query, limit);
    const episodes = (r.results ?? []).map((m) => ({
      id: m.id,
      content: String(m.memory ?? ""),
      occurredAt: (m.metadata as { occurredAt?: string } | undefined)?.occurredAt,
      subType: (m.metadata as { subType?: string } | undefined)?.subType,
    }));
    episodes.sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? ""));
    return { degraded: r.degraded === true, episodes };
  }

  // ── ③偏好 ────────────────────────────────────────────────

  async addPreference(
    userId: string,
    content: string,
    meta: PreferenceMemoryInput,
  ): Promise<MemoryReadResult> {
    return this.add(userId, content, { ...meta, category: "preference" });
  }

  async searchPreference(userId: string, query: string, limit = 10): Promise<MemoryReadResult> {
    return this.search(userId, query, { category: "preference" }, limit);
  }

  /**
   * 按 (userId, domain) 落一条偏好：**同领域更新，不追加**（M11-02）。
   *
   * 追加的后果不是"多一条"，是同一个领域下堆着一串近义句
   * （"晚上充电" / "夜里充电" / "习惯夜充"），检索时全部召回，
   * 而下游无从判断哪条是现在有效的——③是**不硬删**的那一类，堆起来就下不去了。
   *
   * 新旧矛盾时以新的为准（"我改成白天充电了"），并在 metadata 里留一条
   * `supersededContent`：§7③ 的访问强化说的是"越用越牢"，不是"先到先得"，
   * 但覆盖掉的东西要留痕，否则用户说"我什么时候改过"时没人答得上来。
   *
   * 返回是否发生了写入——`false` 表示同内容已存在，不必重复写。
   */
  async upsertPreference(
    userId: string,
    domain: string,
    content: string,
    meta: Omit<PreferenceMemoryInput, "domain">,
  ): Promise<{ written: boolean; superseded?: string }> {
    // `Omit` 对带索引签名的类型会抹掉具名字段（见本文件顶部那条注释），
    // 所以这里显式补回 confidence / lastConfirmedAt，而不是指望 Omit 保住它们。
    const base: PreferenceMemoryInput = {
      domain,
      confidence: (meta as { confidence?: number }).confidence ?? 0.5,
      lastConfirmedAt:
        (meta as { lastConfirmedAt?: string }).lastConfirmedAt ?? new Date().toISOString(),
      ...meta,
    };
    requireUser(userId);
    const existing = await this.getAll(userId, { category: "preference", domain }, 20);
    const prior = (existing.results ?? []).find(
      (m) => (m.metadata as { domain?: string } | undefined)?.domain === domain,
    );

    if (prior && String(prior.memory ?? "").trim() === content.trim()) {
      // 内容没变：只更新"最后确认时间"的语义由访问强化承担，这里不重复写。
      return { written: false };
    }

    if (prior?.id) {
      const superseded = String(prior.memory ?? "");
      // 先删后写而不是 update：`update` 只改文本，metadata（confidence /
      // lastConfirmedAt / evidence）留在旧值上，那正是"看起来更新了其实没有"的形态。
      await this.delete(prior.id).catch(() => undefined);
      await this.addPreference(userId, content, { ...base, supersededContent: superseded });
      return { written: true, superseded };
    }

    await this.addPreference(userId, content, base);
    return { written: true };
  }

  /** 某用户某领域的偏好（供后台展示与用户修正，F-21-11）。 */
  async listPreferences(userId: string, limit = 50): Promise<MemoryReadResult> {
    return this.getAll(userId, { category: "preference" }, limit);
  }

  // ── ⑥用车画像摘要 ────────────────────────────────────────

  async addUsagePattern(
    userId: string,
    content: string,
    meta: UsagePatternInput,
  ): Promise<MemoryReadResult> {
    return this.add(userId, content, { ...meta, category: "usage_pattern" });
  }

  async searchUsagePattern(userId: string, query: string, limit = 10): Promise<MemoryReadResult> {
    return this.search(userId, query, { category: "usage_pattern" }, limit);
  }

  // ── 通用 ─────────────────────────────────────────────────

  async add(
    userId: string,
    content: string,
    metadata: CarLifeMemoryMeta,
  ): Promise<MemoryReadResult> {
    requireUser(userId);
    if (!(MEM0_CATEGORIES as readonly string[]).includes(metadata.category)) {
      // 这条**不降级**：它是调用方的错，不是后端故障。静默吞掉会让④档案
      // 悄悄进向量库，直接违反 §7 的红线。
      throw new Error(
        `Mem0 只承载 ${MEM0_CATEGORIES.join("/")}，不承载 ${metadata.category}——` +
          `④车辆档案走 PostgreSQL、⑤环境缓存走 Redis、①短期任务态在图状态（见 taxonomy.ts）`,
      );
    }

    const opts: AddMemoryOptions = {
      userId,
      metadata: metadata as Record<string, unknown>,
      // 关闭 LLM 自动抽取：metadata 由 CarLife 自己管（类别、时间、置信度都是
      // 衰减层的输入，不能交给模型猜）。
      infer: false,
    };

    return this.guard(() => this.memory.add([{ role: "user", content }], opts));
  }

  async search(
    userId: string,
    query: string,
    filters?: Record<string, unknown>,
    limit = 10,
  ): Promise<MemoryReadResult> {
    requireUser(userId);
    // mem0ai ≥3 的两个命名不一致，很容易写错且**不会报错**：
    //   `Entity`（add / deleteAll）用 camelCase `userId`
    //   `SearchFilters`（search / getAll）用 snake_case `user_id`
    // 写成 `filters: { userId }` 时它会被当成一个普通 metadata 字段去匹配，
    // 结果是**检索不到任何东西**——像"这个用户没有记忆"，而不是像一个 bug。
    return this.guard(() =>
      this.memory.search(query, { topK: limit, filters: { ...filters, user_id: userId } }),
    );
  }

  /**
   * 列举。
   *
   * 类别过滤**两边都做**：`filters` 传给 Mem0（3.x 的 `GetAllMemoryOptions` 支持），
   * 拿回来再按 `metadata.category` 筛一遍。看着冗余，但这一层挡的是
   * "后端把 filters 静默忽略"——2.x 的 `getAll` 就是这样，传了没用也不报错，
   * "查情景记忆"于是返回全部类别。多一次内存过滤的成本远小于那种无症状错误。
   *
   * 代价是 limit 语义：先取再筛，结果可能少于 limit。按 `limit * 4` 上取一批
   * 再截断，是"多取一点"与"不无界扫库"之间的折中。
   */
  async getAll(
    userId: string,
    filters?: Record<string, unknown>,
    limit = 50,
  ): Promise<MemoryReadResult> {
    requireUser(userId);
    const category = filters?.category;
    const fetchLimit = category ? limit * 4 : limit;
    const res = await this.guard(() =>
      this.memory.getAll({ topK: fetchLimit, filters: { ...filters, user_id: userId } }),
    );
    if (!category) return res;
    return {
      ...res,
      results: res.results.filter((m) => m.metadata?.category === category).slice(0, limit),
    };
  }

  async get(memoryId: string): Promise<MemoryItem | null> {
    if (!(await this.ensureReady())) return null;
    try {
      return await this.memory.get(memoryId);
    } catch (err) {
      this.noteError(err);
      return null;
    }
  }

  async update(memoryId: string, content: string): Promise<{ message: string }> {
    return this.memory.update(memoryId, content);
  }

  /**
   * 只合并 metadata、不动正文（mem0ai ≥3.1 的 `update({ metadata })`，合并语义）。
   *
   * 软删标记（M37-03 修复单）走这里：写进正文前缀的标记 `scan` 读不回来
   * （它按 metadata 判），而且前缀会随重复软删反复叠加污染原文。
   * 置 `null` 即清除该键（合并进去的 null 会覆盖旧值）——回滚用。
   * 注意：mem0 对未变文本仍会重算一次 embedding（实现如此），与改文本同代价。
   */
  async updateMetadata(
    memoryId: string,
    metadata: Record<string, unknown>,
  ): Promise<{ message: string }> {
    return this.memory.update(memoryId, { metadata });
  }

  async delete(memoryId: string): Promise<{ message: string }> {
    return this.memory.delete(memoryId);
  }

  async deleteAll(userId: string): Promise<{ message: string }> {
    requireUser(userId);
    return this.memory.deleteAll({ userId });
  }

  /** 重置向量库。**破坏性**——仅开发与演练脚本使用。 */
  async reset(): Promise<void> {
    await this.memory.reset();
    this.ready = false;
  }

  /** 底层实例（迁移脚本等需要直接操作时用）。 */
  getRawMemory(): Mem0Like {
    return this.memory;
  }

  // ── 内部 ─────────────────────────────────────────────────

  /**
   * 降级包装：后端故障 → 空结果 + `degraded` 标记，**不抛到业务层**。
   * 调用方的错（缺 userId、类别不对）在进入这里之前就已经抛掉了。
   */
  private async guard(fn: () => Promise<SearchResult>): Promise<MemoryReadResult> {
    if (!(await this.ensureReady())) {
      return { results: [], degraded: true, error: this.lastError };
    }
    try {
      return await fn();
    } catch (err) {
      this.noteError(err);
      return { results: [], degraded: true, error: this.lastError };
    }
  }

  private noteError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    // 一次失败即认为后端不可用，下次调用重新探活——避免对着挂掉的后端
    // 反复走完整超时。
    this.ready = false;
  }
}

/**
 * 无用户上下文的调用必须失败，**不能退化成读全量**（M7-01 边界）。
 * 这是本模块唯一会抛到业务层的错误类别。
 */
function requireUser(userId: string): void {
  if (!userId || !userId.trim()) {
    throw new Error("记忆读写必须带用户维度：userId 为空。跨用户泄露是严重事故，此处不降级。");
  }
}

// ── 单例 ────────────────────────────────────────────────────

let defaultClient: CarLifeMemoryClient | null = null;

export function getMemoryClient(config?: Partial<MemoryConfig>): CarLifeMemoryClient {
  if (!defaultClient) defaultClient = new CarLifeMemoryClient(config);
  return defaultClient;
}

export function resetMemoryClient(): void {
  defaultClient = null;
}
