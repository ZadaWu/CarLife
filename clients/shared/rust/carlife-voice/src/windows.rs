//! 唤醒对话窗口（施工单 M25-03，F-52-03/04；M60-01 从车机端移入本共享 crate）。
//!
//! 唤醒词换来的对话许可是**有边界的**（US-52 场景 3）：
//!  - 聆听窗口：唤醒后等指令，默认 10s，无下文静默回哨兵；
//!  - 追问窗口：播报结束后免唤醒词，默认 5s。
//!
//! 默认值 2026-08-26 由用户调紧（原 15s/20s）：追问窗口挂在所有播报后，
//! 20s 的窗 + 级联续窗让车内随口说话都会被当指令——窗口越短，误收越少。
//!
//! 两个窗口都是**一次性许可**：窗口内送出一句输入即消耗（`consume`），
//! 下一轮追问窗口由那句话的回复播完再开。窗口不是会话生命周期——
//! M22 的 30 分钟空闲语义与它无关（`Instant` 级 vs 分钟级）。
//!
//! 纯逻辑：时钟由调用方注入，可脱离线程与设备单测。
//!
//! [`WakeWindows::on_tts_finished`] 只有车机端会调（手机端没有本地播报）——
//! 手机端只用聆听窗口那一半，追问窗口在它那边恒不开启。

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct WindowConfig {
    pub listening_ms: u64,
    pub followup_ms: u64,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self { listening_ms: 10_000, followup_ms: 5_000 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowKind {
    Listening,
    Followup,
}

#[derive(Debug)]
pub struct WakeWindows {
    cfg: WindowConfig,
    listening_until: Option<Instant>,
    followup_until: Option<Instant>,
}

impl WakeWindows {
    pub fn new(cfg: WindowConfig) -> Self {
        Self { cfg, listening_until: None, followup_until: None }
    }

    pub fn set_config(&mut self, cfg: WindowConfig) {
        self.cfg = cfg;
    }

    /// 唤醒但没带指令：开聆听窗口。
    pub fn open_listening(&mut self, now: Instant) {
        self.listening_until = Some(now + Duration::from_millis(self.cfg.listening_ms));
    }

    /// 一次播报自然结束：开追问窗口。
    /// 聆听窗口若还开着则**重新起算**——唤醒应答播完才真正开始等指令，
    /// 否则应答本身吃掉窗口头几秒。
    pub fn on_tts_finished(&mut self, now: Instant) {
        if self.listening_until.is_some() {
            self.open_listening(now);
        } else {
            self.followup_until = Some(now + Duration::from_millis(self.cfg.followup_ms));
        }
    }

    /// 此刻哪个窗口在生效（聆听优先）。过期窗口顺手清掉。
    pub fn active(&mut self, now: Instant) -> Option<WindowKind> {
        if let Some(t) = self.listening_until {
            if now < t {
                return Some(WindowKind::Listening);
            }
            self.listening_until = None;
        }
        if let Some(t) = self.followup_until {
            if now < t {
                return Some(WindowKind::Followup);
            }
            self.followup_until = None;
        }
        None
    }

    /// 窗口内送出了一句输入：许可消耗，两个窗口都关。
    pub fn consume(&mut self) {
        self.listening_until = None;
        self.followup_until = None;
    }

    /// 退下/关会话：全部清空。
    pub fn clear(&mut self) {
        self.consume();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> WindowConfig {
        WindowConfig { listening_ms: 15_000, followup_ms: 20_000 }
    }

    #[test]
    fn 聆听窗口_十五秒内有效_过期自动关() {
        let t0 = Instant::now();
        let mut w = WakeWindows::new(cfg());
        assert_eq!(w.active(t0), None);
        w.open_listening(t0);
        assert_eq!(w.active(t0 + Duration::from_secs(14)), Some(WindowKind::Listening));
        assert_eq!(w.active(t0 + Duration::from_secs(15)), None, "边界即过期");
        // 过期后不复活
        assert_eq!(w.active(t0 + Duration::from_secs(16)), None);
    }

    #[test]
    fn 追问窗口_播报结束起算二十秒() {
        let t0 = Instant::now();
        let mut w = WakeWindows::new(cfg());
        w.on_tts_finished(t0);
        assert_eq!(w.active(t0 + Duration::from_secs(19)), Some(WindowKind::Followup));
        assert_eq!(w.active(t0 + Duration::from_secs(20)), None);
    }

    #[test]
    fn 聆听窗口开着时_播报结束重新起算聆听_不开追问() {
        let t0 = Instant::now();
        let mut w = WakeWindows::new(cfg());
        w.open_listening(t0);
        // 唤醒应答播了 3s 才播完：窗口从此刻重新起算
        let t1 = t0 + Duration::from_secs(3);
        w.on_tts_finished(t1);
        assert_eq!(w.active(t1 + Duration::from_secs(14)), Some(WindowKind::Listening));
        assert_eq!(w.active(t1 + Duration::from_secs(15)), None);
    }

    #[test]
    fn 消耗后两个窗口都关() {
        let t0 = Instant::now();
        let mut w = WakeWindows::new(cfg());
        w.open_listening(t0);
        w.on_tts_finished(t0);
        w.consume();
        assert_eq!(w.active(t0 + Duration::from_millis(1)), None);
    }

    #[test]
    fn 默认值_聆听10s_追问5s_用户2026_08_26调定() {
        let d = WindowConfig::default();
        assert_eq!(d.listening_ms, 10_000);
        assert_eq!(d.followup_ms, 5_000);
    }

    #[test]
    fn 配置可改_立即生效() {
        let t0 = Instant::now();
        let mut w = WakeWindows::new(cfg());
        w.set_config(WindowConfig { listening_ms: 1_000, followup_ms: 20_000 });
        w.open_listening(t0);
        assert_eq!(w.active(t0 + Duration::from_millis(999)), Some(WindowKind::Listening));
        assert_eq!(w.active(t0 + Duration::from_millis(1_000)), None);
    }
}
