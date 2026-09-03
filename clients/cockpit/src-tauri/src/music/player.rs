//! 车内音乐的出声那一层（施工单 M63-03）。
//!
//! # 复用 TTS 已经走通的那条路
//!
//! `rodio` 早就在这个 crate 里（ACR-004 第 2 步把 TTS 从 afplay 换过来时引入的），
//! mp3 字节直接进声卡、macOS/iOS 同一条路径。音乐照抄那一段，**不引入第二个音频后端**。
//!
//! # 与 TTS 各开一个设备槽
//!
//! TTS 是**每句话开一个**（一次播报的生命周期就是那个流的生命周期），音乐则要
//! 长期持有一个。macOS 上并发输出流没有问题；iPad 未实测——真撞上互相掐断，
//! 降级方案是两者共享一个 `MixerDeviceSink`，那要动 `tts/mod.rs` 的 `play_bytes`。
//! 先按改动面最小的来：TTS 是关键路径，不该为音乐冒险。
//!
//! # 音量两级
//!
//! `base`（跟随服务端的 `outputVolume`）与 `ducked`（暖暖说话时让路）分开存，
//! 实际下发是两者的乘积。合成一个数之后"恢复"就没有可恢复的目标了——
//! 那正是"音乐一直压着没恢复"这类现象的来路。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

/// 让路时压到原音量的百分之几。与 mock-cabin 的 `DEFAULT_DUCK_TO` 同值。
const DUCK_TO_PERCENT: u32 = 30;

struct Output {
    player: rodio::Player,
    /// 设备槽必须一起存着——drop 掉它声音立刻断（`tts/mod.rs` 同一条注释）。
    _device: rodio::MixerDeviceSink,
}

pub struct MusicPlayer {
    out: Mutex<Option<Output>>,
    base_volume: AtomicU32,
    ducked: AtomicBool,
}

impl Default for MusicPlayer {
    fn default() -> Self {
        Self { out: Mutex::new(None), base_volume: AtomicU32::new(20), ducked: AtomicBool::new(false) }
    }
}

impl MusicPlayer {
    /// 起播一首（换歌也走这里）。已经在放的会被换掉。
    pub fn load(&self, audio: Vec<u8>) -> Result<(), String> {
        let decoder = rodio::Decoder::new(std::io::Cursor::new(audio))
            .map_err(|e| format!("解码失败：{e}"))?;
        let mut guard = self.out.lock().map_err(|_| "音乐播放器状态被污染".to_string())?;
        if guard.is_none() {
            let device = rodio::DeviceSinkBuilder::open_default_sink()
                .map_err(|e| format!("打开音频输出失败：{e}"))?;
            let player = rodio::Player::connect_new(device.mixer());
            *guard = Some(Output { player, _device: device });
        }
        let out = guard.as_ref().expect("上一句刚建好");
        // 换歌先清队列：不清的话新歌会排在旧歌后面，表现是"点了没反应，一首歌之后才响"。
        out.player.clear();
        out.player.append(decoder);
        out.player.set_volume(self.gain());
        out.player.play();
        Ok(())
    }

    pub fn pause(&self) {
        self.with(|p| p.pause());
    }

    pub fn resume(&self) {
        self.with(|p| p.play());
    }

    pub fn stop(&self) {
        self.with(|p| {
            p.stop();
            p.clear();
        });
    }

    /// 服务端说的音量（0..=100）。让路中调它只改 base，压低的比例不变。
    pub fn set_base_volume(&self, percent: u32) {
        self.base_volume.store(percent.min(100), Ordering::SeqCst);
        self.apply_gain();
    }

    /// 让路。**同步、无网络**——它和播报发生在同一台机器上，
    /// 不需要一个 30 秒的租约去兜底"恢复请求没送达"。
    pub fn set_ducked(&self, on: bool) {
        self.ducked.store(on, Ordering::SeqCst);
        self.apply_gain();
    }

    /// 队列空了 = 这一首自然播完。服务端听不见，靠这个判断去推进队列。
    pub fn finished(&self) -> bool {
        self.out
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|o| o.player.empty()))
            .unwrap_or(true)
    }

    /// 已播秒数。
    pub fn position_sec(&self) -> Option<f64> {
        self.out
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|o| o.player.get_pos().as_secs_f64()))
    }

    /// 实际下发给 rodio 的增益。`1.0` 是原始音量。
    pub fn gain(&self) -> f32 {
        let base = self.base_volume.load(Ordering::SeqCst) as f32 / 100.0;
        if self.ducked.load(Ordering::SeqCst) {
            base * (DUCK_TO_PERCENT as f32 / 100.0)
        } else {
            base
        }
    }

    fn apply_gain(&self) {
        let g = self.gain();
        self.with(|p| p.set_volume(g));
    }

    fn with(&self, f: impl FnOnce(&rodio::Player)) {
        if let Ok(guard) = self.out.lock() {
            if let Some(out) = guard.as_ref() {
                f(&out.player);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 音量两级的映射。**不碰声卡**——没有 `Output` 时 `with()` 是空操作，
    /// `gain()` 照常算得出来，正好可以单独钉住这条算术。
    #[test]
    fn 让路是按比例压低而不是设成固定值() {
        let p = MusicPlayer::default();
        p.set_base_volume(60);
        assert!((p.gain() - 0.60).abs() < 1e-6);
        p.set_ducked(true);
        assert!((p.gain() - 0.18).abs() < 1e-6, "60% 压到 30% 是 18%，不是 30%");
        p.set_ducked(false);
        assert!((p.gain() - 0.60).abs() < 1e-6, "恢复要回到原来那个数");
    }

    #[test]
    fn 让路中改音量只改_base_压低比例不变() {
        let p = MusicPlayer::default();
        p.set_base_volume(60);
        p.set_ducked(true);
        p.set_base_volume(40);
        assert!((p.gain() - 0.12).abs() < 1e-6, "40% 的 30% 是 12%");
        p.set_ducked(false);
        assert!((p.gain() - 0.40).abs() < 1e-6, "恢复到的是新的 40%，不是旧的 60%");
    }

    #[test]
    fn 音量夹在_0_到_100() {
        let p = MusicPlayer::default();
        p.set_base_volume(255);
        assert!((p.gain() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn 没起播时算作已播完_别让轮询以为还有歌在放() {
        assert!(MusicPlayer::default().finished());
    }
}
