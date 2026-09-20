/**
 * ACR-050 端到端冒烟：经 runtime 真正用的那个客户端（`yolo.ts` 的 provider）打检测服务，确认出框。
 *
 * 它回答三个问题，都是线上踩过或差点踩的：
 *  1. 那个地址上**有没有人**——2026-09-20 线上配了 yolo 却没有 YOLO 服务，ECONNREFUSED，全程零报错；
 *  2. 应答的是**谁**——`vision-infer`（线上只推理）还是 `vision-trainer`（本机内部工具），两者接口同形，得看 /health 才分得出；
 *  3. 它跑的模型是不是**配置里写的那个**——模型号对不上时 vision-infer 回 404 而不是来者不拒。
 *
 * 用法：
 *   corepack pnpm probe:vision-infer                       # 缺省 VISION_TRAINER_URL 或 http://localhost:8799
 *   corepack pnpm probe:vision-infer http://host:8799      # 指定地址
 * 模型号取 CARLIFE_VISION_YOLO_MODEL；没设就从端上那份 MODEL.md 读（两边本该是同一个）。
 * 零密钥、零 LLM：只打检测这一遍。
 */
import { readFileSync } from "node:fs";

import { createYoloDetectProvider } from "../../../enterprise/backend/shared/tools/src/vision/yolo";

const ROOT = new URL("../../../", import.meta.url).pathname;
const MODEL_DIR = `${ROOT}clients/shared/rust/carlife-vision/`;
const FIXTURE = `${MODEL_DIR}tests/fixtures/store-03-parked`;

const baseURL = (process.argv[2] || process.env.VISION_TRAINER_URL || "http://localhost:8799").replace(/\/$/, "");
const fromDoc = /`(train-[A-Za-z0-9_-]+)`/.exec(readFileSync(`${MODEL_DIR}models/MODEL.md`, "utf8"))?.[1];
const model = process.env.CARLIFE_VISION_YOLO_MODEL?.trim() || fromDoc;
if (!model) throw new Error("读不到模型号：设 CARLIFE_VISION_YOLO_MODEL，或检查 carlife-vision/models/MODEL.md");

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

let health: { service?: string; model?: string; version?: string; ok?: boolean } = {};
try {
  health = (await (await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(5000) })).json()) as typeof health;
} catch (e) {
  fail(`${baseURL} 没有人应答（${(e as Error).cause ? String(((e as Error).cause as { code?: string }).code) : (e as Error).message}）——检测那一遍会每次失败、退到兜底定位`);
}
const who = health.service === "vision-infer" ? `vision-infer（只推理，模型 ${health.model}）` : "vision-trainer（本机内部工具——别把它放到对外服务背后，ACR-026）";
console.log(`· ${baseURL} 应答的是 ${who}`);
if (fromDoc && model !== fromDoc) console.log(`⚠ 配置的模型 ${model} ≠ 端上内置的 ${fromDoc}：网页版与原生端框的不是同一个模型`);

const expected = JSON.parse(readFileSync(`${FIXTURE}.expected.json`, "utf8")) as { detections: { name: string; bbox: number[] }[] };
const provider = createYoloDetectProvider({ baseURL, model, conf: 0.3, imgsz: 960 });
const t0 = Date.now();
const result = await provider.detect(readFileSync(`${FIXTURE}.jpg`)).catch((e: Error) => fail(`检测失败：${e.message}`));
const ms = Date.now() - t0;

const got = result.items.map((i) => `${i.symbolHint ?? "?"} ${Math.round(i.confidence * 100)}% [${i.bbox.join(",")}]`);
console.log(`· 出 ${result.items.length} 框（${ms} ms，含网络）：${got.join("；")}`);
for (const e of expected.detections) {
  const hit = result.items.find((i) => i.symbolHint === e.name && i.bbox.every((v, k) => Math.abs(v - e.bbox[k]) <= 8));
  if (!hit) fail(`夹具里的 ${e.name} [${e.bbox.join(",")}] 没对上——前后处理与端上不是同一个口径`);
}
console.log(`✓ 与端上夹具一致（${expected.detections.length} 框，0–1000 坐标各差 ≤ 8）`);
