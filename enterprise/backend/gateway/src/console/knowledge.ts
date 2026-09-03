/**
 * 知识库管理（施工单 M8-01 的后台部分，FL-24）。
 *
 * # 它是"托管式 RAG"这个选型的必要对冲
 *
 * §6 把解析与切分交给了 RAGFlow，我们保留的是**可见性而非控制权**。
 * 所以"看得见切分"不是锦上添花：说明书里最有价值的内容
 * （保养周期表、故障码表、操作步骤表）恰恰最容易被切坏，
 * 而切坏之后**检索仍然会返回结果**——只是那些结果没用。
 *
 * # "上传成功"是最不可信的四个字
 *
 * 状态一律到**解析层面**（F-24-04）。文件传上去了但解析失败，
 * 检索时什么都查不到，页面上却写着"成功"——这正是要防的。
 *
 * # 未接入时说未接入
 *
 * RAGFlow 是 Cloud 托管，没配就是没配。这里返回明确的 `not_configured`，
 * 而不是空列表——空列表看起来像"知识库是空的"，那是另一回事。
 */

import { Router, type Response } from "express";

import {
  DatasetAccessError,
  DATASETS,
  suspiciousChunks,
  summarizeRetrievalTest,
  type DatasetKey,
  type RagClient,
} from "@carlife/rag";

import type { ChatRepository } from "@carlife/db";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";

/** 后台以哪个身份访问数据集：admin 能看全部三个集，隔离规则本身不放宽。 */
const CONSOLE_AGENTS: Record<DatasetKey, string> = {
  "vehicle-manuals": "ownership",
  "repair-kb": "service",
  "car-catalog": "buying",
};

function isDatasetKey(v: unknown): v is DatasetKey {
  return typeof v === "string" && v in CONSOLE_AGENTS;
}

