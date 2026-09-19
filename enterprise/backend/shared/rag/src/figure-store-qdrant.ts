/**
 * 手册图文索引的 Qdrant 实现（施工单 M81-01，ACR-030）。
 *
 * # 为什么搬出 pgvector
 *
 * 向量是 2560 维，而 **pgvector 的 HNSW 索引上限是 2000 维**——2026-09-12 实测建索引直接报
 * `column cannot have more than 2000 dimensions for hnsw index`。于是 `manual_figures` 只能全表顺序扫描，
 * 3116 行实测 307 ms，且随手册数量线性增长。Qdrant 没有这个上限。
 *
 * # 它只存不算
 *
 * 向量仍由我们自己调 DashScope `qwen3-vl-embedding` 算好传进来。选 Qdrant 而不是 Weaviate / Marqo 正是因为
 * 那两个的内置 vectorizer / 内置推理我们用不上（`qwen3-vl-embedding` 不支持 OpenAI 兼容口），
 * 背一套用不上的推理体系不如要一个纯粹的存储检索层。
 *
 * # 三个实测出来的坑（2026-09-12 探针，都体现在下面的实现里）
 *
 * 1. **Cosine 返回的是相似度不是距离**：完全相同的向量 `score = 1`，正交 `score = 0`。
 *    而 `FigureStore` 的契约（pgvector 版的 `<=>`）返回的是**距离**，调用方按 `1 - distance` 当相似度。
 *    所以这里必须 `distance = 1 - score` 换算回去——不换算的话相似度门（文字 0.70 / 图像 0.65）会整体错位，
 *    而表现只是「换了引擎效果变差」，极难归因。
 * 2. **同 id 再 upsert 是「替换」不是「合并」具名向量**：给已存在的 point 只传 `{ image }`，
 *    它原有的 `text` 向量会被删掉。而 `buildFigureIndex` 是一行一行给过来的（text 一行、image 一行、crop 两行），
 *    所以 `upsertMany` **必须先按 figureId 聚合成一个 point 再写**。这是正确性要求，不是优化。
 * 3. **`indexed_vectors_count` 为 0 是正常的**：缺省 `indexing_threshold` 是 20000 个点，我们只有 3116，
 *    Qdrant 刻意走暴力搜索（小集合上它更快）。别把这个数当成「索引没建成功」。
 *
 * # 降级方向是少说话
 *
 * 查询侧（`nearest`）连不上、超时、collection 不存在都返回空数组并 warn——上游 `recallFigures` 的纪律是
 * 「召回失败只是没有这一段，不进 caveats」。写入侧（`upsertMany` / `deleteByDoc`）照常抛：
 * 灌数据失败必须让人知道，静默成功才是灾难。
 */

import { createHash } from "node:crypto";

import type { FigureStore, FigureStoreRow } from "./figure-index";

/** 三种向量各占一个具名向量位，与 `FigureStoreRow["kind"]` 一一对应。 */
const VECTOR_NAMES = ["image", "text", "crop"] as const;

export const DEFAULT_QDRANT_COLLECTION = "manual_figures";
/** `qwen3-vl-embedding` 的缺省维度。换模型要连带重建 collection（维度写死在 schema 里）。 */
export const DEFAULT_QDRANT_DIM = 2560;

/**
 * UUIDv5 的 namespace。**固定值，不能改**——改了等于所有 point 换 id，重灌会翻倍而不是覆盖。
 * 随手取的一个 v4 UUID，只作命名空间用，无其它含义。
 */
const NAMESPACE = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

/**
 * 从我们的字符串键派生确定性的 point id。
 *
 * Qdrant 的 point id 只收无符号整数或 UUID，而我们的键是 `<doc>#p<page>#b<idx>` 这种字符串，
 * 所以按 RFC 4122 的 v5 规则（namespace + name 过 SHA-1）派生。同一个键永远得到同一个 id，
 * 重灌才是幂等覆盖而不是堆积。
 */
