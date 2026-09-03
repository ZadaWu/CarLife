//! 哨兵段装配（施工单 M25-01，F-52-01）。
//!
//! 在 `VoiceSession`（AlwaysOn + VAD）之上补两件哨兵特有的事：
//!
//! 1. **预卷（pre-roll）**：VAD 需要连续 8 帧（240ms）才报 `SpeechStart`，
//!    不补预卷的话唤醒词「暖暖」的第一个字就被啃掉了——检得出说话，
//!    转写出来却对不上。预卷环形缓冲常驻最近 `preroll_ms` 的采样，
//!    开段时整体前置进段里。
//! 2. **段上限**：借 `VadConfig::max_utterance_ms` 实现（默认 10s，
//!    不是 PTT 的 30s）——是哨兵态 ASR 成本的闸（M25-00 约束）；
//!    取值演变见 `AssemblerConfig::segment_max_ms` 的注释。
//!
//! 隐私纪律：总开关关闭时段与预卷**一起清空**——Off 状态下内存里
//! 不该留着任何音频，哪怕只有 400ms。

use std::collections::VecDeque;

use crate::listen::{ListenAction, ListenMode, ListenState, MicSwitch, VoiceSession};
use crate::vad::{VadConfig, VadGate};

/// 哨兵段目标采样率——与契约一致，`StreamConverter` 的输出就是它。
const SENTINEL_RATE: u32 = 16_000;

#[derive(Debug, Clone, Copy)]
pub struct AssemblerConfig {
    /// 单段上限（ms）。超限强制收尾并标记截断。
    ///
    /// 最初是 5s——那时哨兵只管唤醒词，「唤醒词几乎总在句首，超限截断只影响
    /// 误漏率」。M25-03 起整条指令都走哨兵段，这个假设失效：行程类指令
    /// （「暖暖帮我订一下从上海到广州的4天行程」）说满 6~8s 是常态，5s 截断
    /// 让后半句掉进下一段（走查 0830-③ 实测只识别到前半句）。10s 盖住一口气
    /// 能说完的指令（曾提过 15s，产品裁定 10s——上限同时是哨兵态 ASR 成本闸，
    /// 播报期回采段也按它切）；仍超限的由消费侧的截断拼接兜底（commands/voice.rs）。
    pub segment_max_ms: u32,
    /// 预卷时长（ms）。必须盖过 VAD 的起始去抖（8 帧 = 240ms）。
    pub preroll_ms: u32,
}

impl Default for AssemblerConfig {
    fn default() -> Self {
        Self { segment_max_ms: 10_000, preroll_ms: 400 }
    }
}

/// 一段完整的哨兵语音（16kHz 单声道 i16）。
#[derive(Debug, Clone)]
pub struct SentinelSegment {
    pub samples: Vec<i16>,
    /// 命中段上限被强制收尾。
    pub truncated: bool,
}

impl SentinelSegment {
    pub fn duration_ms(&self) -> u32 {
        (self.samples.len() as u64 * 1000 / SENTINEL_RATE as u64) as u32
    }
}

pub struct SegmentAssembler {
    session: VoiceSession,
    preroll: VecDeque<i16>,
    preroll_cap: usize,
    seg: Option<Vec<i16>>,
}

impl SegmentAssembler {
    pub fn new(cfg: AssemblerConfig) -> Self {
        let vad_cfg = VadConfig { max_utterance_ms: cfg.segment_max_ms, ..VadConfig::default() };
        Self {
            session: VoiceSession::with_config(ListenMode::AlwaysOn, SENTINEL_RATE, vad_cfg),
            preroll: VecDeque::new(),
            preroll_cap: (SENTINEL_RATE as usize / 1000) * cfg.preroll_ms as usize,
            seg: None,
        }
    }

    /// 期望帧长（30ms @16k = 480 样本），与 `StreamConverter` 的输出一致。
    pub fn frame_samples() -> usize {
        VadGate::frame_samples(SENTINEL_RATE)
    }

    /// 供指示灯消费（M25-04）。总开关关闭时恒为 Idle——`VoiceSession` 保证。
    pub fn state(&self) -> ListenState {
        self.session.state()
    }

    /// 总开关。关闭时丢弃在录段**并清空预卷**——Off 状态下不留任何音频。
    pub fn set_switch(&mut self, on: bool) {
        let sw = if on { MicSwitch::On } else { MicSwitch::Off };
        if self.session.set_switch(sw) == ListenAction::AbortCapture {
            self.seg = None;
        }
        if !on {
            self.seg = None;
            self.preroll.clear();
        }
    }

