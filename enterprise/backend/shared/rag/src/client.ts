/**
 * RAGFlow Cloud 客户端（施工单 M8-01，§6）。
 *
 * # 我们只调检索接口
 *
 * 解析→切分→向量化→检索**全部由 RAGFlow 承担**（§6 首段），本仓不自建向量库。
 * 代价是切分质量不完全由我们控制——所以"看得见切分"的能力（F-24-05）
 * 是这个选型的必要对冲，不是锦上添花。
 *
 * # 出处是检索结果的一部分，不是可选字段
 *
 * §6 接入方式原文要求返回**带引用来源的 chunk**。出处**由 RAGFlow 返回，
 * 不由 LLM 生成**——让模型"写出处"等于让它编出处（F-16-09）。
 */

import { datasetFor, datasetsForAgent, type DatasetKey } from "./datasets";

export interface RetrievedChunk {
  content: string;
  /** 出处：文档名 + 位置。**没有它这条 chunk 不该被使用**。 */
  source: { document: string; location?: string };
  score: number;
}

/**
 * RAGFlow 检索的"高级设置"。省略即用下面的常量默认值。
 *
 * 单独抽出来是因为它需要能被评测脚本扫参（`pnpm rag:eval`）——
 * **调参必须有可复现的量化依据**，凭感觉调一个检索阈值和不调没有区别。
 */
export interface RetrievalTuning {
  /** 低于此相似度的块直接丢弃。调高更准更少，调低更全更吵。 */
  similarityThreshold?: number;
  /** 向量相似度的权重，其余给关键词。1.0 = 纯向量，0 = 纯关键词。 */
  vectorSimilarityWeight?: number;
  /** **候选池**大小（不是返回条数）。向量召回先取这么多再排序截断。 */
  candidatePoolSize?: number;
  /** 重排模型 id。留空表示不重排。 */
  rerankId?: string;
}

export interface RetrieveArgs {
  dataset: DatasetKey;
  query: string;
  /** **返回条数**。映射到 RAGFlow 的 `page_size`，不是它的 `top_k`。 */
  topK?: number;
  tuning?: RetrievalTuning;
  /** 调用方 Agent——用于强制隔离检查。 */
  agent: string;
  /**
   * 车型限定（FL-23 F-23-07）。**多车型同库时这不是可选项。**
   *
   * 一个数据集里同时有迈锐宝和 Model 3 的手册，特斯拉车主问"冬天续航为什么掉这么多"
   * 完全可能返回迈锐宝的片段并**带上出处**——看起来对、有引用、说的是另一辆车。
   * 这是本项目最要防的形态，而它不会以任何错误的形式表现出来。
   *
   * 省略即不限定：单车型库、或调用方确实想跨车型查（如购车对比）时才这么用。
   */
  vehicleModel?: string;
}

export interface RagflowConfig {
  baseUrl: string;
  apiKey: string;
  /** dataset key → RAGFlow dataset id。 */
  datasetIds: Record<string, string>;
  /**
   * 超时。默认 15s。
   *
   * **不是随手定的**：RAGFlow Cloud 的 `/retrieval` 要先把 query 送到 embedding
   * 服务（我们这套是 SiliconFlow 的 bge-m3）再检索，实测**空数据集就要 2.3~2.7s**，
   * 首次调用会更高。原来的 8s 在真实环境下会间歇性超时——
   * 而超时的后果是双路退化为单路，用户只看到"本次未引用说明书出处"。
   */
  timeoutMs?: number;
}

export class DatasetAccessError extends Error {}

/**
 * 车型限定后**一篇文档都没匹配上**。
 *
 * 单独成类，因为它绝不能被当成"零命中"处理：零命中说明知识库里没这内容，
 * 而这个说明**我们根本没在这辆车的资料里找**。
 * 更不能退回全库检索——那正好绕开了限定本身。
 */
export class NoDocumentsForModelError extends Error {
  constructor(readonly vehicleModel: string, readonly dataset: string) {
    super(`数据集 ${dataset} 里没有 ${vehicleModel} 的资料。**不退回全库检索**——那会返回别的车型的内容。`);
    this.name = "NoDocumentsForModelError";
  }
}

