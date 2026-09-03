//! carlife-telemetry — 端侧埋点与崩溃捕获（对应 §2.2 C7）
//!
//! # 范围：只做"采集与保管"，不做"上报"
//!
//! 功能清单里的**埋点全部落在服务端** `agent-runtime/src/trace/`（FL-10 F-10-05~07、
//! FL-11 F-11-07、FL-14）。端侧这一档在架构图 §2.2 C7 里有位置，但没有任何功能点
//! 指定它的上报端点、用户同意形态与留存期限——这三件都是产品决策。
//!
//! 所以本 crate **刻意不含网络发送**：它提供有界缓冲、panic 捕获与脱敏，
//! 由 App 侧 `drain()` 后决定送去哪。发明一个上传协议会让"端侧埋点已完成"
//! 这句话在没人接收的情况下成立，那正是本仓栽过三次的形状。
//!
//! # 三条不变量
//!
//! 1. **永不阻塞调用方**——车机 HUD 的渲染线程不能因为埋点卡住；
//! 2. **永不无界增长**——车机可能连开数天不重启，缓冲必须有上限；
//! 3. **脱敏在写入时发生，不在发送时**——没进过缓冲的东西，崩溃转储也带不走。

pub mod buffer;
pub mod panic;
pub mod redact;

pub use buffer::{Event, Severity, TelemetryBuffer, DEFAULT_CAPACITY};
pub use panic::install_panic_hook;
pub use redact::redact;
