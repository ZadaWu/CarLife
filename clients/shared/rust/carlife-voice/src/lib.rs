//! 哨兵监听的**纯逻辑层**——两个端共用（施工单 M60-01）。
//!
//! # 为什么把这三块单独拎出来
//!
//! 哨兵这条链路原本整个长在车机端（`clients/cockpit/src-tauri/src/voice/`）。
//! 手机端要长出同一个功能时，最不该复制的恰恰是这三块：
//!
//!  - [`wake`]：唤醒词与控制口令表。**复制一份的结局是两端听得懂的话不一样**
//!    ——车主在车上说「暖暖，退下」有用，在手机上说同一句没反应，而这种
//!    差异不会有任何报错，只会被当成"手机上这个功能坏了"。
//!  - [`windows`]：唤醒后的对话窗口时长。同上：两端的"喊一次能说几句"
//!    必须是同一个数。
//!  - [`degrade`]：转写连败进降级、退避探测。判据复制一份就会各自漂移。
//!
//! **没有拎出来的是循环本身**（cpal 起停、AEC、播报期窄通道）：车机那份与
//! 本地 TTS 深度交织（回声消除、播报期打断），而手机端根本没有本地播报。
//! 强行抽成一个带钩子的通用循环，等于为了消除重复去重写一个已经在真车上
//! 跑通的组件——两端各留一份循环、共用这三块判据，是刻意的取舍。
//!
//! 三个模块都是纯函数 / 纯状态机：不碰设备、不碰网络、时钟由调用方注入，
//! 因此可以脱离 Tauri 直接单测（`cargo test -p carlife-voice`）。

pub mod degrade;
pub mod wake;
pub mod windows;

pub use degrade::DegradeGate;
pub use wake::{classify, has_wake_word, is_interrupt, WakeOutcome};
pub use windows::{WakeWindows, WindowConfig, WindowKind};
