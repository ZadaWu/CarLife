//! 双模式监听与麦克风总开关（施工单 M4-07，F-02-03 / F-02-08 / §2.3）。
//!
//! # 三个状态是给用户看的，不是给代码用的
//!
//! `ListenState` 是**隐私承诺的可见载体**（M3-07 约束 3）：HUD 上的指示灯直接由它驱动。
//! 因此它必须**由采集层的真实状态推导**，不能由 UI 自己维护一份——
//! 一个"显示没在听、实际在听"的指示灯比没有指示灯更糟。
//! 宁可延迟 200ms 亮起，也不能在没采集时亮着。
//!
//! # 总开关优先于一切
//!
//! `MicSwitch::Off` 时两种模式都不采集、指示灯灭。这条在状态机里是**第一顺位判断**，
//! 不是某个分支里的补充条件——放在分支里迟早会有一条路径漏掉它。

use crate::vad::{VadConfig, VadEvent, VadGate, VadState};

/// 采集模式。默认值按端区分（§2.3）：车机常驻监听为主，手机按住说话。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenMode {
    /// 按住说话——M2 起的既有能力，本工单**行为完全不变**。
    PushToTalk,
    /// 常驻 VAD 监听。
    AlwaysOn,
}

impl ListenMode {
    /// 端默认值（§2.3：车机常驻监听为主 / 手机长按说话）。
    pub fn default_for(cockpit: bool) -> Self {
        if cockpit {
            Self::AlwaysOn
        } else {
            Self::PushToTalk
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PushToTalk => "ptt",
            Self::AlwaysOn => "always-on",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ptt" => Some(Self::PushToTalk),
            "always-on" => Some(Self::AlwaysOn),
            _ => None,
        }
    }
}

/// 麦克风总开关。关闭时两种模式都不采集（F-02-08）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicSwitch {
    On,
    Off,
}

/// 对外暴露给 HUD 的监听状态（F-02-08 的三态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenState {
    /// 没有采集在进行。总开关关闭时**恒为此态**。
    Idle,
    /// 正在采集音频。
    Listening,
    /// 采集已结束，正在编码/上传。
    Uploading,
}

/// 一次语音会话的驱动器：把"谁触发起止"这件事统一起来。
///
/// PTT 与常驻监听**共用同一套编码与上传实现**（M4-07 任务 2），
/// 差异只在触发源：前者是手势，后者是 `VadGate`。
/// 这样做的直接收益是"静音期间零上传"成为结构性的——
/// 常驻模式下 `VadGate` 不发 `SpeechStart`，就没有任何东西进入上传链路。
pub struct VoiceSession {
    mode: ListenMode,
    switch: MicSwitch,
    state: ListenState,
    gate: Option<VadGate>,
    sample_rate: u32,
    vad_cfg: VadConfig,
}

/// 状态机对外产生的动作，由端上桥接层落实（起停 cpal 流、发上传）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenAction {
    None,
    /// 开始一次采集（分配缓冲）。
    BeginCapture,
    /// 收尾并走既有的编码/上传链路。
    FinishCapture { forced: bool },
    /// 丢弃当前采集（总开关关闭时）——**不上传**。
    AbortCapture,
}

impl VoiceSession {
    pub fn new(mode: ListenMode, sample_rate: u32) -> Self {
        Self::with_config(mode, sample_rate, VadConfig::default())
    }

    pub fn with_config(mode: ListenMode, sample_rate: u32, vad_cfg: VadConfig) -> Self {
        let gate = if mode == ListenMode::AlwaysOn {
            VadGate::new(sample_rate, vad_cfg)
        } else {
            None
        };
        Self {
            mode,
            switch: MicSwitch::On,
            state: ListenState::Idle,
            gate,
            sample_rate,
            vad_cfg,
        }
    }

    pub fn mode(&self) -> ListenMode {
        self.mode
    }

    pub fn switch(&self) -> MicSwitch {
        self.switch
    }

    /// 供 HUD 直接消费的状态。**总开关关闭时恒为 Idle**，第一顺位判断。
    pub fn state(&self) -> ListenState {
        if self.switch == MicSwitch::Off {
            ListenState::Idle
        } else {
            self.state
        }
    }

