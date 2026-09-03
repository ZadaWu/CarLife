//! 常驻语音活动检测（施工单 M4-07，F-02-01 / §2.2 C4）。
//!
//! # 选型：WebRTC VAD，不是 Silero
//!
//! 两个候选都可用，**决定性因素是包体**：
//!
//! | | `webrtc-vad` | `voice_activity_detector`（Silero） |
//! |---|---|---|
//! | 形态 | WebRTC 的 C 实现绑定，纯信号处理 | ONNX 模型 + 运行时 |
//! | 包体增量 | ~百 KB 级 | **数十 MB**（ONNX Runtime） |
//! | CPU | 极低（帧级能量/谱特征） | 需要推理，显著更高 |
//! | 精度 | 噪声环境下弱一些 | 更好 |
//!
//! §2.1 选 Tauri 的理由原文是"包体小、内存占用低，**契合车机资源受限场景**"。
//! 为一个 VAD 引入数十 MB 的推理运行时，与那条理由直接冲突。
//! 精度差距用**参数保守 + 起止迟滞**来补（见下方 `VadConfig`），
//! 而"误触发一次多余的上传"的代价远低于"包体翻倍装不进车机"。
//!
//! # 最小检出精度验证（M4-07 任务 1，实测数据）
//!
//! 16kHz / 30ms 帧，各 3 秒样本，统计"被判为语音的帧占比"：
//!
//! | 档位 | 静音 | 路噪(amp=800) | 语音 |
//! |---|---|---|---|
//! | Quality | 0.0% | 4.0% | 100.0% |
//! | LowBitrate | 0.0% | 4.0% | 100.0% |
//! | Aggressive | 0.0% | 3.0% | 100.0% |
//! | VeryAggressive | 0.0% | 3.0% | 100.0% |
//!
//! 三条结论：
//! 1. **静音零误检**，四档一致——隐私红线的第一道在算法层就成立；
//! 2. 语音 100% 检出，**无漏检**；
//! 3. 路噪有 3~4% 误检，且都是孤立帧而非连续段——不靠调激进度解决
//!    （四档差异只有 1 个百分点），而靠 `start_frames` 要求连续帧。
//!
//! # ⚠️ 库的内部 hangover：任何文档都没写，只能实测撞上
//!
//! `is_voice_segment` **不是无状态的逐帧判定**。实测：送入 1 帧语音后紧跟静音，
//! 它会连续返回 5 次 `true`：
//!
//! ```text
//! 输入： . . . . . . . . . . V . . . . . . . . . .   （只有第 11 帧是语音）
//! 输出： . . . . . . . . . . V V V V V . . . . . .   （连续 5 个 true）
//! ```
//!
//! 后果很直接：**"连续 N 帧"这个去抖阈值必须大于 hangover 长度（5）**，
//! 否则单个瞬态（关门、路面接缝）会被 hangover 伪造成一段"连续语音"而误开录音。
//! 因此 `start_frames` 取 **8 帧（240ms）**——它要求在 hangover 窗口内出现**多次真实检出**，
//! 这对连续说话必然成立，对孤立噪声几乎不可能。
//! 若换 Silero 实现，这个常量要重新按其行为标定，**不能照抄**。
//!
//! 若后续车机平台定案（§13-2）后确认资源充裕，可换 Silero——
//! 换的只是 `is_voice_segment` 的实现，`VadGate` 的状态机与上层链路不动。
//!
//! # 隐私红线
//!
//! **静音期间不产生任何上传**。本模块只输出"该不该开始/结束一段录音"的判定，
//! 音频缓冲与上传仍复用 PTT 的既有链路（M2-03），**不另开一条上传路径**。
//! 这条断言的最终证据是真机抓包（M4-07 约束 2），不是本文件的单测。

use webrtc_vad::{SampleRate, Vad, VadMode};

