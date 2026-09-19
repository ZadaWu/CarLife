#!/usr/bin/env node
/**
 * 多会话共用索引下「只提交自己的路径」（施工单 M97-02）。
 *
 * # 为什么需要它
 *
 * 这个仓库常有多个 Claude 会话同时在同一个 worktree 上工作，它们**共用一个 git 索引**。
 * `git commit` 不带 pathspec 时提交整个索引——两个会话之间谁先 commit，谁就把对方刚暂存的文件一并带走。
 * 2026-09-16 一天互卷三次：一次我把别人两个 M94 文件卷进提交（reset 重做）；一次别人把我暂存的三个
 * M95-02 文件卷进 3493d3d0；M95 收口时"把别人的挪开、提交、再放回"的做法两次静默没落，还把别人的
 * 哈希当成自己的回填进验收表头。"逐文件 git add"只防得住第一种，防不住后两种。
 *
 * # 做法：不碰共用索引
 *
 *   1. 先跑 `.husky/pre-commit`（`commit-tree` 不触发钩子，这里补上；失败即停）；
 *   2. `GIT_INDEX_FILE` 指向临时索引，`read-tree HEAD`；
 *   3. 只把自己的路径 `hash-object -w` 后 `update-index --cacheinfo` 放进临时索引
 *      （模式照 `git add` 的口径按磁盘执行位取 `100755`/`100644`，见 `modeOf`）
 *      （`.jsonl` 台账按主键合并：HEAD 的行 + 工作区里指定 id 的行，别人新增的行不带；
 *      主键字段名见 `JSONL_ID_FIELDS`——本仓 `entity_id` / `id` / `unitId` 三种都有）；
 *   4. `write-tree` → `commit-tree -p HEAD` → `update-ref HEAD <new> <base>`：
 *      **带旧值校验**，HEAD 在这期间被别的会话推进就整段重来，永远不会把别人的提交覆盖掉。
 *
 * 共用索引在提交前不读不写；提交成功后只把**自己路径**的索引项对齐到已提交的 blob，且仅当该项
 * 还是 HEAD 原值（或不存在）时才动——别人暂存了同一路径的另一版本就留着不碰。不对齐的话，
 * `git status` 会把自己刚提交的文件显示成"待提交的回退"，下一个不带 pathspec 的 commit 会真的把它退回去。
 *
 * 用法：
 *   node scripts/dev/git/commit-own.mjs -F <msg-file> [--jsonl <path>:<id>[,<id>…]]… \
 *        [--hook <path> | --no-hook] [--retries 3] <path>[=<content-file>]…
 *   `<path>=<content-file>` 表示提交的内容取自另一个文件（按 HEAD 重放过的版本），不取工作区。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 参数与返回都只是字符串，方便用例注入一层包装（比如在 update-ref 之前推进 HEAD）。 */
export function gitRunner(cwd) {
  return (args, env = {}) =>
    execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * 台账主键的候选字段，按优先级取第一个存在的字符串字段。
 *
 * 本仓的 `.jsonl` 台账有三种主键写法，字段名不统一：建模 catalog 一族是 `entity_id`，
 * 事故与需求台账（`内部文档`、`内部文档`、
 * `evals/<集>/cases.jsonl`）是 `id`，研究编码的 gold 是 `unitId`。
 * 只认 `entity_id` 的后果是**这条防互卷的路径对后两类完全用不上**——它们只能整份提交，
 * 别的会话同期加的行会被一并带走，而 `--jsonl` 本来就是为了防这个（INC-0165）。
 */
const JSONL_ID_FIELDS = ["entity_id", "id", "unitId"];

/**
 * 一行的主键。不是 JSON 对象的行返回 `null`——`evals/risk/cases.jsonl` 一类台账开头有
 * `//` 注释行，它们只按 HEAD 原序保留，永不参与匹配（早先在这里直接 `JSON.parse` 会抛）。
 */
function rowId(line) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (row === null || typeof row !== "object") return null;
  for (const field of JSONL_ID_FIELDS) if (typeof row[field] === "string") return row[field];
  return null;
}

/** HEAD 台账 + 工作区里指定主键的行；HEAD 行保序，指定 id 的行原位替换或追加。 */
export function mergeJsonlRows(headText, workText, ids) {
  const rows = (t) => t.split("\n").filter((l) => l.trim() !== "");
  const wanted = new Set(ids);
  const picked = new Map();
  for (const l of rows(workText)) {
    const id = rowId(l);
    if (id !== null && wanted.has(id)) picked.set(id, l);
  }
  const missing = [...wanted].filter((i) => !picked.has(i));
  if (missing.length > 0) {
    throw new Error(`工作区台账里找不到：${missing.join(", ")}（主键只认 ${JSONL_ID_FIELDS.join(" / ")}）`);
  }
  const out = [];
  const seen = new Set();
  for (const l of rows(headText)) {
    const id = rowId(l);
    if (id !== null && picked.has(id)) { out.push(picked.get(id)); seen.add(id); } else out.push(l);
  }
  for (const [id, l] of picked) if (!seen.has(id)) out.push(l);
  return out.join("\n") + "\n";
}

/**
 * 文件模式按 `git add` 的口径定：磁盘上有任一执行位就是 `100755`，否则 `100644`。
 *
 * 写死 `100644` 的后果是**无症状的**——内容照常提交、diff 只显示一行 `mode change`，
 * 没人看；直到有人 `./infra/scripts/dev.sh` 才 Permission denied。
 * 2026-09-17 `dev.sh` 就是这么从 755 降成 644 的（INC-0164）。
 * 内容取自 `contentFile` 时模式仍看目标路径——模式是路径的属性，不是那份内容的。
 */
