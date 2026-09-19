/**
 * 视觉观察层评测 runner（施工单 M71-01）。
 *
 * 给任何视觉模型同一份提示词（`prompts/observe.md`），量它在真实随手拍上的
 * 召回、定位、定色、画面裁切判断、禁词违规与负样本表现。**不经网关与 runtime**，
 * 直接调模型——它量的是观察层的原材料，不是链路。
 *
 * 用法：
 *   corepack pnpm eval:vision-observe                          # qwen3-vl-plus 全量（要 DASHSCOPE_API_KEY）
 *   corepack pnpm eval:vision-observe -- --model fake          # 回放 fixtures/<id>.<fixture>.json，零付费、确定性
 *   corepack pnpm eval:vision-observe -- --model qwen3-vl-flash --id tesla-01
 *   corepack pnpm eval:vision-observe -- --provider ark --model doubao-seed-2-0-mini-260428 --no-think
 *   corepack pnpm eval:vision-observe -- --json evals/runs/vision-observe.json [--save-fixture]
 *   corepack pnpm eval:vision-observe -- --via adapter [--detect-model qwen3-vl-flash] [--describe-pass always|when-uncertain|never] --model qwen3-vl-plus
 *       # 经 @carlife/tools 的两遍适配器（flash 检测 + plus 逐 crop 描述 + 像素定色），多出「代码定色」两行与画框图
 *   corepack pnpm eval:vision-observe -- --via adapter --model fake      # fake provider 按图片 sha8 回放 fixtures/by-sha
 *   corepack pnpm eval:vision-observe -- --via adapter --detect-provider yolo [--yolo-model <训练任务 id>] --model deepseek-flash
 *       # 端侧检测器当第一遍（M80-07）：经 VISION_TRAINER_URL 的 /predict 框位置，第二遍交给 --model 那家
 *   corepack pnpm eval:vision-observe -- --match [--id tesla-01]          # 图标匹配（M71-03）：真值 crop → 双路召回 → 闸门 →（核验）
 *       # 要本机 PG（kb:icons 已建索引）与 DASHSCOPE_API_KEY；按 image-only / text-only / both 三种召回各报 hit@1
 *       # 同时按网格切负样本喂进同一个闸门，出 M-U1 负样本误接受率；--neg-grid 0 关掉、默认 2（每张 4 个 crop）
 *
 * 退出码：fake 档 fixture 解析失败 / 与真值配对崩溃才非 0；真实档是测量不是断言，
 * 只有一张都没跑成（全 unparseable）才非 0。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { failureSection, limitationsSection, metricsTable, replayCommand, runMeta, type FailureRow } from "../lib/report";
import { aggregate, comparePhoto, parseJsonl, parsePrediction, validateCase, type ParsedPrediction, type PhotoResult, type Prediction, type TruthCase } from "./lib";
// 经相对路径而不是包名：根 package.json 不依赖 @carlife/tools，评测目录也不是 workspace 成员。
import {
  composeVisionProvider,
  createDashScopeVisionProvider,
  createDeepSeekVisionProvider,
  createFakeVisionProvider,
  createYoloDetectProvider,
  extractCrop,
  observePhoto,
  renderBoxes,
  type PhotoObservation,
  type VisionProvider,
} from "../../enterprise/backend/shared/tools/src/vision/index";
import { createIconEmbeddingRepository, getPrisma } from "@carlife/db";
import { createDashScopeEmbedder, decideMatch, recallCandidates, type Candidate } from "../../enterprise/backend/shared/rag/src/index";

const HERE = new URL("./", import.meta.url).pathname;
const ROOT = new URL("../..", import.meta.url).pathname;

// ── 参数 ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);

const MODEL = flag("--model") ?? "qwen3-vl-plus";
const PROVIDER = flag("--provider") ?? (MODEL.startsWith("doubao") ? "ark" : MODEL.startsWith("deepseek") ? "deepseek" : "dashscope");
const FIXTURE = flag("--fixture") ?? "qwen3-vl-plus";
const ONLY = flag("--id");
/**
 * 换一份真值文件（M80-10 对照用）：`photos/inbox/` 里产品收来的照片是 internal-eval-only，
 * 不进 `cases.jsonl` 真值集（许可来源不明），但内部对照要能跑——真值另放一份、路径仍相对 HERE。
 */
