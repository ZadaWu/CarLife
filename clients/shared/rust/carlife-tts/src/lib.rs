//! carlife-tts — 暖暖播报的共享核（施工单 M65-04）。
//!
//! # 分层
//!
//! | 模块 | 管什么 | 从哪搬来 |
//! |---|---|---|
//! | [`text`] | 把回复里的 markdown 记号剥干净再送合成 | 车机 `tts/mod.rs::strip_markdown_for_speech` |
//! | [`endpoint`] | `GET /v1/tts/config` 的端上缓存：1.5s 超时、按 TTL 复查、拉不到沿用旧值 | 车机 `tts/endpoint.rs` |
//! | [`state`] | 在播句柄 + 代际守卫 + 静音开关；`stop()` 返回新代际 | 车机 `TtsState` 的子集 |
//! | [`player`] | rodio 内存直解 | 车机 `start_mp3_playback` |
//! | [`speak`] | 合成 → 播放 → 收尾，状态经回调发射 | 车机 `play()` 去掉垫场/ducking/AEC/say |
//!
//! # 为什么现在才有这个 crate
//!
//! 手机端从没出过声：`mobile/src-tauri/src/events.rs` 文件头明写「手机端当前没有本地 TTS」，
//! 而设置页那个「出声播报」开关只往存储里写一个布尔、全仓没有读者。2026-09-02 真机上
//! 用户拨开它暖暖照旧沉默。车机那份 1466 行里大半是车机差异项，直接复制到手机等于养两份；
//! 所以先把核抽出来，手机接上，车机在后续单里回接。

pub mod endpoint;
pub mod player;
pub mod speak;
pub mod state;
pub mod text;

pub use speak::{speak, SpeakCtx};
pub use state::{stop, TtsState};
pub use text::strip_markdown_for_speech;
