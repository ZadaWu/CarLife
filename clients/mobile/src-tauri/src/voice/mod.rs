// voice — 哨兵监听（常驻 VAD + 唤醒词）·手机端（施工单 M60-01）
//
// 车机端 M25-01～M33 做了整条链路，手机端一直只有长按说话。本模块把它补齐：
// 循环见 `sentinel`（与车机端分开的理由写在那个文件头），判据经
// `carlife-voice` 与车机端共用一份，本文件负责**转写文本的去向**。

pub mod sentinel;

/*
 * 唤醒词判定与对话窗口来自共享 crate（M60-01）——与车机端**一字不差**。
 *
 * 复制一份的结局是"同一句话在车上有用、在手机上没反应"，而这种差异
 * 不会有任何报错，只会被当成"手机上这个功能坏了"。
 */
pub use carlife_voice::{wake, windows};

pub use sentinel::wait_mic_released;

use std::sync::atomic::Ordering;

use carlife_core::contract::{MessageSource, WakeStatus};
use carlife_net::GatewayClient;
use tauri::{AppHandle, Manager};

use crate::commands::voice::{emit_wake, SentinelState};
use wake::WakeOutcome;

/// 哨兵转写文本的唯一去向。
///
/// 判定顺序对齐车机端 `voice/mod.rs`：
///  1. `Dismiss` / `Wake` 永远按口令与唤醒处理——窗口内也一样
///     （窗口里说「暖暖退下」是让她走，不是一条消息）；
///  2. `Miss` + 窗口开着 → 整句就是输入（窗口 = 免唤醒词的对话许可，一次性）；
///  3. `Miss` + 没有窗口 → **就地丢弃**，连长度都不记（AC-52-5）。
///
/// 手机端与车机端唯一的行为差异在**三条与播报有关的口令**上，见下面那一支。
pub fn on_transcript(app: &AppHandle, text: &str) {
    let Some(state) = app.try_state::<SentinelState>() else { return };

    let outcome = wake::classify(text);
    /*
     * 本机排障开关（`CARLIFE_SENTINEL_DEBUG=1`）。**默认关，且只能是默认关**：
     * AC-52-5 要求未命中的转写判定后即弃、不留任何副本。
     * 开发机上自己打开，看完关掉；用户手机上永远不开。
     */
    if std::env::var("CARLIFE_SENTINEL_DEBUG").is_ok_and(|v| v == "1") {
        eprintln!("[sentinel][debug] 转写={text:?} 判定={outcome:?}");
    }

    match outcome {
        /*
         * 打断 / 关旁路 / 开旁路——**手机端没有承接方**。
         *
         * 这三条口令拨的都是"她说话"这件事：打断正在播的那句、让她少说点。
         * 手机端没有本地播报（`commands/media.rs` 文件头），三者在这里
         * 都没有能作用的对象。
         *
         * 于是按丢弃处理，**但单独记一行日志**：静默丢弃的话，用户说了
         * 「别废话了」没反应，与"没听清"在现象上完全一样，而两者的下一步
         * 完全不同。这行日志是排查时唯一分得开它们的东西。
         */
        WakeOutcome::Interrupt | WakeOutcome::SidecarOff | WakeOutcome::SidecarOn => {
            eprintln!("[sentinel] 与播报有关的口令在手机端无承接方（无本地 TTS），已丢弃");
            state.missed.fetch_add(1, Ordering::Relaxed);
        }
        WakeOutcome::Dismiss => {
            state.dismissed.fetch_add(1, Ordering::Relaxed);
            state.clear_windows();
            let Some(sid) = state.bound_session() else {
                eprintln!("[sentinel] 收到退下口令但无绑定会话，忽略");
                return;
            };
            match tauri::async_runtime::block_on(gateway().close_session(&sid)) {
                Ok(()) => {
                    eprintln!("[sentinel] 语音退下：会话已软关闭");
                    emit_wake(app, &WakeStatus::Dismissed);
                }
                Err(e) => eprintln!("[sentinel] 语音退下失败：{e}"),
            }
        }
        WakeOutcome::Wake { command: None } => {
            /*
             * 只喊了名字：开聆听窗口，等下一句。
             *
             * 车机端这里还会出声应答一句「哎，我在」，手机端不出声——
             * 但**必须发事件**，否则用户喊完名字屏幕上什么都不动，
             * 与"根本没听见"分不开。HUD 的助手形象靠这条事件进 listening 态。
             */
            eprintln!("[sentinel] 唤醒（只喊名字）：开聆听窗口");
            state.woken.fetch_add(1, Ordering::Relaxed);
            emit_wake(app, &WakeStatus::Woken { has_command: false });
            state.open_listening();
            emit_wake(app, &WakeStatus::ListeningWindow { open: true });
        }
        WakeOutcome::Wake { command: Some(cmd) } => {
            // 只记形状：字数而非内容（AC-52-5 的丢弃纪律对命中项同样适用）。
            eprintln!("[sentinel] 唤醒（带指令，{} 字）：直达上行", cmd.chars().count());
            state.woken.fetch_add(1, Ordering::Relaxed);
            emit_wake(app, &WakeStatus::Woken { has_command: true });
            state.consume_window();
            send_with_adoption(app, &state, &cmd);
        }
        WakeOutcome::Miss => {
            if state.window_active().is_some() {
                // 窗口内：整句免唤醒词直接成输入，许可一次性消耗
                state.consume_window();
                emit_wake(app, &WakeStatus::ListeningWindow { open: false });
                send_with_adoption(app, &state, text);
            } else {
                // 丢弃纪律：只计数。text 到此为止，无任何副本（AC-52-5）。
                state.missed.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

fn gateway() -> GatewayClient {
    let (base_url, token) = crate::commands::chat::gateway_env();
    GatewayClient::new(base_url, token)
}

/// 指令上行；没有会话或会话过期时新建并让前端收编。
///
/// 「没有绑定会话」在手机端是**常态**而非边界：会话是懒建的（第一次说话才建，
/// 见 `app/index.tsx` 的引导），所以启动后没打过字就唤醒时，这里必然走新建那条路。
/// 把它当成边界去丢弃，现象就是"第一句话必丢"——喊了名字、说了指令，
/// 屏幕上什么都没发生。
fn send_with_adoption(app: &AppHandle, state: &SentinelState, content: &str) {
    let gateway = gateway();
    let Some(sid) = state.bound_session() else {
        eprintln!("[sentinel] 还没有会话，现建一个再发（chars={}）", content.chars().count());
        adopt_and_send(app, state, &gateway, content);
        return;
    };
    match tauri::async_runtime::block_on(gateway.send_text(&sid, content, MessageSource::Voice)) {
        Ok(turn) => eprintln!("[sentinel] 指令直达 turn={}", turn.turn_id),
        Err(carlife_net::NetError::SessionExpired | carlife_net::NetError::Server(409)) => {
            eprintln!("[sentinel] 会话已过期，新建并收编");
            adopt_and_send(app, state, &gateway, content);
        }
        Err(e) => eprintln!("[sentinel] 指令上行失败：{e}"),
    }
}

/// 建会话 → 绑定 → 让前端收编 → 重发。「没有会话」与「会话过期」共用它。
///
/// 手机端的 token 是**用户级**的，不像车机要先声明这一趟是谁在用车（M48-05），
/// 所以这里直接 `create_session`，没有车机端那条"未声明就出声提醒"的分支。
fn adopt_and_send(
    app: &AppHandle,
    state: &SentinelState,
    gateway: &GatewayClient,
    content: &str,
) {
    match tauri::async_runtime::block_on(gateway.create_session()) {
        Ok(created) => {
            let sid = created.session_id;
            state.bind(Some(sid.clone()));
            // 前端据此切流、换 localStorage——Rust 不碰那两样，只通知。
            emit_wake(app, &WakeStatus::SessionAdopted { session_id: sid.clone() });
            match tauri::async_runtime::block_on(gateway.send_text(
                &sid,
                content,
                MessageSource::Voice,
            )) {
                Ok(turn) => eprintln!("[sentinel] 指令直达（新会话）turn={}", turn.turn_id),
                Err(e) => eprintln!("[sentinel] 收编后上行仍失败：{e}"),
            }
        }
        Err(e) => eprintln!("[sentinel] 建会话失败，本次指令未送出：{e}"),
    }
}
