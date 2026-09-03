//! 「服务端说该放什么」→「端上下一步做什么」的纯函数（施工单 M63-03）。
//!
//! # 为什么单独一个模块、而且不碰声卡
//!
//! 这一层是整条链上最容易出错的地方：换歌、暂停、被抢、掉线、车辆被重建，
//! 每一种的收尾都不一样，而**错了都不报错**——只是歌不对、或者没声。
//! 把它写成纯函数，这些分支才能被用例逐条钉住；混在轮询循环里就只能靠真机手测。
//!
//! # 端是从动方
//!
//! 放哪首、放不放、repeat/shuffle 全在服务端状态里。端只做三件事：跟随、拉字节、
//! 如实上报。这里出现"队列空了就随便挑一首"那种代码，就是走错了。

use carlife_net::{PlayerStatus, PlayerView};

/// 这一拍该做的**一件**事。一拍一件——轮询 1 秒一次，攒着做只会让状态更难对。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// 什么都不用做。
    Idle,
    /// 认领出声位（首次、被抢之后、或车机侧车辆被重建之后）。
    Claim,
    /// 拉这首的字节并起播。
    Load(String),
    Resume,
    Pause,
    Stop,
    /// 只改音量，**不重新起播**——改音量让歌从头开始是车机上最烦人的那种 bug。
    SetVolume(u32),
    /// 出声位不是我的了：停下来，别和另一个端一起放。
    Yield,
}

/// 端上此刻的实况。字段少是刻意的：它只需要够回答"和服务端差在哪"。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalState {
    /// 这台端的出声位标识。
    pub sink_id: String,
    /// 已经认领过（且还没被告知失去）。
    pub claimed: bool,
    /// 正在放（或暂停在）哪首。
    pub track_id: Option<String>,
    pub status: PlayerStatus,
    /// 已经下发给播放器的音量（0..=100）。
    pub volume: u32,
}

/// 出声位是不是**另一个还活着的端**在拿着。
///
/// 与"不是我的"不是一回事：`kind` 是 `host` / `none` 时出声位是空的，该去认领；
/// 只有 `client` 且 id 不是我，才是别人正拿着。
fn held_by_other(local: &LocalState, remote: &PlayerView) -> bool {
    remote
        .sink
        .as_ref()
        .is_some_and(|s| s.kind == "client" && s.sink_id.as_deref() != Some(local.sink_id.as_str()))
}

/// 下一步做什么。
///
/// 判定顺序本身就是语义，别随手调换：
///
/// 1. **没认领过就先认领**——认领之前收到的一切状态都不该驱动播放。
///    但**别人正拿着的时候不去抢**，理由见下面那一大段。
/// 2. **车辆被重建 ⇒ 重新认领**：队列跟着车机侧车辆走，重建过就等于队列没了。
/// 3. **出声位不是我的 ⇒ 让出**。放在换歌之前：被抢之后还去 Load 就是两个端一起放。
///    服务端**没回 `sink` 段**（旧版本）时也走这条——宁可不放，也不要两台机器同时放。
/// 4. 服务端停了 ⇒ 停。
/// 5. 换歌 ⇒ Load。它比暂停/继续优先：换歌本来就包含"从头开始放"。
/// 6. 暂停 / 继续。
/// 7. 音量。放在最后：前面几条都不成立时才轮到它，所以调音量不会打断播放。
///
/// # 让出之后不许马上抢回来
///
/// 第一版的 `Yield` 顺手把 `claimed` 置回 false，下一拍撞上第 1 条就又去认领了。
/// 两个端各跑一份这个循环，结果是**每 1 秒互夺一次，谁也放不成**——
/// 实测（2026-09-02，同一台机器上两个车机端）出声位在两个 sink id 之间来回跳，
/// `audible` 全程 false，而两边的日志都只说"被对方拿走了"，看不出是自己在抢。
///
/// 服务端那边已经为这件事留了 `claim` 与续租的区分（`media/player.ts` 的 `SinkBeat.claim`），
/// 但那只挡住"续租被当成抢占"；**端主动抢回来**它挡不住，也不该由它挡——
/// 谁该退让是端自己的决定。所以退让在这里：别人还活着就一直 `Idle` 等着，
/// 等对方退出（`alive:false`）或租约过期，`kind` 变回 `host`/`none` 时再认领。
pub fn decide(local: &LocalState, remote: &PlayerView) -> Action {
    if !local.claimed || remote.rebuilt {
        return if held_by_other(local, remote) { Action::Idle } else { Action::Claim };
    }
    if !remote.sink_is(&local.sink_id) {
        return Action::Yield;
    }

    let remote_track = remote.now_playing.as_ref().map(|t| t.track_id.as_str());
    if remote.status == PlayerStatus::Stopped || remote_track.is_none() {
        return if local.status == PlayerStatus::Stopped { Action::Idle } else { Action::Stop };
    }
    let remote_track = remote_track.expect("上一句已排除 None");

    if local.track_id.as_deref() != Some(remote_track) {
        return Action::Load(remote_track.to_string());
    }
    match (remote.status, local.status) {
        (PlayerStatus::Paused, PlayerStatus::Playing) => return Action::Pause,
        (PlayerStatus::Playing, PlayerStatus::Paused) => return Action::Resume,
        // 本地是 stopped 而服务端在放同一首：字节拉失败之类，重来一次。
        (PlayerStatus::Playing, PlayerStatus::Stopped) => return Action::Load(remote_track.to_string()),
        _ => {}
    }
    if remote.output_volume != local.volume {
        return Action::SetVolume(remote.output_volume);
    }
    Action::Idle
}

