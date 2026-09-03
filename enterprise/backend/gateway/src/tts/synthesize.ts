/**
 * 服务端合成（M60-02）——**「文本 → 音频字节」在网关这一侧的唯一实现**。
 *
 * # 为什么网关需要一份
 *
 * 两个消费方：控制台回放（第一次点播放时按当时档位补合成，存进对象存储，
 * 之后不再向供应商要第二次），以及**端上播报**——自 ACR-018 起端上不再直连
 * 任何供应商，`/v1/tts/speech` 收到请求后就是调本模块。
 *
 * 改之前只有前者：端上拿着 `/v1/tts/config` 下发的供应商 URL 自己打，
 * 「豆包档直连火山，服务端全程看不见字节」。看不见就既拦不住（ACR-016 的
 * 日用量闸门）也换不掉（换供应商要发客户端版本）。
 *
 * # 三档的差别只在这一层
 *
 * 端上"换 URL 不换客户端"的不变量靠的是三档同协议（豆包 NDJSON）。
 * 到了服务端反而要拆开：aliyun 档的**真身**是 DashScope（回 OSS 音频 URL），
 * 豆包协议是我们自己在 `http/tts-aliyun.ts` 套上去的门面。这里直接调真身，
 * 不绕自己的门面——绕一圈只是把字节 base64 一遍再解回来。
 *
 * # 它不判断"该不该花这笔钱"
 *
 * 闸门（ACR-016）与鉴权都在调用方。本模块只负责"给我文本，还你字节"，
 * 失败一律抛 `TtsSynthesisError`，消息面向调用方而不是终端用户。
 */

import { resolveTts, type TtsEngine } from "@carlife/db";

/** 豆包协议的正常终止码，与 carlife-net::tts::CODE_DONE 同值。 */
const CODE_DONE = 20_000_000;
/** 与 registry / asr 侧默认值同源同值。 */
const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
/** 合成采样率，与端上 `carlife-net::tts::SAMPLE_RATE` 同值。 */
const SAMPLE_RATE = 24_000;

export class TtsSynthesisError extends Error {}

export interface SynthesizedAudio {
  bytes: Buffer;
  mime: string;
  /** 实际用来合成的档位（调用方可能只给了 `undefined` 让本模块问配置）。 */
  engine: TtsEngine;
  /** 音色（豆包 speaker / 百炼 voice）。 */
  voice: string;
}

