//! carlife-media — 录音、VAD、图片压缩、编码（§2.2 C4）
//!
//! 已落地：push-to-talk 采集（`capture`）与契约格式编码（`encode`，M2-03）；
//! 常驻 VAD 与双模式监听（`vad` / `listen`，M4-07）；按场景取舍的图片压缩（`image`，M8-04）。
//!
//! 原始音频样本不出本 crate 边界之外的进程侧（WebView 不可触达，AC-02-2）。

pub mod aec;
pub mod audio_session;
pub mod capture;
pub mod encode;
pub mod image;
pub mod listen;
pub mod permission;
pub mod sentinel;
pub mod stream;
pub mod vad;

pub use aec::{AecError, AecProcessor, AEC_SAMPLE_RATE};
pub use audio_session::{
    ensure_recording_session, is_recording_session, release_recording_session, RecordingSession,
};
pub use capture::{CaptureError, ContinuousHandle, PttHandle, RawCapture};
pub use encode::{encode_mono16k_i16, encode_pcm_s16le};
pub use image::{compress, Compressed, ImageError, Scene, DEFAULT_BUDGET_BYTES};
pub use listen::{ListenMode, ListenState, MicSwitch, VoiceSession};
pub use permission::{
    is_silent_capture, mic_permission, open_mic_settings, request_mic_permission_blocking,
    MicPermission,
};
pub use sentinel::{AssemblerConfig, SegmentAssembler, SentinelSegment};
pub use stream::StreamConverter;
pub use vad::{Aggressiveness, VadConfig, VadEvent, VadGate, VadState};
