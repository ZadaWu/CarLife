/**
 * TTS 引擎解析 —— 「`TTS_ENGINE=mock` 到底意味着打哪个 URL」的**唯一一份答案**。
 *
 * # 为什么单独抽一个纯函数
 *
 * 这个映射有三个消费方：后台探活（打一次看通不通）、端上配置下发
 * （`GET /v1/tts/config`）、以及将来任何想知道"现在在用哪个引擎"的地方。
 * 三处各写一遍 `engine === "mock" ? mockUrl : DOUBAO_URL` 的下场是它们迟早
 * 对不齐——而对不齐的表现最恶心：**后台探活是绿的，端上打的却是另一个地址**。
 *
 * 所以它是纯函数、不碰 IO、可单测，输入就是 `runtimeValues()` 那张表。
 *
 * # 它不解析密钥
 *
 * 返回值里没有 API Key，这是刻意的：这份结果会经 HTTP 下发到端上，
 * 而 A 类密钥「只写不读、全链路掩码」（§8.2）。
 *
 * # 两个地址：`url` 给端上，`upstreamUrl` 给服务端（ACR-018）
 *
 * 自 ACR-018 起**端上恒打网关自己**（`TTS_GATEWAY_PATH`），三档皆然——
 * 车机与手机是面向车主的消费端，它们只该认识一个后端。真正的供应商地址
 * 变成 `upstreamUrl`，只有网关自己去合成时才用得到，**永远不下发**。
 *
 * 改之前 doubao 档把火山的地址原样下发、由端上拿自己环境里的
 * `BYTEDANCE_TTS_API_KEY` 直连。那条路有四个代价：密钥要发到每台车、
 * ACR-016 的日用量闸门看不见它、换供应商要发客户端版本，
 * 以及——真机上根本没有 `.env`，所以它在生产设备上一直是静默降级 say 的。
 */

/**
 * 豆包 openspeech 的合成端点。**只有网关会打它**（ACR-018 之后端上没有它了，
 * `clients/shared/rust/carlife-net/src/tts.rs` 里那份同名常量已随本次变更删除）。
 */
export const DOUBAO_TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

/**
 * 端上该打的合成端点——**相对路径，三档共用**（ACR-018）。
 *
 * 真正的合成方是网关：它按当前档位分流到豆包 / mock / DashScope，
 * 再把音频折成豆包 NDJSON 回给端上（`enterprise/backend/gateway/src/http/tts-speech.ts`）。
 * 这里给不了绝对地址——db 层不知道网关对外叫什么名字；
 * `tts-config.ts` 下发时按请求的 Host 补成绝对 URL。
 */
export const TTS_GATEWAY_PATH = "/v1/tts/speech";

/**
 * ACR-018 之前 aliyun 档单独用的门面路径。保留是为了**一轮兼容**：
 * 已经在跑的旧客户端二进制可能还缓存着它。两个端都发过一次新版本之后删除。
 */
export const LEGACY_ALIYUN_TTS_GATEWAY_PATH = "/v1/tts/aliyun";

export type TtsEngine = "mock" | "doubao" | "aliyun";

export interface ResolvedTts {
  engine: TtsEngine;
  /**
   * **端上**该打的合成端点：恒为 `TTS_GATEWAY_PATH` 这个相对路径，
   * 下发前由 `tts-config.ts` 补 Host。端上不认识任何供应商地址（ACR-018）。
   */
  url: string;
  /**
   * **服务端**去合成时该打的上游地址：doubao=火山，mock=本机 mock-tts。
   * aliyun 档为空串——DashScope 的地址由 `synthesizeDashScope` 自己按
   * base + 模型名拼，不经这里。
   *
   * 与 `url` 分成两个字段而不是复用一个：它们的读者不同、下发面不同，
   * 合成一个字段的话"哪一个会被发到端上"就要靠调用点自己记住。
   */
  upstreamUrl: string;
  resourceId: string;
  speaker: string;
  /** 这一档是不是按字计费——界面要据此变色，不能只写在文档里。 */
  billed: boolean;
  /**
   * @deprecated ACR-018 起**恒为 `false`**：所有档的密钥都在服务端，端上不持有
   * 任何 vendor 凭证。字段保留只为向后兼容——旧客户端读不到它会回落 `billed`，
   * 而 doubao 档 `billed=true` 会让它误以为"本机得有 key"并降级 say。
   * 两个端都发过一次新版本之后可以连同端上的解析一起删。
   */
  keyRequired: boolean;
}

const DEFAULT_MOCK_URL = "http://localhost:8794/api/v3/tts/unidirectional";
const DEFAULT_RESOURCE_ID = "seed-tts-2.0";
const DEFAULT_SPEAKER = "zh_female_vv_uranus_bigtts";
const DEFAULT_ALIYUN_TTS_MODEL = "qwen3-tts-flash";
const DEFAULT_ALIYUN_TTS_VOICE = "Cherry";

export function isTtsEngine(v: string | undefined): v is TtsEngine {
  return v === "mock" || v === "doubao" || v === "aliyun";
}

/**
 * 从配置表解析出端上要用的合成端点。
 *
 * 认不出的引擎名**回落 mock 而不是 doubao**：回落的方向必须是不花钱的那个。
 * 一个错字（`doubao ` 带空格、`Doubao` 大小写）不该把一台开发机悄悄接上计费引擎。
 */
export function resolveTts(values: ReadonlyMap<string, string>): ResolvedTts {
  const raw = values.get("TTS_ENGINE")?.trim();
  const engine: TtsEngine = isTtsEngine(raw) ? raw : "mock";
  const mockUrl = values.get("MOCK_TTS_URL")?.trim() || DEFAULT_MOCK_URL;
  if (engine === "aliyun") {
    return {
      engine,
      url: TTS_GATEWAY_PATH,
      // DashScope 的地址在 synthesizeDashScope 里按 base + 模型拼，这里没有可给的。
      upstreamUrl: "",
      // 豆包协议里的 resourceId 对门面没有路由意义，放模型名供日志与界面辨认。
      resourceId: values.get("ALIYUN_TTS_MODEL")?.trim() || DEFAULT_ALIYUN_TTS_MODEL,
      speaker: values.get("ALIYUN_TTS_VOICE")?.trim() || DEFAULT_ALIYUN_TTS_VOICE,
      billed: true,
      keyRequired: false,
    };
  }
  return {
    engine,
    url: TTS_GATEWAY_PATH,
    upstreamUrl: engine === "doubao" ? DOUBAO_TTS_URL : mockUrl,
    resourceId: values.get("BYTEDANCE_TTS_RESOURCE_ID")?.trim() || DEFAULT_RESOURCE_ID,
    speaker: values.get("BYTEDANCE_TTS_SPEAKER")?.trim() || DEFAULT_SPEAKER,
    billed: engine === "doubao",
    // ACR-018：密钥全在服务端，端上永远不需要 vendor key。见字段上的 deprecated。
    keyRequired: false,
  };
}
