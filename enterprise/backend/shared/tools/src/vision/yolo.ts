/**
 * 端侧检测器当第一遍（施工单 M80-07）：YOLO 只做「框在哪」，不做「是什么」。
 *
 * # 它在链路里的位置
 *
 * 观察层是两遍：整图定位 → 逐 crop 描述。这里把第一遍换成 M76 / M79 训出来的 yolo11n，
 * 经检测器训练服务（`VISION_TRAINER_URL`，`POST /predict`）推理。第二遍照旧交给云端视觉模型——
 * `composeVisionProvider(yolo, describeProvider)`。
 *
 * # 类别名不进结果
 *
 * 检测器会给每个框一个类别名（`seatbelt_unfastened` 之类），**这里故意丢掉**：链路里名称与级别
 * 只来自手册图标目录（ACR-025），而 2026-09-09 实测它在真实照片上框对了两个灯、名字却全叫错
 * （把驻车灯叫 `regen_limited`、把安全带叫 `airbag_warning`）。带出去只会误导下游。
 * 所有框统一记 `category: "warning_light"`——这个检测器只训过警示灯。
 * 类别名以 `symbolHint` 带下去（M80-15）：它不是结论，观察节点只在目录匹配失败时拿它说「疑似」。
 *
 * # 它不知道的事
 *
 * 画面有没有裁到边（`cut_off_sides`）、糊不糊、有没有眩光——YOLO 一概不知道，`frame` 里全留空。
 * 这是它与视觉模型定位的一个真实差距，评测里的 V-Q1 会如实变差。
 *
 * # 绝不抛到上层之外
 *
 * 服务没起、模型不存在、HTTP 出错都抛 `VisionProviderError`，由 `observePhoto` 收成 `unreadable`。
 * `describe` / `verifyPair` 也抛——它没有这两个能力，`composeVisionProvider` 不会把这两遍派给它。
 */

import { DetectResultSchema, type BBox, type DetectResult } from "./schema";
import { VisionProviderError, type VisionProvider } from "./provider";

export interface YoloDetectOptions {
  /** 检测器训练服务地址（`VISION_TRAINER_URL`），如 `http://localhost:8799`。 */
  baseURL: string;
  /** 训练任务 id（`GET /models` 里的 `id`），如 `train-20260909-141540-e8c0`。 */
  model: string;
  /** 置信阈值，缺省 0.3——G 版权重（M80-15）在 12 张没见过的照片上 0.25 与 0.3 认对同为 26/35、多报 15 → 13；M79 的负样本筛选仍用 0.25。 */
  conf?: number;
  /**
   * 推理边长，缺省 960 = **训练尺寸**。2026-09-10 实测同一个模型同一张图：1280 时驻车灯置信 0.28、21 张负样本误报 13 框；
   * 960 时置信 0.78、误报 5 框，召回不变；1600 以上一个框都不出。推理尺寸离训练尺寸越远越差，不是越大越清楚。
   */
  imgsz?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** 训练服务 `POST /predict` 的响应（只取用到的字段）。 */
interface PredictResponse {
  ok?: boolean;
  detections?: Array<{ name?: string; conf: number; xyxy: [number, number, number, number] }>;
  imageW?: number;
  imageH?: number;
  ms?: number;
  error?: string;
  detail?: unknown;
}

const contentTypeOf = (image: Buffer): string =>
  image.length > 8 && image[0] === 0x89 && image[1] === 0x50 ? "image/png" : "image/jpeg";

/** 像素框 → 0–1000 归一化整数框；贴边裁剪，退化成空框的丢弃（schema 要求右下严格大于左上）。 */
export function toNormalizedBBox(xyxy: readonly number[], width: number, height: number): BBox | null {
  if (width <= 0 || height <= 0) return null;
  const clamp = (v: number): number => Math.max(0, Math.min(1000, Math.round(v)));
  const x1 = clamp((xyxy[0] / width) * 1000);
  const y1 = clamp((xyxy[1] / height) * 1000);
  const x2 = clamp((xyxy[2] / width) * 1000);
  const y2 = clamp((xyxy[3] / height) * 1000);
  if (x2 <= x1 || y2 <= y1) return null;
  return [x1, y1, x2, y2];
}

export function createYoloDetectProvider(opts: YoloDetectOptions): VisionProvider {
  const baseURL = opts.baseURL.replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  const conf = opts.conf ?? 0.3;
  const imgsz = opts.imgsz ?? 960;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const label = `yolo:${opts.model}`;

  async function detect(image: Buffer): Promise<DetectResult> {
    const url = `${baseURL}/predict?model=${encodeURIComponent(opts.model)}&conf=${conf}&imgsz=${imgsz}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": contentTypeOf(image) },
        body: new Uint8Array(image),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new VisionProviderError(`检测器训练服务不可达（${baseURL}）：${(e as Error).message}`, e);
    }
    const json = (await res.json().catch(() => ({}))) as PredictResponse;
    if (!res.ok) {
      throw new VisionProviderError(`检测器 ${label} HTTP ${res.status}: ${JSON.stringify(json.detail ?? json.error ?? json).slice(0, 200)}`);
    }
    const width = json.imageW ?? 0;
    const height = json.imageH ?? 0;
    const items = (json.detections ?? [])
      .map((d) => {
        const bbox = toNormalizedBBox(d.xyxy, width, height);
        // 类别名只作 symbolHint（候选），名称结论仍只能来自手册图标目录（文件头）。
        if (!bbox) return null;
        const hint = typeof d.name === "string" && d.name.trim() ? d.name.trim() : undefined;
        return { category: "warning_light" as const, bbox, confidence: Math.max(0, Math.min(1, d.conf)), ...(hint ? { symbolHint: hint } : {}) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return DetectResultSchema.parse({ frame: { quality: {}, cut_off_sides: [], item_count: items.length }, items });
  }

  const notMine = (what: string) => async (): Promise<never> => {
    throw new VisionProviderError(`${label} 只做检测，不做${what}——第二遍要交给视觉模型（composeVisionProvider）`);
  };

  return {
    name: "yolo",
    models: { detect: label, describe: "-" },
    detect,
    describe: notMine("描述"),
    verifyPair: notMine("成对核验"),
  };
}
