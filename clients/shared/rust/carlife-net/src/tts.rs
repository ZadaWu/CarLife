//! 语音合成客户端——**只认网关，不认任何供应商**（ACR-018）。
//!
//! # 这个客户端知道什么、不知道什么
//!
//! 它知道：网关下发的一个 URL、一个音色名、自己的设备 JWT。
//! 它不知道：现在用的是豆包还是百炼还是本机 say，供应商的地址长什么样，
//! 更没有任何 vendor 密钥。档位分流与协议转换全在服务端
//! （`enterprise/backend/gateway/src/http/tts-speech.ts`）。
//!
//! ACR-018 之前不是这样：`/v1/tts/config` 会把 `openspeech.bytedance.com`
//! 原样下发，端上读自己环境里的 `BYTEDANCE_TTS_API_KEY` 直连。代价是
//! A 类密钥要预装到每一台车机、网关的日用量闸门看不见那条流量、
//! 换供应商要发客户端版本；而真机上根本没有 `.env`，所以那条路在生产设备上
//! 一直是静默降级 say 的。车机与手机是面向车主的消费端，**只该认识一个后端**。
//!
//! 架构 §2.2 C6 定的是"车机**本地**播报"——本实现是云端合成 + 端上播放，
//! 与 C6 的差异已在架构文档回填说明：车机目标平台（§13-2）定案前，
//! 云端合成音质与中文自然度显著优于系统 TTS；离线兜底（FL-05 场景 5）
//! 仍需本地引擎，由调用方在合成失败时降级。
//!
//! 放在 carlife-net 而非 cockpit：合成是**网络调用**（§2.2 C2），mobile 端
//! 未来复用同一份；**播放**是平台相关的，留在 `clients/cockpit/src-tauri/src/tts`（§10）。
//!
//! 响应仍是豆包 NDJSON（网关把三档的结果都折成这个形状，所以本文件的解析
//! 一行没动）：
//!   {"code":0,"data":"<base64 mp3 分片>"}   ← 音频，可多条
//!   {"code":0,"data":null,"sentence":{…}}   ← 句级元信息，跳过
//!   {"code":20000000,"message":"OK"}        ← 正常终止

use base64::Engine as _;
use serde::Deserialize;
use thiserror::Error;

/*
 * ACR-018 删掉了 `DEFAULT_TTS_URL` / `DEFAULT_RESOURCE_ID` / `DEFAULT_SPEAKER`。
 *
 * 删的不只是三个常量，是「端上能自己拼出一个合成端点」这件事本身。
 * 只要端上还有一个默认端点，就一定会有某条降级路径在网关问不到时用上它——
 * 而那个默认值是**豆包**，也就是"网关抖一下就把这台端接上计费引擎"
 * （ACR-017 已经为此删过一次端上兜底）。现在端上唯一的 URL 来源是
 * `/v1/tts/config`，问不到就不合成、降级系统 say。
 */
const SAMPLE_RATE: u32 = 24_000;
/// 服务端正常终止码。
const CODE_DONE: i64 = 20_000_000;

#[derive(Debug, Error)]
pub enum TtsError {
    #[error("network: {0}")]
    Network(String),
    #[error("http status={0}")]
    Status(u16),
    /// 服务端返回的业务错误码。
    #[error("service code={code} message={message}")]
    Service { code: i64, message: String },
    #[error("empty_audio")]
    EmptyAudio,
}

#[derive(Deserialize)]
struct TtsLine {
    code: i64,
    #[serde(default)]
    message: String,
    #[serde(default)]
    data: Option<String>,
}

/// 解析 NDJSON 流为 mp3 字节（纯函数，可单测）。
pub fn parse_ndjson_audio(body: &str) -> Result<Vec<u8>, TtsError> {
    let mut audio = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<TtsLine>(line) else {
            continue; // 无法解析的行跳过，不中断合成
        };
        if parsed.code != 0 && parsed.code != CODE_DONE {
            return Err(TtsError::Service { code: parsed.code, message: parsed.message });
        }
        if let Some(b64) = parsed.data {
            match base64::engine::general_purpose::STANDARD.decode(&b64) {
                Ok(bytes) => audio.extend_from_slice(&bytes),
                Err(_) => continue,
            }
        }
    }
    if audio.is_empty() {
        return Err(TtsError::EmptyAudio);
    }
    Ok(audio)
}

