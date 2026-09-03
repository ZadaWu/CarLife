/**
 * 检索高级设置扫参（施工单 M8-01 补）。
 *
 * # 为什么要有这个
 *
 * RAGFlow 的 Advanced settings（相似度下限、向量/关键词权重、候选池、返回条数）
 * 一直吃默认值，没人验证过默认值在**我们这批语料 + 我们这类问题**上是不是合适。
 * 凭感觉调检索阈值和不调没有区别——这个脚本给出可复现的量化依据。
 *
 * # 指标为什么是这四个
 *
 * | 指标 | 答的是什么 | 为什么不能只看它 |
 * |---|---|---|
 * | 命中率 | 正确文档出现在返回结果里了吗 | 文档对不等于段落对，撞上文件名也算命中 |
 * | MRR | 正确文档排在第几 | 只看第一条会漏掉"排第 2 也够用"的情形 |
 * | 关键词覆盖 | 召回的内容里有没有那几个关键数字 | **这才是"能不能答"的直接证据** |
 * | 噪声率 | 返回的块里有多少来自别的文档 | 全给高分把整库倒出来，前三个指标都会好看 |
 *
 * 最后一列是必须的：**只优化召回会奖励"什么都返回"**。
 *
 * 裁判用 DeepSeek v4-flash 直连。原打算用 RAGFlow 里的同一模型，
 * 但它的对话补全接口在 Cloud 上对**任何**助手都返回
 * `AttributeError('operator_permission')`（现成的 Car Rag Flow 也一样），
 * 是服务端问题，不是配置问题。
 *
 * 用法：
 *   corepack pnpm rag:eval           # 扫参 + 打分
 *   corepack pnpm rag:eval --judge   # 额外让 LLM 对最优档逐题判"能不能答"
 */

import { readFileSync } from "node:fs";

import { createRagClient, type RetrievalTuning } from "../../../enterprise/backend/shared/rag/src/index";
import { DEFAULT_DEEPSEEK_MODEL } from "../../../contracts/src/constants/index";
import { QUESTIONS, type EvalQuestion } from "./rag-eval-questions.mts";

function env(k: string): string {
  if (process.env[k]) return process.env[k] as string;
  try {
    for (const l of readFileSync(".env", "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(l.trim());
      if (m && m[1] === k) return m[2];
    }
  } catch { /* 无 .env */ }
  return "";
}

interface Combo extends RetrievalTuning {
  topK: number;
}

interface Score {
  hit: number;      // 命中率
  mrr: number;      // 平均倒数排名
  coverage: number; // 关键词覆盖
  noise: number;    // 噪声率
  chunks: number;   // 平均返回块数
  ms: number;       // 平均延迟
  errors: number;   // 抛错的题数
}

/** 综合分：覆盖率最重（它最接近"能不能答"），噪声扣分。 */
function overall(s: Score): number {
  return s.coverage * 0.45 + s.hit * 0.25 + s.mrr * 0.2 - s.noise * 0.1;
}

async function scoreCombo(
  client: ReturnType<typeof createRagClient>,
  combo: Combo,
): Promise<{ score: Score; perQuestion: Array<{ q: EvalQuestion; hitRank: number; covered: number; total: number }> }> {
  const rows: Array<{ q: EvalQuestion; hitRank: number; covered: number; total: number }> = [];
  let hit = 0, mrr = 0, coverage = 0, noise = 0, chunks = 0, ms = 0, errors = 0;

  for (const q of QUESTIONS) {
    const t0 = Date.now();
    let got: Awaited<ReturnType<typeof client.retrieve>> = [];
    // 重试一次再认输：偶发的网络抖动不该被读成"这档参数更差"。
    // **第一版把 catch 写成空块**，于是一次超时让 page_size=8 的命中率从
    // 90% 掉到 80%，看起来像"8 比 6 和 12 都差"——而检索其实是完全确定性的
    // （同一问同一参数连跑四次，相似度指纹逐位相同）。
    // **静默的失败会伪装成结论**，这正是这一轮一直在消灭的形态。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        got = await client.retrieve({
          dataset: q.dataset,
          query: q.query,
          agent: q.agent,
          vehicleModel: q.vehicleModel,
          topK: combo.topK,
          tuning: combo,
        });
        break;
      } catch (e) {
        if (attempt === 1) {
          errors += 1;
          console.error(`      ！${q.id} 检索失败：${String(e).slice(0, 90)}`);
        }
      }
    }
    ms += Date.now() - t0;
    chunks += got.length;

    const rank = got.findIndex((c) => q.expectDoc.test(c.source.document));
    if (rank >= 0) { hit += 1; mrr += 1 / (rank + 1); }

    const text = got.map((c) => c.content).join("\n");
    const covered = q.mustContain.filter((k) => text.includes(k)).length;
    coverage += covered / q.mustContain.length;

    const wrong = got.filter((c) => !q.expectDoc.test(c.source.document)).length;
    noise += got.length > 0 ? wrong / got.length : 0;

    rows.push({ q, hitRank: rank, covered, total: q.mustContain.length });
  }

  const n = QUESTIONS.length;
  return {
    score: { hit: hit / n, mrr: mrr / n, coverage: coverage / n, noise: noise / n, chunks: chunks / n, ms: ms / n, errors },
    perQuestion: rows,
  };
}

