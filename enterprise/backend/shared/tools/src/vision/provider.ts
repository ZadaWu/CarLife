/**
 * 视觉模型的适配器（施工单 M71-02，ACR-024）。
 *
 * 上层只认 `VisionProvider` 三个方法：检测、描述、成对核验。DashScope 是当前实现，
 * 换模型、换厂商、私有化都在这一层之后——「可私有化」这句话成立的前提是业务代码里
 * 没有一处直接写 DashScope 的请求。
 *
 * # 四个档位（`CARLIFE_VISION`）
 *
 * - `dashscope`（缺省）：真实调用，`qwen3-vl-flash` 检测、`qwen3-vl-plus` 描述。
 * - `deepseek`：同一套提示词与 schema 换 DeepSeek 视觉档（M80-05）。
 * - `fake`：按图片内容哈希回放 `fixtures/by-sha/<sha8>.json`，零网络、确定性——离线与 fake 档评测用。
 * - `off`：`createVisionProviderFromEnv()` 返回 null，上游节点直通并写 caveat。
 *
 * # 两遍可以来自两家
 *
 * 检测（整图定位）与描述（逐 crop）是两种能力，实测强弱不在同一家手里：
 * 2026-09-09 同一份提示词、同一张 tesla-01，qwen3-vl-plus 的 bbox 平均 IoU 0.936、
 * DeepSeek v4.1-flash 只有 0.643（它按约 800×800 等效像素下采样，坐标精度是结构性的），
 * 而描述那一遍 DeepSeek 的形状一致率与元素 Jaccard 反过来更高、快两个数量级。
 * 所以 `createVisionProviderFromEnv` 允许两遍各选各的（`CARLIFE_VISION_DETECT_PROVIDER` /
 * `CARLIFE_VISION_DESCRIBE_PROVIDER`），缺省仍是两遍都 DashScope。
 *
 * # 解析失败重跑一次
 *
 * JSON 偶发截断是这类接口的常态；第二次仍失败才算它的，抛 `VisionProviderError`，
 * 由 `observePhoto` 降级成 `unreadable`——绝不让整轮对话因为一张图失败。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ALERTS_PROMPT, AlertReadingSchema, type AlertReading } from "./alerts";
import { DESCRIBE_PROMPT, DETECT_PROMPT, VERIFY_PROMPT } from "./prompts";
import { createYoloDetectProvider } from "./yolo";
import {
  DescriptorSchema,
  DetectResultSchema,
  PairVerdictSchema,
  type BBox,
  type Descriptor,
  type DetectResult,
  type PairVerdict,
} from "./schema";

export interface DescribeContext {
  bbox: BBox;
  category: string;
}

export interface VisionProvider {
  readonly name: string;
  readonly models: { detect: string; describe: string };
  detect(image: Buffer): Promise<DetectResult>;
  /**
   * 第一遍**一个框都没出**时的兜底定位（2026-09-19 用户走查）。可选；两遍同一家时没有这个方法。
   *
   * 它兑现的是 ACR-045 写下的那句「云端定位从此只是兜底，不是缺省」——在那之前这句话没有落点，
   * 端侧检测器零框就是零框。而零框会沿着整条链静默塌掉：没有框 → 没有 crop → 第二遍不跑 →
   * 手册目录无从匹配 → 车主拿到「照片里没有辨识出指示符号」，而屏幕上明明亮着四盏灯。
   *
   * 触发条件严格限定在**零框**，不是"框少了"或"置信低了"：端侧检测器出了框就以它为准
   * （它在训练分布内比云端准），只有它什么都没说时才问第二个人。
   */
  detectFallback?(image: Buffer): Promise<DetectResult>;
  describe(crop: Buffer, ctx: DescribeContext): Promise<Descriptor>;
  verifyPair(userCrop: Buffer, catalogIcon: Buffer): Promise<PairVerdict>;
  /**
   * 读车机「警报」列表页上的代码与文字（M80-10）。**可选**：端侧检测器与 fake 档没有这个能力，
   * 上游拿不到就跳过这一遍（照片仍走图标观察那条路），不抛。
   */
  readAlerts?(image: Buffer): Promise<AlertReading>;
}

export class VisionProviderError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "VisionProviderError";
  }
}

export const DEFAULT_DETECT_MODEL = "qwen3-vl-flash";
export const DEFAULT_DESCRIBE_MODEL = "qwen3-vl-plus";
export const DASHSCOPE_COMPAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEEPSEEK_URL = "https://api.deepseek.com";
/**
 * DeepSeek 视觉档（M80-05）。两遍用同一个模型——它没有分档。
 * 2026-09-10 起是正式名 `deepseek-flash`（V4.1 Flash）；对照时用的预览档
 * `deepseek-v4.1-flash-expires-on-0910` 已被别名到它，指纹一致，所以那份对照数据仍然作数。
 */