/**
 * 车型名到文档名的匹配。
 *
 * 文档名的写法五花八门（`Model3_车主手册.pdf` / `tesla_m3_选配.md` /
 * `2017雪佛兰全新迈锐宝用户手册.pdf`），所以两边都先归一化：
 * 去掉空格下划线连字符、转小写，再做子串匹配，并补一张常见简写表。
 *
 * **宁可匹配不到也不要匹配错**：匹配不到会抛 NoDocumentsForModelError（明确的"没资料"），
 * 匹配错则会拿另一辆车的手册作答而不留任何痕迹。
 */
const MODEL_ALIASES: Record<string, readonly string[]> = {
  model3: ["model3", "m3"],
  modely: ["modely", "my"],
  models: ["models", "ms"],
  modelx: ["modelx", "mx"],
  cybertruck: ["cybertruck", "ct"],
};

/** 全部去掉分隔符：`Model3_车主手册` → `model3车主手册`。长别名用它。 */
function compact(s: string): string {
  return s.toLowerCase().replace(/[\s_\-（）()]/g, "");
}

/** 分隔符归一成空格：`tesla_m3_选配` → `tesla m3 选配`。短别名的边界靠它。 */
function spaced(s: string): string {
  return s.toLowerCase().replace(/[_\-（）()]+/g, " ");
}

/**
 * 目录页：**大量行以页码结尾**（`引言 . 0-1` / `钥匙 1-2`）。
 *
 * 它天然没有句末标点，跑串读检查必然全中——而目录被"切坏"这件事
 * 既不影响检索也没人会去看。实测迈锐宝手册转换后剩下的 10 段全是目录。
 */
export function looksLikeToc(content: string): boolean {
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 4) return false;
  // 行尾是"数字-数字"或"点线 + 数字"——目录条目的两种常见收尾。
  const dotted = lines.filter((l) => /[.·…\s]\s*\d+\s*[-–]\s*\d+\s*$|\.{2,}\s*\d+\s*$/.test(l)).length;
  return dotted / lines.length > 0.5;
}

/** 长度到此为止的别名按"短"处理——短到会在无关文件名里撞上。 */
const SHORT_ALIAS_MAX = 3;

export function documentMatchesModel(documentName: string, vehicleModel: string): boolean {
  const docCompact = compact(documentName);
  const docSpaced = spaced(documentName);
  const needles = MODEL_ALIASES[compact(vehicleModel)] ?? [compact(vehicleModel)];

  return needles.some((n) => {
    // 长别名（model3 / cybertruck）：去分隔符后直接子串匹配。
    if (n.length > SHORT_ALIAS_MAX) return docCompact.includes(n);
    // 短别名（m3 / my / ct）：**必须在分隔符归一后的串上做边界匹配**。
    // 这里踩过一次：一开始两种情况共用"去掉全部分隔符"的归一化，
    // 于是 `tesla_m3_选配` 变成 `teslam3选配`，`m3` 前面成了字母 `a`，
    // 边界检查把它判成不匹配——**归一化本身毁掉了边界检查赖以工作的东西**。
    return new RegExp(`(^|[^a-z0-9])${n}([^a-z0-9]|$)`).test(docSpaced);
  });
}

/** 见 `RagflowConfig.timeoutMs` 的实测说明。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * RAGFlow 的分页上限。超过就报 `page_size must be less than or equal to 100`。
 */
const MAX_PAGE_SIZE = 100;

/**
 * 版面识别流水线：**先识别版面 → 切图 → OCR → 再切块**。
 *
 * 不开的话多栏 PDF 会被按行横着串读：三列的半句交替出现，
 * 每一行本身通顺、关键词也在，所以检索照样命中照样给出处，
 * 只是拼起来讲的不是一件事（实测于迈锐宝三栏用户手册）。
 * 单栏 PDF 不开也没事——但**我们无法预先知道一份 PDF 是几栏的**，所以一律开。
 *
 * 写成常量而不是内联字符串：RAGFlow **对这个字段不做取值校验**——
 * 实测传 `"__invalid__"` 也返回 `code=0`，然后静默退回默认。
 * 拼错一个字母的后果是多栏 PDF 被串读，而页面上完全看不出来。
 */
const LAYOUT_DEEPDOC = "DeepDOC";