const CASES = flag("--cases") ?? `${HERE}cases.jsonl`;
const JSON_OUT = flag("--json");
const NO_THINK = has("--no-think");
const SAVE_FIXTURE = has("--save-fixture");
const REPEAT = Math.max(1, Number(flag("--repeat") ?? 1) || 1);
const VIA = flag("--via") ?? "raw";
const DETECT_MODEL = flag("--detect-model") ?? "qwen3-vl-flash";
/** 两遍可以来自两家：缺省按模型名猜，`--detect-provider` / `--describe-provider` 显式覆盖。 */
type Vendor = "dashscope" | "deepseek" | "yolo";
const vendorFor = (model: string): Vendor => (model.startsWith("deepseek") ? "deepseek" : "dashscope");
const DETECT_PROVIDER = (flag("--detect-provider") ?? vendorFor(DETECT_MODEL)) as Vendor;
const DESCRIBE_PROVIDER = (flag("--describe-provider") ?? vendorFor(MODEL)) as Exclude<Vendor, "yolo">;
/** `--detect-provider yolo` 时：训练任务 id（缺省 M79 那版）与训练服务地址。 */
const YOLO_MODEL = flag("--yolo-model") ?? "train-20260909-141540-e8c0";
const YOLO_CONF = Number(flag("--yolo-conf") ?? 0.25);
const YOLO_IMGSZ = Number(flag("--yolo-imgsz") ?? 960);
const DESCRIBE_PASS = (flag("--describe-pass") ?? "always") as "always" | "when-uncertain" | "never";
const BOXES_DIR = `${ROOT}evals/runs/vision-observe-boxes`;
const MATCH = has("--match");
// 负样本探针的网格边长：每张负样本切 NEG_GRID² 个方 crop 送进同一个闸门（M-U1，见 runNegativeProbe）。
const NEG_GRID = Math.max(0, Number(flag("--neg-grid") ?? 2) || 0);
const IS_FAKE = MODEL === "fake";

// ── 模型调用 ─────────────────────────────────────────────────

interface CallResult {
  text: string;
  ms: number;
  usage?: Record<string, unknown>;
}

async function callModel(imagePath: string, systemPrompt: string): Promise<CallResult> {
  const endpoint =
    PROVIDER === "ark"
      ? `${process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3"}/chat/completions`
      : PROVIDER === "deepseek"
        ? `${process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"}/chat/completions`
        : "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
  const keyVar = PROVIDER === "ark" ? "ARK_API_KEY" : PROVIDER === "deepseek" ? "DEEPSEEK_API_KEY" : "DASHSCOPE_API_KEY";
  const key = process.env[keyVar];
  if (!key) throw new Error(`${keyVar} 为空——.env 里的变量要 set -a 导出`);
  const bytes = readFileSync(imagePath);
  const mime = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
  const body: Record<string, unknown> = {
    model: MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } },
          { type: "text", text: "按系统提示词记录这张照片。" },
        ],
      },
    ],
  };
  if (NO_THINK) body.thinking = { type: "disabled" };
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - t0;
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: Record<string, unknown>; error?: unknown };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return { text: json.choices?.[0]?.message?.content ?? "", ms, usage: json.usage };
}

