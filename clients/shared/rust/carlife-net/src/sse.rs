//! SSE 消费（施工单 M2-04，§2.2 C2）。
//!
//! EventSource 风格：`GET /v1/session/:id/stream`，解析 `id:`/`data:` 帧，
//! 断开后**简单重连**（固定 1s 间隔，携带 lastEventId 游标）。
//! 完整指数退避与离线队列归 FL-05——此处刻意保持最小。
//!
//! 事件封套解析失败的帧忽略并计数（信号上抛），不中断消费。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use carlife_core::contract::EventEnvelope;
use futures_util::StreamExt;

/// 连接层信号：供上层（events.rs）转成连接状态指示与封套消费。
#[derive(Debug)]
pub enum SseSignal {
    Connected,
    /// 断开；`reconnecting=true` 表示将按固定间隔重试。
    Disconnected { reconnecting: bool },
    /// 服务端明确拒绝（401/403）：**消费循环就此停止，不再重连**（M54-09）。
    ///
    /// 401 不是网络故障，重连治不了——过期 token 每秒打一次网关，
    /// 2026-09-01 的日志被这种风暴刷满。该做的是把"凭证不行"告诉上层，
    /// 让它走刷新/重新登录/重新声明，那是另一条链。
    Unauthorized,
    Envelope(EventEnvelope),
    /// 无法解析的帧（计数用）。
    Unparseable,
}

const RECONNECT_DELAY: Duration = Duration::from_secs(1);

/// 解析缓冲中的完整 SSE 帧（`\n\n` 分隔），返回消费的字节数与产出的信号。
/// 独立纯函数，可单测。
pub fn drain_frames(buffer: &mut String, out: &mut Vec<SseSignal>) -> Option<String> {
    let mut last_event_id = None;
    while let Some(sep) = buffer.find("\n\n") {
        let frame: String = buffer[..sep].to_string();
        buffer.drain(..sep + 2);
        let mut data_line = None;
        for line in frame.lines() {
            if let Some(rest) = line.strip_prefix("data: ") {
                data_line = Some(rest.to_string());
            } else if let Some(rest) = line.strip_prefix("id: ") {
                last_event_id = Some(rest.trim().to_string());
            }
            // 以 ':' 开头的注释行（心跳）直接跳过
        }
        if let Some(data) = data_line {
            match serde_json::from_str::<EventEnvelope>(&data) {
                Ok(env) => out.push(SseSignal::Envelope(env)),
                Err(_) => out.push(SseSignal::Unparseable),
            }
        }
    }
    last_event_id
}

pub struct SseClient {
    base_url: String,
    /// 每次（重）连接前现取一次 token。
    ///
    /// # 为什么不是 String 字段（M54-09）
    ///
    /// 快照会过期：access token 只活 15 分钟，而这个客户端的重连循环
    /// 以进程同寿。2026-09-01 网关日志里 `GET /v1/session/:sid/stream
    /// by=未鉴权 401` 每秒刷屏——就是一份过期快照在无限重连（过期 token
    /// 验签失败，日志里长得与"没带"一样）。保鲜循环在换新 token，
    /// 但快照永远是旧的那枚。
    token: TokenSource,
    http: reqwest::Client,
}

enum TokenSource {
    Static(String),
    Dynamic(Box<dyn Fn() -> String + Send + Sync>),
}