/**
 * 按扩展名选切分方法。
 *
 * **RAGFlow 的切分方法各自只吃特定格式**，选错了解析必然失败，
 * 而失败要等几分钟才在文档状态里显示出来：
 *   `manual` 只吃 pdf / docx —— markdown 传进去报 "file type not supported"
 *   `table`  只吃 excel / text / csv —— PDF 传进去同样报错
 *   `naive`  通用
 *
 * 两次都是先失败再补救才发现的（一次 PDF 撞上 table、一次 markdown 撞上 manual）。
 * 放在**上传时**决定，就不再有"传上去了、几分钟后才发现方法选错"这一段。
 *
 * 不一律用 naive 图省事：`manual` 对说明书类 PDF 的切分质量明显更好（它认章节结构）。
 */
export function chunkMethodFor(filename: string): "manual" | "naive" {
  return /\.(pdf|docx)$/i.test(filename) ? "manual" : "naive";
}

/**
 * **RAGFlow 出错时返回的是 HTTP 200**，错误在 body 里：
 * `{"code":100,"data":null,"message":"ValueError(...)"}`。
 *
 * 只看 `res.ok` 的后果很隐蔽：任何 API 层错误都变成"空结果"——
 * 文档列表看起来是"这个数据集还没有文档"，检索看起来是"零命中"。
 * 而我们刚刚才把"检索失败"和"零命中"拆成两句话，因为它们含义相反。
 * 不检查 code，那个区分就等于白做。
 *
 * 实测踩到：`page_size=200` 超过上限 100，四篇文档明明传上去了，
 * `listDocuments` 却一直报 0 篇。
 */
function assertOk(body: unknown): unknown {
  const b = body as { code?: number; message?: string } | null;
  if (b && typeof b.code === "number" && b.code !== 0) {
    throw new Error(`RAGFlow 返回错误（code=${b.code}）：${b.message ?? "无说明"}`);
  }
  return body;
}

export interface RagClient {
  retrieve(args: RetrieveArgs): Promise<RetrievedChunk[]>;
  /**
   * 数据集里的文档与**解析状态**（F-24-04）。
   *
   * 状态必须到解析层面，不是文件传输层面——"上传成功"是苏未最不信的四个字：
   * 文件传上去了但没解析成功，检索时什么都查不到，而页面上写着"成功"。
   */
  listDocuments(dataset: DatasetKey, agent: string): Promise<DocumentStatus[]>;
  /** 某文档的切分预览（F-24-05）——托管式 RAG 的必要对冲：我们保留可见性。 */
  listChunks(dataset: DatasetKey, documentId: string, agent: string): Promise<ChunkPreview[]>;
  /**
   * 上传并**触发解析**（F-24-04）。
   *
   * 两步合成一个方法是有意的：只上传不解析的文档在检索时什么都查不到，
   * 而界面上它看起来是"已上传"。**"上传成功"是苏未最不信的四个字**——
   * 把解析放进同一个调用里，就没有"传了但忘了解析"这个状态。
   */
  uploadDocument(
    dataset: DatasetKey,
    agent: string,
    file: { name: string; bytes: Uint8Array; contentType?: string },
  ): Promise<{ documentId: string }>;
  /**
   * 删除文档。
   *
   * 存在的理由只有一个：**放错数据集要能改正**。
   * 三个数据集是按消费方隔离的，一份资料放错位置意味着该看到它的 Agent 看不到、
   * 不该看到的反而能看到——留着比删掉更糟。
   */
  deleteDocuments(dataset: DatasetKey, agent: string, documentIds: string[]): Promise<void>;
}