/// 网关下发的合成端点（`GET /v1/tts/config`）。
///
/// **没有 api_key 字段，将来也不要加**：那条线是服务端 → 端上的单向下发，
/// 加进来就等于把 A 类密钥沿着一条为"换个 URL"而建的通道发出去了（§8.2）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsRuntimeConfig {
    /// `mock` | `doubao` | `aliyun`。端上**只用它打日志**——路由靠 `url`，
    /// 而 ACR-018 之后三档的 `url` 是同一个网关端点，分流在服务端。
    pub engine: String,
    pub url: String,
    pub resource_id: String,
    pub speaker: String,
    /// 这一档按字计费。端上据此决定合成日志里那句话的措辞——
    /// 免费档天天在跑，日志里每条都喊"计费"，真出事时那行字就没人看了。
    #[serde(default)]
    pub billed: bool,
    /// 端上多久复查一次（毫秒）。由服务端定，端上不要自己另设一个。
    #[serde(default)]
    pub refresh_ms: u64,
}
/*
 * 网关仍会下发 `keyRequired`，这里**刻意不解析**（serde 默认忽略未知字段）。
 * ACR-018 之后端上不持有任何 vendor 密钥，"要不要 key"对它没有意义；
 * 留着解析只会让人以为还有一条"没 key 就降级"的分支。
 */

pub struct TtsClient {
    /// 合成端点。**只能来自网关下发**（`TtsRuntimeConfig::url`），没有默认值。
    url: String,
    resource_id: String,
    speaker: String,
    /// 设备 JWT。端上唯一持有的凭证，也是网关认它的唯一依据。
    token: String,
    http: reqwest::Client,
}

impl TtsClient {
    /// 从网关下发的配置构造。**唯一的构造入口**——没有 `new`、没有 `from_env`、
    /// 没有 `with_url`：端上不该有"自己指定一个合成端点"的能力。
    ///
    /// 不返回 `Option` 了：ACR-018 之前这里会因为"计费档但本机没有 vendor 密钥"
    /// 返回 None、由调用方降级 say。密钥搬到服务端之后那个判断没有了对象——
    /// 密钥缺不缺是网关的事，缺了它会回一个 NDJSON 错误行，端上照旧降级。
    pub fn for_runtime(cfg: &TtsRuntimeConfig, token: impl Into<String>) -> Self {
        Self {
            url: cfg.url.clone(),
            resource_id: cfg.resource_id.clone(),
            speaker: cfg.speaker.clone(),
            token: token.into(),
            http: reqwest::Client::new(),
        }
    }

    /// 当前端点。启动横幅要打它——「以为在用免费的 mock、实际连着计费引擎」
    /// 与 M27-03 修的那次「以为在用 say」是同一种没有征兆的错。
    pub fn url(&self) -> &str {
        &self.url
    }

