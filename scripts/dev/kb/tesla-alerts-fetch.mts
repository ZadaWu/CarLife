/**
 * 抓特斯拉官方「排除警报故障」章节，转成带面包屑的 markdown（施工单 M80-10）。
 *
 * # 为什么单独抓这一章，而不是等手册 PDF
 *
 * 车主拍的警报页上是一串代码（`VCFRONT_a004`）加一句话。**代码表不在我们已经入库的手册里**——
 * 2026-09-10 实测：`Model3_车主手册.md` / `ModelY_车主手册.md` 里 `VCFRONT_a`/`APP_w`/`DI_a` 一个都搜不到，
 * 正文只写了一句「点击了解更多」。逐条解释只在官网这一章（每条含「此警报的含义」与「应采取的措施」）。
 *
 * # 覆盖面要如实登记
 *
 * 官方只公布了它选择公布的那些：Model 3 126 条、Model Y 123 条，合起来 126 个不同代码（2026-09-10 实测），
 * 且**集中在充电（CC/CP/UMC）、电池（BMS）、电驱（DI/PCS）这类要紧的**。
 * 车主随手拍到的信息类提示（`UI_a114` 驾驶视觉画面暂时降级、`DI_a223` 牵引力控制已停用…）多数不在其中——
 * 2026-09-10 从 16 张真实警报页里读到 23 个代码，官方表只覆盖 2 个。
 * 所以这份语料是**补充**不是全集，链路里查不到代码时必须如实说「手册里没有这条」，不能编。
 * 每次抓完打印覆盖统计，数字进验收。
 *
 * 用法：
 *   corepack pnpm kb:alerts                       # 抓 model3 + modely → data/kb-md/
 *   corepack pnpm kb:alerts -- --model model3     # 只抓一款
 *   corepack pnpm kb:alerts -- --check <代码...>  # 抓完顺带报这些代码在不在表里
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 官方章节 GUID 各车型共用；语言目录换 `en_us` 就是英文版。 */
const ALERTS_GUID = "GUID-9A3F0F72-71F4-433D-B68B-0A472A9359DF";
const MODELS: Record<string, { label: string; vehicle: string }> = {
  model3: { label: "Model 3", vehicle: "Tesla Model 3" },
  modely: { label: "Model Y", vehicle: "Tesla Model Y" },
};

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

interface Alert {
  code: string;
  /** 屏幕上那一行标题（可能有主副两段）。 */
  headings: string[];
  meaning: string[];
  action: string[];
}

const decode = (s: string): string =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, d: string) => String.fromCodePoint(parseInt(d, 16)));

const stripTags = (s: string): string => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/**
 * 解析一页 HTML → 警报条目。
 *
 * 结构（2026-09-10 实测，稳定）：每条是 `<article class="topic concept nested1" id="APP_W009">`，
 * `<h2>` 里几个 `<span class="ph uicontrol">` 依次是代码与屏幕标题，
 * 正文 `<p>` 里以「此警报的含义：」「应采取的措施：」分段。
 */
export function parseAlerts(html: string): Alert[] {
  const out: Alert[] = [];
  const article = /<article class="topic concept nested1"[^>]*\bid="([A-Z][A-Z0-9]*_[AW][0-9]+)"[^>]*>([\s\S]*?)<\/article>/g;
  for (let m = article.exec(html); m; m = article.exec(html)) {
    const body = m[2];
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(body);
    if (!h2) continue;
    const spans = [...h2[1].matchAll(/<span class="ph uicontrol"[^>]*>([\s\S]*?)<\/span>/g)].map((x) => stripTags(x[1])).filter(Boolean);
    if (spans.length === 0) continue;
    // 第一段就是代码本身（`id` 是大写形态，正文里才是 `APP_w009` 这种真实大小写）
    const code = spans[0];
    const headings = spans.slice(1);

    const paras = [...body.matchAll(/<p class="p">([\s\S]*?)<\/p>/g)].map((x) => stripTags(x[1])).filter(Boolean);
    const meaning: string[] = [];
    const action: string[] = [];
    let bucket: string[] | null = null;
    for (const p of paras) {
      if (/^此警报的含义[:：]?$/.test(p)) { bucket = meaning; continue; }
      if (/^应采取的措施[:：]?$/.test(p)) { bucket = action; continue; }
      if (bucket) bucket.push(p);
    }
    if (!/^[A-Z][A-Z0-9]*_[aw][0-9]+$/.test(code)) continue;
    out.push({ code, headings, meaning, action });
  }
  return out;
}

/**
 * 转 markdown。**每条自带面包屑**（`文档 › 章 › 代码`）——切片后单看一块也知道它属于哪个代码，
 * 与 `prepareMarkdownForChunking` 的约定一致（内部开发指引「切片必须带面包屑」）。
 */
