//! 有界事件缓冲。
//!
//! # 满了丢**最旧**的，不是拒收最新的
//!
//! 崩溃前的最后几条事件是诊断价值最高的。满了就拒收新事件，等于在最需要
//! 记录的时刻停止记录——车机连开数天后缓冲一定是满的，那正是出问题的时候。
//!
//! # 丢弃要被计数
//!
//! `dropped()` 让上层知道"这中间断了多少条"。静默丢弃会让时间线看起来连续，
//! 于是有人据此推断"这两个事件是紧挨着发生的"，而中间可能丢了三百条。

use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::redact::redact;

/// 默认容量。车机长时间运行，这是内存占用与诊断价值之间的折中。
pub const DEFAULT_CAPACITY: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Debug,
    Info,
    Warn,
    Error,
    /// 崩溃。由 panic hook 写入，不该被业务代码直接使用。
    Crash,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub at_ms: u128,
    pub severity: Severity,
    /// 事件名，如 `hud.state_changed`。**不含用户内容**。
    pub name: String,
    /// 补充信息。**写入时已脱敏**（见 redact.rs）。
    pub detail: String,
}

/// 线程安全的有界缓冲。
///
/// 用 `Mutex<VecDeque>` 而不是无锁队列：埋点频率是每秒个位数，
/// 锁竞争不是问题，而无锁实现的复杂度会带来真正的风险。
#[derive(Debug)]
pub struct TelemetryBuffer {
    inner: Mutex<Inner>,
    capacity: usize,
}

#[derive(Debug, Default)]
struct Inner {
    events: std::collections::VecDeque<Event>,
    dropped: u64,
}

impl TelemetryBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            // 容量 0 会让每条事件都记成丢弃，是配置错误而不是"关闭埋点"——
            // 想关闭该是不安装 hook，不是把容量设成 0。
            capacity: capacity.max(1),
        }
    }

    pub fn with_default_capacity() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }

    /// 记录一条事件。**永不阻塞、永不 panic、永不返回错误。**
    ///
    /// 锁中毒（另一个线程持锁时 panic）时直接放弃这条：埋点失败不能演变成
    /// 第二次 panic，那会把原始崩溃现场盖掉。
    pub fn record(&self, severity: Severity, name: &str, detail: &str) {
        let event = Event {
            at_ms: now_ms(),
            severity,
            name: name.to_string(),
            // 脱敏在**这里**发生：没进过缓冲的东西，崩溃转储也带不走
            detail: redact(detail),
        };
        let mut guard = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.events.len() >= self.capacity {
            guard.events.pop_front();
            guard.dropped += 1;
        }
        guard.events.push_back(event);
    }

    /// 取走全部事件并清空。上层拿到后决定送去哪——本 crate 不发送。
    pub fn drain(&self) -> Vec<Event> {
        let mut guard = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        guard.events.drain(..).collect()
    }

    /// 只读快照，不清空。给"看一眼当前状态"的诊断入口用。
    pub fn snapshot(&self) -> Vec<Event> {
        let guard = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        guard.events.iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .events
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 因容量上限被丢弃的累计条数。**上层应把它一并上报**，否则时间线的断裂无人知晓。
    pub fn dropped(&self) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .dropped
    }
}

impl Default for TelemetryBuffer {
    fn default() -> Self {
        Self::with_default_capacity()
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_drains() {
        let b = TelemetryBuffer::new(8);
        b.record(Severity::Info, "hud.state", "listening");
        assert_eq!(b.len(), 1);
        let drained = b.drain();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].name, "hud.state");
        assert!(b.is_empty(), "drain 后应清空");
    }

    #[test]
    fn drops_oldest_not_newest() {
        let b = TelemetryBuffer::new(3);
        for i in 0..5 {
            b.record(Severity::Info, "e", &i.to_string());
        }
        let events = b.snapshot();
        assert_eq!(events.len(), 3);
        // 保留的必须是最后三条 —— 崩溃前的最后几条价值最高
        assert_eq!(events[0].detail, "2");
        assert_eq!(events[2].detail, "4");
        assert_eq!(b.dropped(), 2, "丢弃要被计数，否则时间线断裂无人知晓");
    }

    #[test]
    fn redacts_on_write_not_on_send() {
        let b = TelemetryBuffer::new(4);
        b.record(Severity::Error, "contact", "回拨 13800138000");
        // 断言的是**缓冲里**已经没有原文，而不是发送时才洗
        assert_eq!(b.snapshot()[0].detail, "回拨 [手机号]");
    }

    #[test]
    fn zero_capacity_is_treated_as_one() {
        let b = TelemetryBuffer::new(0);
        b.record(Severity::Info, "e", "x");
        assert_eq!(b.len(), 1, "容量 0 是配置错误，不该表现为「每条都丢」");
    }

    #[test]
    fn survives_poisoned_lock() {
        use std::sync::Arc;
        let b = Arc::new(TelemetryBuffer::new(4));
        let b2 = Arc::clone(&b);
        let _ = std::thread::spawn(move || {
            b2.record(Severity::Info, "before", "x");
            panic!("毒化这把锁");
        })
        .join();
        // 埋点失败不能演变成第二次 panic，那会盖掉原始崩溃现场
        b.record(Severity::Info, "after", "y");
        assert!(b.snapshot().iter().any(|e| e.name == "after"));
    }

    #[test]
    fn concurrent_records_do_not_lose_events() {
        use std::sync::Arc;
        let b = Arc::new(TelemetryBuffer::new(1000));
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let b = Arc::clone(&b);
                std::thread::spawn(move || {
                    for i in 0..50 {
                        b.record(Severity::Info, "e", &format!("{t}-{i}"));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(b.len(), 400);
        assert_eq!(b.dropped(), 0);
    }
}
