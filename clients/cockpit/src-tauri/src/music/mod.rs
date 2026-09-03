//! 车内音乐：跟随服务端播放器状态，在本机出声（施工单 M63-03）。
//!
//! # 为什么出声位在端上
//!
//! mock-cabin 的三个播放后端全是 spawn **它自己那台机器**上的二进制。部署之后
//! 那台机器是服务器：没有 mpg123、没有声卡，装上也没用——响的是服务器，
//! 而车主在车里。所以字节要拉到端上来放。服务端只留状态机。
//!
//! # 端是从动方，一秒一拍
//!
//! 一个常驻任务每秒 `POST /v1/cabin/media/sink`：上报自己在放什么、拿回服务端
//! 的播放器状态，交给 [`decide`] 得出这一拍该做的一件事。放哪首、放不放、
//! repeat/shuffle 全是服务端说了算。
//!
//! 用轮询不用 SSE：车机端本来就常驻，这一跳比 SSE 少一整套连接管理；
//! 而 `session/update` 那条 SSE 是对话流，媒体状态不该混进去。
//!
//! # 掉线：先放完，再停
//!
//! 心跳失败**不立刻静音**——用户在开车，突然没声比慢一拍糟。连续
//! [`MAX_BEAT_FAILURES`] 次（约 5 秒）之后才停，并把原因写进日志。
//! 恢复之后重新 `claim`。
//!
//! # 音乐不进 AEC 参考信号
//!
//! M47 的回声消除参考信号只覆盖 TTS 一路，本单**不接**音乐。后果是放歌时
//! 麦克风会采到音乐，有人声的歌会误唤醒——现场纪律仍是 `mocks/cabin/media/README.md`
//! 里那条"别放有人声的"。这是已知限制，不是忘了。

mod decide;
mod player;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use carlife_net::{PlayerStatus, SinkBeat};

pub use decide::{decide, Action, LocalState};
pub use player::MusicPlayer;

/// 轮询周期。服务端的出声位租约是 5 秒，1 秒一拍留了四次失败余量。
const BEAT_INTERVAL_MS: u64 = 1_000;
/// 连续这么多次心跳失败之后停播。约 5 秒——与服务端租约同量级。
const MAX_BEAT_FAILURES: u32 = 5;

static PLAYER: OnceLock<Arc<MusicPlayer>> = OnceLock::new();
/// 一键静音。默认开；现场要关时从 devtools `invoke("set_music_enabled", {on:false})`。
static ENABLED: AtomicBool = AtomicBool::new(true);

fn player() -> &'static Arc<MusicPlayer> {
    PLAYER.get_or_init(|| Arc::new(MusicPlayer::default()))
}

/// 让路开关。由 `tts::ducking::set_tts_playing` 在**边沿**调用。
///
/// 与那条远端 duck 请求的分工：远端那条压的是服务端自己在放的音乐（单机 demo
/// 形态下 mock-cabin 用 mpg123 出声）；这条压的是本机这个 `rodio::Player`。
/// 两条都留着，因为两种形态都还在用。
pub fn set_ducked(on: bool) {
    player().set_ducked(on);
}

/// 一键静音（现场用）。
///
/// **没有界面入口是有意的**：它是给走查/演示留的逃生阀，不是产品功能——
/// 音乐开不开该由服务端的媒体源（`cabin_control` 的 `source`）决定，
/// 端上再摆一个开关就是第二处真相源。要用时从 devtools：
/// `invoke("set_music_enabled", { on: false })`。
#[tauri::command]
pub fn set_music_enabled(on: bool) {
    set_enabled(on);
}

/// 此刻车机端在不在出声。**只读，不带参数，不改任何状态。**
///
/// # 谁要它、要它干什么
///
/// 出发动画的音景（M64-03）在点「开始行程」那一刻问一次：音乐在放就把音景降级成
/// 两个 earcon，不在放就走完整形态。**它不压音乐**——压不压是 `tts::ducking`
/// 那一条路的事，端上只该有一个让路出口（那条纪律写在 `tts/ducking.rs` 文件头）。
///
/// # 只问一次，不订阅
///
/// 出发动画是 18.9 秒的一次性过程。中途音乐状态变了也不该改变已经在放的音景形态
/// ——半程换形态比全程用一种形态更怪。所以这里是一次调用，不是一条事件流：
/// 往 `run()` 的轮询循环里加 emit，是为一个装饰性功能去动 M63-03 的核心。
///
/// # 判据取 `finished()`，代价说在前面
///
/// `finished()` 问的是"队列空不空"，所以**暂停中且队列非空会被算成在放**。
/// 这个偏差是刻意留在保守那一侧的：把"其实没在响"误判成在放，结果是音景少出两个音；
/// 反过来误判，结果是音景盖在音乐上。宁可少出声。
#[tauri::command]
pub fn music_is_audible() -> bool {
    enabled() && !player().finished()
}

