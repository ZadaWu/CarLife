/**
 * 用 MinerU 把 PDF 转成 markdown（施工单 M8-01 补）。
 *
 * # 为什么不直接把 PDF 传给 RAGFlow
 *
 * RAGFlow 云端唯一可用的解析器 DeepDOC **解决不了多栏**——三栏手册被按行横着串读，
 * 每行通顺、关键词也在，所以检索照样命中照样给出处，只是拼起来讲的不是一件事。
 * 下拉框里的 MinerU / Docling 云端并未部署（实测 `not found`），所以走官方 API。
 *
 * # 产物落盘缓存
 *
 * 一本 192 页手册要几分钟、且**按量计费**。转换结果写到 `data/kb-md/`，
 * 重跑时已存在就跳过——重复转换既慢又花钱，而内容是不会变的。
 * 要强制重转就删掉那个文件。
 *
 * # 超过 200 页自动拆分
 *
 * MinerU 单份上限 200 页，三本特斯拉车主手册（268~326 页）会被直接拒。
 * 这是它的常驻限制，不是一次性障碍——所以拆分做在脚本里，
 * 不靠"这次手工拆一下"：下一本大手册照样会撞上，而那时没人记得该怎么拆。
 *
 * 拆分靠 poppler 的 `pdftocairo`（原件是加密 PDF，详见 splitPdf），拼接在 markdown 层做。
 * **各段之间不做去重也不做接缝修补**——那需要判断"这两段算不算同一句"，
 * 判错了就是悄悄改内容。留一道明显的分段标记，人一眼能看出来在哪拼的。
 *
 * 用法：
 *   corepack pnpm kb:convert <PDF 路径...>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

import { convertPdfs, cleanMineruMarkdown, type MineruResultWithZip } from "../../../enterprise/backend/shared/rag/src/mineru";

const OUT_DIR = "data/kb-md";

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

/** 输出文件名：原名 + 内容哈希前 8 位。**改了 PDF 就会换名**，不会悄悄用旧产物。 */
function outPath(path: string, bytes: Buffer): string {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return join(OUT_DIR, `${basename(path, ".pdf")}.${hash}.md`);
}

/** MinerU 单份上限。留出余量：整页扫描件偶尔会被它多算一页。 */
const MAX_PAGES = 200;
const PART_PAGES = 180;

function pageCount(path: string): number {
  const out = execFileSync("pdfinfo", [path], { encoding: "utf8" });
  const m = /^Pages:\s+(\d+)$/m.exec(out);
  if (!m) throw new Error(`pdfinfo 读不出页数：${path}`);
  return Number(m[1]);
}

/**
 * 把 PDF 切成每段 ≤ `PART_PAGES` 页，返回各段的字节。
 *
 * 用 `pdftocairo -pdf -f -l` 而不是 `pdfseparate` + `pdfunite`：
 * **三份特斯拉手册是加密的**（AES-256，`print:yes copy:yes change:no`），
 * pdfunite 直接拒绝合并加密页（`Could not merge encrypted files`）。
 * pdftocairo 重写出的是未加密 PDF，且**文字层逐字保留**（已用 pdftotext 逐页比对）。
 * 文档本身允许 copy，提取内容不越权——被禁的是 change 与 addNotes。
 *
 * 页数**均分**而不是"前 180 页 + 剩下的"——后者会让最后一段只有几页，
 * 而 MinerU 的排队时间与页数关系不大，一段几页纯属白等一轮。
 */