export interface SynthesizeOptions {
  /** 指定档位；缺省用配置层当前值（`resolveTts`）。 */
  engine?: TtsEngine;
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * 豆包 NDJSON → 音频字节。端上 `parse_ndjson_audio` 的 TS 对侧，判据逐条对齐：
 * 非零且非终止码即业务错误；解析不了的行跳过而不是中断（元信息行就长那样）。
 */
export function parseDoubaoNdjson(body: string): Buffer {
  const chunks: Buffer[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: { code?: number; message?: string; data?: string | null };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    const code = parsed.code ?? 0;
    if (code !== 0 && code !== CODE_DONE) {
      throw new TtsSynthesisError(`合成失败 code=${code} ${parsed.message ?? ""}`.trim());
    }
    if (typeof parsed.data === "string" && parsed.data.length > 0) {
      chunks.push(Buffer.from(parsed.data, "base64"));
    }
  }
  const audio = Buffer.concat(chunks);
  if (audio.length === 0) throw new TtsSynthesisError("合成回包里没有音频");
  return audio;
}

/**
 * 豆包协议档（`doubao` 直连火山 / `mock` 打本机 mock-tts）。
 *
 * 两档共用一个函数，因为它们**就是同一套请求与响应**——这正是端上那条
 * "换 URL 不换客户端"不变量的内容。哪天不成立了，这里会先裂成两个。
 */
async function synthesizeDoubaoProtocol(
  url: string,
  apiKey: string,
  resourceId: string,
  speaker: string,
  text: string,
  doFetch: typeof fetch,
): Promise<Buffer> {
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      req_params: {
        text,
        speaker,
        audio_params: { format: "mp3", sample_rate: SAMPLE_RATE },
      },
    }),
  });
  if (!res.ok) {
    throw new TtsSynthesisError(`合成端点 status=${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return parseDoubaoNdjson(await res.text());
}

interface DashScopeTtsReply {
  output?: { audio?: { url?: string; data?: string } };
  code?: string;
  message?: string;
}

/**
 * 百炼档（`qwen3-tts-flash`）。非流式回的是 OSS 上的音频 URL（24h 有效），
 * 当场取回字节——URL 会过期，存一个链接等于存一个明年打不开的东西。
 *
 * 与 `http/tts-aliyun.ts` 那条门面路由共用本函数：门面只是把这里的字节
 * 再套成豆包 NDJSON 发给端上，DashScope 的调用形状只应存在一份。
 */
export async function synthesizeDashScope(
  values: ReadonlyMap<string, string>,
  text: string,
  voice: string,
  doFetch: typeof fetch,
): Promise<{ bytes: Buffer; mime: string }> {
  const key = values.get("DASHSCOPE_API_KEY");
  if (!key) {
    throw new TtsSynthesisError(
      "DASHSCOPE_API_KEY 未配置——aliyun 档不可用，请在后台配置或切回其它引擎",
    );
  }
  const baseUrl = values.get("DASHSCOPE_BASE_URL")?.trim() || DEFAULT_DASHSCOPE_BASE_URL;
  const model = values.get("ALIYUN_TTS_MODEL")?.trim() || "qwen3-tts-flash";

  const synth = await doFetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: { text, voice, language_type: "Chinese" } }),
  });
  if (!synth.ok) {
    throw new TtsSynthesisError(`dashscope status=${synth.status} ${(await synth.text()).slice(0, 200)}`);
  }
  const reply = (await synth.json()) as DashScopeTtsReply;
  if (typeof reply.code === "string" && reply.code.length > 0 && !reply.output) {
    throw new TtsSynthesisError(`dashscope ${reply.code} ${reply.message ?? ""}`.trim());
  }
  const audioUrl = reply.output?.audio?.url;
  if (!audioUrl) throw new TtsSynthesisError("dashscope 回包无音频 URL");

  const audioRes = await doFetch(audioUrl);
  if (!audioRes.ok) throw new TtsSynthesisError(`音频下载失败 status=${audioRes.status}`);
  const bytes = Buffer.from(await audioRes.arrayBuffer());
  if (bytes.length === 0) throw new TtsSynthesisError("音频下载为空");
  // 百炼当前回 wav；按 URL 后缀判而不是写死，换成 mp3 时这里不用回来改。
  return { bytes, mime: audioUrl.includes(".mp3") ? "audio/mpeg" : "audio/wav" };
}

/**
 * 按档位合成一段语音。
 *
 * `engine` 缺省取配置层当前档；显式传入时**音色也跟着那一档走**——
 * 拿豆包音色名去打 DashScope 会 400（`tts-aliyun.ts` 记着这次实测），
 * 所以音色的选取与档位在同一个分支里决定，不在调用方拼。
 */
export async function synthesizeSpeech(
  values: ReadonlyMap<string, string>,
  text: string,
  opts: SynthesizeOptions = {},
): Promise<SynthesizedAudio> {
  const doFetch = opts.fetchImpl ?? fetch;
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new TtsSynthesisError("文本为空，不合成");

  const engine = opts.engine ?? resolveTts(values).engine;

  if (engine === "aliyun") {
    const voice = values.get("ALIYUN_TTS_VOICE")?.trim() || "Cherry";
    const { bytes, mime } = await synthesizeDashScope(values, trimmed, voice, doFetch);
    return { bytes, mime, engine, voice };
  }

  // 豆包协议两档：URL 与"要不要真钥匙"不同，其余一致。
  const resolved = resolveTts(new Map([...values, ["TTS_ENGINE", engine]]));
  const speaker = resolved.speaker;
  if (engine === "doubao") {
    const key = values.get("BYTEDANCE_TTS_API_KEY")?.trim();
    if (!key) {
      // 与端上同一条纪律：没有真钥匙就明说，不拿占位值去打计费接口
      // ——那会变成一串 401，而日志只会说"合成失败"。
      throw new TtsSynthesisError(
        "BYTEDANCE_TTS_API_KEY 未配置——豆包档不可用，请在后台配置或切到其它引擎试听",
      );
    }
    const bytes = await synthesizeDoubaoProtocol(
      resolved.upstreamUrl,
      key,
      resolved.resourceId,
      speaker,
      trimmed,
      doFetch,
    );
    return { bytes, mime: "audio/mpeg", engine, voice: speaker };
  }

  // mock 档：本机 mock-tts 只校验请求头带没带 Key、不校验值。
  const bytes = await synthesizeDoubaoProtocol(
    resolved.upstreamUrl,
    values.get("BYTEDANCE_TTS_API_KEY")?.trim() || "mock-local",
    resolved.resourceId,
    speaker,
    trimmed,
    doFetch,
  );
  return { bytes, mime: "audio/mpeg", engine, voice: speaker };
}
