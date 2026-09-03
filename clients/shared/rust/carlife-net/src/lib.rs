//! carlife-net — REST + SSE(EventSource 风格) 客户端、断线重连退避（不用 WS，§2.2 C2）
//!
//! 已落地：`upload` 音频上行与历史回源（M2-03/04）、`sse` 消费与简单重连（M2-04）、
//! `media` 车内音乐的端上通路（M63-03：播放器状态 / 心跳认领 / 曲目字节）、
//! `tts` 语音合成（2026-08；ACR-018 起只打网关，端上不持有任何 vendor 密钥）。
//! 完整指数退避与离线队列归 FL-05。

pub mod auth;
pub mod media;
pub mod sse;
pub mod trips;
pub mod tts;
pub mod upload;

pub use auth::{
    confirm_pairing, keep_fresh, login, logout, refresh, register_device, request_pairing_code,
    with_refresh, PairingCode,
};
pub use media::{PlayerStatus, PlayerTrack, PlayerView, SinkBeat, SinkView};
pub use sse::{SseClient, SseSignal};
pub use trips::{ChargeSegment, RejectedTrip, TripQueue, TripReport, TripReportResult, MAX_BATCH};
pub use tts::{TtsClient, TtsError, TtsRuntimeConfig};
pub use upload::{AcceptedTurn, CreatedSession, GatewayClient, NetError, TranscribeResult};
