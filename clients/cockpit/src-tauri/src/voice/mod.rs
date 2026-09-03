// voice — 唤醒词、常驻VAD监听、push-to-talk
//
// M25-01：哨兵监听循环（sentinel）。
// M25-02：唤醒词判定（wake）。
// M25-03：对话窗口（windows）+ 本文件的分发（含 409 收编与唤醒应答）。

pub mod aec_bridge;
pub mod echo;
pub mod sentinel;

/*
 * 唤醒词判定与对话窗口搬去了 `clients/shared/rust/carlife-voice`（M60-01），手机端同用一份。
 *
 * 这里 re-export 回原来的路径，`crate::voice::wake::classify` 之类的调用点
 * 一处不动——搬家的收益是两端听得懂的话永远一致，代价不该是几十处 import 改名。
 */
pub use carlife_voice::{wake, windows};

pub use sentinel::wait_mic_released;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use carlife_core::contract::{MessageSource, WakeStatus};
use tauri::{AppHandle, Manager};

use crate::commands::voice::{emit_wake, SentinelState};
use wake::WakeOutcome;

/// 唤醒应答语——短到一个词，不寒暄（M25-03 约束：应答不该吃掉聆听窗口）。
const WAKE_ACK: &str = "哎，我在。";

/// 哨兵转写文本的唯一去向。
///
/// 判定顺序（M25-03 扩展了 M25-02 的三分支）：
///  1. `Dismiss` / `Wake` 永远按口令与唤醒处理——窗口内也一样
///     （窗口里说「暖暖退下」是让她走，不是一条消息）；
///  2. `Miss` + 窗口开着 → 整句就是输入（窗口 = 免唤醒词的对话许可，一次性）；
///  3. `Miss` + 没有窗口 → **就地丢弃**，连长度都不记（AC-52-5）。
///
/// 409 收编（M25-02 活体实测踩到的坑）：暖暖休息时绑定会话往往已过期，
/// 唤醒指令不能因此被丢——新建会话、重发、经 `SessionAdopted` 事件
/// 交还前端收编（切流 + 换 localStorage 归前端，Rust 不碰它们）。
pub fn on_transcript(app: &AppHandle, text: &str, truncated: bool, duration_ms: u32) {
    let Some(state) = app.try_state::<SentinelState>() else { return };

    let outcome = wake::classify(text);
    /*
     * 本机排障开关（`CARLIFE_SENTINEL_DEBUG=1`）。**默认关，且只能是默认关**：
     * AC-52-5 要求未命中的转写判定后即弃、不留任何副本，这条纪律不因排障而松动。
     *
     * 但"一个副本都不留"在开发机上有代价，2026-08-27 一天内撞了三次：
     * 唤醒没应答、车主气泡不显示、说了「暖暖你好」却毫无反应——三次都卡在
     * 同一处：**没人知道 ASR 究竟转出了什么**，只能靠离线合成语音去猜。
     * 猜的结论还常常是错的（离线转写全对，实际却判 Miss）。
     *
     * 所以留一个显式开关：开发机上自己打开，看完关掉；车上永远不开。
     * 打开时连 duration/truncated 一起打——段被 VAD 切碎时，
     * "唤醒词被从中间切开"和"根本没听清"在文本上长得一模一样，靠时长才分得开。
     */
    if std::env::var("CARLIFE_SENTINEL_DEBUG").is_ok_and(|v| v == "1") {
        eprintln!(
            "[sentinel][debug] 转写={text:?} 判定={outcome:?} dur={duration_ms}ms truncated={truncated}"
        );
    }

    match outcome {
        /*
         * 打断（施工单 M33-03，F-52-02）。
         *
         * 走的是与长按 / 单击**同一个** `interrupt_assistant`——三条路必须做
         * 同样的事，否则"长按能打断、说话打不断"会以三种不同的形状分别出现三次。
         *
         * 没有在跑的轮时它退化成"停播 + 回 idle"，不发空取消（见那个函数）。
         * 所以这一支在任何状态下调用都是安全的，不必先判"她在不在说话"。
         */
        WakeOutcome::Interrupt => {
            eprintln!("[sentinel] 语音口令：打断");
            state.interrupted.fetch_add(1, Ordering::Relaxed);
            crate::interrupt::interrupt_assistant(app, crate::interrupt::InterruptSource::Voice);
        }
        /*
         * 闲聊旁路的语音开关（施工单 M33-04，F-45-08）。
         *
         * 三件事，一件都不能少：
         *  1. 改端上偏好（跨重启保持，`filler-pref` 文件）；
         *  2. **正在播的那句垫场当场停**——车主说"别废话了"的时候她多半正在废话；
         *     `stop_if_filler` 只停垫场、不碰正文（关旁路 ≠ 关播报）；
         *  3. 回一句极短的确认。**这与「打断不出声」不矛盾**：那里车主要的是安静，
         *     这里他要的是"开关被拨动了"的回执——静默生效会让人以为没听见，然后反复说。
         *
         * **不消耗对话窗口、不成轮、不落库**：它是一个设置动作，不是一句话。
         */
        WakeOutcome::SidecarOff => {
            eprintln!("[sentinel] 语音口令：关闭闲聊旁路");
            state.sidecar_off.fetch_add(1, Ordering::Relaxed);
            set_sidecar(app, false);
        }
        WakeOutcome::SidecarOn => {
            eprintln!("[sentinel] 语音口令：打开闲聊旁路");
            state.sidecar_on.fetch_add(1, Ordering::Relaxed);
            set_sidecar(app, true);
        }
        WakeOutcome::Dismiss => {
            state.dismissed.fetch_add(1, Ordering::Relaxed);
            state.clear_windows();
            let Some(sid) = state.bound_session() else {
                eprintln!("[sentinel] 收到退下口令但无绑定会话，忽略");
                return;
            };
            let gateway = crate::commands::media::gateway_client();
            match tauri::async_runtime::block_on(gateway.close_session(&sid)) {
                Ok(()) => {
                    eprintln!("[sentinel] 语音退下：会话已软关闭");
                    emit_wake(app, &WakeStatus::Dismissed);
                }
                Err(e) => eprintln!("[sentinel] 语音退下失败：{e}"),
            }
        }
        WakeOutcome::Wake { command: None } => {
            // 只记"发生了什么"，**不记文本**——AC-52-5 的丢弃纪律对命中项同样适用。
            // 这一支此前完全静默，于是"唤醒了但没应答"与"根本没唤醒"无从区分：
            // 形象亮不亮只有人眼看得到，日志上两者都是一片空白（2026-08-27）。
            eprintln!("[sentinel] 唤醒（只喊名字）：应答 + 开聆听窗口");
            state.woken.fetch_add(1, Ordering::Relaxed);
            emit_wake(app, &WakeStatus::Woken { has_command: false });
            state.open_listening();
            emit_wake(app, &WakeStatus::ListeningWindow { open: true });
            speak_ack(app);
        }
        WakeOutcome::Wake { command: Some(cmd) } => {
            // 同上只记形状：字数而非内容。
            eprintln!("[sentinel] 唤醒（带指令，{} 字）：直达上行", cmd.chars().count());
            state.woken.fetch_add(1, Ordering::Relaxed);
            emit_wake(app, &WakeStatus::Woken { has_command: true });
            // 指令已到手，聆听许可用掉；回复播完 on_tts_finished 会开追问窗口
            state.consume_window();
            send_with_adoption(app, &state, &cmd);
        }
        WakeOutcome::Miss => {
            if state.window_active().is_some() {
                // 窗口内：整句免唤醒词直接成输入，许可一次性消耗
                state.consume_window();
                emit_wake(app, &WakeStatus::ListeningWindow { open: false });
                emit_wake(app, &WakeStatus::FollowupWindow { open: false });
                send_with_adoption(app, &state, text);
            } else {
                // 丢弃纪律：只计数。text 到此为止，无任何副本（AC-52-5）。
                state.missed.fetch_add(1, Ordering::Relaxed);
                let _ = (truncated, duration_ms);
            }
        }
    }
}

