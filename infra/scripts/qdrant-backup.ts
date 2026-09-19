/**
 * Qdrant 快照备份 / 恢复 / 恢复演练（ACR-030 的收尾债：图向量卷不在 `pg_dump` 覆盖内）。
 *
 * # 这个脚本存在的理由
 *
 * 图搜图的向量搬到 Qdrant 之后，`manual_figures` 表暂时留作回滚位——卷坏了可以
 * `kb:figures --store qdrant --from-pgvector` 两秒重建。**但那张表迟早要删**，
 * 删掉之后重建就得从 PDF 重新走一遍 MinerU 与 1534 次 embedding 调用（要钱、要小时）。
 *
 * 所以在删表之前必须先有一条不依赖 pgvector 的备份路径。这个脚本就是那条路径。
 *
 * # 为什么用 Qdrant 的快照 API，不是 `docker cp` 整个卷
 *
 * 直接拷 `/qdrant/storage` 会拷到一个**正在被写的**目录：段文件与 WAL 之间没有一致性点，
 * 拷出来的东西能不能恢复只有恢复的时候才知道——而那时已经来不及了。
 * 快照 API 在服务端先取一致性点再打包，是官方唯一保证可恢复的方式。
 *
 * 代价是快照**先落在容器的存储卷里**（即它要备份的那个卷），所以本脚本下载完就把
 * 服务端那份删掉——否则备份会把自己撑爆磁盘，而且卷坏的时候两份一起没。
 *
 * # 用法
 *
 *   corepack pnpm tsx infra/scripts/qdrant-backup.ts backup          # 备份全部 collection
 *   corepack pnpm tsx infra/scripts/qdrant-backup.ts backup --keep 7 # 只保留最近 7 份
 *   corepack pnpm tsx infra/scripts/qdrant-backup.ts restore <文件>   # 从快照恢复
 *   corepack pnpm tsx infra/scripts/qdrant-backup.ts drill           # 恢复演练（会真的删 collection）
 *
 * 环境：`QDRANT_URL`（缺省 http://127.0.0.1:6333）、`QDRANT_API_KEY`（本机开发档不设）、
 * `CARLIFE_QDRANT_BACKUP_DIR`（缺省 data/backups/qdrant）。
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const URL_BASE = (process.env.QDRANT_URL ?? "http://127.0.0.1:6333").replace(/\/+$/, "");
const API_KEY = process.env.QDRANT_API_KEY;
const OUT_DIR = resolve(process.env.CARLIFE_QDRANT_BACKUP_DIR ?? "data/backups/qdrant");

const headers = (): Record<string, string> => (API_KEY ? { "api-key": API_KEY } : {});

async function api<T>(method: string, path: string): Promise<T> {
  const res = await fetch(`${URL_BASE}${path}`, { method, headers: headers() });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()).result as T;
}

/**
 * 同一个 collection 的旧备份按文件名里的时间戳排序，保留最近 `keep` 份，返回该删的。
 * 单独抽出来是因为"删备份"是唯一一处会造成不可逆损失的逻辑，要能单测。
 */
export function prunable(files: readonly string[], collection: string, keep: number): string[] {
  if (keep <= 0) return [];
  const mine = files.filter((f) => f.startsWith(`${collection}-`) && f.endsWith(".snapshot")).sort();
  return mine.slice(0, Math.max(0, mine.length - keep));
}

/** 文件名带 collection 与 UTC 时间戳，排序即时序；冒号会在部分文件系统上出问题，去掉。 */
export function snapshotFileName(collection: string, at: Date): string {
  return `${collection}-${at.toISOString().replace(/[:.]/g, "-")}.snapshot`;
}

interface CollectionInfo { points_count: number; status: string }

async function collections(): Promise<string[]> {
  const r = await api<{ collections: Array<{ name: string }> }>("GET", "/collections");
  return r.collections.map((c) => c.name);
}

async function pointsOf(name: string): Promise<number> {
  const info = await api<CollectionInfo>("GET", `/collections/${name}`);
  return info.points_count;
}

