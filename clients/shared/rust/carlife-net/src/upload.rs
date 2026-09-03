//! 音频上行（施工单 M2-03，F-02-04）。
//!
//! 协议对齐 M2-02 网关实现：`POST /v1/session/:id/messages`，
//! raw body（`content-type: audio/<format>`）+ `X-Audio-Meta`（AudioMeta JSON）
//! + `Authorization: Bearer <token>`。响应 202 `{ "turnId": "…" }`。
//!
//! 重试策略（工单边界）：网络错误/5xx **一次**自动重试后上抛；
//! 完整退避与离线队列归 FL-05（M2-04/后续），此处不做。

use carlife_core::contract::{AudioMeta, MessageSource};
use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NetError {
    #[error("network: {0}")]
    Network(String),
    /// 会话已被网关软关闭；上层可创建新会话后重发一次原请求。
    #[error("session_expired")]
    SessionExpired,
    /// 凭证不被接受（401）。**与其它 4xx 分开**（M48-02）：上层据此决定
    /// "刷一次 token 重试"还是"回登录页"，而 `Rejected` 的语义是"别重试"。
    #[error("unauthorized")]
    Unauthorized,
    /// 4xx：请求本身有问题，不重试。
    #[error("rejected: status={status} body={body}")]
    Rejected { status: u16, body: String },
    /// 5xx（重试一次后仍失败）。
    #[error("server: status={0}")]
    Server(u16),
    #[error("bad_response: {0}")]
    BadResponse(String),
}

/// 把 reqwest 的错误连同**底层原因**一起转成一句话（施工单 M55-01）。
///
/// # 为什么不能只用 `e.to_string()`
///
/// reqwest 的 Display 只给顶层那一句——`error sending request for url (…)`。
/// 真正说明发生了什么的（`connection refused` / `operation timed out` /
/// `operation not permitted` / DNS 失败）在 `source()` 链上，而
/// `net_err(e)` 把整条链扔了。
///
/// 2026-08-31 装机后手机端登录失败，报的就是那一句：Safari 能打开同一个地址、
/// 本地网络权限也开着，而错误本身说不出**连接到底是被拒了、超时了、还是被系统挡了**——
/// 三种的处置完全不同，却被压成了同一句话。这与 M53-01 修的是同一类病：
/// 错误信息指不出真正的原因。
pub(crate) fn net_err(e: reqwest::Error) -> NetError {
    use std::error::Error as _;
    let mut msg = e.to_string();
    let mut src: Option<&(dyn std::error::Error + 'static)> = e.source();
    // 整条链都带上：中间那层往往是 hyper，最底下那层才是 OS 的 errno。
    while let Some(cause) = src {
        msg.push_str(" ← ");
        msg.push_str(&cause.to_string());
        src = cause.source();
    }
    NetError::Network(msg)
}

/// 网关受理响应。
/// NOTE(契约)：此 REST 响应形状暂在网关内联定义（M2-02），
/// 随契约演进并入 `carlife-core::contract`（M2-01 变更流程）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedTurn {
    pub turn_id: String,
}

/// 打断一轮的结果（施工单 M33-01）。
///
/// **形状留在 `carlife-net` 内部，不进 `carlife-core::contract`**：
/// 它是一个 RPC 的响应体，不是端云共享的领域模型——契约包里多一个类型
/// 就多一份要跟着演进的东西，而这个形状只有这一个调用点会读。
///
/// `Default` 是"没命中任何轮"，也正是网络失败时的兜底值（见 `cancel_turn`）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelOutcome {
    /// 恒为 true——服务端对"没有在跑的轮"同样回成功（那与调用方想要的结果一致）。
    #[serde(default)]
    pub cancelled: bool,
    /// 实际被掐掉的轮；没有则 None。
    #[serde(default)]
    pub turn_id: Option<String>,
    /// 取消落在副作用窗口内 = **动作已经发出去了，收不回来**（F-14-05）。
    /// 调用方据此把话说清楚，不要显示"已取消"。
    #[serde(default)]
    pub side_effect_in_flight: bool,
}

/// 建会话响应（同上，暂内联）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSession {
    pub session_id: String,
    /// 访客模式（M48-05，AC-56-7）。端上据此播报降级话术——
    /// 静默降级的后果是用户以为助手"忘了他的偏好"。缺省 false（人的 token）。
    #[serde(default)]
    pub guest: bool,
}

/// 只转写响应（施工单 M25-01，F-52-01）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeResult {
    pub text: String,
}

pub struct GatewayClient {
    // `pub(crate)`：媒体那条通路（`media.rs`）在同一个 crate 的兄弟模块里写
    // `impl GatewayClient`，而 Rust 的字段私有是**按模块**算的，兄弟模块看不见。
    // 放在这里而不是把 impl 挤进本文件——upload.rs 已经两千多行了。
    pub(crate) base_url: String,
    pub(crate) token: String,
    pub(crate) http: reqwest::Client,
    /**
     * 这台端此刻要不要让服务端产垫场（施工单 M33-04，F-45-08）。
     *
     * # 为什么是客户端的字段，不是每个调用点的参数
     *
     * 做成必填参数是本仓的既有取向（见 `send_text` 的 `source`：让每个调用点
     * 当场表态）。这里没那么做，理由是**它会强迫 `clients/mobile` 跟着改签名**，
     * 而 M33 的 Sprint 边界明写手机端一行不动——为一个 bool 去动一个本期
     * 完全没验过的端，风险不对称。
     *
     * 字段还有一个附带好处：**忘不掉**。它挂在客户端上，那个客户端发出去的
     * 每一条消息都带着它；而参数式写法只要新增一个发送点忘了传，
     * 就又回到"端上关了、服务端照产"的老样子——那正是 M18-05 留下的那笔债。
     *
     * 默认 `true`：与服务端 `TurnInput.fillerEnabled ?? true` 对齐，
     * 不调 `with_filler_enabled` 的调用方（手机端）行为逐字不变。
     */
    filler_enabled: bool,
}

#[derive(Debug, Deserialize)]
struct GatewayErrorBody {
    error: Option<String>,
}

/// 只识别消息端点的明确过期契约，不把任意 409 都当成可恢复。
fn is_session_expired(status: u16, body: &str) -> bool {
    if status != 409 {
        return false;
    }
    serde_json::from_str::<GatewayErrorBody>(body)
        .ok()
        .and_then(|payload| payload.error)
        .is_some_and(|error| error == "session_expired")
}