export function createRagClient(cfg: RagflowConfig): RagClient {
  /** 数据集访问检查抽出来：三个方法用的是同一条规则，写三遍迟早漏一处。 */
  function assertAccess(dataset: DatasetKey, agent: string): string {
    const allowed = datasetsForAgent(agent).some((d) => d.key === dataset);
    if (!allowed) throw new DatasetAccessError(`Agent ${agent} 无权访问数据集 ${dataset}`);
    const id = cfg.datasetIds[datasetFor(dataset).key];
    if (!id) throw new Error(`数据集 ${dataset} 未配置 id（${datasetFor(dataset).envKey}）`);
    return id;
  }

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${cfg.apiKey}`, ...(init?.headers ?? {}) },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`RAGFlow HTTP ${res.status}`);
      return assertOk(await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listDocuments(dataset, agent) {
      const id = assertAccess(dataset, agent);
      const body = await call<{
        data?: { docs?: Array<{ id?: string; name?: string; run?: string; progress_msg?: string; chunk_num?: number }> };
      }>(`/api/v1/datasets/${id}/documents?page_size=${MAX_PAGE_SIZE}`);
      return (body.data?.docs ?? []).map((d) => ({
        documentId: d.id ?? "",
        name: d.name ?? "(未命名)",
        status: mapRunStatus(d.run),
        // **失败原因必须可读**——"解析失败"等于没说。
        error: mapRunStatus(d.run) === "failed" ? (d.progress_msg || "解析失败，原因未提供") : undefined,
        chunkCount: d.chunk_num,
      }));
    },

    async uploadDocument(dataset, agent, file) {
      const id = assertAccess(dataset, agent);

      const form = new FormData();
      form.append("file", new Blob([file.bytes as BlobPart], { type: file.contentType ?? "application/octet-stream" }), file.name);
      const up = await call<{ data?: Array<{ id?: string }> }>(
        `/api/v1/datasets/${id}/documents`,
        { method: "POST", body: form },
      );
      const documentId = up.data?.[0]?.id;
      if (!documentId) throw new Error("上传成功但没拿到 document id，无法触发解析");

      // **先定切分方法与版面识别，再触发解析**。
      //
      // 数据集有默认方法，但它未必适合这一篇——一个 markdown 落进 manual 方法的
      // 数据集，解析必然失败。
      //
      // `layout_recognize: "DeepDOC"` 是"先识别版面 → 切图 → OCR → 再切块"那条流水线。
      // **不开的话多栏 PDF 会被按行横着串读**：三列的半句交替出现，
      // 每一行本身通顺、关键词也在，所以检索照样命中照样给出处，
      // 只是拼起来讲的不是一件事（实测于迈锐宝三栏用户手册）。
      // 单栏 PDF 不开也没事——但我们无法预先知道一份 PDF 是几栏的，所以一律开。
      //
      // 注意 RAGFlow **不校验这个字段的取值**：拼错一个字母照样返回 code=0，
      // 然后静默退回默认。所以它必须是常量，不能拼字符串。
      await call(`/api/v1/datasets/${id}/documents/${documentId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chunk_method: chunkMethodFor(file.name),
          parser_config: {
            layout_recognize: LAYOUT_DEEPDOC,
            chunk_token_num: CHUNK_TOKEN_NUM,
            delimiter: CHUNK_DELIMITER,
          },
        }),
      });

      // 立刻触发解析。**不等它跑完**——解析可能要几分钟，
      // 阻塞在这里会让调用方以为是网络卡住了。进度由 listDocuments 轮询。
      await call(`/api/v1/datasets/${id}/chunks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document_ids: [documentId] }),
      });

      return { documentId };
    },

    async deleteDocuments(dataset, agent, documentIds) {
      const id = assertAccess(dataset, agent);
      await call(`/api/v1/datasets/${id}/documents`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: documentIds }),
      });
    },

    async listChunks(dataset, documentId, agent) {
      const id = assertAccess(dataset, agent);
      const body = await call<{
        data?: { chunks?: Array<{ content?: string; content_with_weight?: string }> };
      }>(`/api/v1/datasets/${id}/documents/${encodeURIComponent(documentId)}/chunks?page_size=${MAX_PAGE_SIZE}`);
      return (body.data?.chunks ?? []).map((c, index) => {
        const content = c.content ?? c.content_with_weight ?? "";
        return { index, content, looksTabular: looksTabular(content) };
      });
    },

    async retrieve(args) {
      // **跨数据集访问在调用层被拒**（AC-24-8），不依赖 prompt 约束。
      const allowed = datasetsForAgent(args.agent).some((d) => d.key === args.dataset);
      if (!allowed) {
        throw new DatasetAccessError(`Agent ${args.agent} 无权检索数据集 ${args.dataset}`);
      }

      const def = datasetFor(args.dataset);
      const datasetId = cfg.datasetIds[def.key];
      if (!datasetId) throw new Error(`数据集 ${def.key} 未配置 id（${def.envKey}）`);

      // 车型限定：把检索面缩到这辆车自己的文档上（F-23-07）。
      let documentIds: string[] | undefined;
      if (args.vehicleModel) {
        const docs = await this.listDocuments(args.dataset, args.agent);
        const mine = docs.filter((d) => documentMatchesModel(d.name, args.vehicleModel!));
        // **匹配不到就抛，不退回全库**——退回等于绕开限定，
        // 而绕开的表现是"返回了别的车型的内容且带着出处"。
        if (mine.length === 0) throw new NoDocumentsForModelError(args.vehicleModel, def.key);
        documentIds = mine.map((d) => d.documentId);
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/api/v1/retrieval`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            dataset_ids: [datasetId],
            ...(documentIds ? { document_ids: documentIds } : {}),
            question: args.query,
            // **`page_size` 才是返回条数**，`top_k` 是向量召回的候选池大小（默认 1024）。
            // 这两个曾被当成一回事：代码写 `top_k: topK ?? 5`，以为在要 5 条，
            // 实际是把候选池砍到 5、而返回条数吃 RAGFlow 的默认值——
            // probe 那句"命中 30 条"就是证据，当时传的 topK 是 5。
            // 后果不是报错：喂给 LLM 的上下文是预期的 6 倍，又长又吵，还多花 token。
            page_size: args.topK ?? DEFAULT_PAGE_SIZE,
            top_k: args.tuning?.candidatePoolSize ?? DEFAULT_CANDIDATE_POOL,
            similarity_threshold: args.tuning?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
            vector_similarity_weight:
              args.tuning?.vectorSimilarityWeight ?? DEFAULT_VECTOR_WEIGHT,
            ...(args.tuning?.rerankId ? { rerank_id: args.tuning.rerankId } : {}),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`RAGFlow HTTP ${res.status}`);
        const body = assertOk(await res.json()) as {
          data?: { chunks?: Array<{ content?: string; document_keyword?: string; similarity?: number; positions?: unknown }> };
        };
        return (body.data?.chunks ?? [])
          .map((c) => ({
            content: c.content ?? "",
            source: { document: c.document_keyword ?? "未知文档", location: formatPosition(c.positions) },
            score: c.similarity ?? 0,
          }))
          // 没有出处的 chunk 直接丢弃——带不出处的引用等于编造（F-16-09）。
          .filter((c) => c.content.trim().length > 0 && c.source.document !== "未知文档");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * RAGFlow 的 `run` 字段到我们的四态。
 *
 * 未知取值一律映射为 `parsing` 而不是 `succeeded`：
 * **不能因为看不懂一个状态就说它成功了**——那正是"上传成功"这四个字不可信的来源。
 */