/** 备份一个 collection：服务端打快照 → 下载到本地 → 删掉服务端那份。返回本地路径与字节数。 */
async function backupOne(name: string, keep: number): Promise<{ path: string; bytes: number; ms: number }> {
  const t0 = performance.now();
  const snap = await api<{ name: string }>("POST", `/collections/${name}/snapshots`);
  await mkdir(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, snapshotFileName(name, new Date()));
  try {
    const res = await fetch(`${URL_BASE}/collections/${name}/snapshots/${snap.name}`, { headers: headers() });
    if (!res.ok || !res.body) throw new Error(`下载快照失败：${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(out));
  } finally {
    // 服务端那份一定要删——它就落在要备份的那个卷里，留着既占地方又毫无冗余意义。
    await api("DELETE", `/collections/${name}/snapshots/${snap.name}`).catch(() => undefined);
  }
  const bytes = (await stat(out)).size;
  for (const old of prunable(await readdir(OUT_DIR), name, keep)) {
    if (join(OUT_DIR, old) !== out) await unlink(join(OUT_DIR, old));
  }
  return { path: out, bytes, ms: performance.now() - t0 };
}

/** 从本地快照恢复。collection 不存在时会被快照重建，所以恢复前不需要先建。 */
async function restoreOne(file: string, collection: string): Promise<number> {
  const t0 = performance.now();
  const form = new FormData();
  form.append("snapshot", new Blob([await readFile(file)]), basename(file));
  const res = await fetch(`${URL_BASE}/collections/${collection}/snapshots/upload?priority=snapshot`, {
    method: "POST", headers: headers(), body: form,
  });
  if (!res.ok) throw new Error(`恢复失败：${res.status} ${await res.text()}`);
  return performance.now() - t0;
}

/** 从文件名反推 collection：`<name>-<ISO 时间戳>.snapshot`。 */
export function collectionFromFile(file: string): string {
  const m = /^(.+)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.snapshot$/.exec(basename(file));
  if (!m) throw new Error(`文件名不像本脚本产出的快照：${basename(file)}（形如 manual_figures-2026-09-12T...Z.snapshot）`);
  return m[1];
}

const MB = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MB`;

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) failures += 1;
};

async function drill(): Promise<void> {
  console.log("Qdrant 恢复演练——会真的删掉 collection 再恢复\n");
  const names = await collections();
  if (!names.length) throw new Error("一个 collection 都没有，没什么可演练的");
  const name = names[0];

  const before = await pointsOf(name);
  check(before > 0, `演练对象 ${name}，当前 ${before} 个 point`);

  const b = await backupOne(name, 0);
  check(b.bytes > 0, `备份完成（${MB(b.bytes)}，${b.ms.toFixed(0)}ms）→ ${b.path}`);

  await api("DELETE", `/collections/${name}`);
  // 这一步不能省：跳过"确认真的没了"就直接恢复，等于把"备份有效"和"数据根本没被删掉"混为一谈。
  const gone = !(await collections()).includes(name);
  check(gone, "删除后确实查不到了——证明下一步恢复的是真数据，不是没删干净");

  const ms = await restoreOne(b.path, name);
  const after = await pointsOf(name);
  check(after === before, `恢复后 point 数与备份前一致（${after} / ${before}，${ms.toFixed(0)}ms）`);

  await unlink(b.path).catch(() => undefined);
  console.log(`\n恢复演练：${4 - failures} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const keepAt = rest.indexOf("--keep");
  const keep = keepAt >= 0 ? Number(rest[keepAt + 1]) : 7;

  if (cmd === "drill") return drill();

  if (cmd === "restore") {
    const file = rest.find((a) => !a.startsWith("--"));
    if (!file) throw new Error("要给快照文件路径");
    const at = rest.indexOf("--collection");
    const name = at >= 0 ? rest[at + 1] : collectionFromFile(file);
    const ms = await restoreOne(file, name);
    console.log(`✓ ${name} 已从 ${basename(file)} 恢复（${ms.toFixed(0)}ms），现有 ${await pointsOf(name)} 个 point`);
    return;
  }

  if (cmd && cmd !== "backup") throw new Error(`不认识的子命令 ${cmd}（backup / restore / drill）`);

  const names = await collections();
  if (!names.length) {
    console.log("Qdrant 里一个 collection 都没有，没有可备份的东西");
    return;
  }
  for (const name of names) {
    const points = await pointsOf(name);
    const r = await backupOne(name, keep);
    console.log(`✓ ${name}（${points} 个 point）→ ${r.path}（${MB(r.bytes)}，${r.ms.toFixed(0)}ms，保留最近 ${keep} 份）`);
  }
}

if (process.argv[1]?.endsWith("qdrant-backup.ts")) {
  main().catch((e) => {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