    /// 总开关。关闭时若正在采集，产生 `AbortCapture`——**丢弃，不上传**。
    ///
    /// 与切模式的语义刻意不同：切模式是"用户还想要这句话"，关麦是"用户要它停下"。
    pub fn set_switch(&mut self, sw: MicSwitch) -> ListenAction {
        if self.switch == sw {
            return ListenAction::None;
        }
        self.switch = sw;
        if sw == MicSwitch::Off {
            if let Some(g) = self.gate.as_mut() {
                g.force_idle();
            }
            let was_capturing = self.state != ListenState::Idle;
            self.state = ListenState::Idle;
            return if was_capturing { ListenAction::AbortCapture } else { ListenAction::None };
        }
        ListenAction::None
    }

    /// 切换模式。正在录制时**先收尾再切，不丢用户已说的话**（M4-07 任务 3）。
    pub fn set_mode(&mut self, mode: ListenMode) -> ListenAction {
        if self.mode == mode {
            return ListenAction::None;
        }
        let action = if self.state == ListenState::Listening {
            ListenAction::FinishCapture { forced: false }
        } else {
            ListenAction::None
        };

        self.mode = mode;
        self.gate = if mode == ListenMode::AlwaysOn {
            VadGate::new(self.sample_rate, self.vad_cfg)
        } else {
            None
        };
        self.state = if action == ListenAction::None { ListenState::Idle } else { ListenState::Uploading };
        action
    }

    /// PTT 按下。总开关关闭时无效。
    pub fn ptt_press(&mut self) -> ListenAction {
        if self.switch == MicSwitch::Off || self.mode != ListenMode::PushToTalk {
            return ListenAction::None;
        }
        self.state = ListenState::Listening;
        ListenAction::BeginCapture
    }

    /// PTT 松开。
    pub fn ptt_release(&mut self) -> ListenAction {
        if self.switch == MicSwitch::Off || self.mode != ListenMode::PushToTalk {
            return ListenAction::None;
        }
        if self.state != ListenState::Listening {
            return ListenAction::None;
        }
        self.state = ListenState::Uploading;
        ListenAction::FinishCapture { forced: false }
    }

    /// 常驻模式下送入一帧。总开关关闭或非常驻模式时**直接丢弃，不判定**。
    pub fn push_frame(&mut self, frame: &[i16]) -> ListenAction {
        if self.switch == MicSwitch::Off || self.mode != ListenMode::AlwaysOn {
            return ListenAction::None;
        }
        let Some(gate) = self.gate.as_mut() else {
            return ListenAction::None;
        };

        match gate.push_frame(frame) {
            VadEvent::SpeechStart => {
                self.state = ListenState::Listening;
                ListenAction::BeginCapture
            }
            VadEvent::SpeechEnd => {
                self.state = ListenState::Uploading;
                ListenAction::FinishCapture { forced: false }
            }
            VadEvent::ForcedEnd => {
                self.state = ListenState::Uploading;
                ListenAction::FinishCapture { forced: true }
            }
            VadEvent::None => ListenAction::None,
        }
    }

    /// 上传完成后由桥接层回调，指示灯回到 idle。
    pub fn upload_finished(&mut self) {
        if self.state == ListenState::Uploading {
            self.state = ListenState::Idle;
        }
    }