#[cfg(test)]
mod tests {
    use super::*;
    use carlife_net::{PlayerTrack, SinkView};

    fn remote(status: PlayerStatus, track: Option<&str>, sink_id: Option<&str>, vol: u32) -> PlayerView {
        PlayerView {
            status,
            audible: status == PlayerStatus::Playing,
            now_playing: track.map(|t| PlayerTrack { track_id: t.into(), ..Default::default() }),
            output_volume: vol,
            sink: sink_id.map(|s| SinkView {
                kind: "client".into(),
                sink_id: Some(s.into()),
                note: String::new(),
            }),
            rebuilt: false,
        }
    }

    fn local(claimed: bool, track: Option<&str>, status: PlayerStatus, vol: u32) -> LocalState {
        LocalState {
            sink_id: "me".into(),
            claimed,
            track_id: track.map(str::to_string),
            status,
            volume: vol,
        }
    }

    #[test]
    fn 没认领过先认领() {
        let l = local(false, None, PlayerStatus::Stopped, 20);
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)), Action::Claim);
        // 出声位空着（服务端后端或没人）也该认领。
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, Some("t1"), None, 20)), Action::Claim);
    }

    /// 别人拿着的时候不许去抢。
    ///
    /// 守的是一次实测到的活锁：两个车机端各跑一份这个循环，让出之后立刻抢回来，
    /// 出声位每秒在两个 id 之间跳一次，`audible` 全程 false——**谁也放不成**，
    /// 而两边日志都只说"被对方拿走了"，看不出是自己在抢。
    #[test]
    fn 别人正拿着时不抢_等它让出来再说() {
        let fresh = local(false, None, PlayerStatus::Stopped, 20);
        let held = remote(PlayerStatus::Playing, Some("t1"), Some("别的端"), 20);
        assert_eq!(decide(&fresh, &held), Action::Idle, "没认领过也不能去抢别人手里的");

        // 让出之后（claimed 被置回 false）同样不许抢回来——这正是活锁的那一拍。
        let after_yield = local(false, None, PlayerStatus::Stopped, 20);
        assert_eq!(decide(&after_yield, &held), Action::Idle);

        // 对方退出 / 租约过期 → kind 变回 host 或 none，这时才轮到我。
        let freed = remote(PlayerStatus::Playing, Some("t1"), None, 20);
        assert_eq!(decide(&after_yield, &freed), Action::Claim);
    }

    /// 车辆被重建也一样：队列没了要重新认领，但别人拿着就先等着。
    #[test]
    fn 重建时别人拿着也不抢() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        let mut r = remote(PlayerStatus::Playing, Some("t1"), Some("别的端"), 20);
        r.rebuilt = true;
        assert_eq!(decide(&l, &r), Action::Idle);
    }

    #[test]
    fn 车辆被重建后重新认领_队列跟着车走已经没了() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        let mut r = remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20);
        r.rebuilt = true;
        assert_eq!(decide(&l, &r), Action::Claim);
    }

    #[test]
    fn 空闲时服务端在放就拉起来() {
        let l = local(true, None, PlayerStatus::Stopped, 20);
        assert_eq!(
            decide(&l, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)),
            Action::Load("t1".into())
        );
    }

    #[test]
    fn 换歌() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(
            decide(&l, &remote(PlayerStatus::Playing, Some("t2"), Some("me"), 20)),
            Action::Load("t2".into())
        );
    }

    #[test]
    fn 暂停与继续() {
        let playing = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(decide(&playing, &remote(PlayerStatus::Paused, Some("t1"), Some("me"), 20)), Action::Pause);
        let paused = local(true, Some("t1"), PlayerStatus::Paused, 20);
        assert_eq!(decide(&paused, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)), Action::Resume);
    }

    #[test]
    fn 服务端停了就停() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(decide(&l, &remote(PlayerStatus::Stopped, Some("t1"), Some("me"), 20)), Action::Stop);
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, None, Some("me"), 20)), Action::Stop);
    }

    #[test]
    fn 出声位不是我的就让出_放在换歌之前判_否则两个端一起放() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, Some("t2"), Some("别人"), 20)), Action::Yield);
    }

    #[test]
    fn 服务端没回_sink_段时也让出_宁可不放也不要两台一起放() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, Some("t1"), None, 20)), Action::Yield);
    }

    #[test]
    fn 只改音量不重新起播() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 60);
        assert_eq!(
            decide(&l, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)),
            Action::SetVolume(20)
        );
    }

    #[test]
    fn 什么都没变就什么都不做_否则每秒重放一次() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)), Action::Idle);
        let stopped = local(true, None, PlayerStatus::Stopped, 20);
        assert_eq!(decide(&stopped, &remote(PlayerStatus::Stopped, None, Some("me"), 20)), Action::Idle);
    }

    #[test]
    fn 本地掉了但服务端还在放同一首_重来一次而不是干等() {
        let l = local(true, Some("t1"), PlayerStatus::Stopped, 20);
        assert_eq!(
            decide(&l, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)),
            Action::Load("t1".into())
        );
    }
}