/// 按状态码区间归类一次失败响应（施工单 M53-01）。**所有端点走这一条。**
///
/// # 为什么值得一个共用函数
///
/// 在它之前，`GatewayClient` 的 29 处失败分支写的都是
/// `if status != 200 { return Err(NetError::Server(status)); }`——
/// 把**任何**非 200 都说成"服务器错误"，而 `Server` 的 Display 是 `server: status={0}`，
/// 既不带服务端的 error code，语义上还指向 5xx。两个实测后果：
///
///  - 车机权限不足拿到 404，端上报 `server：status=404`，走查的人据此去查服务端，
///    真相是端上权限判定（M52-01 查了半天）；
///  - `create_session_as` 的 `active_user_required`（400）同样被吞成 `server: status=400`，
///    于是 `App.tsx` 里"服务端要求先声明谁在用 → 挂回上车声明"那条分支**从来没匹配过**——
///    现象正是它自己注释里写的"车主说了话、屏幕上什么都没发生"。
///
/// # 分类口径
///
/// | 状态 | 归类 | 上层该怎么办 |
/// |---|---|---|
/// | 401 | `Unauthorized` | 刷一次 token 再重试，或回登录页 |
/// | 409 + `session_expired` | `SessionExpired` | 建新会话后重发 |
/// | 其余 4xx | `Rejected { status, body }` | **别重试**；`body` 里带着服务端的 error code |
/// | 5xx 及其它 | `Server(status)` | 服务端的问题，可重试 |
///
/// **4xx 必须带 body**：端上要靠里面的 `vehicle_not_found` / `active_user_required` /
/// `grant_failed` 这些 code 决定下一步。丢了 body，端上只剩一个数字，
/// 而数字说不出"你不是这辆车的成员"和"这辆车不存在"的区别（服务端刻意让它们同形）。
pub(crate) fn classify_failure(status: u16, body: String) -> NetError {
    match status {
        401 => NetError::Unauthorized,
        _ if is_session_expired(status, &body) => NetError::SessionExpired,
        400..=499 => NetError::Rejected { status, body },
        _ => NetError::Server(status),
    }
}

/// 从响应里取回 body 再分类。失败响应的 body 读不出来就当空串——
/// **读不到 body 不该把一次 4xx 变成网络错误**，那会让上层去重试一个永远不会成功的请求。
pub(crate) async fn failure_from(res: reqwest::Response) -> NetError {
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    classify_failure(status, body)
}

/// 最小的 query 值编码：保留 RFC 3986 的 unreserved 集，其余按字节转 `%XX`。
///
/// 只用于会话游标这类短 ASCII 串。**不是通用实现**——需要通用能力时该引 crate，
/// 而不是把这个函数越改越像一个。
fn percent_encode_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