function modeOf(cwd, path) {
  try {
    return statSync(join(cwd, path)).mode & 0o111 ? "100755" : "100644";
  } catch {
    return "100644";
  }
}

/**
 * 提交成功后对齐共用索引里自己的路径：索引项等于 base 的 blob（或没有这一项）才改成已提交的 blob；
 * 别人暂存了别的版本就跳过并提示。这是唯一一处写共用索引的地方。
 */
function syncSharedIndex(git, base, entries) {
  for (const [path, blob, mode] of entries) {
    const staged = git(["ls-files", "-s", "--", path]).split(/\s+/)[1] ?? null;
    let inBase = null;
    try { inBase = git(["rev-parse", "-q", "--verify", `${base}:${path}`]); } catch { inBase = null; }
    if (staged !== null && staged !== inBase) {
      console.warn(`⚠ 共用索引里 ${path} 是别人暂存的另一版本，未对齐`);
      continue;
    }
    git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`]);
  }
}

function runHook(cwd, hook) {
  if (hook === null) {
    console.warn("⚠ --no-hook：跳过了 pre-commit 钩子（check:secrets / check:env-example 没跑）");
    return;
  }
  const r = spawnSync("sh", [hook], { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`pre-commit 钩子失败（${hook}），不提交`);
}

/**
 * @param {object} o
 * @param {string} o.cwd 仓库根
 * @param {string} o.messageFile 提交信息文件
 * @param {Array<{path:string, contentFile?:string}>} o.paths 要提交的路径
 * @param {Array<{path:string, ids:string[]}>} [o.jsonl] 按 entity_id 合并的台账
 * @param {string|null} [o.hook] 钩子路径；null = 显式跳过
 * @param {number} [o.retries]
 * @param {(args:string[], env?:Record<string,string>)=>string} [o.git] 注入的 git 执行器
 */
export function commitOwn(o) {
  const git = o.git ?? gitRunner(o.cwd);
  const retries = o.retries ?? 3;
  const tmp = mkdtempSync(join(tmpdir(), "commit-own-"));
  const idx = join(tmp, "index");
  const env = { GIT_INDEX_FILE: idx };
  try {
    runHook(o.cwd, o.hook === undefined ? ".husky/pre-commit" : o.hook);
    const blobs = [];
    for (const { path, contentFile } of o.paths) {
      blobs.push([path, git(["hash-object", "-w", contentFile ?? path]), modeOf(o.cwd, path)]);
    }
    for (let attempt = 1; attempt <= retries; attempt++) {
      const base = git(["rev-parse", "HEAD"]);
      rmSync(idx, { force: true });
      git(["read-tree", base], env);
      const entries = [...blobs];
      for (const { path, ids } of o.jsonl ?? []) {
        const head = git(["show", `${base}:${path}`]);
        const merged = mergeJsonlRows(head + "\n", readFileSync(join(o.cwd, path), "utf8"), ids);
        const f = join(tmp, "merged.jsonl");
        writeFileSync(f, merged);
        entries.push([path, git(["hash-object", "-w", f]), modeOf(o.cwd, path)]);
      }
      for (const [path, blob, mode] of entries) git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], env);
      const tree = git(["write-tree"], env);
      const commit = git(["commit-tree", tree, "-p", base, "-F", o.messageFile]);
      const subject = readFileSync(o.messageFile, "utf8").split("\n")[0];
      const r = spawnSync("git", ["update-ref", "-m", `commit-own: ${subject}`, "HEAD", commit, base], { cwd: o.cwd, encoding: "utf8" });
      if (r.status === 0) {
        syncSharedIndex(git, base, entries);
        console.log(`committed ${commit.slice(0, 8)} on ${base.slice(0, 8)} (${entries.length} 文件)`);
        return commit;
      }
      console.warn(`HEAD 已被推进（${base.slice(0, 8)} → ${git(["rev-parse", "HEAD"]).slice(0, 8)}），重试 ${attempt}`);
    }
    throw new Error(`${retries} 次都撞上别的会话的提交，放弃`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const o = { paths: [], jsonl: [], hook: undefined, retries: 3, messageFile: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue; // `pnpm run x -- args` 会把 `--` 原样传进来
    if (a === "-F") o.messageFile = argv[++i];
    else if (a === "--jsonl") {
      const [path, ids] = argv[++i].split(":");
      o.jsonl.push({ path, ids: ids.split(",").filter(Boolean) });
    } else if (a === "--hook") o.hook = argv[++i];
    else if (a === "--no-hook") o.hook = null;
    else if (a === "--retries") o.retries = Number(argv[++i]);
    else {
      const [path, contentFile] = a.split("=");
      o.paths.push(contentFile ? { path, contentFile } : { path });
    }
  }
  if (!o.messageFile || (o.paths.length === 0 && o.jsonl.length === 0)) {
    throw new Error("用法：commit-own.mjs -F <msg-file> [--jsonl <path>:<id>,…] [--hook <p>|--no-hook] <path>[=<content-file>]…");
  }
  return o;
}

if (process.argv[1] && process.argv[1].endsWith("commit-own.mjs")) {
  try {
    commitOwn({ cwd: process.cwd(), ...parseArgs(process.argv.slice(2)) });
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
  }
}