function mapRunStatus(run?: string): ParseStatus {
  switch ((run ?? "").toUpperCase()) {
    case "DONE":
      return "succeeded";
    case "FAIL":
      return "failed";
    case "UNSTART":
      return "queued";
    default:
      return "parsing";
  }
}

/**
 * 表格特征。启发式，宁可多报也不漏报。
 *
 * **必须认 HTML 表格标记**：RAGFlow 会把识别出的表格转成 `<table><tr><td>`，
 * 而不是保留 markdown 的 `|` 竖线。只认竖线的话，一份 markdown 表格文档
 * 进了 RAGFlow 就变成"不是表格"——串读检测于是在它上面大面积误报
 * （三份选配数据 20/20 块全被标红）。
 *
 * 误报的代价和漏报一样实在：一屏红字里没人找得到真正该看的那一条。
 */
export function looksTabular(content: string): boolean {
  const trimmed = content.trim();
  // HTML 表格标记：RAGFlow 的表格产物形态。
  if (/<(table|thead|tbody|tr|td|th)\b/i.test(trimmed)) return true;

  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const piped = lines.filter((l) => /[|｜]/.test(l)).length;
  const spaced = lines.filter((l) => /\S\s{3,}\S\s{3,}\S/.test(l)).length;
  return piped / lines.length > 0.5 || spaced / lines.length > 0.5;
}

function formatPosition(p: unknown): string | undefined {
  if (Array.isArray(p) && p.length > 0) return `第 ${String(p[0])} 处`;
  return undefined;
}

/**
 * 知识库管理能力（施工单 M8-06，FL-24）。
 *
 * # 它是"托管式 RAG"这个选型的必要对冲
 *
 * §6 把解析与切分交给了 RAGFlow，我们保留的是**可见性而非控制权**。
 * 因此"看得见切分"不是锦上添花：说明书里最有价值的内容
 * （保养周期表、故障码表、操作步骤表）恰恰最容易被切坏，
 * 而切坏之后**检索仍然会返回结果**——只是那些结果没用。
 *
 * # "上传成功"是苏未最不信的四个字
 *
 * 状态必须到**解析层面**，不是文件传输层面（F-24-04）。
 */

export type ParseStatus = "queued" | "parsing" | "succeeded" | "failed";

export interface DocumentStatus {
  documentId: string;
  name: string;
  status: ParseStatus;
  /** 失败原因必须可读——"解析失败"等于没说 */
  error?: string;
  chunkCount?: number;
}