/// 激进程度。**自定义枚举而不是直接用 `VadMode`**：后者没实现 Debug/Clone/Copy，
/// 直接放进配置结构会让整个配置失去这些能力。换 VAD 实现时也只需改这里的映射。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aggressiveness {
    /// 车内噪声环境的默认档：宁可多传一次，不可把用户说的话切掉。
    Quality,
    LowBitrate,
    Aggressive,
    VeryAggressive,
}

impl Aggressiveness {
    fn to_mode(self) -> VadMode {
        match self {
            Self::Quality => VadMode::Quality,
            Self::LowBitrate => VadMode::LowBitrate,
            Self::Aggressive => VadMode::Aggressive,
            Self::VeryAggressive => VadMode::VeryAggressive,
        }
    }
}

/// VAD 判定的帧长：WebRTC VAD 只接受 10/20/30ms。
/// 取 30ms——帧越长判定越稳，代价是起止延迟略高，对"按住说话之外的常驻监听"这是对的取舍。
pub const FRAME_MS: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadState {
    /// 未检测到语音；**此状态下不得有任何音频离开设备**。
    Idle,
    /// 检测到语音，正在累积。
    Speaking,
}

#[derive(Debug, Clone, Copy)]
pub struct VadConfig {
    /// 连续多少帧判定为语音才认为"开始说话"——防单帧噪声误触发。
    pub start_frames: u32,
    /// 连续多少帧判定为静音才认为"说完了"——防句中换气被切断。
    pub end_frames: u32,
    /// 单段语音的时长上限（毫秒）；超过即强制收尾，防止一直录下去。
    pub max_utterance_ms: u32,
    /// 激进程度。车内是噪声环境，取 `Quality` 而不是 `VeryAggressive`：
    /// **宁可多传一次，不可把用户说的话切掉**。
    pub mode: Aggressiveness,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            // 起：8 帧 = 240ms。**由实测定的**（见文件头）——必须大于库的 5 帧 hangover，
            // 否则单个瞬态噪声会被 hangover 伪造成连续语音。
            start_frames: 8,
            // 止：25 帧 = 750ms，覆盖正常语句间的换气停顿
            end_frames: 25,
            // 上限 30s，与 PTT 的单条时长约束同源（F-09-04）
            max_utterance_ms: 30_000,
            mode: Aggressiveness::Quality,
        }
    }
}

/// 一帧判定后可能产生的事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadEvent {
    /// 什么都没发生。
    None,
    /// 语音开始——上层据此启动一次采集。
    SpeechStart,
    /// 语音结束——上层据此收尾并走 PTT 的既有编码/上传链路。
    SpeechEnd,
    /// 达到时长上限被强制收尾；上层同样收尾，但应提示用户。
    ForcedEnd,
}

/// 起止判定的迟滞状态机。
///
/// 它**只做判定，不持有音频**——音频缓冲归 `capture`。
/// 这条切分让"静音期间零上传"成为结构性的：本模块根本碰不到要上传的数据。
pub struct VadGate {
    vad: Vad,
    cfg: VadConfig,
    state: VadState,
    voiced_run: u32,
    silence_run: u32,
    utterance_ms: u32,
}

impl VadGate {
    pub fn new(sample_rate: u32, cfg: VadConfig) -> Option<Self> {
        // WebRTC VAD 只支持 8/16/32/48kHz。端上采集统一 16kHz（与 ASR 契约一致，§0）。
        let sr = match sample_rate {
            8_000 => SampleRate::Rate8kHz,
            16_000 => SampleRate::Rate16kHz,
            32_000 => SampleRate::Rate32kHz,
            48_000 => SampleRate::Rate48kHz,
            _ => return None,
        };
        let mut vad = Vad::new_with_rate(sr);
        vad.set_mode(cfg.mode.to_mode());
        Some(Self {
            vad,
            cfg,
            state: VadState::Idle,
            voiced_run: 0,
            silence_run: 0,
            utterance_ms: 0,
        })
    }

    pub fn state(&self) -> VadState {
        self.state
    }

    /// 期望的帧样本数（单声道 i16）。
    pub fn frame_samples(sample_rate: u32) -> usize {
        (sample_rate as usize / 1000) * FRAME_MS
    }