/// 一键静音。关掉之后停播并交还出声位。
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::SeqCst);
    if !on {
        player().stop();
    }
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

/// 用例用：设一个好算的基准音量。
#[cfg(test)]
pub(crate) fn set_base_volume_for_test(percent: u32) {
    player().set_base_volume(percent);
}

/// 此刻在不在让路。给 `tts::ducking` 的用例用——它要断言"置位确实压到了音乐上"，
/// 而唯一不碰声卡又看得见的判据就是增益。
#[cfg(test)]
pub(crate) fn ducked_gain() -> f32 {
    player().gain()
}

/// 启动常驻的跟随任务。**只在车机端且已绑定车辆时**——没绑定就没有"这辆车的播放器"。
pub fn start() {
    tauri::async_runtime::spawn(async move {
        // 出声位标识跟着设备实例走：同一台端重启后是同一个 id，
        // 服务端那边看到的就是"它回来了"而不是"又来了一个"。
        // 取不到设备 id（还没 init 完）时退回一个进程内随机值——**不能不带 id**，
        // 空的 sink_id 会被服务端 400 挡下，而现象只是"一直没声"。
        let sink_id = carlife_core::device::current_id()
            .map(|id| format!("cockpit-{id}"))
            .unwrap_or_else(|_| format!("cockpit-{}", std::process::id()));
        run(sink_id).await;
    });
}