export function toMarkdown(alerts: Alert[], label: string, sourceUrl: string): string {
  const doc = `${label}_警报代码`;
  const lines = [
    `# ${label} 车辆警报代码`,
    "",
    `> 来源：特斯拉官方车主手册「排除警报故障」章节（${sourceUrl}），${new Date().toISOString().slice(0, 10)} 抓取。`,
    /*
     * **这里只写来源，不写给系统的指令**。
     * 第一版在这行下面还写了一句「查不到的代码要如实说…不要推断」——那是写给我们自己的纪律，
     * 结果它被切片进了知识库，2026-09-10 真跑（8eb16b81 那张）被检索出来，模型开口第一句就是
     * 「先说一句手册里的原话：车主屏幕上出现、而手册里查不到的代码，要如实说…」——
     * 把我们的指令当成厂商的话念给了车主。**上传的语料里只放厂商写的字**，纪律归提示词。
     */
    "",
  ];
  for (const a of alerts) {
    const title = a.headings.join(" · ");
    lines.push(`> ${doc} › 排除警报故障 › ${a.code}`, "", `## ${a.code}${title ? ` ${title}` : ""}`, "");
    if (title) lines.push(`屏幕上显示的文字：${title}`, "");
    if (a.meaning.length) lines.push("**此警报的含义：**", "", ...a.meaning.map((x) => `${x}`), "");
    if (a.action.length) lines.push("**应采取的措施：**", "", ...a.action.map((x) => `${x}`), "");
  }
  return lines.join("\n");
}

/**
 * 用 curl 取，不用 `fetch`。
 *
 * 2026-09-10 踩到：本机只能经 `HTTPS_PROXY=http://127.0.0.1:7897` 出网，而 Node 的 `fetch`（undici）
 * **默认不认 `HTTPS_PROXY`**，直接 `UND_ERR_CONNECT_TIMEOUT`；curl 认。要让 fetch 走代理得引 undici 的
 * `ProxyAgent`——为一个人工运行的抓取脚本加一个依赖不划算（那还要走 ACR）。curl 在 macOS 与 Linux 都自带，
 * 且它读的就是开发者已经配好的那套代理环境变量。
 */
async function getHtml(url: string): Promise<string> {
  try {
    const { stdout } = await run("curl", ["-sSL", "--fail", "--max-time", "90", url], {
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  } catch (e) {
    throw new Error(`取不到 ${url}：${(e as Error).message.split("\n")[0]}（本机要出网可能得先 export HTTPS_PROXY）`);
  }
}

async function fetchModel(key: string): Promise<{ alerts: Alert[]; url: string }> {
  const url = `https://www.tesla.cn/ownersmanual/${key}/zh_cn/${ALERTS_GUID}.html`;
  const html = await getHtml(url);
  const alerts = parseAlerts(html);
  if (alerts.length === 0) throw new Error(`${url} 一条都没解析出来——页面结构可能变了，先看 HTML 再改解析`);
  return { alerts, url };
}

async function main(): Promise<void> {
  const only = flag("--model");
  const checkIdx = argv.indexOf("--check");
  const wanted = checkIdx >= 0 ? argv.slice(checkIdx + 1).filter((x) => !x.startsWith("--")) : [];
  const keys = only ? [only] : Object.keys(MODELS);
  const all = new Set<string>();
  /** 同一代码两款车都收录时以先抓到的正文为准，`models` 记全——正文实测一致，差别只在车型名。 */
  const byCode = new Map<string, Alert & { models: Set<string> }>();

  for (const key of keys) {
    const meta = MODELS[key];
    if (!meta) throw new Error(`不认识的车型 ${key}（可选：${Object.keys(MODELS).join(" / ")}）`);
    const { alerts, url } = await fetchModel(key);
    for (const a of alerts) {
      all.add(a.code);
      const prev = byCode.get(a.code);
      if (prev) prev.models.add(meta.label);
      else byCode.set(a.code, { ...a, models: new Set([meta.label]) });
    }
    const withMeaning = alerts.filter((a) => a.meaning.length > 0).length;
    const out = `data/kb-md/${meta.label.replace(/\s/g, "")}_警报代码.md`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, toMarkdown(alerts, meta.label, url), "utf8");
    process.stdout.write(`${meta.label}：${alerts.length} 条（${withMeaning} 条有「含义」段）→ ${out}\n`);
  }

  /*
   * 除了给知识库的 markdown，再出一份**给运行时直接查的 JSON**。
   *
   * 为什么不靠向量检索：代码是精确键，不是语义。2026-09-10 真跑 turn-3cf7fe2a 实测——
   * 一张图 5 条警报，代码与标题一起拼进检索词后**整条查询被稀释**，
   * 回来的是软件更新、洗车模式、月检清单，而其中 `APP_w009` 明明在库里。
   * 精确键就该精确查：本地表零网络、零稀释，"查不到"也是确定的答案而不是"这次没检索到"。
   * markdown 那份仍然上传——车主用症状描述提问时走的是那条语义路。
   */
  const catalog = {
    source: "特斯拉官方车主手册「排除警报故障」章节",
    fetchedAt: new Date().toISOString().slice(0, 10),
    entries: Object.fromEntries(
      [...byCode.entries()].map(([code, e]) => [code, { models: [...e.models].sort(), title: e.headings.join(" · "), meaning: e.meaning, action: e.action }]),
    ),
  };
  mkdirSync("data/kb-src/alerts", { recursive: true });
  writeFileSync("data/kb-src/alerts/tesla-alerts.json", `${JSON.stringify(catalog, null, 1)}\n`, "utf8");
  process.stdout.write(`合计不同代码：${all.size} → data/kb-src/alerts/tesla-alerts.json\n`);
  if (wanted.length) {
    const hit = wanted.filter((c) => all.has(c));
    process.stdout.write(`\n覆盖检查：${hit.length} / ${wanted.length}\n`);
    for (const c of wanted) process.stdout.write(`  ${all.has(c) ? "✓" : "✗"} ${c}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
