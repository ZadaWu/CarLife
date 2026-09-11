/**
 * 「模型训练」页的纯函数（施工单 M76-03）：错误码 → 人话、任务进度、真值框归一化 → 像素、叠框缩放。
 * 页面不算任何指标——数字只显示服务给的。
 */

export interface ModelView {
  id: string;
  name: string;
  dataset: string | null;
  base: string | null;
  createdAt: string | null;
  status: string | null;
  epochsRun: number | null;
  mAP50: number | null;
  mAP50_95: number | null;
  perClass: Record<string, number> | null;
  classes: string[] | null;
  weightsBytes: number;
  onnx: boolean;
  onnxBytes: number | null;
}

export interface DatasetView {
  name: string;
  classes: string[];
  train: number;
  val: number;
}

export interface TruthItem {
  bbox: [number, number, number, number] | null;
  category: string | null;
  symbol_id: string | null;
  color?: string | null;
  state?: string | null;
}

export interface PhotoView {
  id: string;
  file: string;
  vehicle: string | null;
  negative: boolean;
  items: TruthItem[];
}

export interface ProgressLine {
  epoch: number;
  epochs: number;
  mAP50?: number;
  mAP50_95?: number;
  box_loss?: number;
  cls_loss?: number;
}

export interface JobView {
  id: string;
  kind: "train" | "val" | "export";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  params: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  progress: ProgressLine | null;
  report?: { steps?: Record<string, Record<string, unknown>> };
  hasWeights: boolean;
  hasOnnx: boolean;
}

export interface Detection {
  cls: number;
  name: string;
  conf: number;
  xyxy: [number, number, number, number];
}

export interface PredictResult {
  ok: boolean;
  detections: Detection[];
  imageW: number;
  imageH: number;
  ms: number;
  model: string;
  conf: number;
}

export interface PixelBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
}

export function errorMessage(code: string): string {
  switch (code) {
    case "vision_trainer_not_configured":
      return "服务未启用：在 .env 里设 VISION_TRAINER_URL=http://localhost:8799（或在后台「配置」里改），然后 corepack pnpm dev:restart gateway";
    case "vision_trainer_unreachable":
      return "服务没起来：corepack pnpm dev:restart vision-trainer";
    case "forbidden":
      return "发起、取消与删除是管理员动作；当前角色只能查看";
    case "dataset_not_found":
      return "数据集不存在：把 YOLO 格式的数据集放到 evals/vision-observe/datasets/<名>/";
    case "model_not_found":
      return "模型不存在（任务目录里没有 weights/best.pt）";
    case "predict_failed":
      return "推理失败：看 .dev-logs/vision-trainer.log";
    case "invalid_params":
      return "参数不合法：轮数 1～300、批大小 1～64、图片尺寸只能是 320 / 480 / 640 / 960";
    default:
      return `请求失败：${code}`;
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "done":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

export function kindLabel(kind: string): string {
  return kind === "train" ? "训练" : kind === "val" ? "验证" : kind === "export" ? "导出 ONNX" : kind;
}

/** 训练按轮数算百分比；验证 / 导出没有中间进度，只有跑没跑完。 */
export function percentOf(job: Pick<JobView, "kind" | "status" | "progress">): number | null {
  if (job.status === "done") return 100;
  if (job.kind !== "train" || !job.progress || !job.progress.epochs) return null;
  return Math.min(100, Math.round((job.progress.epoch / job.progress.epochs) * 100));
}

export function isActive(status: string): boolean {
  return status === "queued" || status === "running";
}

/** 真值框是 0–1000 归一化的 [x1,y1,x2,y2]，转成原图像素。 */
export function normalizeTruthBox(bbox: [number, number, number, number], imageW: number, imageH: number): [number, number, number, number] {
  const [x1, y1, x2, y2] = bbox;
  return [(x1 / 1000) * imageW, (y1 / 1000) * imageH, (x2 / 1000) * imageW, (y2 / 1000) * imageH];
}

/** 原图像素框等比缩放到画布宽度；返回缩放比、画布高与缩放后的框。 */
export function fitBoxes(boxes: PixelBox[], imageW: number, imageH: number, canvasW: number): { scale: number; canvasH: number; boxes: PixelBox[] } {
  if (imageW <= 0 || imageH <= 0) return { scale: 1, canvasH: 0, boxes: [] };
  const scale = canvasW / imageW;
  return {
    scale,
    canvasH: Math.round(imageH * scale),
    boxes: boxes.map((b) => ({ ...b, x1: b.x1 * scale, y1: b.y1 * scale, x2: b.x2 * scale, y2: b.y2 * scale })),
  };
}

export function truthBoxes(photo: PhotoView | null, imageW: number, imageH: number): PixelBox[] {
  if (!photo) return [];
  return photo.items
    .filter((it) => it.bbox && it.category === "warning_light")
    .map((it) => {
      const [x1, y1, x2, y2] = normalizeTruthBox(it.bbox as [number, number, number, number], imageW, imageH);
      return { x1, y1, x2, y2, label: it.symbol_id ?? "?" };
    });
}

export function detectionBoxes(dets: Detection[]): PixelBox[] {
  return dets.map((d) => ({ x1: d.xyxy[0], y1: d.xyxy[1], x2: d.xyxy[2], y2: d.xyxy[3], label: `${d.name} ${d.conf.toFixed(2)}` }));
}

export type ProgressEvent = { type: "progress"; job: JobView } | { type: "done"; status: string; error?: string };

export interface ProgressState {
  job: JobView | null;
  finished: boolean;
}

export function applyProgress(state: ProgressState, ev: ProgressEvent): ProgressState {
  if (ev.type === "progress") return { job: ev.job, finished: false };
  return { job: state.job ? { ...state.job, status: ev.status as JobView["status"], error: ev.error ?? state.job.error } : null, finished: true };
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtMetric(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toFixed(3);
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