impl GatewayClient {
    pub fn new(base_url: impl Into<String>, token: impl Into<String>) -> Self {
        /*
         * 声明会话线索作为**默认请求头**（M54-13）。
         *
         * 放在构造器里而不是各调用点：`GatewayClient` 上有 39 个带鉴权的请求点，
         * 逐个加第二个头是对核心网络 crate 的大范围重构（要先立 ACR），
         * 而 reqwest 的 default_headers 一处生效、且**新增请求点忘不掉**。
         *
         * 端上只出示会话 id，不自称是谁——自称等于伪造。服务端回查
         * `Session` 行（userId + deviceId 都要对上）才认。
         */
        let mut builder = reqwest::Client::builder();
        if let Some(sid) = carlife_core::acting::session() {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(&sid) {
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert("x-carlife-session", value);
                builder = builder.default_headers(headers);
            }
        }
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token: token.into(),
            // 构造失败回落到默认客户端：少一个头总比整条链路不可用好。
            http: builder.build().unwrap_or_else(|_| reqwest::Client::new()),
            filler_enabled: true,
        }
    }

    /// 声明这台端此刻的闲聊旁路开关（M33-04）。见字段注释。
    pub fn with_filler_enabled(mut self, enabled: bool) -> Self {
        self.filler_enabled = enabled;
        self
    }

    async fn post_audio_once(
        &self,
        session_id: &str,
        bytes: &[u8],
        meta: &AudioMeta,
    ) -> Result<reqwest::Response, NetError> {
        let meta_json =
            serde_json::to_string(meta).map_err(|e| NetError::BadResponse(e.to_string()))?;
        self.http
            .post(format!("{}/v1/session/{}/messages", self.base_url, session_id))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", format!("audio/{}", meta.format))
            .header("x-audio-meta", meta_json)
            /*
             * 音频这一支的 body 是 raw PCM，塞不进 JSON（M33-04），所以走请求头。
             * 网关那边两条分支各取各的、汇到同一个变量。
             */
            .header("x-filler-enabled", if self.filler_enabled { "1" } else { "0" })
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(net_err)
    }

    /// 只转写，不建轮（施工单 M25-01，F-52-01）。
    ///
    /// 哨兵监听的语音段走这里：`POST /v1/asr/transcribe`，文本回端上判定唤醒词。
    /// **与 `upload_audio` 并列而非替换**——PTT 仍走会话端点成轮。
    /// 不做自动重试：哨兵段天然高频且下一段马上就来，重试旧段只会积压
    /// （ASR 故障的显式降级归 M25-04）。
    pub async fn transcribe_audio(
        &self,
        bytes: &[u8],
        meta: &AudioMeta,
    ) -> Result<TranscribeResult, NetError> {
        let meta_json =
            serde_json::to_string(meta).map_err(|e| NetError::BadResponse(e.to_string()))?;
        let res = self
            .http
            .post(format!("{}/v1/asr/transcribe", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", format!("audio/{}", meta.format))
            .header("x-audio-meta", meta_json)
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.json::<TranscribeResult>()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 行程批量上报的一次 POST（M11-01）。真正的重试与队列在 `trips.rs`。
    pub(crate) async fn post_trips_once(
        &self,
        trips: &[crate::trips::TripReport],
    ) -> Result<reqwest::Response, reqwest::Error> {
        self.http
            .post(format!("{}/v1/telemetry/trips", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .json(&serde_json::json!({ "trips": trips }))
            .send()
            .await
    }

    /// 建立新会话（`POST /v1/session`，201）。
    pub async fn create_session(&self) -> Result<CreatedSession, NetError> {
        self.create_session_as(None).await
    }

    /// 建会话并**声明谁在用**（M48-05，F-56-05）。
    ///
    /// `active`：`None` = 不声明（人的 token 走这条，服务端恒用登录者）；
    /// `Some(None)` = 显式声明访客；`Some(Some(id))` = 声明成某位成员。
    ///
    /// 三态而不是 `Option<String>`：**"没声明"与"声明是访客"必须分开**。
    /// 合并的话，车机忘了声明会被静默当成访客——而访客是要播报出来的降级，
    /// 不该悄悄发生。
    pub async fn create_session_as(
        &self,
        active: Option<Option<String>>,
    ) -> Result<CreatedSession, NetError> {
        let mut req = self
            .http
            .post(format!("{}/v1/session", self.base_url))
            .header("authorization", format!("Bearer {}", self.token));
        if let Some(active_user) = active {
            req = req.json(&serde_json::json!({ "activeUserId": active_user }));
        }
        let res = req
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 201 {
            return Err(failure_from(res).await);
        }
        res.json::<CreatedSession>()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 关闭会话（`POST /v1/session/:id/close`，200；施工单 M22-01/03）。
    ///
    /// **软关闭：历史一条不删。** 关掉的是"还能不能接着说"——
    /// 之后 `GET /v1/session/:id/messages` 仍照常返回全部历史，车主上滑还看得见。
    ///
    /// 服务端幂等，所以这里**不做去重**：车主连点「退下」两次是正常操作。
    pub async fn close_session(&self, session_id: &str) -> Result<(), NetError> {
        let res = self
            .http
            .post(format!("{}/v1/session/{}/close", self.base_url, session_id))
            .header("authorization", format!("Bearer {}", self.token))
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        // 404 也当成功：会话已经不在了，"结束这段对话"这个诉求已经达成。
        // 报错只会让端上多一个恢复分支，而那个分支什么都做不了。
        if status == 200 || status == 404 {
            Ok(())
        } else {
            Err(failure_from(res).await)
        }
    }

    /// 打断这一轮（`POST /v1/session/:id/cancel`，200；施工单 M33-01，F-08-08 / F-14-04）。
    ///
    /// # 它不是「退下」
    ///
    /// `close_session` 关的是**这段对话**，本方法掐的是**这一轮**——会话继续，
    /// 下一句话照常成轮。车主长按打断之后紧接着就要问新问题，
    /// 走错成 close 会让那个新问题落在已关闭的会话上，上下文白丢一次。
    ///
    /// # 失败也不是错误
    ///
    /// 端上此刻**已经把声音停了**（那一步是同步的、本地的），
    /// 车主要的那件事已经发生。网关不可达时回一个"没命中任何轮"的结果而不是 Err：
    /// 给调用方一个它处理不了的错误，只会变成一个用户点不掉的提示框。
    /// 真正的收敛交给服务端那一轮自己的超时。
    ///
    /// `turn_id` 为 `None` 表示"掐掉这个会话当前在跑的那一轮"。
    pub async fn cancel_turn(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
    ) -> CancelOutcome {
        let body = match turn_id {
            Some(t) => serde_json::json!({ "turnId": t }),
            None => serde_json::json!({}),
        };
        let sent = self
            .http
            .post(format!("{}/v1/session/{}/cancel", self.base_url, session_id))
            .header("authorization", format!("Bearer {}", self.token))
            .json(&body)
            .send()
            .await;
        match sent {
            Ok(res) if res.status().as_u16() == 200 => {
                res.json::<CancelOutcome>().await.unwrap_or_default()
            }
            Ok(res) => {
                eprintln!("[net] 取消失败 status={}", res.status().as_u16());
                CancelOutcome::default()
            }
            Err(e) => {
                eprintln!("[net] 取消失败（网络）：{e}");
                CancelOutcome::default()
            }
        }
    }

    /// 发送一条已经是文本的消息（`POST /v1/session/:id/messages`，JSON 体）。
    ///
    /// 施工单 M3-07（F-03-09 文字输入框）：与音频上行走**同一个端点**，
    /// 只是 content-type 不同——服务端据此分流（gateway/src/http/index.ts）。
    /// 网络在 Rust 侧（§2.2 C2），WebView 不直接访问网关。
    ///
    /// # `source` 必须显式给，没有默认值（2026-08-27）
    ///
    /// "文本已经在手里"不等于"来源是打字"：唤醒词那条链是本地转写完再发文本，
    /// 内容是文本、来源却是语音。这个参数原本不存在，哨兵于是默默复用了打字那条路，
    /// 后果是**车主自己说的话在车机对话界面上不显示**（`fanout.rs` 只在 prompt 事件
    /// 带 transcript 时才追加用户气泡，而服务端只给 `voice` 带），
    /// 外加控制台把所有语音指令标成「文字」。
    /// 做成必填参数就是为了让每个调用点都得当场表态，不能靠默认值蒙混。
    ///
    /// # 闲聊旁路开关随每条消息带上去（M33-04）
    ///
    /// 车主说过「不要废话了」之后，**服务端必须知道**，否则它照产垫场、
    /// 照跑判断、照写指标——`commands/prefs.rs` 从 M18-05 起就挂着这句话：
    /// "端上丢弃而服务端照产……上行链路本单未接"。这次接上。
    /// 值取自客户端的 `filler_enabled` 字段（见 `with_filler_enabled`）。
    pub async fn send_text(
        &self,
        session_id: &str,
        content: &str,
        source: MessageSource,
    ) -> Result<AcceptedTurn, NetError> {
        let source = match source {
            MessageSource::Voice => "voice",
            MessageSource::Text => "text",
        };
        let res = self
            .http
            .post(format!("{}/v1/session/{}/messages", self.base_url, session_id))
            .header("authorization", format!("Bearer {}", self.token))
            .json(&serde_json::json!({
                "content": content,
                "source": source,
                // 闲聊旁路开关（M33-04，补 M18-05 那笔债）。**端上关掉不算真关**：
                // 不带这个字段的话，服务端照建 A-pair、照跑判断、照写指标，
                // 接了 L1 之后照烧钱。做成必填参数，理由与上面的 `source` 一样——
                // 让每个调用点当场表态，不靠默认值蒙混。
                "fillerEnabled": self.filler_enabled,
            }))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 202 {
            // `classify_failure` 是 `classify_message_client_error` 的超集：
            // 它多认一个 401 → Unauthorized，其余（含 409 session_expired）一字不差。
            return Err(failure_from(res).await);
        }
        res.json::<AcceptedTurn>()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// HITL 确认/拒绝回灌（M13-05，`POST /v1/session/:id/resume`）。
    ///
    /// 返回 `true` 表示网关已受理（含 duplicate——重复 resume 是正常情况，F-04-11）。
    /// 409（未知/过期的中断点）返回 `false`：对 UI 同样意味着"这事已了，收起弹窗"，
    /// 但调用方可以据此打日志区分。**任何返回值都不该触发重试**——越试越乱。
    pub async fn post_resume(
        &self,
        session_id: &str,
        interrupt_id: &str,
        approved: bool,
    ) -> Result<bool, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/session/{}/resume", self.base_url, session_id))
            .header("authorization", format!("Bearer {}", self.token))
            .json(&serde_json::json!({ "interruptId": interrupt_id, "approved": approved }))
            .send()
            .await
            .map_err(net_err)?;
        match res.status().as_u16() {
            200 => Ok(true),
            409 => Ok(false),
            _ => Err(failure_from(res).await),
        }
    }

    /// 拉取当前已确认行程（M13-04，`GET /v1/trip-plan/current`）。
    ///
    /// 返回**原样 JSON 文本**：行程契约的真相源在 TS/shared（`TripPlanSnapshot`），
    /// Rust 只搬运不解析——在这里再定义一遍结构体就是第二份契约，必然漂移。
    pub async fn fetch_trip_plan(&self) -> Result<String, NetError> {
        self.fetch_trip_plan_with(false).await
    }

    /// 同上，但可要求网关**按最新天气重算**行前物品与天气（M20-06）。
    ///
    /// `refresh_pretrip` 只在"打开 App / 从后台切回前台"那一次为 true——
    /// 60 秒一轮的常规轮询带上它，等于把天气接口按分钟打。
    /// 重算失败时网关照常回 200 + 库里那份，这里不需要额外分支。
    pub async fn fetch_trip_plan_with(&self, refresh_pretrip: bool) -> Result<String, NetError> {
        let url = if refresh_pretrip {
            format!("{}/v1/trip-plan/current?refreshPretrip=1", self.base_url)
        } else {
            format!("{}/v1/trip-plan/current", self.base_url)
        };
        let res = self
            .http
            .get(url)
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 景区导览简报（M36-03，`POST /v1/guide/brief`）。
    ///
    /// 入参与出参都是**原样 JSON 文本**：契约真相源在 TS/shared（`GuideBrief` /
    /// `GuideBriefResponse`），Rust 只搬运不解析——与 `fetch_trip_plan` 同一条纪律。
    ///
    /// **单独给 110 秒超时**：网关是同步挂等（冷启三分支采集，网关侧预算 100s），
    /// reqwest 默认无超时，但不设上限的话网关挂死时这条请求会永远悬着。
    /// 110 = 网关 100s + 网络余量；别的方法不受影响（超时是 per-request 的）。
    pub async fn fetch_guide_brief(&self, body_json: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/guide/brief", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .timeout(std::time::Duration::from_secs(110))
            .body(body_json.to_string())
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 出发导航规划（M66-03，`POST /v1/trip-plan/nav-plan`）。
    ///
    /// 入参出参都是**原样 JSON 文本**：契约真相源在 TS/shared（`NavPlanRequest` / `NavPlanResponse`），
    /// Rust 只搬运不解析——与 `fetch_guide_brief` 同一条纪律。
    ///
    /// **单独给 65 秒超时**：网关挂等预算 60 s（runtime 分支 55 s），65 = 网关 + 网络余量。
    /// 比网关长是为了让"网关先超时回 failed"而不是"这里先断线看到连接错误"——
    /// 两者对端上都是 failed，但排障时能分清是谁放弃的。
    pub async fn post_nav_plan(&self, body_json: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/trip-plan/nav-plan", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .timeout(std::time::Duration::from_secs(65))
            .body(body_json.to_string())
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 导览采集任务状态（M40-02，`GET /v1/guide/jobs`）。原样 JSON（契约在
    /// TS/shared 的 `GuideJobsResponse`）。快路径（服务侧只读 pg-boss+缓存），10s 足够。
    pub async fn fetch_guide_jobs(&self) -> Result<String, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/guide/jobs", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 手动「获取导览」（M40-02，`POST /v1/guide/jobs/trigger`）。入参出参原样 JSON。
    pub async fn trigger_guide_job(&self, body_json: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/guide/jobs/trigger", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .timeout(std::time::Duration::from_secs(15))
            .body(body_json.to_string())
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 拉取当前用户的车辆档案列表（M14-04，`GET /v1/vehicles`）。
    ///
    /// 与 `fetch_trip_plan` 同一条纪律：返回**原样 JSON 文本**，
    /// 档案契约的真相源在 TS/shared（`VehicleProfile`），Rust 只搬运不解析。
    /// 购车候选与成本（`GET /v1/session/:id/buying` 原样 JSON）。
    ///
    /// **原样透传，Rust 不解析**：契约真相源在 TS/shared，
    /// 在这里解析一遍就等于多一处会漂移的定义（同 `fetch_vehicles` 的取向）。
    pub async fn fetch_buying(&self, session_id: &str) -> Result<String, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/session/{}/buying", self.base_url, session_id))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 合成端点下发（`GET /v1/tts/config`）。
    ///
    /// **不带密钥**：响应里没有，也不该有（见网关侧 `http/tts-config.ts`）。
    /// 端上继续用自己环境里的 `BYTEDANCE_TTS_API_KEY`。
    pub async fn fetch_tts_config(&self) -> Result<crate::tts::TtsRuntimeConfig, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/tts/config", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.json::<crate::tts::TtsRuntimeConfig>()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 车主自己的会话列表（M28-01，车机端左侧历史）。原样 JSON 搬运，
    /// 解析在 TS 侧——契约真相源在 `contracts`，Rust 再解一遍就是第二份定义。
    ///
    /// `cursor` 是上一页的 `nextCursor`（ISO 时间串）；首页不传。
    pub async fn fetch_sessions(
        &self,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<String, NetError> {
        let mut url = format!("{}/v1/sessions?limit={}", self.base_url, limit);
        if let Some(c) = cursor {
            // 游标是 ISO 时间串（`2026-08-26T13:24:38.123Z`），带 `:` 与 `.`。
            // 自己编一遍而不是拉一个 urlencode 依赖：**为三个字符引一个 crate 不划算**，
            // 而放任不编码则是在赌服务端那侧的解析口味。
            url.push_str("&cursor=");
            url.push_str(&percent_encode_component(c));
        }
        let res = self
            .http
            .get(url)
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    pub async fn fetch_vehicles(&self) -> Result<String, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/vehicles", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 车型目录 + 车型↔知识库关联关系（M14-08，`GET /v1/vehicle-catalog`）。
    /// 同样只搬运不解析：覆盖三态与文案在 TS 侧（`@carlife/ui` 的 knowledgeNote）。
    pub async fn fetch_vehicle_catalog(&self) -> Result<String, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/vehicle-catalog", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 这辆车的⑥用车画像（M14-09，`GET /v1/vehicles/:vin/usage`）。
    ///
    /// **503 也要把响应体带回去**：那时 body 里写着"⑥未接入"，
    /// 而"未接入"与"没有数据"在端上是两句完全不同的话。只回一个状态码，
    /// TS 侧就只能把两者说成同一件事。
    pub async fn fetch_vehicle_usage(&self, vin: &str) -> Result<String, NetError> {
        self.get_text_allow_unavailable(&format!("{}/v1/vehicles/{}/usage", self.base_url, vin))
            .await
    }

    /// 某位成员的画像（M14-10，`GET /v1/vehicles/:vin/members/:id/usage`）。
    pub async fn fetch_member_usage(&self, vin: &str, member_id: &str) -> Result<String, NetError> {
        self.get_text_allow_unavailable(&format!(
            "{}/v1/vehicles/{}/members/{}/usage",
            self.base_url, vin, member_id
        ))
        .await
    }

    /// ③偏好列表（M14-10，`GET /v1/preferences`）。同样允许 503 带体返回。
    pub async fn fetch_preferences(&self) -> Result<String, NetError> {
        self.get_text_allow_unavailable(&format!("{}/v1/preferences", self.base_url))
            .await
    }

    /// 删除一条③偏好（`DELETE /v1/preferences/:id`）。
    ///
    /// **404 不当错误**：那是"这条本来就没了"（并发删除、或列表已过期），
    /// 端上把行去掉即可，不该弹一句红字说删除失败——用户想要的结果已经达成。
    /// 其余非 200 照常报错：503（记忆库降级）必须让端上说"暂时删不了"，
    /// 因为那时**东西还在**，静默当成功会让它刷新后又冒出来。
    pub async fn delete_preference(&self, id: &str) -> Result<String, NetError> {
        let res = self
            .http
            .delete(format!("{}/v1/preferences/{}", self.base_url, id))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        if status == 404 {
            return Ok("{\"deleted\":true,\"missing\":true}".to_string());
        }
        if status != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 200 与 503 都返回体，其余状态码按错误处理。
    async fn get_text_allow_unavailable(&self, url: &str) -> Result<String, NetError> {
        let res = self
            .http
            .get(url)
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        if status != 200 && status != 503 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 建档 / 编辑档案（M14-04，`POST /v1/vehicles`）。入参与返回都是原样 JSON 文本。
    pub async fn post_vehicle(&self, body_json: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/vehicles", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .body(body_json.to_string())
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        if status != 201 {
            // 400/409 的错误体对端上有意义（校验详情），带回去而不是丢掉。
            let text = res.text().await.unwrap_or_default();
            return Err(NetError::BadResponse(format!("{status}: {text}")));
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 手动记一笔保养（M29-03，`POST /v1/vehicles/:vin/maintenance`）。
    /// 入参与返回都是原样 JSON 文本——Rust 只搬运不解析（同 `post_vehicle` 纪律）。
    pub async fn append_maintenance(&self, vin: &str, body_json: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/vehicles/{}/maintenance", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .body(body_json.to_string())
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        if status != 201 {
            // 400/404 的错误体对端上有意义（校验详情），带回去而不是丢掉。
            let text = res.text().await.unwrap_or_default();
            return Err(NetError::BadResponse(format!("{status}: {text}")));
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 档案变更记录（M29-05，`GET /v1/vehicles/:vin/changes`）。原样 JSON 透传。
    pub async fn fetch_vehicle_changes(
        &self,
        vin: &str,
        cursor: Option<&str>,
    ) -> Result<String, NetError> {
        let mut url = format!("{}/v1/vehicles/{}/changes", self.base_url, vin);
        if let Some(c) = cursor {
            url.push_str(&format!("?cursor={c}"));
        }
        let res = self
            .http
            .get(url)
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 占位 VIN → 真 VIN 补录（M29-04，`POST /v1/vehicles/:vin/vin`）。
    /// 成功是 200（迁移不是新建）；4xx 错误体带校验详情，原样带回。
    pub async fn backfill_vin(&self, vin: &str, body_json: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/vehicles/{}/vin", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .body(body_json.to_string())
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        if status != 200 {
            let text = res.text().await.unwrap_or_default();
            return Err(NetError::BadResponse(format!("{status}: {text}")));
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 设默认车（M14-04，`POST /v1/vehicles/:vin/default`）。
    pub async fn post_vehicle_default(&self, vin: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/vehicles/{}/default", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 车内音乐让路（M27，`POST /v1/cabin/media/duck`）——播报期间压低，播完恢复。
    ///
    /// # 它有自己的超时，而且很短
    ///
    /// 调用点在 TTS 起停那一刻。`GatewayClient` 共用的那个 `reqwest::Client`
    /// **没有配超时**，一次挂住的请求会把这个任务永远留在运行时里；
    /// 而让路是装饰性的，等它一秒都不值得。所以这里单独建一个带超时的客户端。
    ///
    /// # 不带 vin
    ///
    /// 一路都不认车辆：让路是给**正在出声的那个**让，而主机只有一套喇叭。
    /// 曾按"登录用户的默认车"解析过，真跑当场打脸——演示数据里默认车没绑车机、
    /// 放歌的是另一辆，让路 100% 失败而现象只是"音乐没让路"。详见
    /// gateway 的 `http/cabin-media.ts` 与 mock-cabin 的 `duckAudible`。
    pub async fn post_cabin_duck(&self, on: bool, hold_ms: Option<u64>) -> Result<(), NetError> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1_500))
            .build()
            .map_err(net_err)?;
        let mut body = serde_json::json!({ "on": on });
        if let Some(ms) = hold_ms {
            body["holdMs"] = serde_json::json!(ms);
        }
        let res = http
            .post(format!("{}/v1/cabin/media/duck", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .json(&body)
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        // 网关对让路一律回 204：它自己也不让播报等结果（见那边的文件头）。
        if status != 204 && status != 200 {
            return Err(failure_from(res).await);
        }
        Ok(())
    }

    /// 写常用人员座舱偏好（M24-09，`PUT /v1/vehicles/:vin/members/:id/cabin-preference`）。
    pub async fn put_member_preference(&self, vin: &str, id: &str, body_json: &str) -> Result<String, NetError> {
        let res = self
            .http
            .put(format!("{}/v1/vehicles/{}/members/{}/cabin-preference", self.base_url, vin, id))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .body(body_json.to_string())
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        if status != 200 {
            let text = res.text().await.unwrap_or_default();
            return Err(NetError::BadResponse(format!("{status}: {text}")));
        }
        res.text().await.map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 组合列表（M24-09，`GET /v1/vehicles/:vin/combinations`，含失效的）。
    pub async fn fetch_combinations(&self, vin: &str) -> Result<String, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/vehicles/{}/combinations", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text().await.map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 建/改组合（M24-09）。400 的错误体带"哪一项不合法"，带回去。
    pub async fn post_combination(&self, vin: &str, body_json: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/vehicles/{}/combinations", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .body(body_json.to_string())
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        if status != 200 {
            let text = res.text().await.unwrap_or_default();
            return Err(NetError::BadResponse(format!("{status}: {text}")));
        }
        res.text().await.map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 删组合（M24-09，幂等）。
    pub async fn delete_combination(&self, vin: &str, id: &str) -> Result<String, NetError> {
        let res = self
            .http
            .delete(format!("{}/v1/vehicles/{}/combinations/{}", self.base_url, vin, id))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text().await.map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 车机绑定状态（M24-05，`GET /v1/vehicles/:vin/cabin`）。三态（unbound/offline/bound）
    /// 原样 JSON 透传——**离线与未绑定的区分在响应体里**，Rust 不解析业务字段。
    pub async fn fetch_cabin(&self, vin: &str) -> Result<String, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/vehicles/{}/cabin", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 剩余电量 / 剩余油量（M27，`GET /v1/vehicles/:vin/energy`）。
    ///
    /// 与 `fetch_cabin` 同样原样透传：三态（unbound/offline/bound）与
    /// `energyType` 分叉都在响应体里，**Rust 不解析业务字段**（§2.2 C2：
    /// 网络在 Rust，语义在 WebView）。502 也带回响应体——端上要念离线原因，
    /// 而不是显示一个 0%。
    pub async fn fetch_vehicle_energy(&self, vin: &str) -> Result<String, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/vehicles/{}/energy", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        // 502 = 车机离线，网关给的是可渲染的 {state:"offline",reason}。
        // 当成错误丢掉的话，端上只知道"失败了"，说不出为什么。
        if status != 200 && status != 502 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 触发车机绑定（M24-05，`POST /v1/vehicles/:vin/cabin/bind`，幂等）。
    /// 502 = 车机离线，响应体带说明——**带回去而不是丢掉**，端上要念原因。
    pub async fn post_cabin_bind(&self, vin: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/vehicles/{}/cabin/bind", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        if status != 200 {
            let text = res.text().await.unwrap_or_default();
            return Err(NetError::BadResponse(format!("{status}: {text}")));
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 常用人员名单（M17-04，`GET /v1/vehicles/:vin/members`）。原样 JSON 透传。
    pub async fn fetch_members(&self, vin: &str) -> Result<String, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/vehicles/{}/members", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 车辆成员授权名单（M48-03，`GET /v1/vehicles/:vin/grants`）。
    ///
    /// 与 `fetch_members` 是两回事：那边是**影子成员档案**（车上常有谁，可以没有账号），
    /// 这边是**使用授权**（谁能登录用这辆车）。端上也是两块 UI——合并会让用户以为
    /// 删掉一个就两边都没了（它们的生命周期是独立的，AC-55-6）。
    pub async fn fetch_vehicle_grants(&self, vin: &str) -> Result<String, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/vehicles/{}/grants", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 添加成员授权（M48-03，`POST /v1/vehicles/:vin/grants`）。
    ///
    /// 409 的错误体统一是 `grant_failed`（服务端刻意不区分"账号不存在"与
    /// "已是成员"——区分它们等于给车主一个账号探测接口），原样带回给端上。
    pub async fn post_vehicle_grant(&self, vin: &str, body_json: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/vehicles/{}/grants", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .body(body_json.to_string())
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        let text = res
            .text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))?;
        if status == 201 || status == 200 {
            return Ok(text);
        }
        Err(NetError::Rejected { status, body: text })
    }

    /// 移除成员授权（M48-03，`DELETE /v1/vehicles/:vin/grants/:userId`）。
    /// 幂等：移除一个本来就不在的人也是 200。
    pub async fn delete_vehicle_grant(&self, vin: &str, user_id: &str) -> Result<String, NetError> {
        let res = self
            .http
            .delete(format!(
                "{}/v1/vehicles/{}/grants/{}",
                self.base_url, vin, user_id
            ))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 新增 / 更新常用人员（M17-04，`POST /v1/vehicles/:vin/members`）。
    ///
    /// 200（更新）与 201（新增）都算成功；400 的错误体带着"哪一项不合法"，
    /// 对端上有意义，所以带回去而不是丢掉。
    pub async fn post_member(&self, vin: &str, body_json: &str) -> Result<String, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/vehicles/{}/members", self.base_url, vin))
            .header("authorization", format!("Bearer {}", self.token))
            .header("content-type", "application/json")
            .body(body_json.to_string())
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        if status != 200 && status != 201 {
            let text = res.text().await.unwrap_or_default();
            return Err(NetError::BadResponse(format!("{status}: {text}")));
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 删除常用人员（M17-04，`DELETE /v1/vehicles/:vin/members/:id`）。
    ///
    /// 端点是幂等的：删不到也返回 200 `{removed:false}`，这里照样透传，
    /// 不把"已经删过了"翻译成错误。
    pub async fn delete_member(&self, vin: &str, id: &str) -> Result<String, NetError> {
        let res = self
            .http
            .delete(format!("{}/v1/vehicles/{}/members/{}", self.base_url, vin, id))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.text()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 拉取权威历史（`GET /v1/session/:id/messages`，回源校正缓存用）。
    pub async fn fetch_history(
        &self,
        session_id: &str,
        limit: u32,
    ) -> Result<carlife_core::contract::HistoryPage, NetError> {
        let res = self
            .http
            .get(format!(
                "{}/v1/session/{}/messages?limit={}",
                self.base_url, session_id, limit
            ))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.json::<carlife_core::contract::HistoryPage>()
            .await
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 上传一段编码后的音频，返回受理的 turnId。
    pub async fn upload_audio(
        &self,
        session_id: &str,
        bytes: &[u8],
        meta: &AudioMeta,
    ) -> Result<AcceptedTurn, NetError> {
        let mut last_err: Option<NetError> = None;

        for attempt in 0..2 {
            match self.post_audio_once(session_id, bytes, meta).await {
                Ok(res) => {
                    let status = res.status().as_u16();
                    if status == 202 {
                        return res
                            .json::<AcceptedTurn>()
                            .await
                            .map_err(|e| NetError::BadResponse(e.to_string()));
                    }
                    if (400..500).contains(&status) {
                        // 4xx 不重试，直接把带 body 的分类结果抛出去。
                        return Err(failure_from(res).await);
                    }
                    // 5xx 记下来再试一次——**这里必须留 `Server`**：
                    // 它就是"可重试"的那一类，换成 `Rejected` 会让重试逻辑失去依据。
                    last_err = Some(NetError::Server(status));
                }
                Err(e) => last_err = Some(e),
            }
            if attempt == 0 {
                // 单次快速重试；不做指数退避（FL-05 范围）。
            }
        }
        Err(last_err.unwrap_or_else(|| NetError::Network("unknown".into())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    /// 极简 stub 网关：收一个请求，断言并按脚本响应。
    fn spawn_stub(
        status_line: &'static str,
        body: &'static str,
        capture_tx: std::sync::mpsc::Sender<(String, String, usize)>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();

                let mut meta_header = String::new();
                let mut content_len = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    let trimmed = line.trim_end().to_string();
                    if trimmed.is_empty() {
                        break;
                    }
                    let lower = trimmed.to_lowercase();
                    if let Some(v) = lower.strip_prefix("x-audio-meta:") {
                        // 保留原始大小写 JSON（值部分）
                        meta_header = trimmed[trimmed.len() - v.trim().len()..].to_string();
                    }
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        content_len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut payload = vec![0u8; content_len];
                reader.read_exact(&mut payload).unwrap();

                capture_tx
                    .send((request_line.trim().to_string(), meta_header, payload.len()))
                    .unwrap();

                let response = format!(
                    "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        format!("http://{addr}")
    }

    fn meta() -> AudioMeta {
        AudioMeta {
            duration_ms: 2300,
            format: "pcm_s16le".into(),
            sample_rate_hz: 16_000,
            channels: 1,
        }
    }

    /// 抓整条请求（头 + body），给 M33-04 的开关上行用——
    /// 既有的 `spawn_stub` 只捕获请求行 / x-audio-meta / body 长度，看不见别的头。
    fn spawn_raw_stub(
        status_line: &'static str,
        body: &'static str,
        capture_tx: std::sync::mpsc::Sender<String>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut raw = String::new();
                let mut content_len = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    if line.trim_end().is_empty() {
                        break;
                    }
                    if let Some(v) = line.to_lowercase().strip_prefix("content-length:") {
                        content_len = v.trim().parse().unwrap_or(0);
                    }
                    raw.push_str(&line);
                }
                let mut payload = vec![0u8; content_len];
                reader.read_exact(&mut payload).unwrap();
                raw.push_str(&String::from_utf8_lossy(&payload));
                capture_tx.send(raw).ok();
                let resp = format!(
                    "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(resp.as_bytes()).unwrap();
                stream.flush().ok();
            }
        });
        format!("http://{addr}")
    }

    /// M33-04：**端上关掉不算真关**——服务端必须在每一条上行消息里收到这个开关。
    /// `commands/prefs.rs` 从 M18-05 起就挂着这句债，这组测试是它的还款凭证。
    #[tokio::test]
    async fn 文本上行带闲聊旁路开关() {
        let (tx, rx) = std::sync::mpsc::channel();
        let base = spawn_raw_stub("202 Accepted", r#"{"turnId":"t1"}"#, tx);

        GatewayClient::new(base.clone(), "demo-token")
            .with_filler_enabled(false)
            .send_text("sess-1", "别说了", MessageSource::Voice)
            .await
            .expect("send ok");

        let raw = rx.recv().unwrap();
        assert!(raw.contains(r#""fillerEnabled":false"#), "{raw}");
        assert!(raw.contains(r#""source":"voice""#), "source 不该被这次改动带偏");
    }

    #[tokio::test]
    async fn 文本上行默认开着_老调用方行为逐字不变() {
        let (tx, rx) = std::sync::mpsc::channel();
        let base = spawn_raw_stub("202 Accepted", r#"{"turnId":"t1"}"#, tx);

        // 不调 with_filler_enabled —— 手机端就是这么用的
        GatewayClient::new(base, "demo-token")
            .send_text("sess-1", "你好", MessageSource::Text)
            .await
            .expect("send ok");

        let raw = rx.recv().unwrap();
        assert!(raw.contains(r#""fillerEnabled":true"#), "{raw}");
    }

    /// 音频体是 raw PCM，塞不进 JSON —— 所以走请求头。
    #[tokio::test]
    async fn 音频上行的开关走请求头() {
        let (tx, rx) = std::sync::mpsc::channel();
        let base = spawn_raw_stub("202 Accepted", r#"{"turnId":"t1"}"#, tx);

        GatewayClient::new(base, "demo-token")
            .with_filler_enabled(false)
            .upload_audio("sess-1", &[1, 2, 3], &meta())
            .await
            .expect("upload ok");

        let raw = rx.recv().unwrap().to_lowercase();
        assert!(raw.contains("x-filler-enabled: 0"), "{raw}");
    }

    #[tokio::test]
    async fn uploads_raw_body_with_meta_header() {
        let (tx, rx) = std::sync::mpsc::channel();
        let base = spawn_stub("202 Accepted", r#"{"turnId":"turn-x1"}"#, tx);
        let client = GatewayClient::new(base, "demo-token");

        let accepted = client
            .upload_audio("sess-1", &[1, 2, 3, 4, 5], &meta())
            .await
            .expect("upload ok");
        assert_eq!(accepted.turn_id, "turn-x1");

        let (request_line, meta_header, body_len) = rx.recv().unwrap();
        assert!(
            request_line.starts_with("POST /v1/session/sess-1/messages"),
            "{request_line}"
        );
        assert!(meta_header.contains("\"durationMs\":2300"), "{meta_header}");
        assert!(meta_header.contains("\"sampleRateHz\":16000"));
        assert_eq!(body_len, 5);
    }

    #[tokio::test]
    async fn client_error_is_not_retried() {
        let (tx, rx) = std::sync::mpsc::channel();
        let base = spawn_stub("400 Bad Request", r#"{"error":"invalid_audio_meta"}"#, tx);
        let client = GatewayClient::new(base, "demo-token");

        let err = client.upload_audio("sess-1", &[0], &meta()).await.unwrap_err();
        match err {
            NetError::Rejected { status, .. } => assert_eq!(status, 400),
            other => panic!("expected Rejected, got {other:?}"),
        }
        // 只收到一次请求（4xx 不重试）
        rx.recv().unwrap();
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn text_session_expired_is_classified_without_retry() {
        let (tx, rx) = std::sync::mpsc::channel();
        let base = spawn_stub(
            "409 Conflict",
            r#"{"error":"session_expired","sessionId":"sess-1"}"#,
            tx,
        );
        let client = GatewayClient::new(base, "demo-token");

        let err = client
            .send_text("sess-1", "hello", MessageSource::Text)
            .await
            .unwrap_err();
        assert!(matches!(err, NetError::SessionExpired), "{err:?}");
        rx.recv().unwrap();
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn audio_session_expired_is_classified_without_retry() {
        let (tx, rx) = std::sync::mpsc::channel();
        let base = spawn_stub(
            "409 Conflict",
            r#"{"error":"session_expired","sessionId":"sess-1"}"#,
            tx,
        );
        let client = GatewayClient::new(base, "demo-token");

        let err = client.upload_audio("sess-1", &[0], &meta()).await.unwrap_err();
        assert!(matches!(err, NetError::SessionExpired), "{err:?}");
        rx.recv().unwrap();
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn server_error_retries_once_then_fails() {
        let (tx, rx) = std::sync::mpsc::channel();
        let base = spawn_stub("500 Internal Server Error", "{}", tx);
        let client = GatewayClient::new(base, "demo-token");

        let err = client.upload_audio("sess-1", &[0], &meta()).await.unwrap_err();
        assert!(matches!(err, NetError::Server(500)), "{err:?}");
        rx.recv().unwrap();
        rx.recv().unwrap(); // 第二次 = 重试
        assert!(rx.try_recv().is_err());
    }
}

#[cfg(test)]
mod classify_tests {
    use super::*;

    /// 走查 W8 的现象：车机权限不足拿到 404，端上报 `server：status=404`，
    /// 人据此去查服务端——而真相是端上权限判定。这一组把分类口径逐格钉住。
    #[test]
    fn 四百段带回服务端的_error_code() {
        let err = classify_failure(404, r#"{"error":"vehicle_not_found"}"#.into());
        match err {
            NetError::Rejected { status, ref body } => {
                assert_eq!(status, 404);
                assert!(body.contains("vehicle_not_found"), "{body}");
            }
            other => panic!("404 该归 Rejected，实际 {other:?}"),
        }
        // Display 也要带得出来：端上就是靠 `String(err).includes(...)` 分支的
        assert!(err.to_string().contains("vehicle_not_found"), "{err}");
        assert!(!err.to_string().starts_with("server:"), "{err}");
    }

    #[test]
    fn 四百的_active_user_required_能被端上认出来() {
        // App.tsx 的 `String(err).includes("active_user_required")` 依赖这一条。
        // 此前 `create_session_as` 归 Server(400)，那条分支从来没匹配过。
        let err = classify_failure(400, r#"{"error":"active_user_required"}"#.into());
        assert!(err.to_string().contains("active_user_required"), "{err}");
    }

    #[test]
    fn 四百零一仍然单独归_unauthorized() {
        // 上层据此决定"刷一次 token"还是"回登录页"，不能混进 Rejected。
        assert!(matches!(classify_failure(401, "{}".into()), NetError::Unauthorized));
    }

    #[test]
    fn 四百零九加_session_expired_归可恢复() {
        assert!(matches!(
            classify_failure(409, r#"{"error":"session_expired"}"#.into()),
            NetError::SessionExpired
        ));
        // 普通 409 不算——不把任意 409 都当成可恢复
        assert!(matches!(
            classify_failure(409, r#"{"error":"grant_failed"}"#.into()),
            NetError::Rejected { status: 409, .. }
        ));
    }

    #[test]
    fn 五百段仍归_server_它才是可重试的那一类() {
        assert!(matches!(classify_failure(500, "boom".into()), NetError::Server(500)));
        assert!(matches!(classify_failure(502, String::new()), NetError::Server(502)));
        assert!(matches!(classify_failure(503, String::new()), NetError::Server(503)));
    }

    #[test]
    fn body_为空也不改变分类() {
        // 读不出 body 时按空串走，**不能**因此把 4xx 降级成网络错误——
        // 那会让上层去重试一个永远不会成功的请求。
        assert!(matches!(
            classify_failure(403, String::new()),
            NetError::Rejected { status: 403, .. }
        ));
    }
}

#[cfg(test)]
mod net_err_tests {
    use super::*;

    /// 连一个没人监听的端口，看错误里带不带得出**原因**。
    #[tokio::test]
    async fn 连不上时错误里要说得出为什么() {
        let err = GatewayClient::new("http://127.0.0.1:1", "t")
            .fetch_vehicles()
            .await
            .expect_err("这个端口不该有人听");
        let msg = err.to_string();
        assert!(msg.starts_with("network:"), "{msg}");
        // 顶层那句谁都一样，**要的是 ← 后面那截**
        assert!(msg.contains(" ← "), "错误链条没带上，等于又回到「说不出为什么」：{msg}");
        let low = msg.to_lowercase();
        assert!(
            low.contains("refused") || low.contains("connect"),
            "最底下那层该是 OS 说的话：{msg}",
        );
    }
}