/**
 * 与播报重叠过的段的判定入口（施工单 M33-03；0830 走查放宽）。
 *
 * 一进门先滤回采，然后按"播报此刻还在不在进行"分两条路：
 *
 *  - **播报进行中**（`TTS_PLAYING`）：维持 M33-03 的窄通道——打断口令走
 *    `interrupt_assistant`，其余丢弃并计数。**不成轮、不落库、不进记忆、
 *    不开窗口**（AC-52-5 的丢弃纪律一字不改）。
 *  - **播报已经结束**：这个段只是压着播报的尾巴（VAD 要 750ms 静音才收段，
 *    紧跟播报开口的车主几乎必然和尾音并进同一段）。非回采就**转回常规分发**：
 *    追问窗口、唤醒词、退下在那边照常生效。
 *
 * # 0830 实测教训：结束后的非回采不能丢
 *
 * 0829 ④ 初版把重叠段一律按窄通道处理，非回采非打断即丢——结果是
 * **播完之后 5s 追问窗口里说什么都没反应**：人对答案的自然反应就落在
 * 播报结束后的一秒内，那时的段全都与尾音重叠。回采已由 `is_echo`
 * （含 `recently_spoken` 的迟到比对）挡住，剩下的就是车主在说话。
 *
 * # 顺序不能反
 *
 * 先回采后其它。反过来的话，回答里出现「等等」「别说了」这类词时，
 * 她会被自己的话打断——那比"喊停没反应"看起来严重得多。
 *
 * # `barge_in_require_wake` 是约束 1 的降级位
 *
 * 若真机实测发现回采比对挡不住，把它打开：播报进行中的窄通道只放行
 * 喊了名字的段（「暖暖，停」）。代价是多说两个字，但暖暖不会被自己的话打断。
 */