export const DEFAULT_DEEPSEEK_VISION = "deepseek-flash";

export interface DashScopeVisionOptions {
  apiKey: string;
  baseURL?: string;
  detectModel?: string;
  describeModel?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface OpenAICompatVisionOptions extends DashScopeVisionOptions {
  /** `provider.name`，进轨迹与报告。 */
  name: string;
  /** 并进请求体的固定字段（DeepSeek 的关思考开关走这里）。 */
  extraBody?: Record<string, unknown>;
}

/** 剥掉 markdown 围栏，取第一个 `{` 到最后一个 `}`。 */
export function extractJsonObject(text: string): string {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const a = stripped.indexOf("{");
  const b = stripped.lastIndexOf("}");
  return a >= 0 && b > a ? stripped.slice(a, b + 1) : stripped;
}

const dataUrl = (image: Buffer): string => {
  const isPng = image.length > 8 && image[0] === 0x89 && image[1] === 0x50;
  return `data:${isPng ? "image/png" : "image/jpeg"};base64,${image.toString("base64")}`;
};

export function createOpenAICompatVisionProvider(opts: OpenAICompatVisionOptions): VisionProvider {
  const baseURL = (opts.baseURL ?? DASHSCOPE_COMPAT_URL).replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const models = { detect: opts.detectModel ?? DEFAULT_DETECT_MODEL, describe: opts.describeModel ?? DEFAULT_DESCRIBE_MODEL };

  async function chat(model: string, system: string, images: Buffer[], userText: string): Promise<string> {
    const res = await doFetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        ...opts.extraBody,
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [...images.map((img) => ({ type: "image_url", image_url: { url: dataUrl(img) } })), { type: "text", text: userText }],
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown };
    if (!res.ok) throw new VisionProviderError(`${opts.name} ${model} HTTP ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 200)}`);
    return json.choices?.[0]?.message?.content ?? "";
  }

  /** 解析 + schema 校验；失败重跑一次。 */
  async function chatJson<T>(model: string, system: string, images: Buffer[], userText: string, parse: (raw: unknown) => T): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const text = await chat(model, system, images, userText);
      try {
        return parse(JSON.parse(extractJsonObject(text)));
      } catch (e) {
        lastErr = e;
      }
    }
    throw new VisionProviderError(`两次均不可解析：${String((lastErr as Error)?.message ?? lastErr)}`, lastErr);
  }

  return {
    name: opts.name,
    models,
    detect: (image) => chatJson(models.detect, DETECT_PROMPT, [image], "按系统提示词检测并定位这张照片里的符号。", (raw) => DetectResultSchema.parse(raw)),
    describe: (crop) => chatJson(models.describe, DESCRIBE_PROMPT, [crop], "按系统提示词描述画面中央的这一个符号。", (raw) => DescriptorSchema.parse(raw)),
    verifyPair: (a, b) =>
      chatJson(models.describe, VERIFY_PROMPT, [a, b], "第一张是车主照片裁下的符号，第二张是手册图标。是否同一符号？", (raw) => PairVerdictSchema.parse(raw).verdict),
    // 用描述那一档：读小字要的是同一种细节能力，而检测档是为定位调的便宜档。
    readAlerts: (image) =>
      chatJson(models.describe, ALERTS_PROMPT, [image], "按系统提示词把这张车机截图上的警报列表抄下来。", (raw) => AlertReadingSchema.parse(raw)),
  };
}

/** 通义千问视觉档（缺省）：`qwen3-vl-flash` 检测、`qwen3-vl-plus` 描述。 */
export function createDashScopeVisionProvider(opts: DashScopeVisionOptions): VisionProvider {
  return createOpenAICompatVisionProvider({ ...opts, name: "dashscope", baseURL: opts.baseURL ?? DASHSCOPE_COMPAT_URL });
}

/**
 * DeepSeek 视觉档（M80-05）。
 *
 * ⚠️ **必须显式关思考**：DeepSeek v4 全系默认 `thinking: enabled`，实测同一张图 600 token 预算
 * 全烧在 `reasoning_content` 上、`content` 是空字符串——上层看到的是「两次均不可解析」，
 * 离根因很远。关掉后同一张图 1.1 s、84 token 出正文。同 `llm/thinking-policy.ts` 的纪律。
 */