    /// 送入一帧；段收尾时返回整段。
    pub fn push_frame(&mut self, frame: &[i16]) -> Option<SentinelSegment> {
        match self.session.push_frame(frame) {
            ListenAction::BeginCapture => {
                let mut seg = Vec::with_capacity(self.preroll.len() + frame.len());
                seg.extend(self.preroll.drain(..));
                seg.extend_from_slice(frame);
                self.seg = Some(seg);
                None
            }
            ListenAction::FinishCapture { forced } => {
                let mut samples = self.seg.take().unwrap_or_default();
                samples.extend_from_slice(frame);
                // 收尾即回 Idle：转写在外面异步做，不占用状态机
                self.session.upload_finished();
                Some(SentinelSegment { samples, truncated: forced })
            }
            ListenAction::AbortCapture => {
                self.seg = None;
                None
            }
            ListenAction::None => {
                if let Some(seg) = self.seg.as_mut() {
                    seg.extend_from_slice(frame);
                } else {
                    self.preroll.extend(frame.iter().copied());
                    while self.preroll.len() > self.preroll_cap {
                        self.preroll.pop_front();
                    }
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 语音近似帧：基频 + 谐波（同 listen.rs 测试——纯正弦不会被 WebRTC VAD 判为语音）。
    fn voiced_frame() -> Vec<i16> {
        let n = SegmentAssembler::frame_samples();
        (0..n)
            .map(|i| {
                let t = i as f32 / SENTINEL_RATE as f32;
                let s = (2.0 * std::f32::consts::PI * 150.0 * t).sin() * 0.5
                    + (2.0 * std::f32::consts::PI * 300.0 * t).sin() * 0.3
                    + (2.0 * std::f32::consts::PI * 450.0 * t).sin() * 0.2;
                (s * 12000.0) as i16
            })
            .collect()
    }

    fn silent_frame() -> Vec<i16> {
        vec![0i16; SegmentAssembler::frame_samples()]
    }

    fn speak_until_segment(a: &mut SegmentAssembler, max_frames: usize) -> Option<SentinelSegment> {
        for _ in 0..max_frames {
            if let Some(seg) = a.push_frame(&voiced_frame()) {
                return Some(seg);
            }
        }
        // 转静音直到收尾
        for _ in 0..200 {
            if let Some(seg) = a.push_frame(&silent_frame()) {
                return Some(seg);
            }
        }
        None
    }

    #[test]
    fn 静音期间不产生段_也不长预卷之外的内存() {
        let mut a = SegmentAssembler::new(AssemblerConfig::default());
        for _ in 0..500 {
            assert!(a.push_frame(&silent_frame()).is_none());
        }
        assert!(a.preroll.len() <= a.preroll_cap, "预卷必须封顶");
        assert!(a.seg.is_none());
    }

    #[test]
    fn 说话产生段_且段含预卷() {
        let mut a = SegmentAssembler::new(AssemblerConfig::default());
        // 先喂满预卷（静音也进预卷）
        for _ in 0..20 {
            a.push_frame(&silent_frame());
        }
        let seg = speak_until_segment(&mut a, 30).expect("应产出一段");
        // 段长 > 触发后帧数 × 帧长 ⇒ 预卷被并入（VAD 去抖吃掉的 8 帧回来了）
        let frame = SegmentAssembler::frame_samples();
        assert!(seg.samples.len() > 10 * frame, "len={} 应含预卷", seg.samples.len());
        assert!(!seg.truncated);
        assert_eq!(a.state(), crate::listen::ListenState::Idle, "收尾即回 Idle");
    }

    #[test]
    fn 段上限强制收尾并标记截断() {
        let mut a = SegmentAssembler::new(AssemblerConfig { segment_max_ms: 600, preroll_ms: 400 });
        let seg = speak_until_segment(&mut a, 100).expect("应因上限收尾");
        assert!(seg.truncated, "600ms 上限内一直说话必须被截断");
    }

    #[test]
    fn 关总开关_在录段与预卷都清空() {
        let mut a = SegmentAssembler::new(AssemblerConfig::default());
        for _ in 0..20 {
            a.push_frame(&voiced_frame());
        }
        a.set_switch(false);
        assert!(a.seg.is_none(), "在录段必须丢弃，不上传");
        assert!(a.preroll.is_empty(), "Off 状态内存里不留音频");
        // 关闭期间说话无效
        for _ in 0..40 {
            assert!(a.push_frame(&voiced_frame()).is_none());
        }
        assert_eq!(a.state(), crate::listen::ListenState::Idle);
        // 重开后恢复工作
        a.set_switch(true);
        assert!(speak_until_segment(&mut a, 40).is_some());
    }

    #[test]
    fn 连续两段互不串音() {
        let mut a = SegmentAssembler::new(AssemblerConfig::default());
        let first = speak_until_segment(&mut a, 30).expect("第一段");
        // 静音间隔
        for _ in 0..40 {
            a.push_frame(&silent_frame());
        }
        let second = speak_until_segment(&mut a, 30).expect("第二段");
        // 第二段不该把第一段整段带上（预卷封顶远小于一段）
        assert!(second.samples.len() < first.samples.len() + a.preroll_cap + SegmentAssembler::frame_samples() * 2);
    }
}