/** DeepSeek 裁判：只问"给定这些材料，能不能答上这个问题"。 */
async function judge(question: string, context: string): Promise<{ score: number; why: string }> {
  const key = env("DEEPSEEK_API_KEY");
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: DEFAULT_DEEPSEEK_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "你是检索质量裁判。只依据给出的材料判断，不要用材料以外的知识补全。" +
            "输出严格的 JSON：{\"score\":0|1|2,\"why\":\"一句话\"}。" +
            "2=材料足以直接回答；1=沾边但缺关键信息；0=答不了或答非所问。",
        },
        { role: "user", content: `问题：${question}\n\n材料：\n${context.slice(0, 12_000)}` },
      ],
    }),
  });
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = body.choices?.[0]?.message?.content ?? "";
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return { score: 0, why: "裁判没有返回可解析的 JSON" };
  try {
    const parsed = JSON.parse(m[0]) as { score?: number; why?: string };
    return { score: Number(parsed.score ?? 0), why: String(parsed.why ?? "") };
  } catch {
    return { score: 0, why: "裁判返回的 JSON 解析失败" };
  }
}

function bar(v: number): string {
  return "█".repeat(Math.round(v * 10)).padEnd(10, "·");
}

async function main(): Promise<void> {
  const client = createRagClient({
    baseUrl: env("RAGFLOW_BASE_URL"),
    apiKey: env("RAGFLOW_API_KEY"),
    datasetIds: {
      "vehicle-manuals": env("RAGFLOW_DATASET_VEHICLE_MANUALS"),
      "repair-kb": env("RAGFLOW_DATASET_REPAIR_KB"),
      "car-catalog": env("RAGFLOW_DATASET_CAR_CATALOG"),
    },
    timeoutMs: 60_000,
  });

  // 第一轮：相似度下限 × 向量权重（返回条数固定 6，候选池默认）。
  //
  // **区间必须先量再定**。第一版扫 0.0~0.3，二十个档分数一模一样——
  // 当时差点写成"这个参数不敏感"，实测本库的相似度分布是 **0.24~0.59**，
  // 整个扫描区间落在分布之下，等于没扫。分不动往往不是参数没用，
  // 是刻度不在量程上。
  const combos: Combo[] = [];
  for (const similarityThreshold of [0.20, 0.25, 0.30, 0.35, 0.40]) {
    for (const vectorSimilarityWeight of [0.0, 0.3, 0.5, 0.7, 1.0]) {
      combos.push({ similarityThreshold, vectorSimilarityWeight, topK: 6 });
    }
  }

  console.log(`评测集 ${QUESTIONS.length} 题，参数档 ${combos.length} 个\n`);
  console.log("阈值  向量权重  综合   覆盖        命中   MRR   噪声  块数  延迟   错");
  const results: Array<{ combo: Combo; score: Score }> = [];
  for (const combo of combos) {
    const { score } = await scoreCombo(client, combo);
    results.push({ combo, score });
    console.log(
      `${combo.similarityThreshold!.toFixed(2)}  ${combo.vectorSimilarityWeight!.toFixed(1)}     ` +
      `${overall(score).toFixed(3)}  ${bar(score.coverage)} ${(score.coverage * 100).toFixed(0).padStart(3)}%  ` +
      `${(score.hit * 100).toFixed(0).padStart(3)}%  ${score.mrr.toFixed(2)}  ` +
      `${(score.noise * 100).toFixed(0).padStart(3)}%  ${score.chunks.toFixed(1).padStart(4)}  ${Math.round(score.ms)}ms` +
      `  ${score.errors > 0 ? `**${score.errors}**` : " ·"}`,
    );
  }

  results.sort((a, b) => overall(b.score) - overall(a.score));
  const best = results[0];
  console.log(
    `\n最优：阈值 ${best.combo.similarityThreshold} ／ 向量权重 ${best.combo.vectorSimilarityWeight}` +
    `（综合 ${overall(best.score).toFixed(3)}）`,
  );

  // 第二轮：在最优档上扫返回条数。**分两轮而不是一次全排列**——
  // 返回条数与前两个参数几乎正交，全排列只是把 20 档变成 80 档。
  console.log("\n返回条数  综合   覆盖   命中   噪声  延迟");
  const byTopK: Array<{ combo: Combo; score: Score }> = [];
  for (const topK of [3, 5, 6, 8, 12]) {
    const combo: Combo = { ...best.combo, topK };
    const { score } = await scoreCombo(client, combo);
    byTopK.push({ combo, score });
    console.log(
      `${String(topK).padStart(6)}    ${overall(score).toFixed(3)}  ${(score.coverage * 100).toFixed(0).padStart(3)}%  ` +
      `${(score.hit * 100).toFixed(0).padStart(3)}%  ${(score.noise * 100).toFixed(0).padStart(3)}%  ${Math.round(score.ms)}ms`,
    );
  }
  byTopK.sort((a, b) => overall(b.score) - overall(a.score));
  const final = byTopK[0].combo;

  console.log(
    `\n══ 建议设置 ══\n` +
    `  similarity_threshold      ${final.similarityThreshold}\n` +
    `  vector_similarity_weight  ${final.vectorSimilarityWeight}\n` +
    `  page_size（返回条数）      ${final.topK}\n` +
    `  top_k（候选池）            ${final.candidatePoolSize ?? 1024}`,
  );

  // 逐题明细：**平均分掩盖单题失败**，哪一题答不了要点名。
  const { perQuestion } = await scoreCombo(client, final);
  console.log("\n逐题（最优档）");
  for (const r of perQuestion) {
    const mark = r.hitRank === 0 ? "✓" : r.hitRank > 0 ? `#${r.hitRank + 1}` : "✗";
    console.log(
      `  ${mark.padEnd(3)} ${r.q.id}  关键词 ${r.covered}/${r.total}  ${r.q.persona}  「${r.q.query}」`,
    );
  }

  if (!process.argv.includes("--judge")) {
    console.log("\n（加 --judge 让 DeepSeek 逐题判「能不能答」）");
    return;
  }

  console.log("\nLLM 裁判（DeepSeek，temperature=0）");
  let sum = 0;
  for (const q of QUESTIONS) {
    const got = await client.retrieve({
      dataset: q.dataset, query: q.query, agent: q.agent,
      vehicleModel: q.vehicleModel, topK: final.topK, tuning: final,
    });
    const ctx = got.map((c) => `【${c.source.document}】${c.content}`).join("\n\n");
    const v = await judge(q.query, ctx);
    sum += v.score;
    console.log(`  ${["✗", "△", "✓"][v.score] ?? "?"} ${q.id} ${v.score}/2  ${v.why.slice(0, 60)}`);
  }
  console.log(`\n裁判总分 ${sum}/${QUESTIONS.length * 2}（${((sum / (QUESTIONS.length * 2)) * 100).toFixed(0)}%）`);
}

void main();
