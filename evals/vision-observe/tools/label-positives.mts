/**
 * 给真实正样本候选认名字（施工单 M80-08）：每一枚亮着的灯 → 手册图标目录里的哪一个符号。
 *
 * # 用生产链路那一套认，不另写规则
 *
 * 名字只能来自手册图标目录（ACR-025）。这里走的就是观察层的匹配：图像向量召回 → 闸门 → 成对核验
 * （`recallCandidates` + `decideMatch`，M71-03 / M78）。**只收「闸门通过且核验为 same」的**，
 * 其余一律丢——一条标错的训练标签比少一条更糟（它会教模型把 A 认成 B）。
 *
 * # 输入 / 输出
 *
 * 输入 `pick_positives.py` 出的 `candidates.json`（每枚灯的整帧像素框 + crop PNG）。
 * 输出 `labels.json`：每枚灯的 symbolId 与核验结果。按类别分组的联系表由 `pick_positives.py --sheet-by-class` 出，人眼抽查用。
 *
 * 用法：
 *   node --import tsx evals/vision-observe/tools/label-positives.mts <positives 目录> [--limit N]
 *   # 要 DASHSCOPE_API_KEY（向量）、DEEPSEEK_API_KEY（核验）、本机 PG（kb:icons 已建索引）
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 经相对路径而不是包名：评测目录不是 workspace 成员，根 node_modules 里没有 @carlife/*
import { createIconEmbeddingRepository, getPrisma } from "../../../enterprise/backend/shared/db/src/index";
import { createDashScopeEmbedder, decideMatch, recallCandidates, type Candidate } from "../../../enterprise/backend/shared/rag/src/index";
import { createDeepSeekVisionProvider } from "../../../enterprise/backend/shared/tools/src/vision/index";

const ROOT = new URL("../../..", import.meta.url).pathname;
const VEHICLE = "Tesla Model 3/Y";

interface Cand {
  id: string;
  video: string;
  frame: string;
  screen: [number, number, number, number];
  bbox: [number, number, number, number];
  crop: string;
}
interface Label extends Cand {
  symbolId: string | null;
  verified: boolean;
  reason: string;
  top3: string[];
  sim: number | null;
}

const dir = process.argv[2];
if (!dir) throw new Error("用法：label-positives.mts <positives 目录>");
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;
for (const k of ["DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY"]) if (!process.env[k]) throw new Error(`${k} 为空——.env 里的变量要 set -a 导出`);

const { candidates } = JSON.parse(readFileSync(join(dir, "candidates.json"), "utf8")) as { candidates: Cand[] };
const prisma = getPrisma();
const store = createIconEmbeddingRepository(prisma);
const embedder = createDashScopeEmbedder({ apiKey: process.env.DASHSCOPE_API_KEY!, model: process.env.CARLIFE_ICON_EMBED_MODEL || undefined });
const verifier = createDeepSeekVisionProvider({ apiKey: process.env.DEEPSEEK_API_KEY! });
const iconsDir = `${ROOT}data/kb-src/icons/tesla-model3`;
const iconImage = (symbolId: string): Buffer | null => {
  const f = `${iconsDir}/${symbolId}.png`;
  return existsSync(f) ? readFileSync(f) : null;
};

const indexed = await store.countByVehicle(VEHICLE);
if (indexed === 0) throw new Error("库里没有 Tesla 的图标索引——先 corepack pnpm kb:icons data/kb-src/icons/tesla-model3-indicators.md");

const labels: Label[] = [];
let n = 0;
for (const c of candidates) {
  if (n >= LIMIT) break;
  n += 1;
  const w = c.bbox[2] - c.bbox[0];
  const h = c.bbox[3] - c.bbox[1];
  // 形状先筛：图标近似方形；横条（屏幕定位偏了裁到风景）与针尖一律不送去认
  if (w < 12 || h < 12 || w / h > 2.2 || h / w > 2.2) {
    labels.push({ ...c, symbolId: null, verified: false, reason: `形状不像图标（${w}×${h}）`, top3: [], sim: null });
    continue;
  }
  const crop = readFileSync(c.crop); // pick_positives 存的就是 PNG
  try {
    const { candidates: cands } = await recallCandidates({ crop, vehicleModel: VEHICLE, k: 8 }, { embedder, store });
    const decision = await decideMatch(cands, crop, { iconImage, verifyPair: (a, b) => verifier.verifyPair(a, b) });
    const top3 = cands.slice(0, 3).map((x: Candidate) => x.symbolId);
    let symbolId: string | null = decision.matched && decision.verified ? decision.semantics.symbolId : null;
    let reason = decision.matched ? (decision.verified ? "通过且核验 same" : "通过但核验不是 same") : decision.reason;
    /*
     * 闸门卡在 below_delta 的，几乎全是「近光灯 vs 驻车灯」这一对——向量分不开两枚同形的绿灯（M71-03 记过的缺陷）。
     * 这时不猜、也不丢：拿 top-2 的两枚手册图标各做一次成对核验，**恰好一枚 same** 才收；两枚都 same 或都不 same 照样丢。
     */
    if (!symbolId && !decision.matched && /below_delta/.test(decision.reason) && cands.length >= 2) {
      const pair = cands.slice(0, 2);
      const verdicts = await Promise.all(pair.map(async (x: Candidate) => {
        const icon = iconImage(x.symbolId);
        return icon ? verifier.verifyPair(crop, icon) : "unsure";
      }));
      const same = pair.filter((_, i) => verdicts[i] === "same");
      if (same.length === 1) {
        symbolId = same[0].symbolId;
        reason = `below_delta → 逐枚核验：${pair.map((x, i) => `${x.symbolId}=${verdicts[i]}`).join("，")}`;
      } else {
        reason = `below_delta → 逐枚核验分不开：${pair.map((x, i) => `${x.symbolId}=${verdicts[i]}`).join("，")}`;
      }
    }
    labels.push({ ...c, symbolId, verified: symbolId !== null, reason, top3, sim: decision.matched ? decision.sim : null });
    process.stderr.write(`${c.id.padEnd(28)} ${symbolId ? "✓ " + symbolId : "✗"} ${reason} top3=[${top3.join(", ")}]\n`);
  } catch (e) {
    labels.push({ ...c, symbolId: null, verified: false, reason: `出错：${(e as Error).message.slice(0, 120)}`, top3: [], sim: null });
  }
}
await prisma.$disconnect();

const byClass = new Map<string, Label[]>();
for (const l of labels) byClass.set(l.symbolId ?? "（未认出）", [...(byClass.get(l.symbolId ?? "（未认出）") ?? []), l]);
const summary = Object.fromEntries([...byClass.entries()].map(([k, v]) => [k, v.length]));
writeFileSync(join(dir, "labels.json"), JSON.stringify({ summary, labels }, null, 1));

// 按类别分组的联系表由 pick_positives.py --sheet-by-class labels.json 出（PIL 在那边；评测目录没有 sharp）
console.log(JSON.stringify({ total: labels.length, summary }, null, 1));