export interface ChunkPreview {
  index: number;
  content: string;
  /** 内容里是否疑似含表格结构——用于提示"这里可能被切坏了" */
  looksTabular: boolean;
}

/**
 * 多列版面被逐行串读的检测（F-24-05）。
 *
 * # 这是真实踩到的一种切坏形态，而且原来的启发式一条都没抓到
 *
 * 迈锐宝用户手册是三列排版（从左往右读）。RAGFlow 在未开版面识别时按**行**抽取，
 * 于是三列的文字被横着串起来：
 *
 *   引言
 *   的自录供您查找具体信息的位置。      ← 第 2 列
 *   操作车辆时应该注意的事项。忽视      ← 第 3 列
 *   本车集先进技术、安全性、环保及      ← 第 1 列
 *   该信息可能会导致错误的操作。        ← 第 3 列
 *
 * **它比"表被截断"更隐蔽**：每一行本身都是通顺的中文，关键词也都在，
 * 所以检索照样命中、照样给出处——只是拼起来讲的不是一件事。
 *
 * # 判据：连续多行都不以句末标点收尾
 *
 * 正常正文里，句子会在某一行结束（。！？；：）。列被串读时，每一列的半句
 * 交替出现，**连续很多行都停在句子中间**。用"最长的未收尾连续行数"做信号。
 *
 * 目录、参数表、列表天然也是短行，所以阈值给得保守（8 行），
 * 且只在行数足够多时才判——**宁可漏报也不要在正常表格上刷屏**，
 * 刷屏的检查等于没有检查。
 */
export const UNTERMINATED_RUN_THRESHOLD = 8;

/**
 * 切块目标长度。
 *
 * **这个字段以前从没设过**，于是一直吃 RAGFlow 的默认值 128 ——
 * 实测线上 1091 块的中位数是 108，落在客服问答推荐区间（256~512）的只有 12%，
 * 而 22% 短于 50 token（检索命中了也撑不起回答）。
 *
 * 512 取自客服/文档问答的通行区间上沿：手册类是**过程性内容**
 * （"先…再…最后…"），切太碎会把一个步骤序列拆成互不相干的几块，
 * 每块单看都通顺，合起来却答不了"这事怎么做"。
 */
export const CHUNK_TOKEN_NUM = 512;

/**
 * 切分优先落在哪些字符上。
 *
 * 在默认的句末标点之外加了 `\n`：经 `prepareMarkdownForChunking` 整理过的
 * markdown 里，段落边界就是语义边界，优先在那里断比在句号处断更整齐。
 */
export const CHUNK_DELIMITER = "\n!?;。；！？";

// ── 检索高级设置（由 `corepack pnpm rag:eval` 在 10 道画像题上扫参定出） ──
//
// **阈值和权重不独立**，这是定这组值时最关键的一条：`vector_similarity_weight`
// 改变的是合成相似度的量纲——同一批块在 w=0.0 时得分 0.19~0.23、
// w=1.0 时 0.82~0.85。所以"阈值 0.3"在不同权重下含义完全不同，
// 拿固定阈值网格横比不同权重，比的不是一回事。
//
// RAGFlow 的默认组合（w=0.3）**恰恰是最脆的一档**：阈值升到 0.4 时
// 关键词覆盖从 81% 掉到 43%、命中率掉到 50%，而 w≥0.5 的几档纹丝不动。
// 我们把权重抬到 0.5，阈值 0.3 因此落在得分分布（≈0.50~0.53）之下留有余量，
// 既能切掉真正的尾巴，又不会一碰就崩。

/**
 * 返回给 LLM 的块数（RAGFlow 的 `page_size`）。
 *
 * 8 与 12 的 LLM 裁判分完全相同（19/20），而 8 只用 3019 tok 上下文、
 * 12 要 4475 —— **同样的答题质量，少三分之一的 token**。
 * 覆盖率随条数单调上升是必然的（块越多越容易撞上关键词），
 * 所以不能只看覆盖率选大的。
 */
