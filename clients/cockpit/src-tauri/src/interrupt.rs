//! 打断暖暖：端上唯一的那一个动作（施工单 M33-02，F-02-07 / F-45-07）。
//!
//! # 为什么必须是一个函数，而不是各处各写各的
//!
//! 「打断」不是"停播"，它是三件事按序做完：
//!
//! 1. **停播**——正文与垫场一起停，并把垫场槽位的三个标志复位；
//! 2. **取消服务端这一轮**——不取消的话 delta 继续回、turn_end 继续落库、
//!    垫场继续发，旧答案还进历史成了下一轮的上下文（M33-01 修的就是这个）；
//! 3. **回 idle + 记下这一轮**——之后到达的旧轮事件按 turnId 丢弃。
//!
//! 长按、单击、语音口令（M33-03/04）三条路都进这里。各写各的必然漏掉其中一步，
//! 而漏掉哪一步的症状都离根因很远：漏 1 是"还在说"，漏 2 是"两轮的声音叠在一起"，
//! 漏 3 是"打断之后又冒出半句"。
//!
//! # 顺序是有讲究的：先同步停播，再异步取消
//!
//! 取消要走一次网络往返（局域网，实测几十毫秒），而停播必须**立刻**发生——
//! 车主要的就是"别说了"这一下。所以停播同步做完再 spawn 取消请求。
//!
//! 取消请求失败**不回滚停播**：声音已经停了正是用户要的结果，
//! 服务端那一轮会自己按超时收敛。失败只记日志与计数，不弹错误——
//! 给车主一个他处置不了的错误框，比不报更糟。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::events::StreamState;

/// 谁发起的打断。**只用于计数与日志，不改变行为**——
/// 三条路必须做同样的事，否则"长按能打断、说话打不断"这类问题会以
/// 三种不同的形状分别出现三次。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterruptSource {
    /// 长按说话（M2-05 起就有这个手势，此前只停声音）。
    PushToTalk,
    /// 单击暖暖形象（M33-02 新接；此前这块区域点了什么都不发生）。
    Tap,
    /// 语音口令（M33-03 的播报期窄通道接进来）。
    // 变体先立在这里而不是等 M33-03 再加：三条路必须共用同一个入口，
    // 到时候只需在 `on_transcript_during_tts` 里调它，不必回头改本模块。
    #[allow(dead_code)]
    Voice,
}

impl InterruptSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::PushToTalk => "push_to_talk",
            Self::Tap => "tap",
            Self::Voice => "voice",
        }
    }
}

/// 打断计数。**没有它，"打断到底有没有生效"只能靠人眼看**——
/// 而"停了但没取消"与"取消了但没停"在车里听起来差别很微妙。
#[derive(Default)]
pub struct InterruptCounters {
    pub by_push_to_talk: AtomicU64,
    pub by_tap: AtomicU64,
    pub by_voice: AtomicU64,
    /// 取消请求没送出去（网关不可达等）。声音照停，只是服务端那一轮要等自己超时。
    pub cancel_failed: AtomicU64,
    /// 因为"此刻没有在跑的轮"而只做了停播、没发取消。**不是错误**。
    pub no_active_turn: AtomicU64,
}

impl InterruptCounters {
    fn bump(&self, source: InterruptSource) {
        match source {
            InterruptSource::PushToTalk => &self.by_push_to_talk,
            InterruptSource::Tap => &self.by_tap,
            InterruptSource::Voice => &self.by_voice,
        }
        .fetch_add(1, Ordering::Relaxed);
    }
}