export function createKnowledgeRouter(
  getClient: () => RagClient | undefined,
  /** 运行时地址：双路探针在 runtime 侧（那边才有工具句柄），网关只转发。 */
  runtimeUrl?: string,
  /** 会话仓储：双路轮次的清单与明细都从轨迹 + 对话历史里读。 */
  chat?: ChatRepository,
): Router {
  const router = Router();

  /**
   * 触发过双路的轮次清单（M-dual-turns）。
   *
   * 从"现场重跑一个问题"改成"翻看真实发生过的那一轮"——后者才是证据：
   * 重跑的检索结果未必与当时相同（知识库与用车数据都在变），
   * 而演示时被追问"这是刚查的还是当时就这样"，重跑答不上来。
   */
  router.get(
    "/console/knowledge/dual-turns",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      if (!chat) {
        res.status(503).json({ error: "chat_unconfigured" });
        return;
      }
      const limit = Number(req.query.limit ?? 30);
      res.json({ turns: await chat.dualPathTurns(Number.isFinite(limit) ? limit : 30) });
    },
  );

  /**
   * 对照答案：同一轮的上下文**去掉用车数据那一节**再答一次（M-dual-turns 第二步）。
   *
   * **按需生成**：一次 LLM 调用十几秒且花钱，不该在打开页面时就跑。
   * 上下文取当时留在轨迹里的那份，不重跑检索——见 runtime 侧的说明。
   */
  router.post(
    "/console/knowledge/dual-turns/:turnId/contrast",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      if (!chat || !runtimeUrl) {
        res.status(503).json({ error: "unconfigured" });
        return;
      }
      const turn = await chat.dualPathTurn(String(req.params.turnId));
      const context = typeof turn?.detail?.context === "string" ? turn.detail.context : "";
      if (!turn || !context) {
        // 旧轮次没留上下文，生不出对照——**明说**，不给一个编的答案。
        res.status(404).json({ error: "context_not_recorded" });
        return;
      }
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/dual-path/contrast`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ context, question: turn.question ?? "" }),
        });
        res.status(upstream.status).type("application/json").send(await upstream.text());
      } catch (err) {
        console.error("[console] 对照答案转发失败", err);
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  /** 单轮明细：两路各拿到什么、合成了什么、模型真实答了什么。 */
  router.get(
    "/console/knowledge/dual-turns/:turnId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      if (!chat) {
        res.status(503).json({ error: "chat_unconfigured" });
        return;
      }
      const r = await chat.dualPathTurn(String(req.params.turnId));
      if (!r) {
        res.status(404).json({ error: "turn_not_found" });
        return;
      }
      res.json(r);
    },
  );

  /**
   * 双路检索对照（M-dual-probe）。
   *
   * 单路检索测试回答"知识库里有没有这段"；这一条回答的是另一个问题：
   * **同一个提问，只查手册与加上这辆车的数据，喂给模型的东西差在哪**。
   * 前者是知识库运维，后者是这套系统的核心主张——而主张此前只写在文档里。
   */
  router.post(
    "/console/knowledge/dual-path",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
    if (!runtimeUrl) {
      res.status(503).json({ error: "runtime_unconfigured" });
      return;
    }
    try {
      const upstream = await fetch(`${runtimeUrl}/internal/dual-path/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body ?? {}),
      });
      const text = await upstream.text();
      // 原样透传状态码与体：runtime 的 400（缺 query）与 502（检索失败）
      // 各有各的含义，压成一个 500 会让页面说不清是谁的问题。
      res.status(upstream.status).type("application/json").send(text);
    } catch (err) {
      console.error("[console] 双路探针转发失败", err);
      res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  const withClient = (
    res: Response,
    fn: (c: RagClient) => Promise<unknown>,
  ): Promise<void> => {
    const client = getClient();
    if (!client) {
      res.status(503).json({
        error: "not_configured",
        reason: "RAGFlow 未接入（RAGFLOW_BASE_URL / API_KEY / dataset id 未配置）。此时双路检索只剩⑥那一路。",
      });
      return Promise.resolve();
    }
    return fn(client)
      .then((body) => {
        res.json(body);
      })
      .catch((err: unknown) => {
        // 跨集访问被拒是**规则生效**，不是故障——单独给 403 让它在页面上可区分。
        if (err instanceof DatasetAccessError) {
          res.status(403).json({ error: "dataset_forbidden", reason: err.message });
          return;
        }
        res.status(502).json({ error: "ragflow_error", reason: String(err) });
      });
  };

  /** 三个数据集的定义——含 provenance：`repair-kb` 是模拟数据，展示时必须标注（F-24-11）。 */
  router.get("/console/knowledge/datasets", requireAnyRole(CONSOLE_READERS), (_req, res: Response) => {
    res.json({
      datasets: DATASETS.map((d) => ({
        key: d.key,
        name: d.name,
        consumers: d.consumers,
        provenance: d.provenance,
        configured: getClient() !== undefined,
      })),
    });
  });

  router.get(
    "/console/knowledge/:dataset/documents",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const dataset = req.params.dataset;
      if (!isDatasetKey(dataset)) {
        res.status(400).json({ error: "unknown_dataset" });
        return;
      }
      await withClient(res, async (c) => ({
        documents: await c.listDocuments(dataset, CONSOLE_AGENTS[dataset]),
      }));
    },
  );

  /**
   * 切分预览 + 质量提示。
   *
   * **提示不是判定**（`suspiciousChunks` 的原文）：它不判断切得对不对，
   * 只把最可能出问题的地方挑出来让人优先看。切得好不好最终要人看。
   */
  router.get(
    "/console/knowledge/:dataset/documents/:documentId/chunks",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const dataset = req.params.dataset;
      if (!isDatasetKey(dataset)) {
        res.status(400).json({ error: "unknown_dataset" });
        return;
      }
      await withClient(res, async (c) => {
        const chunks = await c.listChunks(dataset, String(req.params.documentId), CONSOLE_AGENTS[dataset]);
        return { chunks, suspicious: suspiciousChunks(chunks) };
      });
    },
  );

  /**
   * 上传文档并触发解析。
   *
   * 用原始 body + 头部元数据，与 M8-04 的附件上传同一形态——
   * 但**两者是两条路，不能混**：附件是用户拍的照片（进对象存储），
   * 这里是知识库资料（进 RAGFlow）。用户上传的内容**不得进入知识库**
   * （M8-01 约束 5-②），所以没有从附件转存到这里的通路。
   */
  router.post(
    "/console/knowledge/:dataset/documents",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const dataset = req.params.dataset;
      if (!isDatasetKey(dataset)) {
        res.status(400).json({ error: "unknown_dataset" });
        return;
      }
      const nameHeader = req.headers["x-filename"];
      const raw = Array.isArray(nameHeader) ? nameHeader[0] : nameHeader;
      let name = "upload";
      if (raw) {
        // 与附件上传同一约定：中文文件名走 percent-encoding，
        // HTTP 头是 ByteString，直接塞在客户端就抛。
        try {
          name = decodeURIComponent(raw);
        } catch {
          name = raw;
        }
      }

      const chunks: Buffer[] = [];
      for await (const c of req as unknown as AsyncIterable<Buffer>) chunks.push(c);
      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) {
        res.status(400).json({ error: "empty_file" });
        return;
      }

      await withClient(res, async (c) =>
        c.uploadDocument(dataset, CONSOLE_AGENTS[dataset], {
          name,
          bytes,
          contentType: String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0],
        }),
      );
    },
  );

  /**
   * 检索测试（F-24-06）——苏未判定"传成功了"的真正标准。
   *
   * **零命中不是错误，是信息**：它说明这个问题当前知识库答不了，
   * 而这正是上传后最该先问的一件事。
   */
  router.get(
    "/console/knowledge/:dataset/retrieval-test",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const dataset = req.params.dataset;
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!isDatasetKey(dataset)) {
        res.status(400).json({ error: "unknown_dataset" });
        return;
      }
      if (!query) {
        res.status(400).json({ error: "empty_query" });
        return;
      }
      await withClient(res, async (c) =>
        summarizeRetrievalTest(
          query,
          // **不传 topK，用检索侧的生产默认值**（`DEFAULT_PAGE_SIZE`）。
          // 这一页的用途是让运营看到"用户会拿到什么"（F-24-06），
          // 写死一个跟生产不一样的条数，测的就不是生产。
          await c.retrieve({ dataset, query, agent: CONSOLE_AGENTS[dataset] }),
        ),
      );
    },
  );

  return router;
}