    /// 常驻模式下 VAD 的内部状态，供自检断言用。
    pub fn vad_state(&self) -> Option<VadState> {
        self.gate.as_ref().map(|g| g.state())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 16_000;

    /// 语音近似：基频 + 谐波。**单一正弦不行**——WebRTC VAD 看的是谱特征，
    /// 纯音调不会被判为语音（实测撞到过，测试一直触发不了）。
    fn voiced_frame() -> Vec<i16> {
        let n = VadGate::frame_samples(SR);
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

    fn silent_frame() -> Vec<i16> {
        vec![0i16; VadGate::frame_samples(SR)]
    }

    #[test]
    fn 端默认值按_2_3_区分() {
        assert_eq!(ListenMode::default_for(true), ListenMode::AlwaysOn, "车机常驻监听为主");
        assert_eq!(ListenMode::default_for(false), ListenMode::PushToTalk, "手机长按说话");
    }

    #[test]
    fn 模式字符串可往返_供端上持久化用() {
        for m in [ListenMode::PushToTalk, ListenMode::AlwaysOn] {
            assert_eq!(ListenMode::parse(m.as_str()), Some(m));
        }
        assert_eq!(ListenMode::parse("怪值"), None);
    }

    #[test]
    fn ptt_行为不变_按下开始松开收尾() {
        let mut s = VoiceSession::new(ListenMode::PushToTalk, SR);
        assert_eq!(s.ptt_press(), ListenAction::BeginCapture);
        assert_eq!(s.state(), ListenState::Listening);
        assert_eq!(s.ptt_release(), ListenAction::FinishCapture { forced: false });
        assert_eq!(s.state(), ListenState::Uploading);
        s.upload_finished();
        assert_eq!(s.state(), ListenState::Idle);
    }

    #[test]
    fn 总开关关闭时两种模式都不采集() {
        for mode in [ListenMode::PushToTalk, ListenMode::AlwaysOn] {
            let mut s = VoiceSession::new(mode, SR);
            s.set_switch(MicSwitch::Off);
            assert_eq!(s.ptt_press(), ListenAction::None);
            assert_eq!(s.push_frame(&voiced_frame()), ListenAction::None);
            assert_eq!(s.state(), ListenState::Idle, "指示灯必须灭");
        }
    }

    #[test]
    fn 关总开关时正在录的内容被丢弃_而不是偷偷上传() {
        let mut s = VoiceSession::new(ListenMode::PushToTalk, SR);
        s.ptt_press();
        assert_eq!(s.set_switch(MicSwitch::Off), ListenAction::AbortCapture);
        assert_eq!(s.state(), ListenState::Idle);
    }

    #[test]
    fn 常驻模式静音期间不产生任何采集动作_隐私红线() {
        let mut s = VoiceSession::new(ListenMode::AlwaysOn, SR);
        for _ in 0..200 {
            assert_eq!(s.push_frame(&silent_frame()), ListenAction::None);
        }
        assert_eq!(s.state(), ListenState::Idle);
    }

    #[test]
    fn 常驻模式检出语音后走与_ptt_相同的收尾动作() {
        let mut s = VoiceSession::new(ListenMode::AlwaysOn, SR);
        let mut began = false;
        for _ in 0..40 {
            if s.push_frame(&voiced_frame()) == ListenAction::BeginCapture {
                began = true;
                break;
            }
        }
        assert!(began, "持续语音应触发 BeginCapture");
        assert_eq!(s.state(), ListenState::Listening);

        let mut finished = false;
        for _ in 0..60 {
            if s.push_frame(&silent_frame()) == (ListenAction::FinishCapture { forced: false }) {
                finished = true;
                break;
            }
        }
        assert!(finished, "静音足够久应收尾——且与 PTT 是同一个动作");
    }

    #[test]
    fn 切模式时正在录的内容先收尾_不丢用户已说的话() {
        let mut s = VoiceSession::new(ListenMode::PushToTalk, SR);
        s.ptt_press();
        assert_eq!(
            s.set_mode(ListenMode::AlwaysOn),
            ListenAction::FinishCapture { forced: false },
            "切模式必须先收尾——这与关总开关的丢弃语义刻意不同"
        );
        assert_eq!(s.mode(), ListenMode::AlwaysOn);
    }

    #[test]
    fn 空闲时切模式不产生多余动作() {
        let mut s = VoiceSession::new(ListenMode::PushToTalk, SR);
        assert_eq!(s.set_mode(ListenMode::AlwaysOn), ListenAction::None);
        assert_eq!(s.state(), ListenState::Idle);
    }

    #[test]
    fn ptt_模式下送帧不触发_vad() {
        let mut s = VoiceSession::new(ListenMode::PushToTalk, SR);
        for _ in 0..30 {
            assert_eq!(s.push_frame(&voiced_frame()), ListenAction::None);
        }
    }
}