export function pointIdFor(key: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(ns).update(key, "utf8").digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 一张图在 Qdrant 里是一个 point，同图的多种向量合并进 `vectors`（见文件头第 2 条坑）。 */
const groupKeyOf = (r: FigureStoreRow): string => `${r.doc}#${r.figureId}`;

export interface QdrantFigureStoreOptions {
  /** 缺省 `http://127.0.0.1:6333`。 */
  url?: string;
  /** 本机档没有鉴权；部署到任何非本机环境必须给。 */
  apiKey?: string;
  collection?: string;
  dim?: number;
  /** 单次请求超时，缺省 5 s。查询侧超时按「没查到」处理。 */
  timeoutMs?: number;
  /** 注入用（测试）。 */
  fetch?: typeof fetch;
}

interface QdrantPoint {
  id: string;
  vector: Record<string, number[]>;
  payload: Record<string, unknown>;
}

/**
 * 裸 HTTP 调 Qdrant，不引它的 SDK 到这一层的类型里——
 * 需要的只有四个端点，而 SDK 的类型会把 `FigureStore` 的实现绑死在某个客户端大版本上。
 */
function createHttp(opts: QdrantFigureStoreOptions) {
  const base = (opts.url ?? "http://127.0.0.1:6333").replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(opts.apiKey ? { "api-key": opts.apiKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: unknown; result?: T };
    if (!res.ok) {
      const detail = typeof json.status === "object" ? JSON.stringify(json.status) : String(json.status ?? res.statusText);
      throw new Error(`Qdrant ${method} ${path} 失败（HTTP ${res.status}）：${detail}`);
    }
    return json.result as T;
  };
}

export function createQdrantFigureStore(opts: QdrantFigureStoreOptions = {}): FigureStore & {
  /** 幂等建 collection；`upsertMany` 会自动调，单独暴露是给灌数据脚本先建好用。 */
  ensureCollection(): Promise<void>;
  /** 给灌数据脚本打印用。 */
  stats(): Promise<{ points: number; indexedVectors: number; status: string } | null>;
} {
  const call = createHttp(opts);
  const collection = opts.collection ?? DEFAULT_QDRANT_COLLECTION;
  const dim = opts.dim ?? DEFAULT_QDRANT_DIM;
  let ensured = false;

  async function ensureCollection(): Promise<void> {
    if (ensured) return;
    const exists = await call<{ status?: string } | null>("GET", `/collections/${collection}`).catch(() => null);
    if (!exists) {
      await call("PUT", `/collections/${collection}`, {
        vectors: Object.fromEntries(VECTOR_NAMES.map((n) => [n, { size: dim, distance: "Cosine" }])),
      });
      // doc 与 confidence 每次查询都要过滤，建索引让过滤走索引而不是逐点扫 payload。
      await call("PUT", `/collections/${collection}/index`, { field_name: "doc", field_schema: "keyword" }).catch(() => {});
      await call("PUT", `/collections/${collection}/index`, { field_name: "confidence", field_schema: "float" }).catch(() => {});
    }
    ensured = true;
  }

  /** 与 pgvector 版同款的过滤：doc 精确、confidence >= 下限。`kind` 由具名向量承担，不进 filter。 */
  function filterFor(q: { doc?: string; minConfidence?: number }): Record<string, unknown> | undefined {
    const must: unknown[] = [];
    if (q.doc) must.push({ key: "doc", match: { value: q.doc } });
    if (q.minConfidence !== undefined && q.minConfidence > 0) must.push({ key: "confidence", range: { gte: q.minConfidence } });
    return must.length ? { must } : undefined;
  }

  const rowFromPayload = (p: Record<string, unknown>, kind: FigureStoreRow["kind"]): FigureStoreRow => ({
    doc: String(p.doc ?? ""),
    figureId: String(p.figureId ?? ""),
    page: Number(p.page ?? 0),
    location: String(p.location ?? ""),
    breadcrumb: String(p.breadcrumb ?? ""),
    kind,
    imgPath: String(p.imgPath ?? ""),
    anchorText: String(p.anchorText ?? ""),
    caption: String(p.caption ?? ""),
    confidence: Number(p.confidence ?? 0),
    rule: String(p.rule ?? ""),
    sourceAsset: String((p.sourceAsset as Record<string, string> | undefined)?.[kind] ?? ""),
    descriptor: (p.descriptor as Record<string, unknown> | undefined)?.[kind] ?? null,
  });

  return {
    ensureCollection,

    async stats() {
      const info = await call<{ points_count?: number; indexed_vectors_count?: number; status?: string }>("GET", `/collections/${collection}`).catch(() => null);
      if (!info) return null;
      return { points: info.points_count ?? 0, indexedVectors: info.indexed_vectors_count ?? 0, status: info.status ?? "unknown" };
    },

    async upsertMany(rows) {
      if (rows.length === 0) return 0;
      await ensureCollection();
      /*
       * 按图聚合成 point。`sourceAsset` 与 `descriptor` 按 kind 分别存进 payload 的子对象，读回来时按 kind 取。
       */
      const byFigure = new Map<string, QdrantPoint>();
      for (const r of rows) {
        const key = groupKeyOf(r);
        const point: QdrantPoint = byFigure.get(key) ?? {
          id: pointIdFor(key),
          vector: {},
          payload: {
            doc: r.doc,
            figureId: r.figureId,
            page: r.page,
            location: r.location,
            breadcrumb: r.breadcrumb,
            imgPath: r.imgPath,
            anchorText: r.anchorText,
            caption: r.caption ?? "",
            confidence: r.confidence,
            rule: r.rule,
            sourceAsset: {} as Record<string, string>,
            descriptor: {} as Record<string, unknown>,
          },
        };
        point.vector[r.kind] = r.embedding;
        (point.payload.sourceAsset as Record<string, string>)[r.kind] = r.sourceAsset ?? "";
        (point.payload.descriptor as Record<string, unknown>)[r.kind] = r.descriptor ?? null;
        byFigure.set(key, point);
      }
      const points = [...byFigure.values()];

      // 分批：一张手册几百个 point、每个 point 三个 2560 维向量，一次全塞进去请求体过大。
      const BATCH = 64;
      for (let i = 0; i < points.length; i += BATCH) {
        const batch = points.slice(i, i + BATCH);
        /*
         * **先读回已有向量再合并**（文件头第 2 条坑）。
         *
         * upsert 是「替换整个 vector 对象」而不是「合并具名向量」——2026-09-12 探针实测：
         * 给已有 point 只传 `{ image }`，它原有的 `text` 会被删掉。而 `buildFigureIndex` 是
         * 一行一行给过来的（text 一行、image 一行、crop 两行），分多次调到这里。
         * 只在单次调用内聚合是不够的，跨调用同样会互相覆盖。
         *
         * 另有一个 `PUT /points/vectors` 端点能「只更新指定向量、保留其余」，但 point 不存在时回 404，
         * 要先判存在再分支；读回来合并这条路少一个分支，语义也更直白。灌数据是离线动作，多一次往返可接受。
         */
        type Existing = { id: string; vector?: Record<string, number[]>; payload?: Record<string, unknown> };
        const existing = await call<Existing[]>("POST", `/collections/${collection}/points`, {
          ids: batch.map((p) => p.id),
          with_vector: true,
          with_payload: true,
        }).catch(() => [] as Existing[]);
        const had = new Map(existing.map((p) => [String(p.id), p]));
        for (const p of batch) {
          const old = had.get(p.id);
          if (!old) continue;
          // 本批的同名向量覆盖旧的，未提及的保留
          p.vector = { ...(old.vector ?? {}), ...p.vector };
          /*
           * payload 同样是替换语义，而 `sourceAsset` / `descriptor` 是**按 kind 分存的子对象**——
           * 直接覆盖会把上一次写进去的那一档抹掉（2026-09-12 单测抓到：写完 crop 之后 image 的 sourceAsset 没了）。
           * 这两个子对象要逐键合并，其余字段以本次为准（同一张图的出处与锚段不会变，变了也该以新的为准）。
           */
          const oldPayload = old.payload ?? {};
          p.payload.sourceAsset = { ...((oldPayload.sourceAsset as Record<string, string>) ?? {}), ...(p.payload.sourceAsset as Record<string, string>) };
          p.payload.descriptor = { ...((oldPayload.descriptor as Record<string, unknown>) ?? {}), ...(p.payload.descriptor as Record<string, unknown>) };
        }
        await call("PUT", `/collections/${collection}/points?wait=true`, { points: batch });
      }
      // 返回入参行数，与 pgvector 版同语义（它数的是写了几行，不是几个 point）。
      return rows.length;
    },

    async nearest(q) {
      const kinds: Array<FigureStoreRow["kind"]> = q.kind ? [q.kind] : [...VECTOR_NAMES];
      const filter = filterFor(q);
      const out: Array<FigureStoreRow & { distance: number }> = [];
      try {
        await ensureCollection();
        for (const kind of kinds) {
          const r = await call<{ points?: Array<{ score: number; payload?: Record<string, unknown> }> }>(
            "POST",
            `/collections/${collection}/points/query`,
            { query: q.vector, using: kind, limit: Math.max(1, Math.min(200, q.k)), with_payload: true, ...(filter ? { filter } : {}) },
          );
          for (const p of r.points ?? []) {
            // Cosine 给的是相似度，契约要的是距离（文件头第 1 条坑）
            out.push({ ...rowFromPayload(p.payload ?? {}, kind), distance: 1 - p.score });
          }
        }
      } catch (e) {
        // 查询侧降级：没有这一段，不是整轮失败
        console.warn(`[qdrant] 图示召回失败，本次按没查到处理：${(e as Error).message}`);
        return [];
      }
      return out.sort((a, b) => a.distance - b.distance).slice(0, Math.max(1, Math.min(200, q.k)));
    },

    async deleteByDoc(doc) {
      await ensureCollection();
      const before = await call<{ count?: number }>("POST", `/collections/${collection}/points/count`, {
        filter: { must: [{ key: "doc", match: { value: doc } }] },
        exact: true,
      });
      await call("POST", `/collections/${collection}/points/delete?wait=true`, {
        filter: { must: [{ key: "doc", match: { value: doc } }] },
      });
      return before.count ?? 0;
    },
  };
}
