//! 在播句柄、代际守卫、静音开关。是车机 `TtsState` 去掉垫场/回采那些字段后的子集。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;

/// 出厂音量（百分比）。与车机 `cockpit/src-tauri/src/tts/mod.rs::DEFAULT_VOLUME_PERCENT` 同值：
/// 2026-09-03 定为 15——豆包合成本身响度偏高，满格开箱第一句就把人吓一跳。
/// 手机贴着耳朵或放在桌上，量级与车内近场一致，不另取一个数。
pub const DEFAULT_VOLUME_PERCENT: u32 = 15;

/// 百分比 → 下发给 rodio 的增益。**纯函数**：越界的百分比钳到 100，
/// 不让一个写坏的偏好把喇叭推到 2.55 倍。
pub fn gain_for_percent(percent: u32) -> f32 {
    percent.min(100) as f32 / 100.0
}

/// 一次在播的播报。只有 rodio 一种句柄——`say` 降级是车机（macOS）差异项，不进共享核。
pub struct Playback {
    /// `_device` 必须一起存着——drop 掉设备槽，声音立刻断。
    pub(crate) player: rodio::Player,
    pub(crate) _device: rodio::MixerDeviceSink,
}

impl Playback {
    pub(crate) fn halt(&mut self) {
        self.player.stop();
    }
    /// 是否已自然播完：rodio 播完即队列空。
    pub(crate) fn is_finished(&mut self) -> bool {
        self.player.empty()
    }
    /// 对正在播的这句改增益。
    pub(crate) fn set_gain(&self, gain: f32) {
        self.player.set_volume(gain);
    }
}

/// 播报状态。`Default` 即**静音**——手机默认不出声（F-02-12「车机播报 / 手机静默」），
/// 出声是用户在设置页明确打开之后的事。车机那边初值来自它自己的偏好文件，不受本默认影响。
pub struct TtsState {
    current: Mutex<Option<Playback>>,
    generation: AtomicU64,
    muted: AtomicBool,
    /// 播报音量（百分比，0~100，默认 [`DEFAULT_VOLUME_PERCENT`]）。
    ///
    /// 与 `muted` 是两个量：0 也不等于关——关掉的语义是"不合成、不出声、状态机不进
    /// speaking"，而音量 0 仍然走完整条播报链路。合成一个字段的话，"调到最小再拉回来"
    /// 会把开关也翻了。持久化是端的事（键与文件各端自定），与 `muted` 同一取向。
    ///
    /// 初值**不能**是 `AtomicU32::default()` 的 0：那是一台从没设过音量、一声不响、
    /// 每条播报都正常走完、日志一行不缺的手机。
    volume: AtomicU32,
}

impl Default for TtsState {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
            generation: AtomicU64::new(0),
            muted: AtomicBool::new(true),
            volume: AtomicU32::new(DEFAULT_VOLUME_PERCENT),
        }
    }
}

impl TtsState {
    /// 用已持久化的开关值构造（调用方负责持久化——键与文件是端的事）。
    pub fn with_muted(muted: bool) -> Self {
        let s = Self::default();
        s.muted.store(muted, Ordering::SeqCst);
        s
    }
    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::SeqCst)
    }
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::SeqCst);
    }
    /// 当前播报音量（百分比）。
    pub fn volume_percent(&self) -> u32 {
        self.volume.load(Ordering::SeqCst)
    }
    /// 起播该用的增益——取自**当前**音量，不是某个缓存值。
    pub fn gain(&self) -> f32 {
        gain_for_percent(self.volume_percent())
    }
    /// 设置播报音量；**对正在播的那句立即生效**。返回实际落下的值（钳到 0~100）。
    ///
    /// 立即生效不是锦上添花：用户拖滑块时暖暖多半正在说话，拖完要等下一句才听得出
    /// 变化的话，他会来回拖好几遍再断定"这个滑块没用"。持久化由调用方做。
    pub fn set_volume_percent(&self, percent: u32) -> u32 {
        let percent = percent.min(100);
        self.volume.store(percent, Ordering::SeqCst);
        if let Some(playback) = self.current().as_ref() {
            playback.set_gain(gain_for_percent(percent));
        }
        percent
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    pub fn is_playing(&self) -> bool {
        self.current.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }
    pub(crate) fn current(&self) -> std::sync::MutexGuard<'_, Option<Playback>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 停止当前播放（若有）。代际 +1，使旧播放的监视任务不再发结束状态。
///
/// **返回停完之后的代际，调用方必须用这个返回值，不要自己再 `load` 一次**（车机 M27-02）：
/// `stop(); load()` 是两步——A 任务把代际推到 5，B 紧接着推到 6，两个再各自 `load()`
/// 都拿到 6，于是两次播放都通过守卫、同时出声。演示现场的表现是"十几个声音叠着说同一句话"。
pub fn stop(state: &TtsState) -> u64 {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(mut playback) = state.current().take() {
        playback.halt();
    }
    generation
}

#[cfg(test)]
mod tests {
    use super::{stop, TtsState};

    #[test]
    fn 默认静音_手机默认不出声() {
        assert!(TtsState::default().is_muted());
        assert!(!TtsState::with_muted(false).is_muted());
    }

    #[test]
    fn 开关翻转即时可见() {
        let s = TtsState::default();
        s.set_muted(false);
        assert!(!s.is_muted());
        s.set_muted(true);
        assert!(s.is_muted());
    }

    /// 出厂默认 15、越界钳到 100；音量与开关互不影响。
    #[test]
    fn 播报音量_默认十五_越界钳到一百_不动开关() {
        let s = TtsState::default();
        assert_eq!(s.volume_percent(), super::DEFAULT_VOLUME_PERCENT);
        assert_eq!(s.volume_percent(), 15, "出厂默认 15：既不哑（0）也不吓人（100）");
        assert_eq!(s.set_volume_percent(30), 30);
        assert_eq!(s.volume_percent(), 30);
        assert_eq!(s.set_volume_percent(255), 100, "写坏的值不能把喇叭推过原始响度");
        assert_eq!(s.set_volume_percent(0), 0);
        assert!(s.is_muted(), "音量调到 0 不等于关：开关一点没动");
        assert_eq!(super::gain_for_percent(0), 0.0);
        assert_eq!(super::gain_for_percent(50), 0.5);
        assert_eq!(super::gain_for_percent(999), 1.0);
        assert_eq!(s.gain(), 0.0, "gain() 跟着当前音量走");
    }

    /// M27-02：`stop` 的返回值就是新代际，且严格单调——两次 stop 不能拿到同一个数。
    #[test]
    fn stop返回新代际且单调() {
        let s = TtsState::default();
        assert_eq!(s.generation(), 0);
        let g1 = stop(&s);
        let g2 = stop(&s);
        assert_eq!(g1, 1);
        assert_eq!(g2, 2);
        assert_eq!(s.generation(), g2);
        assert!(!s.is_playing());
    }
}