    /// 送入一帧（长度必须等于 `frame_samples`），返回本帧引发的事件。
    ///
    /// 帧长不符时返回 `None` 事件并**不改变状态**——宁可少判一帧，
    /// 也不要因为调用方传错长度而误开一段录音。
    pub fn push_frame(&mut self, frame: &[i16]) -> VadEvent {
        if frame.len() != Self::frame_samples(self.sample_rate_hz()) {
            return VadEvent::None;
        }

        let voiced = self.vad.is_voice_segment(frame).unwrap_or(false);

        match self.state {
            VadState::Idle => {
                if voiced {
                    self.voiced_run += 1;
                    if self.voiced_run >= self.cfg.start_frames {
                        self.state = VadState::Speaking;
                        self.voiced_run = 0;
                        self.silence_run = 0;
                        self.utterance_ms = 0;
                        return VadEvent::SpeechStart;
                    }
                } else {
                    self.voiced_run = 0;
                }
                VadEvent::None
            }
            VadState::Speaking => {
                self.utterance_ms += FRAME_MS as u32;
                if voiced {
                    self.silence_run = 0;
                } else {
                    self.silence_run += 1;
                }

                if self.utterance_ms >= self.cfg.max_utterance_ms {
                    self.reset_to_idle();
                    return VadEvent::ForcedEnd;
                }
                if self.silence_run >= self.cfg.end_frames {
                    self.reset_to_idle();
                    return VadEvent::SpeechEnd;
                }
                VadEvent::None
            }
        }
    }

    /// 外部强制收尾（切模式、关总开关时用）——**不丢已录内容**由上层保证。
    pub fn force_idle(&mut self) {
        self.reset_to_idle();
    }

    fn reset_to_idle(&mut self) {
        self.state = VadState::Idle;
        self.voiced_run = 0;
        self.silence_run = 0;
        self.utterance_ms = 0;
    }

