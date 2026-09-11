// @carlife/rag —— RAGFlow Cloud 客户端封装（§6）。本仓不自建向量库。
export { DATASETS, datasetFor, datasetsForAgent, type DatasetDef, type DatasetKey } from "./datasets";
export {
  createRagClient,
  DatasetAccessError,
  NoDocumentsForModelError,
  documentMatchesModel,
  chunkMethodFor,
  type RagClient,
  type RagflowConfig,
  type RetrieveArgs,
  type RetrievedChunk,
  suspiciousChunks,
  longestUnterminatedRun,
  looksTabular,
  looksLikeToc,
  UNTERMINATED_RUN_THRESHOLD,
  tableDataRowCount,
  hasTableHeader,
  looksFlattenedTable,
  CHUNK_TOKEN_NUM,
  CHUNK_DELIMITER,
  summarizeRetrievalTest,
  type ChunkPreview,
  type DocumentStatus,
  type ParseStatus,
  type RetrievalTestResult,
} from "./client";

export {
  coverageOf,
  invisibleDocuments,
  fetchModelCoverage,
  type CoverageIndex,
  type CoverageLink,
  type DocumentsByDataset,
  type FetchedCoverage,
} from "./coverage";

export {
  convertPdfs,
  cleanMineruMarkdown,
  figurePlaceholder,
  parseContentList,
  FIGURE_PLACEHOLDER_RE,
  type CleanMineruOptions,
  type MineruConfig,
  type MineruJob,
  type MineruResult,
  type MineruResultWithZip,
} from "./mineru";

export {
  prepareMarkdownForChunking,
  resolveFigurePlaceholders,
  splitLongText,
  estimateTokens,
  tableToText,
  type ChunkPrepOptions,
} from "./chunk-prep";

// 图标图文索引（M71-03，ACR-025）：目录解析 / 向量化与双路召回 / 闸门与成对核验。向量只召回不裁决。
export { parseIconCatalog, normalizeDescriptor, severityFor, type IconCatalogEntry, type IconDescriptor, type IconClass, type IconSeverity } from "./icon-catalog";
export { ALERT_CATALOG_FILE, loadAlertCatalog } from "./alert-catalog";
export type { AlertCatalog, AlertCatalogEntry } from "./alert-catalog";
export {
  createDashScopeEmbedder,
  buildIconIndex,
  recallCandidates,
  fuseByRrf,
  IconEmbedError,
  DASHSCOPE_EMBED_URL,
  DEFAULT_EMBED_MODEL,
  RRF_K,
  type Embedder,
  type IconStore,
  type IconStoreRow,
  type Candidate,
  type BuildIndexResult,
  type RecallArgs,
} from "./icon-index";
export { createIconImageResolver, type IconImageResolver, type IconImageResolverOptions } from "./icon-images";
export { gate, decideMatch, DEFAULT_TAU, DEFAULT_DELTA, type GateOptions, type GateResult, type MatchResult, type MatchDeps, type IconSemantics } from "./icon-verify";

// 手册图 → 段落锚定（ACR-029）：MinerU 块表进、带锚段与出处的图列表出，纯函数。
export { anchorFigures, anchorStats, cleanBlockText, columnSplits, figureText } from "./figures";
export type { AnchorOptions, AnchorRule, FigureAnchor, ManualFigure, MineruBlock } from "./figures";
export { buildFigureIndex, recallFigures } from "./figure-index";
export type { BuildFigureIndexOptions, BuildFigureIndexResult, FigureHit, FigureObserver, FigureStore, FigureStoreRow, RecallFiguresArgs } from "./figure-index";