impl SseClient {
    pub fn new(base_url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token: TokenSource::Static(token.into()),
            http: reqwest::Client::new(),
        }
    }

    /// token 由闭包现取（端上传 `settings::gateway().1` 这类"当前生效凭证"）。
    /// 长连接一律用这个形态；`new` 的静态形态只适合一次性脚本与测试。
    pub fn new_with_token_source(
        base_url: impl Into<String>,
        token: impl Fn() -> String + Send + Sync + 'static,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token: TokenSource::Dynamic(Box::new(token)),
            http: reqwest::Client::new(),
        }
    }

    fn current_token(&self) -> String {
        match &self.token {
            TokenSource::Static(t) => t.clone(),
            TokenSource::Dynamic(f) => f(),
        }
    }

    /// 消费循环：直到 `stop` 置位。每个信号回调一次。
    /// 断开（网络错误/服务端关闭）→ 1s 后携带最新 lastEventId 重连。
    pub async fn run(
        &self,
        session_id: &str,
        stop: &AtomicBool,
        mut on_signal: impl FnMut(SseSignal),
    ) {
        let mut last_event_id: Option<String> = None;

        while !stop.load(Ordering::Relaxed) {
            let mut url = format!("{}/v1/session/{}/stream", self.base_url, session_id);
            if let Some(id) = &last_event_id {
                url.push_str(&format!("?lastEventId={id}"));
            }

            let res = self
                .http
                .get(&url)
                .header("authorization", format!("Bearer {}", self.current_token()))
                .send()
                .await;

            let res = match res {
                Ok(r) if r.status().is_success() => r,
                Ok(r) if matches!(r.status().as_u16(), 401 | 403) => {
                    // 被拒 ≠ 断线：重连只会把一次失败变成风暴（M53-01 同一课）。
                    on_signal(SseSignal::Unauthorized);
                    return;
                }
                _ => {
                    on_signal(SseSignal::Disconnected { reconnecting: true });
                    tokio::time::sleep(RECONNECT_DELAY).await;
                    continue;
                }
            };
            on_signal(SseSignal::Connected);

            let mut stream = res.bytes_stream();
            let mut buffer = String::new();
            loop {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                match stream.next().await {
                    Some(Ok(chunk)) => {
                        buffer.push_str(&String::from_utf8_lossy(&chunk));
                        let mut signals = Vec::new();
                        if let Some(id) = drain_frames(&mut buffer, &mut signals) {
                            last_event_id = Some(id);
                        }
                        /*
                         * **回调之前再判一次停**（施工单 M27-02）。
                         *
                         * 顶上那次判停是在 `next().await` **之前**做的，而被替换掉的流
                         * 正阻塞在这个 await 里——它醒来时早已不是当前流了。原来的写法
                         * 是先把这批信号全回调出去、下一圈才发现自己该退，于是每条陈旧流
                         * 都会把这一轮**再讲一遍**。上层 `handle_envelope` 收到就播报，
                         * 现象是"好几个声音重叠着说同一句话"，而这里一行异常都没有。
                         *
                         * 丢掉这批信号是对的：这条流已经被替换，接手的那条会从
                         * `lastEventId` 之后拿到同样的事件。
                         */
                        if stop.load(Ordering::Relaxed) {
                            return;
                        }
                        for s in signals {
                            on_signal(s);
                        }
                    }
                    Some(Err(_)) | None => break, // 断流 → 外层重连
                }
            }
            if !stop.load(Ordering::Relaxed) {
                on_signal(SseSignal::Disconnected { reconnecting: true });
                tokio::time::sleep(RECONNECT_DELAY).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    #[test]
    fn drain_parses_frames_ids_and_heartbeats() {
        let mut buf = String::from(
            ": connected\n\nid: 3\ndata: {\"eventId\":\"3\",\"sessionId\":\"s\",\"ts\":1,\"event\":{\"type\":\"session\",\"status\":\"created\"}}\n\nid: 4\ndata: not-json\n\npartial",
        );
        let mut out = Vec::new();
        let last = drain_frames(&mut buf, &mut out);
        assert_eq!(last.as_deref(), Some("4"));
        assert_eq!(out.len(), 2);
        assert!(matches!(out[0], SseSignal::Envelope(_)));
        assert!(matches!(out[1], SseSignal::Unparseable));
        assert_eq!(buf, "partial", "不完整帧保留在缓冲");
    }

    /// stub SSE 服务器：第一次连接发 2 个事件后断开；
    /// 第二次连接必须带 lastEventId=2，续发第 3 个事件。
    #[tokio::test(flavor = "multi_thread")]
    async fn reconnects_with_last_event_id() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen_paths: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let paths = Arc::clone(&seen_paths);

        std::thread::spawn(move || {
            let envelope = |id: u32| {
                format!(
                    "id: {id}\ndata: {{\"eventId\":\"{id}\",\"sessionId\":\"s1\",\"ts\":1,\"event\":{{\"type\":\"session\",\"status\":\"created\"}}}}\n\n"
                )
            };
            for round in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut head = [0u8; 1024];
                use std::io::Read;
                let n = stream.read(&mut head).unwrap();
                let request_line =
                    String::from_utf8_lossy(&head[..n]).lines().next().unwrap_or("").to_string();
                paths.lock().unwrap().push(request_line);

                let mut body = String::from(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
                );
                if round == 0 {
                    body.push_str(&envelope(1));
                    body.push_str(&envelope(2));
                } else {
                    body.push_str(&envelope(3));
                }
                stream.write_all(body.as_bytes()).unwrap();
                // round 0 直接关闭连接 → 触发客户端重连
            }
        });

        let client = SseClient::new(format!("http://{addr}"), "demo-token");
        let stop = Arc::new(AtomicBool::new(false));
        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let received_cb = Arc::clone(&received);
        let stop_cb = Arc::clone(&stop);

        client
            .run("s1", &stop, move |signal| {
                if let SseSignal::Envelope(env) = signal {
                    received_cb.lock().unwrap().push(env.event_id.clone());
                    if env.event_id == "3" {
                        stop_cb.store(true, Ordering::Relaxed);
                    }
                }
            })
            .await;

        assert_eq!(*received.lock().unwrap(), vec!["1", "2", "3"], "不重不漏");
        let paths = seen_paths.lock().unwrap();
        assert!(!paths[0].contains("lastEventId"), "首连无游标: {}", paths[0]);
        assert!(paths[1].contains("lastEventId=2"), "重连带游标: {}", paths[1]);
    }
}
