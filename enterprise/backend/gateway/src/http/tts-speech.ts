/**
 * 端上的合成端点——**三档共用的唯一一个**（ACR-018；aliyun 一档的门面形态由
 * ACR-015 先行验证）。
 *
 *   POST /v1/tts/speech   请求体 = 豆包 unidirectional 形状（req_params.text）
 *                         响应   = 豆包 NDJSON（{"code":0,"data":"<base64>"}… + 20000000 终止行）
 *
 * # 为什么端上只该有一个地址
 *
 * 改之前 `/v1/tts/config` 按档位下发不同地址：doubao 下发火山、mock 下发本机
 * mock-tts、只有 aliyun 下发网关自己。于是端上必须持有 `BYTEDANCE_TTS_API_KEY`
 * 才能打前两档——A 类密钥被要求**预先装在每一台车机上**，比下发还难收回；
 * ACR-016 的日用量闸门也看不见那两档的流量。
 *
 * 车机与手机是面向车主的消费端，它们只该认识一个后端。所以三档一律打这里，
 * 由本路由按当前档位分流（`tts/synthesize.ts` 的 `synthesizeSpeech`），
 * 密钥一律留在服务端。端上那条 vendor 路径随本单删除。
 *
 * # 协议转换也收在这一处
 *
 * `clients/shared/rust/carlife-net/src/tts.rs` 原来的不变量是"换 URL 不换客户端"——mock 与
 * 豆包同请求体同响应。qwen3-tts-flash 的协议长得完全不同（DashScope
 * multimodal-generation，音频回 OSS URL），在端上实现它就是把协议分裂带进每个端。
 * 现在这条不变量更强：端上**只有一个 URL**，协议差异全部消化在服务端。
 *
 * # 密钥边界
 *
 * `DASHSCOPE_API_KEY` 与 `BYTEDANCE_TTS_API_KEY` 都只在服务端被读取，
 * **永远不下发到端上**（§8.2 A 类只写不读）。端上打本端点带的是设备 JWT
 * （挂在网关鉴权中间件之后）；豆包协议的 `X-Api-Key` 请求头在这里被无视——
 * 端上已经没有任何 vendor 凭证可带，旧客户端带来的那个占位值也不参与鉴权。
 *
 * # 音色由服务端定
 *
 * 请求体里的 `req_params.speaker` **不再被采用**。它本来就是我们自己经
 * `/v1/tts/config` 下发的那一个，绕一圈回来没有新信息；而"拿豆包音色名去打
 * DashScope 会 400"（ACR-015 实测）这类坑，正是因为音色的选取与档位分了家。
 * 现在两者在 `synthesizeSpeech` 的同一个分支里决定。
 *
 * # 失败形态
 *
 * 全部失败都折成豆包 NDJSON 的非零 code 行（端上 `parse_ndjson_audio` 会转成
 * `TtsError::Service` 并降级 say，日志里能看到 message）。不用 HTTP 非 200：
 * 那会丢掉 message，端上只剩一个数字。
 */

import { Router, json } from "express";
import type { Response } from "express";

import type { ConfigStore } from "@carlife/db";

import type { AuthedRequest } from "../auth";
import type { DailyQuota } from "../quota/daily-quota";
import { synthesizeSpeech, TtsSynthesisError } from "../tts/synthesize";

/** 豆包协议的正常终止码，与 carlife-net::tts::CODE_DONE 同值。 */
const CODE_DONE = 20_000_000;
/** 门面侧错误统一用这个 code（豆包 4xxxxxxx 段是它自己的业务码，不冒用）。 */
const CODE_FACADE_ERROR = 50_000_000;

/** NDJSON 分片的原始字节数。豆包也是分片回的，端上按行拼接，大小不敏感。 */
const CHUNK_BYTES = 48 * 1024;

/** 音频字节 → 豆包 NDJSON 行（纯函数，可单测）。 */
export function audioToDoubaoNdjson(bytes: Buffer): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    lines.push(JSON.stringify({ code: 0, data: bytes.subarray(i, i + CHUNK_BYTES).toString("base64") }));
  }
  lines.push(JSON.stringify({ code: CODE_DONE, message: "OK", data: null }));
  return lines.join("\n") + "\n";
}

