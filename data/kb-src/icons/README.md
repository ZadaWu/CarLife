# 手册图标目录（M71-03，ACR-025）

一个车型一份 `<车型>-indicators.md`，表格是文本路的真相源；图标图片放同名目录 `<车型>/`（`symbol_id.png`）。

- 解析与规范化在 `@carlife/rag` 的 `icon-catalog.ts`（`parseIconCatalog` 校验 class / severity 与「类别 × 颜色」表一致）。
- 建索引：`corepack pnpm kb:icons data/kb-src/icons/tesla-model3-indicators.md`（文本向量必建，有图片再加图像向量）。
- 进 RAGFlow 的文本路：`corepack pnpm kb:replace vehicle-manuals data/kb-src/icons/tesla-model3-indicators.md`（要 `RAGFLOW_*` 凭据）。

| 目录 | 条目 | 描述子来源 | 图片 | 整理日期 |
|---|---|---|---|---|
| `tesla-model3-indicators.md` | 27 | standard-symbol（未对图） | 0 / 27 | 2026-09-08 |

**如实说明**：描述子按 ISO 2575 通用符号与特斯拉屏幕常见画法起草，还没有逐条对着手册图标图片核对；
仓库没有手册 PDF，特斯拉在线手册对脚本抓取 403。拿到 PDF 后用 `pdftocairo -r 300` 渲染指示灯页裁图，
填「图片」列并把来源改成 `manual-image`——这一步是 Sprint M71 判定 4 的人工准备。