export function createDeepSeekVisionProvider(opts: DashScopeVisionOptions): VisionProvider {
  return createOpenAICompatVisionProvider({
    ...opts,
    name: "deepseek",
    baseURL: opts.baseURL ?? DEEPSEEK_URL,
    detectModel: opts.detectModel ?? DEFAULT_DEEPSEEK_VISION,
    describeModel: opts.describeModel ?? DEFAULT_DEEPSEEK_VISION,
    extraBody: { thinking: { type: "disabled" } },
  });
}

// ── fake ─────────────────────────────────────────────────────

export const sha8 = (image: Buffer): string => createHash("sha256").update(image).digest("hex").slice(0, 8);

/**
 * fixture 的形状就是评测集 `fixtures/*.json` 的形状（整图观察：frame + items 含描述子与 bbox）。
 * `detect` 取 frame 与各项的 category / bbox / confidence；`describe` 按 bbox 找回同一项的描述子。
 */
interface FixtureItem extends Descriptor {
  bbox: BBox;
}
interface Fixture {
  frame: DetectResult["frame"];
  items: FixtureItem[];
}

export interface FakeVisionOptions {
  /** `by-sha/<sha8>.json` 所在目录。 */
  fixturesDir: string;
}

export function createFakeVisionProvider(opts: FakeVisionOptions): VisionProvider {
  let current: Fixture | null = null;
  const load = (image: Buffer): Fixture => {
    const p = join(opts.fixturesDir, `${sha8(image)}.json`);
    if (!existsSync(p)) throw new VisionProviderError(`无 fixture：${p}`);
    const raw = JSON.parse(readFileSync(p, "utf8")) as Fixture;
    return raw;
  };
  return {
    name: "fake",
    models: { detect: "fake", describe: "fake" },
    async detect(image) {
      current = load(image);
      return DetectResultSchema.parse({
        frame: current.frame,
        items: current.items.map((it) => ({ category: it.category, bbox: it.bbox, confidence: it.confidence ?? 1 })),
      });
    },
    async describe(_crop, ctx) {
      const hit = current?.items.find((it) => it.bbox.every((v, i) => v === ctx.bbox[i]));
      if (!hit) throw new VisionProviderError(`fixture 里没有 bbox 为 [${ctx.bbox}] 的项`);
      const { bbox: _bbox, ...desc } = hit;
      return DescriptorSchema.parse(desc);
    },
    async verifyPair(a, b) {
      return a.equals(b) ? "same" : "unsure";
    },
  };
}

// ── env ──────────────────────────────────────────────────────

export type VisionMode = "dashscope" | "deepseek" | "fake" | "off";
/** 两遍各自可以指向哪一家。`yolo` 只能当检测那一遍（M80-07，见 yolo.ts）。 */
export type VisionVendor = "dashscope" | "deepseek" | "yolo";

export function visionModeFromEnv(env: NodeJS.ProcessEnv = process.env): VisionMode {
  const v = (env.CARLIFE_VISION ?? "dashscope").trim().toLowerCase();
  if (v === "fake" || v === "off" || v === "deepseek") return v;
  return "dashscope";
}

const vendorOf = (raw: string | undefined, fallback: VisionVendor): VisionVendor => {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "deepseek" || v === "dashscope" || v === "yolo" ? v : fallback;
};

/**
 * 一家的真实 provider；缺密钥就抛，让启动期而不是第一张照片发现。
 *
 * 两个模型名的环境变量是**按角色**给的（`..._DETECT_MODEL` / `..._DESCRIBE_MODEL`），
 * 混搭时各自只作用在自己那一遍上——否则给 DeepSeek 的那一遍会被塞进一个 qwen 的模型名。
 */
function realProvider(vendor: VisionVendor, env: NodeJS.ProcessEnv): VisionProvider {
  const detectModel = env.CARLIFE_VISION_DETECT_MODEL || undefined;
  const describeModel = env.CARLIFE_VISION_DESCRIBE_MODEL || undefined;
  if (vendor === "yolo") {
    const baseURL = env.VISION_TRAINER_URL?.trim();
    const model = env.CARLIFE_VISION_YOLO_MODEL?.trim();
    if (!baseURL) throw new VisionProviderError("检测那一遍选了 yolo 但 VISION_TRAINER_URL 为空");
    if (!model) throw new VisionProviderError("检测那一遍选了 yolo 但 CARLIFE_VISION_YOLO_MODEL 为空（训练任务 id）");
    const num = (raw: string | undefined, fallback: number): number => {
      const n = Number(raw);
      return raw && Number.isFinite(n) && n > 0 ? n : fallback;
    };
    return createYoloDetectProvider({ baseURL, model, conf: num(env.CARLIFE_VISION_YOLO_CONF, 0.3), imgsz: num(env.CARLIFE_VISION_YOLO_IMGSZ, 960) });
  }
  if (vendor === "deepseek") {
    const key = env.DEEPSEEK_API_KEY;
    if (!key) throw new VisionProviderError("视觉档选了 deepseek 但 DEEPSEEK_API_KEY 为空");
    return createDeepSeekVisionProvider({ apiKey: key, baseURL: env.DEEPSEEK_BASE_URL || undefined, detectModel, describeModel });
  }
  const key = env.DASHSCOPE_API_KEY;
  if (!key) throw new VisionProviderError("视觉档选了 dashscope 但 DASHSCOPE_API_KEY 为空");
  return createDashScopeVisionProvider({ apiKey: key, detectModel, describeModel });
}