async fn run(sink_id: String) {
    let mut local = LocalState { sink_id: sink_id.clone(), ..Default::default() };
    let mut failures: u32 = 0;
    /*
     * 下一拍要不要抢出声位。
     *
     * **它由上一拍的 `decide` 决定，不由 `!local.claimed` 决定**——这两者看着等价，
     * 差别是后者在"刚被别人抢走"的那一拍恒为真，于是心跳带着 `claim:true` 又抢回去。
     * 两台车机各跑一份这个循环，结果是出声位每秒来回跳、`audible` 全程 false、
     * **谁也放不成**，而两边日志都只说"被对方拿走了"，看不出是自己在抢。
     * （2026-09-02 实测：本机与局域网上另一台车机端撞上，两个 sink id 交替出现。）
     *
     * 起手是 false：第一拍先只问不抢——那时还没有任何视图，
     * 盲抢就是从一台正在放歌的车机手里把声音掐掉。代价是首次认领晚一拍（1 秒）。
     */
    let mut want_claim = false;

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(BEAT_INTERVAL_MS)).await;

        if carlife_core::auth::bound_vin().is_none() {
            // 没绑定就没有"这辆车的播放器"。安静等着，别每秒打一次必然失败的请求。
            continue;
        }
        if !enabled() {
            continue;
        }

        let (base_url, token) = crate::settings::gateway();
        let client = carlife_net::GatewayClient::new(base_url, token);

        // 本曲在端上自然播完了：这一拍要把它告诉服务端，否则队列永远不往前走。
        let ended = local.status == PlayerStatus::Playing && player().finished();
        let beat = SinkBeat {
            sink_id: sink_id.clone(),
            claim: want_claim,
            status: Some(local.status),
            position_sec: player().position_sec(),
            ended,
            error: local_error(),
            ..Default::default()
        };
        if ended {
            local.status = PlayerStatus::Stopped;
            local.track_id = None;
        }

        let view = match client.post_cabin_media_sink(&beat).await {
            Ok(v) => {
                if failures > 0 {
                    eprintln!("[music] 心跳恢复（此前失败 {failures} 次）");
                }
                failures = 0;
                clear_error();
                v
            }
            // 下面这个分支之后会 `continue`，所以 `local.claimed` 的更新放在 match 之后。
            Err(e) => {
                failures += 1;
                // 先放完手上这首。用户在开车，突然静音比慢一拍糟。
                if failures == MAX_BEAT_FAILURES {
                    eprintln!("[music] 心跳连续失败 {failures} 次，停播：{e}");
                    player().stop();
                    local.status = PlayerStatus::Stopped;
                    local.track_id = None;
                    local.claimed = false;
                    // 网络回来之后重新走一遍"先问再抢"，别一恢复就去夺。
                    want_claim = false;
                }
                continue;
            }
        };

        /*
         * **认领成没成功只有服务端知道**，所以这一位从它的回答里取，不自己记。
         * 自己记的写法在"我以为我认领了、其实上一拍就被别人抢走了"这一格会错，
         * 而那一格的表现是本机接着往下放——两台车机同时出声。
         */
        local.claimed = view.sink_is(&sink_id);

        match decide(&local, &view) {
            Action::Idle => {}
            Action::Claim => {
                // 只是"下一拍带上 claim"，不是"已经认领到了"。
                if !want_claim {
                    eprintln!("[music] 出声位空着，下一拍认领 sink_id={sink_id}");
                }
                want_claim = true;
                local.track_id = None;
                local.status = PlayerStatus::Stopped;
            }
            Action::Yield => {
                if local.status != PlayerStatus::Stopped || want_claim {
                    let holder = view.sink.as_ref().and_then(|s| s.sink_id.clone()).unwrap_or_default();
                    eprintln!("[music] 出声位被 {holder} 拿走，让出（等它退出或租约过期再说）");
                    player().stop();
                }
                // 关键的一行：让出之后**不再抢**。少了它就是那个谁也放不成的活锁。
                want_claim = false;
                local.status = PlayerStatus::Stopped;
                local.track_id = None;
            }
            Action::Load(track_id) => match client.get_cabin_media_track(&track_id).await {
                Ok(bytes) => {
                    let n = bytes.len();
                    match player().load(bytes) {
                        Ok(()) => {
                            player().set_base_volume(view.output_volume);
                            local.track_id = Some(track_id.clone());
                            local.status = PlayerStatus::Playing;
                            local.volume = view.output_volume;
                            clear_error();
                            eprintln!("[music] 起播 {track_id}（{n} 字节，音量 {}）", view.output_volume);
                        }
                        Err(e) => {
                            // 播不了要如实上报，下一拍随心跳带给服务端——
                            // 车主听不到声时，这句话就是答案本身。
                            eprintln!("[music] 起播失败 {track_id}：{e}");
                            set_error(format!("起播失败：{e}"));
                            local.status = PlayerStatus::Stopped;
                            local.track_id = None;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[music] 拉字节失败 {track_id}：{e}");
                    set_error(format!("拉字节失败：{e}"));
                    local.status = PlayerStatus::Stopped;
                    local.track_id = None;
                }
            },
            Action::Pause => {
                player().pause();
                local.status = PlayerStatus::Paused;
                eprintln!("[music] 暂停");
            }
            Action::Resume => {
                player().resume();
                local.status = PlayerStatus::Playing;
                eprintln!("[music] 继续");
            }
            Action::Stop => {
                player().stop();
                local.status = PlayerStatus::Stopped;
                local.track_id = None;
                eprintln!("[music] 停止");
            }
            Action::SetVolume(v) => {
                player().set_base_volume(v);
                local.volume = v;
            }
        }
    }
}

// ── 端上错误的暂存 ────────────────────────────────────────────
//
// 拉字节 / 解码失败的原因要随下一次心跳原样上报。存一格就够：
// 连续失败时后一条覆盖前一条，而车主关心的永远是最近那一条。

static LAST_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn set_error(msg: String) {
    if let Ok(mut g) = LAST_ERROR.lock() {
        *g = Some(msg);
    }
}

fn clear_error() {
    if let Ok(mut g) = LAST_ERROR.lock() {
        *g = None;
    }
}

fn local_error() -> Option<String> {
    LAST_ERROR.lock().ok().and_then(|g| g.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 没起播时不算在出声。
    ///
    /// 这条同时守住了"还没有 `Output`"那一格：`finished()` 在拿不到输出时返回 `true`，
    /// 所以客户端刚起来、一首歌都没放过的时候，音景该走完整形态而不是被无端降级。
    #[test]
    fn 没起播时不算在出声() {
        let was = enabled();
        set_enabled(true);
        assert!(!music_is_audible(), "一首歌都没放过，不该被当成在放");
        set_enabled(was);
    }

    /// 一键静音关掉之后，无论队列里有什么都不算在出声——它连声卡都不占了。
    #[test]
    fn 一键静音关掉之后恒为假() {
        let was = enabled();
        set_enabled(false);
        assert!(!music_is_audible());
        set_enabled(was);
    }
}