/// 打断当前这一轮。返回是否真的发出了取消请求（只停播时为 false）。
///
/// **任何状态下调用都是安全的**：没有在跑的轮时它退化成"停播 + 回 idle"，
/// 不发空取消、不报错。单击手势因此可以无脑调它。
pub fn interrupt_assistant(app: &AppHandle, source: InterruptSource) -> bool {
    if let Some(counters) = app.try_state::<Arc<InterruptCounters>>() {
        counters.bump(source);
    }

    // ① 停播。正文与垫场一起停——用户说的是"别说了"，不是"别说垫场"。
    if let Some(tts) = app.try_state::<Arc<crate::tts::TtsState>>() {
        crate::tts::stop(&tts);
        /*
         * 垫场槽位复位（M18-09 的三个标志）。
         *
         * **不复位的话下一轮的垫场会被 `filler_slot()` 判成 `Drop`**：
         * `body_active` 要覆盖正文的整个播放期，而打断是在播放中途把它掐掉的——
         * 那个标志于是永远挂着。症状是"打断过一次之后就再也没有垫场了"，
         * 而且全程零报错，只能靠 `sidecarCounters` 的 dropped 计数才看得出来。
         */
        tts.reset_filler_slots();
    }

    // ② 记下这一轮 + 发取消。
    let Some(stream) = app.try_state::<Arc<StreamState>>() else {
        emit_idle(app);
        return false;
    };
    let Some((session_id, turn_id)) = stream.current_turn() else {
        // 没有在跑的轮：**不发空取消**。这不是错误，空闲时点一下暖暖就是这条路。
        if let Some(counters) = app.try_state::<Arc<InterruptCounters>>() {
            counters.no_active_turn.fetch_add(1, Ordering::Relaxed);
        }
        emit_idle(app);
        return false;
    };
    stream.mark_cancelled(&turn_id);

    let app_for_cancel = app.clone();
    let source_name = source.as_str();
    tauri::async_runtime::spawn(async move {
        let gateway = crate::commands::media::gateway_client();
        let outcome = gateway.cancel_turn(&session_id, Some(&turn_id)).await;
        if outcome.turn_id.is_none() {
            // 服务端那一轮已经收口了，或者请求没送到。两者对用户都一样
            // （声音已经停了），但排障时要分得开——所以只在这里记一笔。
            if let Some(counters) = app_for_cancel.try_state::<Arc<InterruptCounters>>() {
                counters.cancel_failed.fetch_add(1, Ordering::Relaxed);
            }
        }
        if outcome.side_effect_in_flight {
            // 动作已经发出去了，取消不回来（F-14-05）。这里只记录——
            // 怎么告诉车主归表现层，而本函数不该在打断这个动作上出声。
            eprintln!("[interrupt] 取消落在副作用窗口内：动作已发出（turn={turn_id}）");
        }
        eprintln!("[interrupt] {source_name} → 取消 turn={turn_id} 结果={:?}", outcome.turn_id);
    });

    // ③ 形象回位。放在最后：前两步都是瞬时的，中间插状态事件只会让画面抖一下。
    emit_idle(app);
    true
}

fn emit_idle(app: &AppHandle) {
    if let Err(e) = app.emit(
        carlife_core::fanout::EVENT_ASSISTANT_STATE,
        carlife_core::contract::AssistantState::Idle,
    ) {
        eprintln!("[interrupt] emit idle failed: {e}");
    }
}

/// 前端手势的入口（单击暖暖）。语音与长按在 Rust 侧直接调 `interrupt_assistant`。
#[tauri::command]
pub fn interrupt_assistant_cmd(app: AppHandle) -> bool {
    interrupt_assistant(&app, InterruptSource::Tap)
}

/// 打断计数快照（验收与排障用）。
#[tauri::command]
pub fn interrupt_stats(counters: tauri::State<'_, Arc<InterruptCounters>>) -> serde_json::Value {
    serde_json::json!({
        "pushToTalk": counters.by_push_to_talk.load(Ordering::Relaxed),
        "tap": counters.by_tap.load(Ordering::Relaxed),
        "voice": counters.by_voice.load(Ordering::Relaxed),
        "cancelFailed": counters.cancel_failed.load(Ordering::Relaxed),
        "noActiveTurn": counters.no_active_turn.load(Ordering::Relaxed),
    })
}