function splitPdf(path: string, total: number): Buffer[] {
  const parts = Math.ceil(total / PART_PAGES);
  const per = Math.ceil(total / parts);
  const dir = mkdtempSync(join(tmpdir(), "mineru-split-"));
  try {
    const out: Buffer[] = [];
    for (let i = 0; i < parts; i += 1) {
      const from = i * per + 1;
      const to = Math.min(total, (i + 1) * per);
      const f = join(dir, `part-${i + 1}.pdf`);
      execFileSync("pdftocairo", ["-pdf", "-f", String(from), "-l", String(to), path, f]);
      // **逐段核对页数**：pdftocairo 对坏页会跳过而不报错，
      // 少几页的产物看起来完全正常——正是这一轮在消灭的那种失败。
      const got = pageCount(f);
      if (got !== to - from + 1) {
        throw new Error(`第 ${i + 1} 段应有 ${to - from + 1} 页，实得 ${got} 页`);
      }
      out.push(readFileSync(f));
      console.log(`    切出第 ${i + 1}/${parts} 段：第 ${from}~${to} 页（${got} 页）`);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 各段 markdown 拼回一份。
 *
 * 段与段之间插一行分隔注释：拼接点是**最可能出问题的地方**（一句话被切成两半、
 * 一张表跨段），留个记号让 `kb:qa` 报出来时人知道该往哪看。
 * 不做接缝修补——判断"这两段算不算同一句"判错了就是悄悄改内容。
 */
export function joinParts(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0];
  return parts
    .map((p, i) => (i === 0 ? p : `<!-- 分段转换接缝：第 ${i + 1} 段起 -->\n\n${p}`))
    .join("\n\n");
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("用法：pnpm kb:convert <PDF 路径...>");
    process.exit(2);
  }
  const token = env("MINERU_API_TOKEN");
  if (!token) {
    console.error("缺少 MINERU_API_TOKEN。多栏 PDF 不经它转换会被 RAGFlow 串读。");
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const todo: Array<{ path: string; bytes: Buffer; out: string }> = [];
  for (const p of paths) {
    const bytes = readFileSync(p);
    const out = outPath(p, bytes);
    if (existsSync(out)) {
      console.log(`↷ 已有产物，跳过：${out}`);
      continue;
    }
    todo.push({ path: p, bytes, out });
  }
  if (todo.length === 0) {
    console.log("\n全部已转换。要强制重转就删掉对应的 .md。");
    return;
  }

  // 超页的先拆。**提交名带段号**：MinerU 的回执按文件名匹配，同名会串。
  const jobs: Array<{ name: string; bytes: Buffer }> = [];
  const partsOf = new Map<string, string[]>(); // out 路径 → 该文档的各段提交名（有序）
  for (const t of todo) {
    const stem = basename(t.out, ".md");
    const total = pageCount(t.path);
    if (total <= MAX_PAGES) {
      jobs.push({ name: `${stem}.pdf`, bytes: t.bytes });
      partsOf.set(t.out, [`${stem}.pdf`]);
      continue;
    }
    console.log(`  ${basename(t.path)} 共 ${total} 页，超过 MinerU 上限 ${MAX_PAGES}，拆分：`);
    const names: string[] = [];
    splitPdf(t.path, total).forEach((bytes, i) => {
      const name = `${stem}__p${i + 1}.pdf`;
      jobs.push({ name, bytes });
      names.push(name);
    });
    partsOf.set(t.out, names);
  }

  console.log(`\n提交 ${jobs.length} 份给 MinerU（${todo.length} 个文档）…`);
  const results = (await convertPdfs(
    { token, language: "ch", timeoutMs: 120_000 },
    jobs,
    {
      deadlineMs: 60 * 60_000,
      onProgress: (done, total, states) => console.log(`  ${done}/${total} — ${states}`),
    },
  )) as MineruResultWithZip[];
  const byName = new Map(results.map((r) => [r.name, r]));

  let ok = 0;
  let failed = 0;
  for (const t of todo) {
    const names = partsOf.get(t.out) ?? [];
    const mds: string[] = [];
    let broke = false;
    for (const name of names) {
      const r = byName.get(name);
      if (!r || r.state !== "done" || !r.zipUrl) {
        // **一段失败就整份不落盘**。写下缺了一段的 markdown 比不写更糟：
        // 文件在、看着正常、检索也命中，只是中间少了几十页——没有任何外部信号。
        console.error(`✗ ${basename(t.path)}${names.length > 1 ? `（${name}）` : ""}：${r?.error ?? r?.state ?? "无回执"}`);
        broke = true;
        break;
      }
      // zip 里除 full.md 外还有原始 PDF 与图片，只取 markdown。
      const zip = join(tmpdir(), `mineru-${Date.now()}-${Math.abs(hashOf(name))}.zip`);
      writeFileSync(zip, Buffer.from(await (await fetch(r.zipUrl)).arrayBuffer()));
      mds.push(cleanMineruMarkdown(
        execFileSync("unzip", ["-p", zip, "full.md"], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8"),
      ));
      rmSync(zip, { force: true });
    }
    if (broke) {
      failed += 1;
      continue;
    }
    const joined = joinParts(mds);
    writeFileSync(t.out, joined, "utf8");
    ok += 1;
    const seams = names.length > 1 ? `，${names.length} 段拼接` : "";
    console.log(`✓ ${basename(t.path)} → ${t.out}（${(joined.length / 1024).toFixed(0)} KB 文本${seams}）`);
  }

  console.log(`\nMinerU 转换：${ok} 成功，${failed} 失败`);
  process.exitCode = failed === 0 ? 0 : 1;
}

/** 只用于临时文件名，不参与任何判定。 */
function hashOf(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

void main();