function ndjsonError(res: Response, message: string): void {
  // 门面的失败也走 200 + NDJSON：HTTP 状态码进不了端上的错误消息。
  res.status(200).type("application/x-ndjson");
  res.end(JSON.stringify({ code: CODE_FACADE_ERROR, message, data: null }) + "\n");
}

export interface TtsSpeechOptions {
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /**
   * 日用量闸门（ACR-016）。不注入即不设闸。
   *
   * **计的是字符数不是次数**——这一档按字符计费，按次数设闸挡不住
   * "一次合成一整篇"。参照 INC-0030：一上午重复播报烧掉几十万字当量，
   * 那次的调用次数并不惊人，字符数才是。
   */
  quota?: DailyQuota;
}

/**
 * 旧路径。ACR-018 之前 aliyun 档单独打它，而**已经在跑的旧客户端二进制**
 * 可能还缓存着上一次 `/v1/tts/config` 给的那个地址（复查间隔 30s，但进程
 * 可能几天不重启）。同一个 handler 挂两条路径，代价一行、收益是升级期间
 * 不会有一台端突然哑掉。
 *
 * **删除条件**：两个端都发过一次新版本之后（届时连同 `LEGACY_ALIYUN_TTS_GATEWAY_PATH`
 * 一起删）。留着它的唯一理由是兼容，不是"说不定还有人用"。
 */
const LEGACY_PATH = "/v1/tts/aliyun";

export function createTtsSpeechRouter(config: ConfigStore, opts: TtsSpeechOptions = {}): Router {
  const doFetch = opts.fetchImpl ?? fetch;
  const router = Router();

  router.post(["/v1/tts/speech", LEGACY_PATH], json(), async (req: AuthedRequest, res: Response) => {
    // 与 /v1/tts/config 同一条判据（M54-07）：车机以 vehicleVin 身份鉴权，
    // 而车机恰恰是主要的播报端——只认人的话，合成到不了车机。
    if (!req.userId && !req.vehicleVin) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const text = (req.body as { req_params?: { text?: unknown; speaker?: unknown } } | undefined)
      ?.req_params?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      ndjsonError(res, "req_params.text 缺失或为空");
      return;
    }

    let values: ReadonlyMap<string, string>;
    try {
      values = await config.runtimeValues();
    } catch (err) {
      console.error("[tts-speech] 配置读取失败", err);
      ndjsonError(res, "config_unavailable");
      return;
    }

    // 日用量闸门（ACR-016）。放在取密钥之前——超限就不该再往下走。
    // 超限回 NDJSON 错误行而不是 HTTP 非 200：端上据此走既有降级路径到系统 say，
    // 而 message 里那句话是运维事后知道"为什么那天声音变了"的唯一线索。
    if (opts.quota) {
      const limit = Number(values.get("TTS_DAILY_CHAR_LIMIT"));
      const decision = await opts.quota.consume(
        "tts",
        text.length,
        Number.isFinite(limit) ? limit : 0,
      );
      if (!decision.allowed) {
        console.warn(`[quota] 云 TTS 今日字符数 ${decision.used} 已超上界 ${decision.limit}——本次降级端上 say`);
        ndjsonError(
          res,
          `今日合成字符已达上界（${decision.used}/${decision.limit}），本次降级本地播报；` +
            `要继续用云端音色请在后台调高 TTS_DAILY_CHAR_LIMIT 或置 0 解除`,
        );
        return;
      }
    }

    try {
      /*
       * 按当前档位分流。合成的调用形状只有一份（`tts/synthesize.ts`）——
       * 控制台试听走的是同一个函数。两处各写一遍的下场是"端上好使、控制台 400"。
       *
       * 不传 `engine`：让它自己问配置层，端上说了不算。端上要是能指定档位，
       * 那"后台切引擎"就成了一个建议而不是开关。
       */
      const { bytes, engine } = await synthesizeSpeech(values, text, { fetchImpl: doFetch });
      // 计费档留一行痕：与端上那行合成日志一样，这是本地对账的原始记录。
      if (engine !== "mock") {
        console.log(`[tts-speech] ${engine} 合成 ${text.length} 字，${bytes.length} bytes`);
      }
      res.status(200).type("application/x-ndjson");
      res.end(audioToDoubaoNdjson(bytes));
    } catch (err) {
      // 合成侧的失败消息面向运维，原样折进 NDJSON 行（端上日志里看得到）。
      ndjsonError(
        res,
        err instanceof TtsSynthesisError
          ? err.message
          : `合成失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  return router;
}
