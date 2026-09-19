/**
 * codebook 载入与锁版校验（施工单 M82-04）。
 *
 * # 版本 = 文件 hash
 *
 * `research_codebooks.hash` 存 YAML 的 sha256。没锁版时改文件只是更新那一行；
 * **锁版之后文件被改 → 启动直接拒绝**。
 *
 * 为什么这么硬：codebook 是口径本身。锁版之后改一个码的定义，
 * 锁版前后的所有数字就换了含义——而图上看不出任何区别，
 * 一致率也不会掉（两批各自内部仍然一致）。这类错误没有任何自然现象，
 * 只能靠一次启动期的 hash 比对拦住。
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

export interface CodebookCode {
  id: string;
  label: string;
  definition: string;
  include: string;
  exclude: string;
  examples: string[];
  counter_examples: string[];
}

export interface CodebookAxis {
  id: string;
  label: string;
  cardinality: "single" | "multi";
  /** 多选轴的上限；单选轴无。 */
  max?: number;
  /** 这一轴是否附带 0–3 的强度（只有 `emotion`）。 */
  intensity?: boolean;
  codes: CodebookCode[];
}

export interface Codebook {
  version: string;
  hash: string;
  filePath: string;
  axes: CodebookAxis[];
}

export class CodebookLockedMismatchError extends Error {
  constructor(version: string, storedHash: string, fileHash: string) {
    super(
      `codebook_locked_mismatch: ${version} 已锁版，但文件内容变了` +
        `（库里 ${storedHash.slice(0, 12)}…，文件 ${fileHash.slice(0, 12)}…）。` +
        "锁过的码表只增不改——要改概念请开下一版，否则锁版前后的数字含义不同而图上看不出来",
    );
  }
}

export function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 每个码都必须有的字段。缺 exclude 的码会慢慢吸走整个语料。 */
function validateAxis(axis: CodebookAxis, version: string): void {
  if (!axis.id || !axis.codes?.length) throw new Error(`codebook_invalid: ${version} 的轴 ${axis.id} 没有码`);
  const ids = new Set<string>();
  for (const c of axis.codes) {
    if (ids.has(c.id)) throw new Error(`codebook_invalid: ${version} 的 ${axis.id} 轴有重复码 ${c.id}`);
    ids.add(c.id);
    for (const field of ["definition", "include", "exclude"] as const) {
      if (!c[field] || String(c[field]).trim() === "") {
        throw new Error(`codebook_invalid: ${version} 的 ${axis.id}/${c.id} 缺 ${field}`);
      }
    }
    if (!Array.isArray(c.examples) || c.examples.length < 2) {
      throw new Error(`codebook_invalid: ${version} 的 ${axis.id}/${c.id} 至少要两个 examples`);
    }
    if (!Array.isArray(c.counter_examples) || c.counter_examples.length < 1) {
      throw new Error(`codebook_invalid: ${version} 的 ${axis.id}/${c.id} 至少要一个 counter_examples`);
    }
  }
  if (axis.cardinality === "multi" && !(typeof axis.max === "number" && axis.max > 0)) {
    throw new Error(`codebook_invalid: ${version} 的多选轴 ${axis.id} 必须声明 max`);
  }
}

export function parseCodebook(text: string, filePath: string): Codebook {
  const raw = parseYaml(text) as { version?: string; axes?: CodebookAxis[] };
  if (!raw?.version) throw new Error(`codebook_invalid: ${filePath} 没有 version`);
  if (!Array.isArray(raw.axes) || raw.axes.length === 0) throw new Error(`codebook_invalid: ${filePath} 没有 axes`);
  for (const a of raw.axes) validateAxis(a, raw.version);
  return { version: raw.version, hash: hashOf(text), filePath, axes: raw.axes };
}

export function loadCodebookFile(filePath: string): Codebook {
  return parseCodebook(readFileSync(filePath, "utf8"), filePath);
}

/** 目录里版本号最大的那一份。**不看文件名排序**，看解析出来的 version。 */
export function loadLatestCodebook(dir: string): Codebook {
  const files = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
  if (files.length === 0) throw new Error(`codebook_missing: ${dir} 下没有 YAML`);
  const books = files.map((f) => loadCodebookFile(join(dir, f)));
  books.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  return books[books.length - 1];
}

export interface StoredCodebook {
  version: string;
  hash: string;
  lockedAt: Date | null;
}

/**
 * 与库里那一行对账。**锁过版且 hash 不同就抛**——调用方（`index.ts`）
 * 不捕获它，进程直接起不来：带着一份与库里不一致的口径继续跑，
 * 产出的每个数字都不知道是按哪一版编的。
 */
export function assertCodebookConsistent(book: Codebook, stored: StoredCodebook | null): void {
  if (!stored?.lockedAt) return;
  if (stored.hash !== book.hash) throw new CodebookLockedMismatchError(book.version, stored.hash, book.hash);
}
