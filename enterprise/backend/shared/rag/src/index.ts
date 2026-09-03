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
  type MineruConfig,
  type MineruJob,
  type MineruResult,
  type MineruResultWithZip,
} from "./mineru";

export {
  prepareMarkdownForChunking,
  splitLongText,
  estimateTokens,
  tableToText,
  type ChunkPrepOptions,
} from "./chunk-prep";
