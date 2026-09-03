//! 端云契约的单一真相源（施工单 M2-01）。
//!
//! 本模块内的类型经 ts-rs 生成 TypeScript 到 `contracts/src/generated/`，
//! TS 侧只做 re-export，**两侧均不得手写重复定义**（架构 §10 要点 6）。
//!
//! 生成命令（幂等，生成物入库）：
//! ```bash
//! corepack pnpm generate:contract
//! ```
//!
//! 修改本模块 = 契约变更：改完必须重新生成并连同生成物一起提交，
//! `corepack pnpm typecheck` 会捕获 TS 侧未跟上的消费点。

pub mod events;
pub mod messages;
pub mod samples;
pub mod voice;

pub use events::*;
pub use messages::*;
pub use voice::*;
