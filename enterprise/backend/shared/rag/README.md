# @carlife/rag

RAGFlow 客户端与三数据集隔离（`src/datasets.ts`，按消费方分、调用层强制）。数据集归属、切片纪律、
运维命令见内部开发指引「RAG 永远是双路」一节；本文只放**实测数字**——那些不在代码里、
改设计前要先看一眼的东西。

## 实测：DashScope 多模态向量（ACR-025 第 1 步，2026-09-08）

图标图文索引（ACR-025）建表前先探接口。
脚本 `scripts/dev/probe/icon-embedding-probe.mts`（`corepack pnpm probe:icon-embedding <图A> <图B> "<文A>" "<文B>"`），
样本是 `tesla-01` 上裁下的安全带与近光两个 crop，文本是观察层的规范化描述子。

| 模型 | 接口 | 维度 | 单图耗时 | 单图 token | cos(安全带图, 安全带文) | cos(安全带图, 近光文) | cos(近光图, 近光文) | cos(近光图, 安全带文) | cos(安全带图, 近光图) |
|---|---|---|---|---|---|---|---|---|---|
| `qwen3-vl-embedding` | `POST /api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`，`input.contents[{image}|{text}]` | **2560** | 313–558 ms | 16–20 | **0.360** | 0.091 | **0.476** | 0.147 | 0.310 |
| `tongyi-embedding-vision-flash-2026-03-06` | 同上 | 768 | 127–157 ms | 402 | 0.167 | 0.027 | 0.221 | 0.123 | 0.434 |

读法：

- **图文同空间成立**：同一符号的图与文的相似度是错配的 3–4 倍（0.360 vs 0.091、0.476 vs 0.147），双路召回（图像路 ∪ 文本路）有依据。
- **绝对值不高**（0.36 / 0.48），所以闸门阈值 τ 不能照搬文本检索的经验值；初值 τ=0.30。
- **边际 δ 量相似度差**（top-1 与 top-2 的最高相似度之差），初值 0.03。不能量 RRF 融合分差——两名之差只有 1/61 − 1/62 ≈ 0.0003，
  第一版就是这么错的，tesla-01 四个符号全被拦。`--match` 在 ≥30 张 + 负样本上标定后改 `icon-verify.ts` 并同步这里。

## 实测：图标匹配（`eval:vision-observe -- --match`，2026-09-08，tesla-01，目录只有文本向量）

| 真值符号 | 图像路 top-1（相似度） | 文本路 top-1（相似度） | 边际 | 判 |
|---|---|---|---|---|
| auto_high_beam_standby | auto_high_beam_standby 0.49（次 0.35） | 同 0.92（次 0.80） | 0.14 | 过闸门，正确 |
| seatbelt_unfastened | seatbelt_unfastened | 同 | 见 `evals/runs/vision-observe-match-tesla-01.json` | 过闸门，正确 |
| low_beam | low_beam 0.49 / parking_lights 0.49 | parking_lights 0.96 / low_beam 0.96 | ≈0 | **该拦**：目录里两者描述子同形「绿色 灯形 直线」 |
| fog_lamp_front | low_beam 0.51 / fog_lamp_front 0.50 | fog_lamp_front 0.89 | ≈0.01 | **该拦**：同上，词表分不出「线朝下」与「波浪线在前」的差别 |

读法：hit@3 4/4、hit@1 3/4；闸门通过且正确 2/4、**误接受 0**——被拦的两个都是目录描述子同形，不是索引的错。
去向：词表加能区分灯组朝向 / 双灯并排的元素（M71 之后），或拿到手册图标图片后走图像向量与成对核验。
- `qwen3-vl-embedding` 的分离度明显好于 flash 档（flash 的图-图相似 0.434 反而高于图-文，说明它的空间偏图像侧）；采用前者，flash 不作批量入库替代。
- **维度 2560 超过 pgvector `ivfflat` / `hnsw` 的 2000 维索引上限**：几十到几千条图标用顺序扫描即可（毫秒级），不建 ANN 索引；真要建，用 `halfvec(2560)`（hnsw 上限 4000）。表定义 `embedding vector(2560)`。
- 融合向量（`enable_fusion`）本次没测：双路召回用独立向量就够，融合留给「图 + 一句话」的场景（异响定位）再评。

前置：`DASHSCOPE_API_KEY`（`.env` 里未 `export`，跑前 `set -a; source .env; set +a`）。