export const DEFAULT_PAGE_SIZE = 8;
/** 向量召回的候选池——RAGFlow 默认 1024，够大且实测不影响延迟。 */
export const DEFAULT_CANDIDATE_POOL = 1024;
/** 相似度下限。见上面关于"阈值与权重不独立"的说明。 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.3;
/** 向量 : 关键词 的权重。手册类问题里型号、代码、单位这些**字面量很重要**。 */
export const DEFAULT_VECTOR_WEIGHT = 0.5;
/** 短于此的行不参与判定：标题、页码、编号本来就不该有句末标点。 */
const MIN_JUDGEABLE_LINE = 6;
const SENTENCE_END = /[。！？；：.!?]$/;

/**
 * 标题、项目符号、表格行 —— **本来就不该有句末标点的行**。
 *
 * 把它们算进"未收尾"是最容易犯的误判：保养手册里一串
 * `z 经常在低温条件下行驶` 会凑出 12 行"未收尾"，规格表里一串 `## Motor Type`
 * 会凑出 11 行，两者都完全正常。真串读的特征是**句子被从中间切开**，
 * 而列表项是完整的一项，只是短。
 *
 * `z` 是这批 PDF 里项目符号（Wingdings 的 ●）被 OCR 成的字形。
 */
const LIST_OR_HEADING =
  // 图例编号写法很杂：全角 `1．`、无空格的 `2.`、`3）`、`(4)` 都出现过。
  // 数字标号后面**必须跟非数字**，否则 "2.5 米的车身长度…" 这种小数开头的
  // 正文行会被当成列表放过去——那才是真该报的东西。
  /^(#{1,6}\s|[-*+•·▪◆■○●z]\s|\||\d+[.．、)）]\s*(?=\D)|[A-Za-z][.．、)）]\s|[（(]\d+[）)])/;

/** 单行的键值形态：`GVWR：3,948 kg` 或 `代码 | 名称 | 价格`。 */
const KV_ROW = /^[^。！？；.!?;]{1,25}[：:]\s*\S|^[^|\n]{1,40}(\s\|\s[^|\n]+)+$/;

/**
 * 摊平后的表格块。
 *
 * `prepareMarkdownForChunking` 把小表摊成文本以便打包并带上面包屑
 * （见 chunk-prep.ts），代价是这些行天然没有句末标点——
 * **修表格上下文的动作造出了新的误报**，五篇文档因此被标成"疑似串读"。
 *
 * 判断必须在**块级**而不是行级：`注意：请勿在行驶中调节座椅` 这种正文
 * 单行看就是键值形态，逐行放过等于把串读里最常见的一类静默吞掉。
 * 而摊平的表格是**整块**都长这样——正文里冒号行只会是少数。
 */
export function looksFlattenedTable(content: string): boolean {
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 4) return false;
  return lines.filter((l) => KV_ROW.test(l)).length / lines.length >= 0.8;
}

export function longestUnterminatedRun(content: string): number {
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  let run = 0;
  let max = 0;
  for (const l of lines) {
    // 列表项与标题同样"跳过不重置"：它们不是证据，也不该抹掉证据。
    // 三列串读的碎片里混进一行小标题是常事，重置会把整段串读切成两半藏起来。
    if (LIST_OR_HEADING.test(l)) continue;
    // **短行跳过，不重置**。第一版写成重置，结果漏报了真实样本：
    // 三列串读时每一列的尾巴天然就短（"经济性于一体" 6 字），
    // 而那恰恰是串读的证据不是干扰——按"重置"处理等于把证据当噪声扔掉。
    if (l.length < MIN_JUDGEABLE_LINE) continue;
    if (SENTENCE_END.test(l)) run = 0;
    else max = Math.max(max, (run += 1));
  }
  return max;
}

/**
 * 表格的**数据行数**（不含表头），而不是文本的换行数。
 *
 * 这两者曾被当成一回事，代价是 36/38 块误报：RAGFlow 切 PDF 时表格是多行文本，
 * 数换行确实等于数行；而 MinerU 输出的 `<table>` **整张挤在一行里**，
 * 一张完好的 30 行表于是被判成"只有 1~2 行 → 被拦腰截断"。
 */
export function tableDataRowCount(content: string): number {
  const rows = content.match(/<tr[\s\S]*?<\/tr>/gi);
  if (rows) return rows.filter((r) => !/<th[\s>]/i.test(r)).length;
  const piped = content.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (piped.length > 0) {
    // markdown 管道表：表头行 + `| --- |` 分隔行都不算数据。
    const sep = piped.findIndex((l) => /^\|[\s:|-]+\|?$/.test(l));
    return sep >= 0 ? piped.length - sep - 1 : piped.length;
  }
  // **既没有 `<tr>` 也没有 `|` 起头的行，就按非空行数算**。
  // 这里原先直接返回 `piped.length`（也就是 0），于是摊平后的
  // `代码 | 名称 | 价格` 整块被判成"只剩表头，没有数据行"——
  // 一个 306 token、内容完好的块被报成碎片。
  return content.split("\n").filter((l) => l.trim().length > 0).length;
}