pub fn on_transcript_during_tts(app: &AppHandle, text: &str, truncated: bool, duration_ms: u32) {
    let Some(state) = app.try_state::<SentinelState>() else { return };

    if std::env::var("CARLIFE_SENTINEL_DEBUG").is_ok_and(|v| v == "1") {
        eprintln!("[sentinel][debug][播报重叠段] 转写={text:?}");
    }

    /*
     * 原文取"正在播的，或刚播完不久的"（走查 2026-08-29 ④）。
     * 重叠段的判定时刻往往已在播报结束之后（VAD 收尾 750ms + ASR 一趟），
     * `speaking_text` 已清——只看它的话，播报每句的尾巴都拿 None 去比对，
     * 一律放行。保留窗盖住这两段延迟即可。
     */
    let speaking = app
        .try_state::<Arc<crate::tts::TtsState>>()
        .and_then(|tts| tts.recently_spoken(std::time::Duration::from_secs(8)));
    if echo::is_echo(text, speaking.as_deref()) {
        state.echo_filtered.fetch_add(1, Ordering::Relaxed);
        return;
    }

    // 播报已经结束：非回采 = 紧跟播报开口的车主，交回常规分发（见函数注释）。
    // 注意合并段的转写可能带着几个尾音词做前缀——与 0829 之前的行为一致，
    // 比把整句丢掉好。
    if !sentinel::TTS_PLAYING.load(Ordering::Relaxed) {
        on_transcript(app, text, truncated, duration_ms);
        return;
    }

    /*
     * 播报进行中喊名字 = 最明确的「别念了，听我说」（0830 走查②：
     * 「中途喊她不理，说完了才理」）。原窄通道只认打断口令表，喊「暖暖」
     * 不在表里，于是被当 Miss 丢掉。现在：停播（走统一打断入口），
     * 再把整句交回常规分发——只喊名字会得到应答 + 聆听窗口，带指令直接执行，
     * 「暖暖退下」也在那边照常生效。
     *
     * 误触面：她自己的播报里出现「暖暖」且 ASR 错到拼音比对都没拦住时，
     * 会自己停下来说「我在」。两层小概率叠加（echo 先过一道），
     * 且唤醒词判定本来就是全链路里最强的用户信号（REQUIRE_WAKE 降级位
     * 就是拿它当唯一放行条件的），可接受。
     */
    if wake::has_wake_word(text) {
        eprintln!("[sentinel] 播报期喊名字：停播并接管");
        state.interrupted.fetch_add(1, Ordering::Relaxed);
        crate::interrupt::interrupt_assistant(app, crate::interrupt::InterruptSource::Voice);
        on_transcript(app, text, truncated, duration_ms);
        return;
    }

    // 降级位：只放行喊了名字的段（见函数注释）。喊名字已在上面接管，
    // 这道闸挡的是其余一切（含打断口令表——降级位开着就意味着比对不可信）。
    if sentinel::BARGE_IN_REQUIRE_WAKE.load(Ordering::Relaxed) {
        state.missed.fetch_add(1, Ordering::Relaxed);
        return;
    }

    if wake::is_interrupt(text) {
        eprintln!("[sentinel] 播报期语音打断");
        state.interrupted.fetch_add(1, Ordering::Relaxed);
        crate::interrupt::interrupt_assistant(app, crate::interrupt::InterruptSource::Voice);
        return;
    }

    // 丢弃纪律：只计数，文本到此为止（AC-52-5）。
    state.missed.fetch_add(1, Ordering::Relaxed);
}

