//! 契约序列化往返测试（M2-01）。
//!
//! 消费 `contracts/fixtures/contract-events.json` —— 与 TS 侧
//! `check-contract-fixtures.mjs` 共用同一份样例，保证两侧对同一 JSON
//! 的理解一致：反序列化为类型 → 再序列化 → 与原始 JSON 逐值相等。

use carlife_core::contract::*;
use serde_json::Value;

fn fixtures() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../contracts/fixtures/contract-events.json"
    );
    let raw = std::fs::read_to_string(path).expect("读取共享 fixtures 失败");
    serde_json::from_str(&raw).expect("fixtures 不是合法 JSON")
}

/// 对 fixtures 中的一段数组做 typed 往返并断言逐值相等。
fn roundtrip_each<T>(items: &[Value])
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    for item in items {
        let typed: T = serde_json::from_value(item.clone())
            .unwrap_or_else(|e| panic!("反序列化失败: {e}\n样例: {item}"));
        let back = serde_json::to_value(&typed).expect("序列化失败");
        assert_eq!(&back, item, "往返后与原始 JSON 不一致");
    }
}

#[test]
fn envelopes_roundtrip() {
    let f = fixtures();
    let envelopes = f["envelopes"].as_array().expect("envelopes 缺失");
    assert_eq!(
        envelopes.len(),
        10,
        "五类事件样例应覆盖齐全（含 update/branch 成败两态与 update/filler，10 条）"
    );
    roundtrip_each::<EventEnvelope>(envelopes);
}

#[test]
fn envelopes_cover_all_five_event_kinds() {
    let f = fixtures();
    let envelopes = f["envelopes"].as_array().unwrap();
    let kinds: Vec<&str> = envelopes
        .iter()
        .map(|e| e["event"]["type"].as_str().unwrap())
        .collect();
    for expected in ["session", "prompt", "update", "permission", "tool_call"] {
        assert!(
            kinds.contains(&expected),
            "fixtures 未覆盖事件类型 {expected}"
        );
    }
}

#[test]
fn messages_roundtrip() {
    let f = fixtures();
    roundtrip_each::<ChatMessage>(f["messages"].as_array().expect("messages 缺失"));
}

#[test]
fn history_page_roundtrip() {
    let f = fixtures();
    roundtrip_each::<HistoryPage>(std::slice::from_ref(&f["historyPage"]));
}

#[test]
fn capture_statuses_roundtrip() {
    let f = fixtures();
    roundtrip_each::<CaptureStatus>(
        f["captureStatuses"]
            .as_array()
            .expect("captureStatuses 缺失"),
    );
}

#[test]
fn audio_meta_roundtrip_and_matches_defaults() {
    let f = fixtures();
    roundtrip_each::<AudioMeta>(std::slice::from_ref(&f["audioMeta"]));

    // fixtures 中的音频元数据必须与契约常量一致（TS 镜像常量另有脚本核对）。
    let meta: AudioMeta = serde_json::from_value(f["audioMeta"].clone()).unwrap();
    assert_eq!(meta.format, DEFAULT_AUDIO_FORMAT);
    assert_eq!(meta.sample_rate_hz, DEFAULT_AUDIO_SAMPLE_RATE_HZ);
    assert_eq!(meta.channels, DEFAULT_AUDIO_CHANNELS);
    assert!(meta.duration_ms <= MAX_CAPTURE_DURATION_MS);
}

#[test]
fn assistant_state_serializes_lowercase() {
    // AvatarState 的 TS 字面量（"idle" 等）与 Rust 枚举的对应关系。
    for (state, expected) in [
        (AssistantState::Idle, "\"idle\""),
        (AssistantState::Listening, "\"listening\""),
        (AssistantState::Thinking, "\"thinking\""),
        (AssistantState::Speaking, "\"speaking\""),
        (AssistantState::Alert, "\"alert\""),
    ] {
        assert_eq!(serde_json::to_string(&state).unwrap(), expected);
    }
}