/** 有没有表头 —— 一块表格**有没有说清每一列是什么**，比它有几行要紧。 */
export function hasTableHeader(content: string): boolean {
  if (/<th[\s>]/i.test(content)) return true;
  return content.split("\n").some((l) => /^\s*\|[\s:|-]+\|?\s*$/.test(l));
}

/**
 * 切分质量的启发式检查（F-24-05）。
 *
 * **它不判断切得对不对**——那需要人看。它只负责把"最可能出问题的地方"
 * 挑出来让人优先看：一个 chunk 里出现表格特征却只有一两行，
 * 多半是一张表被拦腰截断了。
 */
export function suspiciousChunks(chunks: readonly ChunkPreview[]): Array<{ index: number; why: string }> {
  const out: Array<{ index: number; why: string }> = [];
  for (const c of chunks) {
    const lines = c.content.split("\n").filter((l) => l.trim().length > 0);
    if (c.looksTabular) {
      // RAGFlow 切大表时会**给每一块补上表头**，所以"表头 + 一行数据"是正常产物，
      // 不是碎片——按行数判会把 9/20 块正常分块判成截断。真正没法用的是两种：
      // 只剩表头没有数据，以及有数据却不知道每列是什么。
      const dataRows = tableDataRowCount(c.content);
      if (dataRows === 0) {
        out.push({ index: c.index, why: "疑似表格被拦腰截断（只剩表头，没有数据行）" });
      } else if (!hasTableHeader(c.content) && dataRows <= 1) {
        out.push({ index: c.index, why: "疑似表格被拦腰截断（只有一行数据且没有表头，读不出每列是什么）" });
      }
    }
    if (c.content.trim().length < 20) {
      out.push({ index: c.index, why: "内容过短，检索命中后也难以支撑回答" });
    }
    // 表格特征跨 chunk 边界：上一块结尾与下一块开头都像表格行
    if (c.looksTabular && /^[|｜]/.test(c.content.trim())) {
      out.push({ index: c.index, why: "以表格分隔符开头，可能缺少表头" });
    }
    // 多列被逐行串读。**这一条比其它几条更值得先看**：
    // 它不会让检索失败，只会让检索命中一段读不通的文字。
    //
    // `looksTabular` 再算一次而不是只信调用方传的：表格的每一行本来就不带句末标点，
    // 在表格上跑这条检查必然大面积误报，而**一屏红字里没人找得到真正该看的那一条**。
    // 表格与目录都排除：两者天然不带句末标点，在它们上面跑串读检查必然全中，
    // 而**一屏红字里没人找得到真正该看的那一条**。
    const skip =
      c.looksTabular || looksTabular(c.content) || looksLikeToc(c.content) || looksFlattenedTable(c.content);
    if (!skip && lines.length >= UNTERMINATED_RUN_THRESHOLD) {
      const run = longestUnterminatedRun(c.content);
      if (run >= UNTERMINATED_RUN_THRESHOLD) {
        out.push({
          index: c.index,
          why: `连续 ${run} 行停在句子中间——**多列版面可能被逐行串读了**。` +
            `每行本身通顺、关键词也在，所以检索照样命中，但拼起来讲的不是一件事。` +
            `到 RAGFlow 里把该文档的 layout_recognize 设为 DeepDOC 再重新解析。`,
        });
      }
    }
  }
  return out;
}

/** 检索测试的结果——苏未判定"传成功了"的真正标准（F-24-06）。 */
export interface RetrievalTestResult {
  query: string;
  hits: Array<{ document: string; location?: string; score: number; excerpt: string }>;
  /** 零命中不是错误，是**信息**：说明这个问题当前知识库答不了。 */
  empty: boolean;
}

export function summarizeRetrievalTest(
  query: string,
  chunks: readonly RetrievedChunk[],
): RetrievalTestResult {
  return {
    query,
    hits: chunks.map((c) => ({
      document: c.source.document,
      location: c.source.location,
      score: c.score,
      excerpt: c.content.slice(0, 120),
    })),
    empty: chunks.length === 0,
  };
}