    /// 合成整段文本，返回 mp3 字节。
    ///
    /// NOTE(已知限制)：一次性收全再播（非流式播放），长文本首字延迟等于整段
    /// 合成时长。流式播放属体验优化，记录于 M2 验收"已知限制"。
    pub async fn synthesize(&self, text: &str) -> Result<Vec<u8>, TtsError> {
        /*
         * 鉴权只有一种：设备 JWT。
         *
         * `X-Api-Resource-Id` 留着是因为它是豆包协议请求的一部分，网关按档位
         * 决定要不要往上游传；但 `X-Api-Key` 没有了——端上手里没有任何
         * vendor 密钥可带，这正是 ACR-018 的目的。
         */
        let res = self
            .http
            .post(&self.url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("X-Api-Resource-Id", &self.resource_id)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "req_params": {
                    "text": text,
                    "speaker": self.speaker,
                    "audio_params": { "format": "mp3", "sample_rate": SAMPLE_RATE }
                }
            }))
            .send()
            .await
            .map_err(|e| TtsError::Network(e.to_string()))?;

        let status = res.status().as_u16();
        if status != 200 {
            return Err(TtsError::Status(status));
        }
        let body = res.text().await.map_err(|e| TtsError::Network(e.to_string()))?;
        parse_ndjson_audio(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn concatenates_chunks_and_skips_metadata() {
        let body = format!(
            "{{\"code\":0,\"data\":\"{}\"}}\n\
             {{\"code\":0,\"data\":\"{}\"}}\n\
             {{\"code\":0,\"data\":null,\"sentence\":{{\"text\":\"你好\"}}}}\n\
             {{\"code\":20000000,\"message\":\"OK\",\"data\":null}}",
            b64(b"AAA"),
            b64(b"BBB")
        );
        assert_eq!(parse_ndjson_audio(&body).unwrap(), b"AAABBB");
    }

    #[test]
    fn service_error_code_propagates() {
        let body = "{\"code\":40000001,\"message\":\"bad speaker\",\"data\":null}";
        match parse_ndjson_audio(body) {
            Err(TtsError::Service { code, .. }) => assert_eq!(code, 40_000_001),
            other => panic!("expected Service error, got {other:?}"),
        }
    }

    #[test]
    fn no_audio_is_error() {
        let body = "{\"code\":20000000,\"message\":\"OK\",\"data\":null}";
        assert!(matches!(parse_ndjson_audio(body), Err(TtsError::EmptyAudio)));
    }

    /// 与网关 `http/tts-config.ts` 的响应字段一一对应。
    /// 那边改了字段名而这里没改，症状是端上**默默沿用旧端点**——
    /// 后台切了引擎却毫无反应，且两侧都不报错。
    #[test]
    fn runtime_config_deserializes_gateway_shape() {
        // 注意 url：ACR-018 之后网关下发的是它自己的 /v1/tts/speech，不是供应商地址。
        // `keyRequired` 网关仍在发，这里不再解析（serde 忽略未知字段）——
        // 这条用例带着它，就是为了钉住"多一个字段不会让反序列化炸掉"。
        let body = r#"{"engine":"mock","url":"http://gw.local:8790/v1/tts/speech",
            "resourceId":"seed-tts-2.0","speaker":"zh_female_vv_uranus_bigtts",
            "billed":false,"keyRequired":false,"refreshMs":30000}"#;
        let cfg: TtsRuntimeConfig = serde_json::from_str(body).expect("反序列化");
        assert_eq!(cfg.engine, "mock");
        assert!(!cfg.billed);
        assert_eq!(cfg.refresh_ms, 30_000);

        let client = TtsClient::for_runtime(&cfg, "device-jwt");
        assert_eq!(client.url(), "http://gw.local:8790/v1/tts/speech");
    }

    /// ACR-018 的端上侧断言：**任何档都能构造，且构造出来的端点就是网关给的那个**。
    ///
    /// 它取代的是旧的 `key_requirement_follows_billing_tier`——那条测的是
    /// "计费档没 vendor 密钥就拒绝构造"，而端上现在根本没有 vendor 密钥这个概念。
    /// 留着旧断言会让人以为端上还有一条"没 key 就降级"的分支。
    #[test]
    fn 任何档都从网关下发的端点构造() {
        let base = TtsRuntimeConfig {
            engine: "mock".into(),
            url: "http://gw.local:8790/v1/tts/speech".into(),
            resource_id: "seed-tts-2.0".into(),
            speaker: "zh_female_vv_uranus_bigtts".into(),
            billed: false,
            refresh_ms: 30_000,
        };
        for engine in ["mock", "doubao", "aliyun"] {
            let cfg = TtsRuntimeConfig {
                engine: engine.into(),
                billed: engine != "mock",
                ..base.clone()
            };
            let client = TtsClient::for_runtime(&cfg, "device-jwt");
            assert_eq!(client.url(), base.url, "{engine} 档应当打网关下发的端点");
        }
    }

    #[test]
    fn unparseable_lines_are_skipped() {
        let body = format!("garbage\n{{\"code\":0,\"data\":\"{}\"}}\n", b64(b"OK"));
        assert_eq!(parse_ndjson_audio(&body).unwrap(), b"OK");
    }
}