/**
 * 两遍来自两家时的组合体：`detect` 走一家、`describe` 与 `verifyPair` 走另一家。
 *
 * `verifyPair` 与 `readAlerts` 都跟着 describe——它们和描述是同一种能力（看清一个符号 / 一行小字长什么样），
 * 而与「在整张照片里找出符号在哪」不是一回事。
 *
 * **describe 那一家顺带当零框兜底**（`detectFallback`，2026-09-19）：它是个视觉模型，本来就会整图定位，
 * 只是精度不如专训的检测器，所以平时不用它。零框时不用白不用——那一刻的对照项是"什么都没有"。
 */
export function composeVisionProvider(detect: VisionProvider, describe: VisionProvider): VisionProvider {
  if (detect === describe) return detect;
  return {
    name: `${detect.name}+${describe.name}`,
    models: { detect: detect.models.detect, describe: describe.models.describe },
    detect: (image) => detect.detect(image),
    detectFallback: (image) => describe.detect(image),
    describe: (crop, ctx) => describe.describe(crop, ctx),
    verifyPair: (a, b) => describe.verifyPair(a, b),
    // 读警报页也跟着 describe（同一种"看清小字"的能力）；那一家没有就整个不给，上游跳过这一遍。
    ...(describe.readAlerts ? { readAlerts: (image: Buffer) => describe.readAlerts!(image) } : {}),
  };
}

/**
 * 检测那一遍的缺省档（ACR-045：云端定位退役）。
 *
 * 没显式选时：训练服务与权重都配了 → `yolo`；否则退回 `base`（dashscope / deepseek）并给一句原因——
 * 云端定位从此只是**兜底**，不是缺省。显式 `CARLIFE_VISION_DETECT_PROVIDER=dashscope` 仍能选回（回滚就这一行）。
 * 端上带了框（ACR-045 `detections`）时这一遍根本不会被调用，缺省档只影响老端上 / 控制台 / 评测那些不带框的照片。
 */
export function defaultDetectVendor(env: NodeJS.ProcessEnv, base: VisionVendor): { vendor: VisionVendor; reason: string } {
  const explicit = (env.CARLIFE_VISION_DETECT_PROVIDER ?? "").trim();
  if (explicit) return { vendor: vendorOf(explicit, base), reason: `显式 CARLIFE_VISION_DETECT_PROVIDER=${explicit}` };
  const trainer = (env.VISION_TRAINER_URL ?? "").trim();
  const model = (env.CARLIFE_VISION_YOLO_MODEL ?? "").trim();
  if (trainer && model) return { vendor: "yolo", reason: "缺省：训练服务与权重已配，端侧检测器定位" };
  return { vendor: base, reason: `云端定位已退役，仅作兜底——缺 ${trainer ? "CARLIFE_VISION_YOLO_MODEL" : "VISION_TRAINER_URL"}，本机暂用 ${base} 定位` };
}

/** `off` → null（上游直通并写 caveat）；真实档缺密钥 → 抛错，让启动期就发现。 */
export function createVisionProviderFromEnv(env: NodeJS.ProcessEnv = process.env): VisionProvider | null {
  const mode = visionModeFromEnv(env);
  if (mode === "off") return null;
  if (mode === "fake") {
    return createFakeVisionProvider({ fixturesDir: env.CARLIFE_VISION_FIXTURES ?? join(process.cwd(), "evals/vision-observe/fixtures/by-sha") });
  }
  const base: VisionVendor = mode === "deepseek" ? "deepseek" : "dashscope";
  const detect = defaultDetectVendor(env, base).vendor;
  const describe = vendorOf(env.CARLIFE_VISION_DESCRIBE_PROVIDER, base);
  if (describe === "yolo") throw new VisionProviderError("描述那一遍不能选 yolo——它只会框位置，不会说这是什么");
  // 同一家时只造一个——两遍共用一条连接，`name` 也就不会写成「dashscope+dashscope」。
  if (detect === describe) return realProvider(detect, env);
  return composeVisionProvider(realProvider(detect, env), realProvider(describe, env));
}
