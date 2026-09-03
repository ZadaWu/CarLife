/**
 * protocol —— 会话/事件/消息/语音 协议类型（施工单 M2-01）。
 *
 * 全部类型的唯一真相源在 `clients/shared/rust/carlife-core/src/contract/`（Rust），
 * 经 ts-rs 生成到 `../generated/`，本模块只做 re-export 与类型化样例。
 * SSE 事件语义对齐 ACP 五类：session / prompt / update / permission / tool_call（架构 §3）。
 */

export * from "../generated";
export * from "./samples";
