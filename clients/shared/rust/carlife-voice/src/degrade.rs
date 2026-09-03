//! 转写链路的降级判定与退避（施工单 M25-04，F-52-08；M60-01 从车机端移入本共享 crate）。
//!
//! 纯逻辑，时钟由调用方注入：连续失败 `threshold` 次进入降级；降级中按退避
//! 节奏放行探测（15s 起步，×2 封顶 120s）；一次成功即恢复并复位。
//!
//! 两端共用同一份判据是有理由的：降级期间哨兵**停止采集**，这是用户能直接
//! 感知的行为（"她突然听不见了"）。两端各写一份阈值，迟早会漂成
//! "手机上转写坏三次就聋，车上要坏五次"——而这种差异没有任何报错。

use std::time::{Duration, Instant};

pub struct DegradeGate {
    threshold: u32,
    streak: u32,
    degraded: bool,
    backoff_ms: u64,
    next_probe_at: Option<Instant>,
}

impl Default for DegradeGate {
    fn default() -> Self {
        Self { threshold: 3, streak: 0, degraded: false, backoff_ms: 15_000, next_probe_at: None }
    }
}

impl DegradeGate {
    /// 一次转写失败。返回 `true` = 此刻**进入**降级（沿上只报一次，供一次性提示用）。
    pub fn on_failure(&mut self, now: Instant) -> bool {
        self.streak += 1;
        if !self.degraded && self.streak >= self.threshold {
            self.degraded = true;
            self.backoff_ms = 15_000;
            self.next_probe_at = Some(now + Duration::from_millis(self.backoff_ms));
            return true;
        }
        if self.degraded {
            // 探测失败：退避翻倍，封顶 120s
            self.backoff_ms = (self.backoff_ms * 2).min(120_000);
            self.next_probe_at = Some(now + Duration::from_millis(self.backoff_ms));
        }
        false
    }

    /// 一次转写成功。返回 `true` = 此刻**退出**降级（自动回位）。
    pub fn on_success(&mut self) -> bool {
        self.streak = 0;
        let was = self.degraded;
        self.degraded = false;
        self.next_probe_at = None;
        self.backoff_ms = 15_000;
        was
    }

    /// 到探测时间了吗（只在降级中有意义）。
    pub fn probe_due(&self, now: Instant) -> bool {
        self.degraded && self.next_probe_at.is_some_and(|t| now >= t)
    }
}

#[cfg(test)]
mod tests {
    use super::DegradeGate;
    use std::time::{Duration, Instant};

    #[test]
    fn 连续三败进入降级_且进入沿只报一次() {
        let mut g = DegradeGate::default();
        let t0 = Instant::now();
        assert!(!g.on_failure(t0));
        assert!(!g.on_failure(t0));
        assert!(g.on_failure(t0), "第三败进入降级");
        assert!(!g.on_failure(t0), "已在降级中，不再重复报进入");
    }

    #[test]
    fn 探测按退避节奏放行_翻倍封顶() {
        let mut g = DegradeGate::default();
        let t0 = Instant::now();
        for _ in 0..3 {
            g.on_failure(t0);
        }
        assert!(!g.probe_due(t0 + Duration::from_secs(14)), "15s 前不探测");
        assert!(g.probe_due(t0 + Duration::from_secs(15)));
        // 探测失败：退避 30s
        let t1 = t0 + Duration::from_secs(15);
        g.on_failure(t1);
        assert!(!g.probe_due(t1 + Duration::from_secs(29)));
        assert!(g.probe_due(t1 + Duration::from_secs(30)));
        // 一路翻倍封顶 120s
        let mut t = t1;
        for _ in 0..6 {
            t += Duration::from_secs(200);
            g.on_failure(t);
        }
        assert!(!g.probe_due(t + Duration::from_secs(119)));
        assert!(g.probe_due(t + Duration::from_secs(120)), "退避封顶 120s");
    }

    #[test]
    fn 一次成功即恢复_且恢复沿只报一次() {
        let mut g = DegradeGate::default();
        let t0 = Instant::now();
        for _ in 0..3 {
            g.on_failure(t0);
        }
        assert!(g.on_success(), "恢复沿");
        assert!(!g.on_success(), "已恢复，不再重复报");
        assert!(!g.probe_due(t0 + Duration::from_secs(999)), "恢复后不再探测");
    }

    #[test]
    fn 未降级时偶发失败不触发探测() {
        let mut g = DegradeGate::default();
        let t0 = Instant::now();
        g.on_failure(t0);
        assert!(g.on_success() == false);
        g.on_failure(t0);
        g.on_failure(t0);
        // 中间成功清零了 streak：两败不达阈值
        assert!(!g.probe_due(t0 + Duration::from_secs(999)));
    }
}
