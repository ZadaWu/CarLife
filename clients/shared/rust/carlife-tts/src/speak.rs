//! 合成 → 播放 → 收尾。车机 `play()` 去掉垫场/ducking/AEC/say 之后剩下的骨架。
//!
//! 必须在 tokio 运行时内调用（`tokio::spawn`）：Tauri 的 `async_runtime` 就是 tokio，
//! 从 SSE 消费任务或命令里调都满足；共享 crate 不依赖 tauri，所以不用它的 spawn。

use std::sync::Arc;
use std::time::Duration;

use carlife_core::contract::AssistantState;
use carlife_net::TtsClient;

use crate::endpoint;
use crate::player::start_mp3_playback;
use crate::state::{stop, TtsState};
use crate::text::strip_markdown_for_speech;

/// 端注入进来的三样：网关地址、设备 JWT、状态发射器。
/// 状态经回调而不是直接 emit：共享 crate 拿不到 `AppHandle`，也不该拿。
pub struct SpeakCtx {
    pub base_url: String,
    pub token: String,
    pub on_state: Arc<dyn Fn(AssistantState) + Send + Sync>,
}

/// 播报一段正文。
///
/// 静音 / 空文本直接返回，**不推代际、不发状态**——什么都没发生就不该留下痕迹。
/// 其余路径：`stop` 取新代际 → 后台任务里取端点、合成、代际守卫、起播、轮询到播完 →
/// 代际仍一致时发 `Idle`。合成失败或端点问不到：一行日志 + `Idle`，不播不重试
/// （iOS 没有 `say`，不造一个降级）。
pub fn speak(ctx: &SpeakCtx, state: &Arc<TtsState>, text: &str) {
    if state.is_muted() {
        return;
    }
    let text = strip_markdown_for_speech(text);
    if text.trim().is_empty() {
        return;
    }
    // 代际必须取自 stop 的返回值（M27-02），见 state.rs。
    let generation = stop(state);
    let state = Arc::clone(state);
    let base_url = ctx.base_url.clone();
    let token = ctx.token.clone();
    let on_state = Arc::clone(&ctx.on_state);

    tokio::spawn(async move {
        let audio = match endpoint::effective(&base_url, &token).await {
            Some(cfg) => match TtsClient::for_runtime(&cfg, token.clone()).synthesize(&text).await {
                Ok(bytes) => {
                    // 每次计费合成都要留痕（M27-03）：这行日志就是本地对账单，
                    // 引擎名跟着字数一起打——"这些字算不算钱"取决于当时连的是哪一档。
                    eprintln!(
                        "[tts] 合成 {} 字（正文，{}{}），{} bytes",
                        text.chars().count(),
                        cfg.engine,
                        if cfg.billed { " **计费**" } else { "" },
                        bytes.len()
                    );
                    Some(bytes)
                }
                Err(e) => {
                    eprintln!("[tts] 合成失败，本次不出声：{e}");
                    None
                }
            },
            None => {
                eprintln!("[tts] 网关问不到合成端点，本次不出声（端上没有可回落的端点）");
                None
            }
        };

        // 合成期间若已被打断（用户长按说话 / 关开关），放弃本次播放，也不发状态——
        // 打断者自己会发。
        if state.generation() != generation {
            return;
        }
        let Some(bytes) = audio else {
            on_state(AssistantState::Idle);
            return;
        };
        let playback = match start_mp3_playback(bytes) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[tts] 播放启动失败: {e}");
                on_state(AssistantState::Idle);
                return;
            }
        };
        on_state(AssistantState::Speaking);
        // 占位时把上一个停掉（兜底；代际守卫下正常路径到不了这里）。
        if let Some(mut prev) = state.current().replace(playback) {
            prev.halt();
        }
        // 轮询播放句柄；自然结束且代际未变 → 回落 idle。
        loop {
            tokio::time::sleep(Duration::from_millis(120)).await;
            if state.generation() != generation {
                return; // 已被打断/替换
            }
            let mut guard = state.current();
            let finished = guard.as_mut().map(|p| p.is_finished()).unwrap_or(true);
            if finished {
                guard.take();
                drop(guard);
                if state.generation() == generation {
                    on_state(AssistantState::Idle);
                }
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn ctx(counter: &Arc<AtomicUsize>) -> SpeakCtx {
        let c = Arc::clone(counter);
        SpeakCtx {
            base_url: "http://127.0.0.1:9".into(), // 端口 9（discard）：真发出去也立刻失败
            token: String::new(),
            on_state: Arc::new(move |_| {
                c.fetch_add(1, Ordering::SeqCst);
            }),
        }
    }

    /// 静音时什么都不发生：代际不动、没有状态发射、不起后台任务。
    #[tokio::test]
    async fn muted_is_a_complete_noop() {
        let state = Arc::new(TtsState::default());
        let emitted = Arc::new(AtomicUsize::new(0));
        speak(&ctx(&emitted), &state, "你好");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(state.generation(), 0, "静音不该推代际");
        assert_eq!(emitted.load(Ordering::SeqCst), 0, "静音不该发任何状态");
    }

    /// 清洗后为空同样是 no-op（一段只剩记号的回复不该让助手闪一下 speaking）。
    #[tokio::test]
    async fn empty_after_strip_is_a_noop() {
        let state = Arc::new(TtsState::with_muted(false));
        let emitted = Arc::new(AtomicUsize::new(0));
        speak(&ctx(&emitted), &state, "** ** `` ");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(state.generation(), 0);
        assert_eq!(emitted.load(Ordering::SeqCst), 0);
    }

    /// 未静音且有正文：代际推进（M27-02 语义），端点问不到时以 Idle 收尾而不是卡在 speaking。
    #[tokio::test]
    async fn unreachable_endpoint_ends_in_idle() {
        let state = Arc::new(TtsState::with_muted(false));
        let emitted = Arc::new(AtomicUsize::new(0));
        speak(&ctx(&emitted), &state, "你好");
        assert_eq!(state.generation(), 1, "起播前 stop 一次，代际应为 1");
        // 端点请求最多 1.5s 超时；本地 discard 端口通常立刻拒绝。
        tokio::time::sleep(Duration::from_millis(2_200)).await;
        assert_eq!(emitted.load(Ordering::SeqCst), 1, "失败路径必须恰好发一次 Idle");
        assert!(!state.is_playing());
    }
}