function readFixture(id: string): string | null {
  const p = `${HERE}fixtures/${id}.${FIXTURE}.json`;
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

// ── 主流程 ───────────────────────────────────────────────────

interface NegRow {
  photo: string;
  cell: string;
  top1: string;
  sims: string;
  gate: string;
  accepted: boolean;
}

interface MatchRow {
  photo: string;
  symbol: string;
  mode: "image" | "text" | "both";
  top3: string[];
  sims: string;
  gate: string;
  matched: boolean;
  verified: boolean;
}

/** 图标匹配评测（M71-03）：真值里带 symbol_id 的项 → 裁 crop → 三种召回 → 闸门/核验 → hit@k。 */
async function runMatch(all: TruthCase[], selected: TruthCase[]): Promise<void> {
  if (!process.env.DASHSCOPE_API_KEY) throw new Error("DASHSCOPE_API_KEY 为空——.env 里的变量要 set -a 导出");
  const prisma = getPrisma();
  const store = createIconEmbeddingRepository(prisma);
  const embedder = createDashScopeEmbedder({ apiKey: process.env.DASHSCOPE_API_KEY, model: process.env.CARLIFE_ICON_EMBED_MODEL || undefined });
  const rows: MatchRow[] = [];
  const negRows: NegRow[] = [];
  /** 没有图标目录的车型：如实记进报告的「不适用」，不算失败。 */
  const skippedNoIndex: string[] = [];
  /*
   * 手册图标图片（2026-09-09 起有了）：`data/kb-src/icons/<车型目录>/<symbol_id>.png`。
   * 在这之前这里写死 `iconImage: () => null`，于是**成对核验从来没跑过**，M-V1 恒为 0 而报告把它归因成"没有图片"。
   * 现在有图了就必须真的核验——不然「疑似」永远摘不掉。
   */
  const iconsDir = `${HERE}../../data/kb-src/icons/tesla-model3`;
  const iconImage = (symbolId: string): Buffer | null => {
    const f = `${iconsDir}/${symbolId}.png`;
    return existsSync(f) ? readFileSync(f) : null;
  };
  // 核验用真实视觉模型（与观察层第二遍同一个），fake 档没有核验能力——那时退回 verified=false。
  const verifier = process.env.DASHSCOPE_API_KEY
    ? createDashScopeVisionProvider({ apiKey: process.env.DASHSCOPE_API_KEY, describeModel: process.env.CARLIFE_VISION_DESCRIBE_MODEL || undefined })
    : null;
  try {
    for (const c of selected) {
      if (c.negative) continue;
      const bytes = readFileSync(`${HERE}${c.file}`);
      const indexed = await store.countByVehicle(c.vehicle ?? "");
      if (indexed === 0) {
        /*
         * 没有这个车型的目录就跳过，不再整条 run 抛掉（M80-09）。
         * 起因是 storex-01：老款 Model X 的图标与 Model 3 长得就不一样（充电是绿的、近光是白灰的），
         * 它进真值集是为了量跨车型泛化，本来就不该参与图标匹配。一条这样的样本掀掉整次评测不合理。
         */
        process.stderr.write(`${c.id.padEnd(12)} 跳过：库里没有车型「${c.vehicle}」的图标索引\n`);
        skippedNoIndex.push(`${c.id}（${c.vehicle}）`);
        continue;
      }
      for (const it of c.items) {
        if (!it.symbol_id) continue;
        const crop = await extractCrop(bytes, it.bbox, 0.5);
        const descriptor = { shape: it.shape, color: it.color, state: it.state, elements: it.elements, text: it.text };
        for (const mode of ["image", "text", "both"] as const) {
          const args = mode === "image" ? { crop } : mode === "text" ? { descriptor } : { crop, descriptor };
          const { candidates } = await recallCandidates({ ...args, vehicleModel: c.vehicle, k: 8 }, { embedder, store });
          const decision = await decideMatch(candidates, mode === "text" ? null : crop, { iconImage, verifyPair: verifier ? (a, b) => verifier.verifyPair(a, b) : undefined });
          const fmt = (x: Candidate): string => `${x.symbolId}(${[x.imageSim, x.textSim].map((v) => (v == null ? "-" : v.toFixed(2))).join("/")})`;
          rows.push({
            photo: c.id,
            symbol: it.symbol_id,
            mode,
            top3: candidates.slice(0, 3).map((x) => x.symbolId),
            sims: candidates.slice(0, 3).map(fmt).join(" "),
            gate: decision.matched ? `通过 sim ${decision.sim.toFixed(3)}` : decision.reason,
            matched: decision.matched && decision.semantics.symbolId === it.symbol_id,
            verified: decision.matched ? decision.verified : false,
          });
          process.stderr.write(`${c.id} ${it.symbol_id.padEnd(24)} ${mode.padEnd(5)} top3=[${candidates.slice(0, 3).map((x) => x.symbolId).join(", ")}] ${decision.matched ? "✓" : "✗ " + decision.reason}\n`);
        }
      }
    }
    /*
     * M-U1 负样本误接受率（M79-01）。
     *
     * 负样本的定义就是「手册那 27 个符号里没有一个亮着」，所以**闸门放行任何一个 crop 都是误接受**——
     * 不需要真值框，也正因为没有真值框，这里按网格切：画面中部 80% 切成 NEG_GRID² 个方 crop，
     * 走图像路召回，喂给**同一个** decideMatch。判定口径一行没动，动的只是 crop 从哪来。
     *
     * 这道数只回答「不该匹配时会不会匹配」。它不回答「检测器会不会先框出个东西来」——
     * 那是观察层的事，在主档位的 V-N1（负样本高置信警示灯报出数）里量。两条都低才算过关。
     */
    for (const c of selected.filter((x) => x.negative)) {
      if (NEG_GRID === 0) break;
      const bytes = readFileSync(`${HERE}${c.file}`);
      // 车型缺省按 Tesla 索引查：负样本问的正是「拿它去比特斯拉的 27 个符号，会不会比中」。
      const vehicleModel = c.vehicle ?? "Tesla Model 3/Y";
      const span = Math.floor(800 / NEG_GRID);
      for (let gy = 0; gy < NEG_GRID; gy++) {
        for (let gx = 0; gx < NEG_GRID; gx++) {
          const x0 = 100 + gx * span;
          const y0 = 100 + gy * span;
          const crop = await extractCrop(bytes, [x0, y0, x0 + span, y0 + span], 0);
          const { candidates } = await recallCandidates({ crop, vehicleModel, k: 8 }, { embedder, store });
          const decision = await decideMatch(candidates, crop, { iconImage, verifyPair: verifier ? (a, b) => verifier.verifyPair(a, b) : undefined });
          const top = candidates[0];
          negRows.push({
            photo: c.id,
            cell: `${gx},${gy}`,
            top1: top?.symbolId ?? "—",
            sims: top ? [top.imageSim, top.textSim].map((v) => (v == null ? "-" : v.toFixed(2))).join("/") : "—",
            gate: decision.matched ? "放行" : decision.reason,
            accepted: decision.matched,
          });
          process.stderr.write(`${c.id} 格(${gx},${gy}) top1=${top?.symbolId ?? "—"} ${decision.matched ? "⚠ 误接受" : "✓ 拒绝"}\n`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  const by = (mode: MatchRow["mode"]): MatchRow[] => rows.filter((r) => r.mode === mode);
  const hit = (xs: MatchRow[], k: number): string => (xs.length ? `${xs.filter((r) => r.top3.slice(0, k).includes(r.symbol)).length}/${xs.length}` : "无法计算");
  const pct = (frac: string): string => {
    const [a, b] = frac.split("/").map(Number);
    return Number.isFinite(a) && b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "无法计算";
  };
  const metrics = (["both", "image", "text"] as const).flatMap((mode) => [
    { id: `M-H1-${mode}`, name: `hit@1（${mode}）`, value: pct(hit(by(mode), 1)), denom: hit(by(mode), 1) },
    { id: `M-H3-${mode}`, name: `hit@3（${mode}）`, value: pct(hit(by(mode), 3)), denom: hit(by(mode), 3) },
    { id: `M-G1-${mode}`, name: `闸门通过且正确（${mode}）`, value: pct(`${by(mode).filter((r) => r.matched).length}/${by(mode).length}`), denom: `${by(mode).filter((r) => r.matched).length}/${by(mode).length}` },
  ]);
  metrics.push({ id: "M-V1", name: "核验覆盖（verified）", value: `${rows.filter((r) => r.verified).length}/${rows.length}`, denom: "verified=true 才能说「是」；成对核验只在 image / both 两路上跑（text 路没有 crop）" });
  const negPhotos = new Set(negRows.map((r) => r.photo)).size;
  metrics.push({
    id: "M-U1",
    name: "负样本误接受率",
    value: negRows.length ? pct(`${negRows.filter((r) => r.accepted).length}/${negRows.length}`) : "本档位不适用",
    denom: negRows.length ? `${negRows.filter((r) => r.accepted).length}/${negRows.length}` : "负样本目录为空或 --neg-grid 0",
    note: negRows.length ? `${negPhotos} 张负样本 × ${NEG_GRID}² 个网格 crop；负样本里没有任何手册符号，所以闸门放行一次就是误接受一次` : undefined,
  });
  const meta = runMeta({
    name: "图标匹配评测（eval:vision-observe --match）",
    tier: `real（DashScope ${embedder.model}，维度 ${embedder.dimension ?? "?"}）`,
    model: embedder.model,
    total: all.length,
    selected: selected.length,
    at: new Date().toISOString(),
    command: replayCommand("eval:vision-observe", argv),
  });
  const table = [
    "## 逐项",
    "",
    "| 照片 | 真值符号 | 召回路 | top-3（图像相似/文本相似） | 闸门 | 正确 |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.photo} | ${r.symbol} | ${r.mode} | ${r.sims} | ${r.gate} | ${r.matched ? "✓" : "✗"} |`),
    "",
    ...(negRows.length
      ? [
          "## 负样本逐格（M-U1）",
          "",
          "| 负样本 | 网格 | top-1 | 相似度（图像/文本） | 闸门 | 误接受 |",
          "|---|---|---|---|---|---|",
          ...negRows.map((r) => `| ${r.photo} | ${r.cell} | ${r.top1} | ${r.sims} | ${r.gate} | ${r.accepted ? "⚠" : "—"} |`),
          "",
        ]
      : []),
  ].join("\n");
  const limits = limitationsSection({
    defects: [
      { what: "文本路的描述子把「绿色 灯形 直线」这类同形符号写成一模一样（近光灯 vs 驻车灯 文本相似度都是 0.96）", impact: "只走文本路时这两个分不开，hit@1 与闸门都掉在这一对上", next: "词表补「灯组朝向 / 双灯并排」等元素后重写这几条描述子；图像路已能分开（0.70 vs 0.57），生产走的是双路" },
      { what: "τ / δ 是单张探针上的初值", impact: "闸门通过率不可跨车型硬比", next: "≥30 张 + 负样本上标定后改 icon-verify.ts 并同步 README" },
      { what: "用户侧 crop 用真值 bbox 裁，不是观察层检测的框", impact: "量的是「索引 + 闸门」，不含检测误差", next: "M71-04 接入后用观察层输出端到端量一次" },
    ],
    notApplicable: [
      ...(negRows.length ? [] : ["负样本误接受率：--neg-grid 0 或没有负样本入选"]),
      ...(skippedNoIndex.length ? [`库里没有图标目录的车型，已跳过：${skippedNoIndex.join("、")}`] : []),
      "轮胎 / 液体：目录只有警示灯",
    ],
    uncertainty: [{ what: `样本 ${rows.length / 3} 个符号`, basis: "≥30 张后数字才作数" }],
  });
  const md = [meta, metricsTable(metrics as never), "", table, limits].join("\n");
  process.stdout.write(md + "\n");
  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({ suite: "vision-observe-match", model: embedder.model, at: new Date().toISOString(), metrics, rows, negRows }, null, 2));
    process.stderr.write(`→ ${JSON_OUT}\n`);
  }
}

async function main(): Promise<void> {
  const all = parseJsonl<TruthCase>(readFileSync(CASES, "utf8"));
  for (const c of all) {
    const errs = validateCase(c);
    if (errs.length) throw new Error(`真值 ${c.id} 不合格：\n  ${errs.join("\n  ")}`);
  }
  const selected = ONLY ? all.filter((c) => c.id === ONLY) : all;
  if (selected.length === 0) throw new Error(`没有选中任何照片（--id ${ONLY}）`);
  if (MATCH) return runMatch(all, selected);
  const prompt = readFileSync(`${HERE}prompts/observe.md`, "utf8");

  const results: PhotoResult[] = [];
  const raws: Record<string, { text: string; ms: number | null; usage?: Record<string, unknown> }> = {};
  const latencies: number[] = [];

  for (const c of selected) for (let run = 1; run <= (IS_FAKE ? 1 : REPEAT); run += 1) {
    let parsed: ParsedPrediction;
    let ms: number | null = null;
    let usage: Record<string, unknown> | undefined;
    let text = "";
    if (VIA === "adapter") {
      const oneVendor = (vendor: Vendor): VisionProvider => {
        if (vendor === "yolo") {
          const baseURL = process.env.VISION_TRAINER_URL || "http://localhost:8799";
          return createYoloDetectProvider({ baseURL, model: YOLO_MODEL, conf: YOLO_CONF, imgsz: YOLO_IMGSZ });
        }
        const keyVar = vendor === "deepseek" ? "DEEPSEEK_API_KEY" : "DASHSCOPE_API_KEY";
        const apiKey = process.env[keyVar];
        if (!apiKey) throw new Error(`${keyVar} 为空——.env 里的变量要 set -a 导出`);
        const args = { apiKey, detectModel: DETECT_MODEL, describeModel: MODEL };
        return vendor === "deepseek" ? createDeepSeekVisionProvider(args) : createDashScopeVisionProvider(args);
      };
      const provider: VisionProvider = IS_FAKE
        ? createFakeVisionProvider({ fixturesDir: `${HERE}fixtures/by-sha` })
        : composeVisionProvider(oneVendor(DETECT_PROVIDER), oneVendor(DESCRIBE_PROVIDER));
      const bytes = readFileSync(`${HERE}${c.file}`);
      const obs: PhotoObservation = await observePhoto(bytes, provider, { describePass: DESCRIBE_PASS });
      text = JSON.stringify(obs);
      ms = obs.timings.totalMs;
      if (!IS_FAKE) latencies.push(obs.timings.totalMs);
      const pred: Prediction = {
        frame: { quality: obs.frame.quality, cut_off_sides: obs.frame.cut_off_sides, item_count: obs.frame.item_count },
        items: obs.items.map((it) => ({
          category: it.category,
          bbox: it.bbox,
          shape: it.shape,
          color: it.colorByModel,
          colorByPixels: it.colorByPixels,
          state: it.state,
          text: it.text,
          elements: it.elements,
          literal: it.literal,
          confidence: it.confidence,
          quality: it.quality,
          undeterminable: it.undeterminable,
        })),
      };
      parsed = obs.frame.unreadable ? { pred: null, fatal: obs.notes.join("；") || "unreadable", vocabErrors: [] } : { pred, fatal: null, vocabErrors: [] };
      if (!obs.frame.unreadable) {
        mkdirSync(BOXES_DIR, { recursive: true });
        const png = await renderBoxes(bytes, obs.items.map((it, i) => ({ bbox: it.bbox, label: `${i}:${it.colorByPixels}` })));
        writeFileSync(`${BOXES_DIR}/${c.id}-${IS_FAKE ? "fake" : `${DETECT_PROVIDER === "yolo" ? "yolo+" : ""}${MODEL}`}${run > 1 ? `-${run}` : ""}.png`, png);
      }
      for (const n of obs.notes) process.stderr.write(`  note: ${n}\n`);
    } else if (IS_FAKE) {
      const fx = readFixture(c.id);
      if (!fx) {
        parsed = { pred: null, fatal: `无 fixture：fixtures/${c.id}.${FIXTURE}.json`, vocabErrors: [] };
      } else {
        text = fx;
        parsed = parsePrediction(fx);
      }
    } else {
      try {
        const r = await callModel(`${HERE}${c.file}`, prompt);
        text = r.text;
        ms = r.ms;
        usage = r.usage;
        latencies.push(r.ms);
        parsed = parsePrediction(r.text);
        if (parsed.fatal) {
          // 解析失败重跑一次——JSON 偶发截断是这类接口的常态，第二次仍失败才算它的。
          const again = await callModel(`${HERE}${c.file}`, prompt);
          text = again.text;
          ms = (ms ?? 0) + again.ms;
          parsed = parsePrediction(again.text);
          if (parsed.fatal) parsed.fatal = `两次均不可解析：${parsed.fatal}`;
        }
        if (SAVE_FIXTURE && parsed.pred) {
          writeFileSync(`${HERE}fixtures/${c.id}.${MODEL}.json`, JSON.stringify(parsed.pred, null, 2));
        }
      } catch (e) {
        parsed = { pred: null, fatal: String((e as Error).message), vocabErrors: [] };
      }
    }
    const key = REPEAT > 1 ? `${c.id}#${run}` : c.id;
    raws[key] = { text, ms, usage };
    const r = comparePhoto(c, parsed);
    r.id = key;
    results.push(r);
    process.stderr.write(`${key}  ${r.unparseable ? "✗ " + r.unparseable : `召回 ${r.matched}/${r.truthCount}  误检 ${r.extra}  颜色 ${r.color.agree}/${r.color.n}  cut_off ${r.cutOffMatch ? "✓" : "✗"}`}${ms != null ? `  ${ms} ms` : ""}\n`);
  }

  // ── 报告 ──
  const metrics = aggregate(results);
  const modelLabel = IS_FAKE ? `fake（回放 fixture ${FIXTURE}）` : MODEL;
  const meta = runMeta({
    name: "视觉观察层评测（eval:vision-observe）",
    tier: `${IS_FAKE ? "fake（确定性回放）" : `real（${VIA === "adapter" ? `${DETECT_PROVIDER}→${DESCRIBE_PROVIDER}` : PROVIDER}${NO_THINK ? "，关思考" : ""}${REPEAT > 1 ? `，每张 ${REPEAT} 次` : ""}）`}${VIA === "adapter" ? `；经适配器（检测 ${IS_FAKE ? "fake" : DETECT_MODEL}，第二遍 ${DESCRIBE_PASS}）` : "；整图一遍（对照，不经适配器）"}`,
    model: modelLabel,
    total: all.length,
    selected: selected.length,
    at: new Date().toISOString(),
    command: replayCommand("eval:vision-observe", argv),
    // 多次运行时 selected 计的是运行次数——报告首屏会标「抽样」，这里如实：一张图跑三次不是三张图

  });
  const perPhoto = [
    "## 逐张",
    "",
    "| 照片 | 负样本 | 召回 | 误检 | 平均 IoU | 颜色 | 状态 | 文字 | cut_off | 禁词 | 耗时 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...results.map((r) => {
      const raw = raws[r.id];
      const meanIou = r.ious.length ? (r.ious.reduce((s, x) => s + x, 0) / r.ious.length).toFixed(3) : "-";
      return `| ${r.id} | ${r.negative ? "是" : "否"} | ${r.unparseable ? "不可解析" : `${r.matched}/${r.truthCount}`} | ${r.extra} | ${meanIou} | ${r.color.agree}/${r.color.n} | ${r.state.agree}/${r.state.n} | ${r.text.hit}/${r.text.n} | ${r.cutOffMatch === null ? "-" : r.cutOffMatch ? "✓" : "✗"} | ${r.forbiddenViolations} | ${raw?.ms != null ? `${raw.ms} ms` : "-"} |`;
    }),
    "",
  ].join("\n");
  const failures: FailureRow[] = results
    .filter((r) => r.reasons.length > 0)
    .map((r) => ({ id: r.id, group: r.negative ? "负样本" : "正样本", input: all.find((c) => c.id === r.id.split("#")[0])?.file ?? r.id, reasons: r.reasons }));
  const provenance = [
    "## 照片来源",
    "",
    "| 照片 | 来源 | 车型 |",
    "|---|---|---|",
    ...selected.map((c) => `| ${c.id} | ${c.provenance} | ${c.vehicle ?? "-"} |`),
    "",
  ].join("\n");
  const limits = limitationsSection({
    defects: [
      {
        what: "真值 bbox 来自 qwen3-vl-plus 的输出经人工核对采纳，与 plus 同源",
        impact: "plus 的 IoU 与召回天然偏高；其它模型的 IoU 是对 plus 的框而非独立人工框",
        next: "扩充到 ≥30 张时用 CVAT / Label Studio 独立标框，tesla-01 的框同时重标",
      },
      {
        what: "颜色一致率量的是模型报告的颜色，不是系统最终采用的颜色",
        impact: "模型报错颜色而代码定色对的情况，这里记失败；反之亦然",
        next: "M71-02 接 sharp 像素定色后加「代码定色 vs 真值」一行，两行并列",
      },
      {
        what: "禁词是词表正则，模型换个说法（如「提示灯」「警告」）就漏",
        impact: "V-L1 可能低估 literal 泄露名称的次数",
        next: "M71-02 起 literal 不进检索，禁词表随逐条复核扩充；评测与生产共用同一份正则",
      },
      {
        what: "同一模型、温度 0、同一张图，跨运行结果不同（2026-09-08 qwen3-vl-plus 三次：8/8 → 7/8 + 1 误检 → 8/8；cut_off_sides 分别为 right+bottom / 空 / left+bottom）",
        impact: "单次运行的任何一个数字都带抖动；cut_off_sides 由模型判断不可靠",
        next: "用 --repeat N 报告多次运行；cut_off_sides 在 M71-02 改由代码检测屏幕边框，模型的值只作参考",
      },
      {
        what: "IoU 配对阈值 0.5 与「负样本高置信」阈值 0.7 是初值",
        impact: "阈值未在 ≥30 张上标定前，V-R1 / V-N1 的绝对数不可跨模型硬比",
        next: "Sprint 判定 1 达到样本量后标定并写进本节",
      },
    ],
    notApplicable: [
      ...(IS_FAKE ? ["时延与 token：fake 档不调模型"] : []),
      "轮胎 / 液体 / 异响部位：本集目前只有仪表照片，这些类别的观察质量本报告不回答",
      "链路正确性：不经网关与 runtime，路由、【图片观察】段、补拍指引由 eval:scenarios 与 M71-04 的用例回答",
      "图标是什么、什么级别：观察层不命名，匹配正确率在 --match（M71-03）里量",
    ],
    uncertainty: [
      { what: `样本量 ${selected.length} 张`, basis: "Sprint 判定要求 ≥30 张真实随手拍 + ≥10 张负样本后数字才作数；小样本只用于回归与方向判断" },
      { what: "颜色一致率是「模型报告 vs 真值」", basis: "代码从像素定色（M71-02）接入前，这一行量的是模型说的颜色，不是系统最终采用的颜色" },
    ],
  });
  const md = [meta, metricsTable(metrics as never), "", perPhoto, failureSection(failures), provenance, limits].join("\n");
  process.stdout.write(md + "\n");

  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          suite: "vision-observe",
          model: modelLabel,
          provider: IS_FAKE ? "fake" : PROVIDER,
          at: new Date().toISOString(),
          metrics,
          results,
          raw: Object.fromEntries(Object.entries(raws).map(([k, v]) => [k, { ms: v.ms, usage: v.usage, text: v.text }])),
          latencyMs: latencies,
          root: ROOT,
        },
        null,
        2,
      ),
    );
    process.stderr.write(`→ ${JSON_OUT}\n`);
  }

  const unparseable = results.filter((r) => r.unparseable).length;
  if (unparseable === results.length) process.exit(1);
  if (IS_FAKE && unparseable > 0) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`eval:vision-observe 失败：${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