/// 指令上行；409（会话过期）时新建会话重发并让前端收编。
///
/// **没有绑定会话时不再把指令丢掉**（施工单 M50-02）。M50-02 之前引导会在开机时
/// 预建一个会话，于是"无绑定会话"只在极边界出现；改成"第一次说话才建"之后，
/// 启动后还没说过话就是常态——原来那条丢弃分支会变成"第一句话必丢"，
/// 而现象是喊了名字、说了指令，屏幕上什么都没发生。
///
/// 走的是与 409 完全相同的那条路（建会话 → 绑定 → 让前端收编 → 重发），
/// 不另造一套：车机上建不出会话（车辆级 token 要求先声明谁在用，M48-05）时，
/// 两条路的收敛行为也该一样——记一行日志，指令这次确实没送出去。
fn send_with_adoption(app: &AppHandle, state: &SentinelState, content: &str) {
    // 闲聊旁路开关随这条消息上行（M33-04）：端上关掉不算真关。
    let gateway = crate::commands::media::gateway_client()
        .with_filler_enabled(filler_enabled_now(app));
    let Some(sid) = state.bound_session() else {
        eprintln!("[sentinel] 还没有会话，现建一个再发（chars={}）", content.chars().count());
        adopt_and_send(app, state, &gateway, content);
        return;
    };
    match tauri::async_runtime::block_on(gateway.send_text(&sid, content, MessageSource::Voice)) {
        Ok(turn) => eprintln!("[sentinel] 指令直达 turn={}", turn.turn_id),
        Err(
            carlife_net::NetError::SessionExpired | carlife_net::NetError::Server(409),
        ) => {
            eprintln!("[sentinel] 会话已过期，新建并收编");
            adopt_and_send(app, state, &gateway, content);
        }
        Err(e) => eprintln!("[sentinel] 指令上行失败：{e}"),
    }
}

