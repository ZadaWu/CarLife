//! 让路 —— 暖暖说话时把车内音乐压低，说完恢复（M27，§2.2 C6 的补角）。
//!
//! # 为什么和 `TTS_PLAYING` 合成一个出口
//!
//! 哨兵那个标志已经**精确标记了"正在出声"**：afplay 子进程起来才置位、
//! 退出/被 kill 就清位，四个写入点覆盖了自然结束、被打断、启动失败三种收尾。
//! 让路要的边沿与它逐字相同。
//!
//! 那就不该有第二套判断。两处各写一遍的下场是它们迟早对不齐——
//! 而对不齐的表现是**音乐一直压着没恢复**（或者反过来，播报时音乐照样很响），
//! 两个现象都不会报错，只会让人觉得"这车音频有点怪"。
//! 所以 `tts/mod.rs` 里所有对 `TTS_PLAYING` 的写入都改走 [`set_tts_playing`]，
//! 置位与让路是同一次调用的两件事，结构上没法漏一个。
//!
//! # 它绝不能拖住播报
//!
//! 播报是功能，让路是装饰。车机没连上、mock 挂了、网关慢了——任何一种情况下
//! 暖暖都必须照常开口。所以这一跳是 fire-and-forget：另起任务、带 1.5s 超时、
//! 失败只记一行日志。**不要改成 await**，那等于把一个装饰性功能接进了
//! "助手还说不说话"的关键路径。
//!
//! # 两条让路，各服务一种形态（M63-03）
//!
//! 出声位搬到端上之后，音乐是**这个进程里的一个 `rodio::Player`**在放。
//! 压它是一次同步函数调用（`music::set_ducked`），不经网络、不需要租约。
//! 下面那条远端请求仍然保留：单机 demo 形态下（全部跑在一台 Mac 上）音乐由
//! mock-cabin 自己用 mpg123 出声，压的是那一个。两种形态都还在用。
//!
//! # 恢复请求没送达怎么办
//!
//! 车机侧的让路是**租约**不是开关（见 mock-cabin 的 `player.ts`）：压低带到期
//! 时间，到点自客恢复。这里发的恢复请求照常立即生效，租约只兜底"这个进程
//! 在播报中途被关掉"那一类情况——否则音乐会永远停在压低状态且一声不响。

use std::sync::atomic::Ordering;

use carlife_net::GatewayClient;

/// 让路租期。取值要**大于任何一句播报的时长**：正常路径上恢复请求总会到，
/// 租约只是兜底；定得太短会把一段长播报截成"说到一半音乐突然变响"。
const DUCK_HOLD_MS: u64 = 30_000;

/// 置位"正在出声"，并把让路请求发出去。
///
/// 只在**边沿**发请求：`stop()` 会在本来就没在播时清位，那种情况下
/// 一次多余的往返没有意义，而演示里 `stop` 是每轮都会走的。
pub fn set_tts_playing(playing: bool) {
    let prev = crate::voice::sentinel::TTS_PLAYING.swap(playing, Ordering::SeqCst);
    if prev == playing {
        return;
    }
    // 本机这一路先压（M63-03）：音乐现在就在这个进程里放，让路是一次函数调用，
    // 同步、无网络、没有"恢复请求送不到"这回事——上面那整段租约理由对它不成立。
    crate::music::set_ducked(playing);
    // 远端那一路照发：单机 demo 形态下音乐由 mock-cabin 自己用 mpg123 出声，
    // 压的是那一个。两种形态都还在用，所以两条都留着。
    spawn_duck(playing);
}

fn spawn_duck(on: bool) {
    // 与 commands/stream.rs 同一对环境变量——网关地址与令牌只有一处口径。
    // 统一走设置层（ACR-004 第 3 步）——iOS 没有环境变量，各自读 env 在 iPad 上必错。
    let (base_url, token) = crate::settings::gateway();
    tauri::async_runtime::spawn(async move {
        let hold = if on { Some(DUCK_HOLD_MS) } else { None };
        if let Err(e) = GatewayClient::new(base_url, token).post_cabin_duck(on, hold).await {
            // 只记一行。失败的后果是音乐没让路，不影响任何人说话——
            // **但不能一声不吭**，"演示时音乐没让路"总得查得到原因。
            eprintln!("[tts] 让路请求失败（on={on}）：{e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 置位要**真的压到音乐上**（M63-03）。
    ///
    /// 这条守的是一个不会报错的回归：`set_tts_playing` 里少了那一行
    /// `music::set_ducked`，远端请求照发、日志照打、`TTS_PLAYING` 照置——
    /// 唯一的现象是暖暖说话时音乐还是那么响。判据用增益而不是"调用过没有"：
    /// 调用了但传错了值同样是坏的。
    #[test]
    fn 置位会压低本机音乐_解除会恢复() {
        crate::music::set_ducked(false);
        crate::voice::sentinel::TTS_PLAYING.store(false, Ordering::SeqCst);
        // 基准音量取一个好算的数：20% 压到 30% 是 6%。
        crate::music::set_base_volume_for_test(20);

        crate::music::set_ducked(true);
        assert!((crate::music::ducked_gain() - 0.06).abs() < 1e-6, "让路中应当是 20% 的 30%");
        crate::music::set_ducked(false);
        assert!((crate::music::ducked_gain() - 0.20).abs() < 1e-6, "解除后要回到原音量");
    }

    /// 边沿判定是纯逻辑，不碰网络：连着置同一个值只应触发一次。
    ///
    /// 这条用例保护的是"每轮播报两次往返"这个量级——写成无条件发送的话，
    /// 一轮里 `stop` + `play` + 结束轮询会打出四五次，而多出来的那几次
    /// 一次都不会报错，只是白白占着网关。
    #[test]
    fn 同值重复置位不重复触发() {
        crate::voice::sentinel::TTS_PLAYING.store(false, Ordering::SeqCst);
        let first = crate::voice::sentinel::TTS_PLAYING.swap(true, Ordering::SeqCst);
        let second = crate::voice::sentinel::TTS_PLAYING.swap(true, Ordering::SeqCst);
        assert_eq!(first, false, "第一次是边沿");
        assert_eq!(second, true, "第二次不是边沿，调用方据此跳过");
        crate::voice::sentinel::TTS_PLAYING.store(false, Ordering::SeqCst);
    }
}