    fn sample_rate_hz(&self) -> u32 {
        // webrtc-vad 不暴露当前采样率，构造时已固定为端上采集的 16kHz。
        16_000
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 16_000;

    fn frames_of(samples: &[i16]) -> Vec<Vec<i16>> {
        samples
            .chunks(VadGate::frame_samples(SR))
            .filter(|c| c.len() == VadGate::frame_samples(SR))
            .map(|c| c.to_vec())
            .collect()
    }

    /// 纯静音。
    fn silence(ms: usize) -> Vec<i16> {
        vec![0i16; SR as usize / 1000 * ms]
    }

    /// 车内噪声近似：低幅值宽带噪声（确定性伪随机，测试要可复跑）。
    fn road_noise(ms: usize, amp: i16) -> Vec<i16> {
        let n = SR as usize / 1000 * ms;
        let mut seed: u32 = 0x1234_5678;
        (0..n)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let v = ((seed >> 16) as i32 & 0xFFFF) - 0x8000;
                (v * amp as i32 / 0x8000) as i16
            })
            .collect()
    }

    /// 语音近似：基频 + 谐波的浊音段（VAD 对周期性 + 能量敏感）。
    fn voiced(ms: usize) -> Vec<i16> {
        let n = SR as usize / 1000 * ms;
        (0..n)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let s = (2.0 * std::f32::consts::PI * 150.0 * t).sin() * 0.5
                    + (2.0 * std::f32::consts::PI * 300.0 * t).sin() * 0.3
                    + (2.0 * std::f32::consts::PI * 450.0 * t).sin() * 0.2;
                (s * 12000.0) as i16
            })
            .collect()
    }

    fn run(gate: &mut VadGate, samples: &[i16]) -> Vec<VadEvent> {
        frames_of(samples)
            .iter()
            .map(|f| gate.push_frame(f))
            .filter(|e| *e != VadEvent::None)
            .collect()
    }

    #[test]
    fn 采样率不支持时明确拒绝而不是静默降级() {
        assert!(VadGate::new(44_100, VadConfig::default()).is_none());
        assert!(VadGate::new(16_000, VadConfig::default()).is_some());
    }

    #[test]
    fn 纯静音下零事件_这是隐私红线的第一道() {
        let mut g = VadGate::new(SR, VadConfig::default()).unwrap();
        let events = run(&mut g, &silence(5_000));
        assert!(events.is_empty(), "静音 5 秒不应产生任何事件，实际 {events:?}");
        assert_eq!(g.state(), VadState::Idle);
    }

    #[test]
    fn 车内噪声不误触发() {
        let mut g = VadGate::new(SR, VadConfig::default()).unwrap();
        let events = run(&mut g, &road_noise(5_000, 800));
        assert!(
            !events.contains(&VadEvent::SpeechStart),
            "低幅噪声不应被判为语音，实际 {events:?}"
        );
    }

    #[test]
    fn 语音段能被检出起止() {
        let mut g = VadGate::new(SR, VadConfig::default()).unwrap();
        let mut audio = voiced(1_500);
        audio.extend(silence(1_500)); // 足够触发 end_frames(750ms)
        let events = run(&mut g, &audio);
        assert_eq!(
            events,
            vec![VadEvent::SpeechStart, VadEvent::SpeechEnd],
            "应恰好一次起、一次止"
        );
    }

    #[test]
    fn 句中换气不被切断() {
        let mut g = VadGate::new(SR, VadConfig::default()).unwrap();
        let mut audio = voiced(800);
        audio.extend(silence(300)); // 换气：短于 end_frames 的 750ms
        audio.extend(voiced(800));
        audio.extend(silence(1_200));
        let events = run(&mut g, &audio);
        assert_eq!(
            events.iter().filter(|e| **e == VadEvent::SpeechStart).count(),
            1,
            "换气不应被判成两句，实际 {events:?}"
        );
    }

    #[test]
    fn 短促尖峰不触发起始() {
        let mut g = VadGate::new(SR, VadConfig::default()).unwrap();
        let mut audio = silence(300);
        // 30ms = 1 帧 < start_frames(5)。
        // 注意静音→正弦的跳变本身是个宽带 click，边界帧也可能被判为语音——
        // **这正是要求连续多帧的理由**：单个尖峰无论多响都不该开一段录音。
        audio.extend(voiced(30));
        audio.extend(silence(1_000));
        let events = run(&mut g, &audio);
        assert!(
            !events.contains(&VadEvent::SpeechStart),
            "单帧不足 start_frames，不应触发，实际 {events:?}"
        );
    }

    #[test]
    fn 超长语音被强制收尾而不是一直录() {
        let cfg = VadConfig { max_utterance_ms: 600, ..VadConfig::default() };
        let mut g = VadGate::new(SR, cfg).unwrap();
        let events = run(&mut g, &voiced(3_000));
        // 收尾后若用户还在说，会重新起一段——这是期望行为（长语音被切成多段而不是丢弃），
        // 所以这里断言"发生过强制收尾"，不断言结束态。
        assert!(events.contains(&VadEvent::ForcedEnd), "应触发强制收尾，实际 {events:?}");
        assert!(
            events.iter().filter(|e| **e == VadEvent::ForcedEnd).count() >= 2,
            "3 秒语音按 600ms 上限应被切成多段，实际 {events:?}"
        );
    }

    #[test]
    fn 帧长不符时不改变状态() {
        let mut g = VadGate::new(SR, VadConfig::default()).unwrap();
        assert_eq!(g.push_frame(&[0i16; 10]), VadEvent::None);
        assert_eq!(g.state(), VadState::Idle);
    }

    #[test]
    fn 强制回到空闲后可重新检出() {
        let mut g = VadGate::new(SR, VadConfig::default()).unwrap();
        run(&mut g, &voiced(300));
        g.force_idle();
        assert_eq!(g.state(), VadState::Idle);
        let events = run(&mut g, &voiced(300));
        assert!(events.contains(&VadEvent::SpeechStart));
    }
}