/// 建会话 → 绑定 → 让前端收编 → 重发。「没有会话」与「会话过期」共用它。
fn adopt_and_send(
    app: &AppHandle,
    state: &SentinelState,
    gateway: &carlife_net::GatewayClient,
    content: &str,
) {
    /*
     * 车机建会话必须带本次上车的声明（M54-05）。
     *
     * 此前这里恒调不带声明的 `create_session`，车机上必然 400——**表现是
     * 喊了唤醒词、指令被静默丢弃**，日志里只有一行"建会话失败"。
     * 下面那句注释当时把它当成"该回去走上车声明"，但人其实刚声明过，
     * 只是那次声明没被任何地方记住。
     */
    let created = if carlife_core::auth::bound_vin().is_some() {
        match crate::boarding::declared() {
            Some(who) => tauri::async_runtime::block_on(gateway.create_session_as(Some(who))),
            None => {
                /*
                 * **出声说一句，不要静默。**
                 *
                 * 用户的原话是"我喊暖暖开空调，不理我"——静默丢弃指令时，
                 * 人分不清是没听见、没听懂、还是被拒了，三者的下一步动作
                 * 完全不同。这里唯一正确的下一步是回屏幕上声明，那就说出来。
                 *
                 * 不加 WakeStatus 新分支：那要动 `carlife-core` 的共享契约
                 * （ts-rs 生成到前端），为一句提示改协议不划算。
                 */
                eprintln!("[sentinel] 车机尚未完成上车声明，本次指令未送出");
                if let Some(tts) = app.try_state::<Arc<crate::tts::TtsState>>() {
                    crate::tts::speak(app, &tts, "请先在屏幕上选择现在是谁在用车。");
                }
                return;
            }
        }
    } else {
        tauri::async_runtime::block_on(gateway.create_session())
    };
    match created {
        Ok(created) => {
            let sid = created.session_id;
            state.bind(Some(sid.clone()));
            emit_wake(app, &WakeStatus::SessionAdopted { session_id: sid.clone() });
            match tauri::async_runtime::block_on(gateway.send_text(&sid, content, MessageSource::Voice)) {
                Ok(turn) => eprintln!("[sentinel] 指令直达（新会话）turn={}", turn.turn_id),
                Err(e) => eprintln!("[sentinel] 收编后上行仍失败：{e}"),
            }
        }
        // 车机（车辆级 token）会在这里拿到 400 active_user_required——
        // 那是"该回去走上车声明"，不是可重试的错误，日志说清即可。
        Err(e) => eprintln!("[sentinel] 建会话失败，本次指令未送出：{e}"),
    }
}

/// 关掉 / 打开闲聊旁路（施工单 M33-04）。
///
/// ⚠️ **端上关掉只是一半**：服务端仍会建 A-pair、仍在跑判断、仍在写指标，
/// 接了 L1 之后仍会烧钱（M18-05 自己留的那句注释）。另一半是把
/// `fillerEnabled` 随每一条上行消息带给服务端——那条链路在
/// `commands/media.rs` 与 `voice/mod.rs` 的发送点上，见 `filler_enabled_now`。
fn set_sidecar(app: &AppHandle, on: bool) {
    let Some(tts) = app.try_state::<Arc<crate::tts::TtsState>>() else { return };
    tts.set_filler_muted(!on);
    if !on {
        // 正在播的那句垫场当场停。**只停垫场，不碰正文**——
        // 关旁路不是关播报，主回答该念还是念。
        crate::tts::stop_if_filler(&tts);
    }
    emit_wake(app, &WakeStatus::SidecarSwitched { on });
    crate::tts::speak(app, &tts, if on { SIDECAR_ON_ACK } else { SIDECAR_OFF_ACK });
}

/// 拨开关的回执。**短到一句**——车主刚说完"别废话了"，回一段话是同一个错误的延续。
const SIDECAR_OFF_ACK: &str = "好，我少说点。";
const SIDECAR_ON_ACK: &str = "好，路上我陪你聊。";

/// 此刻要不要让服务端产垫场（施工单 M33-04）。
///
/// 每条上行消息都带它。**缺省是"要"**——与服务端 `TurnInput.fillerEnabled ?? true`
/// 对齐，老端上不传时行为逐字不变。
pub fn filler_enabled_now(app: &AppHandle) -> bool {
    app.try_state::<Arc<crate::tts::TtsState>>()
        .map(|tts| !tts.is_filler_muted())
        .unwrap_or(true)
}

/// 唤醒应答：一声短应答（走既有 TTS 通道，静音开关由 tts 模块自己判）。
/// 播报期间哨兵自动丢帧（sentinel::TTS_PLAYING），应答不会被自己转写。
fn speak_ack(app: &AppHandle) {
    if let Some(tts) = app.try_state::<Arc<crate::tts::TtsState>>() {
        crate::tts::speak(app, &tts, WAKE_ACK);
    }
}
