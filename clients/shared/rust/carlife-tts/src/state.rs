//! 在播句柄、代际守卫、静音开关。是车机 `TtsState` 去掉垫场/回采那些字段后的子集。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

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
}

/// 播报状态。`Default` 即**静音**——手机默认不出声（F-02-12「车机播报 / 手机静默」），
/// 出声是用户在设置页明确打开之后的事。车机那边初值来自它自己的偏好文件，不受本默认影响。
pub struct TtsState {
    current: Mutex<Option<Playback>>,
    generation: AtomicU64,
    muted: AtomicBool,
}

impl Default for TtsState {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
            generation: AtomicU64::new(0),
            muted: AtomicBool::new(true),
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
