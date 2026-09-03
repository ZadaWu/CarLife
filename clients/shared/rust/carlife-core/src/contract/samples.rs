//! 契约样例（编译期内嵌，施工单 M2-04）。
//!
//! 数据源与 TS 侧 `contracts/src/protocol/samples.ts`、Rust 往返测试
//! 完全同一份：`contracts/fixtures/contract-events.json`（编译期 include）。
//! 用途：mock 事件驱动器（M2-04 F-01-08 的开发模式）必须走与真实 SSE
//! **同一条 fan-out 路径**，样例即标准事件序列。

use serde::Deserialize;

use super::{AudioMeta, ChatMessage, EventEnvelope};

const FIXTURES: &str = // 相对路径随 ACR-020 批① 深了两层（crates/ → clients/shared/rust/）；批⑤ contracts → contracts/ 时还要再改一次。
include_str!("../../../../../../contracts/fixtures/contract-events.json");

#[derive(Deserialize)]
struct Fixtures {
    envelopes: Vec<EventEnvelope>,
    messages: Vec<ChatMessage>,
    #[serde(rename = "audioMeta")]
    audio_meta: AudioMeta,
}

fn fixtures() -> Fixtures {
    serde_json::from_str(FIXTURES).expect("内嵌 fixtures 不合法——与契约类型不一致")
}

/// 覆盖五类事件的标准事件序列（一次语音对话）。
pub fn sample_envelopes() -> Vec<EventEnvelope> {
    fixtures().envelopes
}

pub fn sample_messages() -> Vec<ChatMessage> {
    fixtures().messages
}

pub fn sample_audio_meta() -> AudioMeta {
    fixtures().audio_meta
}

#[cfg(test)]
mod tests {
    #[test]
    fn embedded_fixtures_parse_against_contract() {
        assert_eq!(super::sample_envelopes().len(), 10);
        assert_eq!(super::sample_messages().len(), 2);
    }
}
