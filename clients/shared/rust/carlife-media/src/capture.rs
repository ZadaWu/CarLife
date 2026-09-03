//! push-to-talk 采集（施工单 M2-03，F-02-02）。
//!
//! 线程模型：`cpal::Stream` 非 `Send`，由**专用采集线程**独占持有；
//! 外部经 `PttHandle`（channel，`Send`）控制。这使句柄可安全放进
//! Tauri 的异步 command（配合 `spawn_blocking`）。
//!
//! 语义（§2.2 / FL-02 AC-02-3）：
//!  - `start` 即录（不做 VAD 判定）；
//!  - `stop` 立即结束并**释放麦克风**（线程内 drop Stream）；
//!  - 超过 60s 上限自动停止追加并标记截断（`MAX_CAPTURE_DURATION_MS`）。
//!
//! 桥接层/WebView 永远接触不到本模块的样本数据（AC-02-2）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use carlife_core::contract::MAX_CAPTURE_DURATION_MS;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CaptureError {
    /// 无可用输入设备（含系统权限被拒的常见表现）。
    #[error("no_input_device")]
    NoDevice,
    /// 设备被占用或流构建失败。
    #[error("device_unavailable: {0}")]
    DeviceUnavailable(String),
    /// 采集线程异常退出。
    #[error("capture_thread_failed")]
    ThreadFailed,
    /// 重复启动。
    #[error("already_recording")]
    AlreadyRecording,
    /// 未在录音（stop 无对应 start）。
    #[error("not_recording")]
    NotRecording,
}

/// 一次采集的原始结果（未编码）。
pub struct RawCapture {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
    /// 命中 60s 上限被截断。
    pub truncated: bool,
}

impl RawCapture {
    pub fn duration_ms(&self) -> u32 {
        if self.sample_rate == 0 || self.channels == 0 {
            return 0;
        }
        (self.samples.len() as u64 * 1000
            / (self.sample_rate as u64 * self.channels as u64)) as u32
    }
}

/// 采集缓冲：上限判定与截断逻辑（独立于 cpal，可单测）。
pub struct CaptureBuffer {
    samples: Vec<f32>,
    max_samples: usize,
    truncated: bool,
}

impl CaptureBuffer {
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        let max_samples = (sample_rate as u64 * channels as u64 * MAX_CAPTURE_DURATION_MS as u64
            / 1000) as usize;
        Self { samples: Vec::new(), max_samples, truncated: false }
    }

    /// 追加一批帧；命中上限后停止追加并标记截断。
    pub fn push(&mut self, data: &[f32]) {
        if self.truncated {
            return;
        }
        let remaining = self.max_samples.saturating_sub(self.samples.len());
        if data.len() >= remaining {
            self.samples.extend_from_slice(&data[..remaining]);
            self.truncated = true;
        } else {
            self.samples.extend_from_slice(data);
        }
    }

    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    fn into_capture(self, sample_rate: u32, channels: u16) -> RawCapture {
        RawCapture { samples: self.samples, sample_rate, channels, truncated: self.truncated }
    }
}

enum ThreadReply {
    Started { sample_rate: u32, channels: u16 },
    Failed(CaptureError),
}

/// 采集会话句柄（`Send`；跨线程控制采集线程）。
pub struct PttHandle {
    stop_tx: SyncSender<()>,
    result_rx: Receiver<RawCapture>,
    join: JoinHandle<()>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl PttHandle {
    /// 立即启动采集。阻塞至输入流就绪（或失败），保证返回时"确实在录"。
    pub fn start() -> Result<PttHandle, CaptureError> {
        let (reply_tx, reply_rx) = sync_channel::<ThreadReply>(1);
        let (stop_tx, stop_rx) = sync_channel::<()>(1);
        let (result_tx, result_rx) = sync_channel::<RawCapture>(1);

        let join = std::thread::spawn(move || {
            capture_thread(reply_tx, stop_rx, result_tx);
        });

        match reply_rx.recv() {
            Ok(ThreadReply::Started { sample_rate, channels }) => Ok(PttHandle {
                stop_tx,
                result_rx,
                join,
                sample_rate,
                channels,
            }),
            Ok(ThreadReply::Failed(err)) => {
                let _ = join.join();
                Err(err)
            }
            Err(_) => Err(CaptureError::ThreadFailed),
        }
    }

    /// 立即停止：采集线程 drop Stream（释放麦克风）并交回样本。
    pub fn stop(self) -> Result<RawCapture, CaptureError> {
        match self.stop_tx.try_send(()) {
            Ok(()) | Err(TrySendError::Disconnected(_)) => {}
            Err(TrySendError::Full(_)) => {}
        }
        let capture = self.result_rx.recv().map_err(|_| CaptureError::ThreadFailed)?;
        let _ = self.join.join();
        Ok(capture)
    }
}

/// 持续采集句柄（施工单 M25-01，F-52-01）——哨兵监听的输入端。
///
/// 与 `PttHandle` 的差别只有一个：不攒整段，采到的每一小块 f32 立刻经
/// `data_rx` 交给消费方（哨兵循环做 VAD 分段）。通道**有界且满了就丢**：
/// 消费方卡住时宁可丢音频也不能让内存无界增长——哨兵丢一块的代价是
/// 这句唤醒没听见（车主会再喊一次），内存涨的代价是整个车机端。
pub struct ContinuousHandle {
    stop_tx: SyncSender<()>,
    join: JoinHandle<()>,
    pub sample_rate: u32,
    pub channels: u16,
    pub data_rx: Receiver<Vec<f32>>,
}

impl ContinuousHandle {
    /// 启动持续采集。阻塞至输入流就绪（或失败）。
    pub fn start() -> Result<ContinuousHandle, CaptureError> {
        let (reply_tx, reply_rx) = sync_channel::<ThreadReply>(1);
        let (stop_tx, stop_rx) = sync_channel::<()>(1);
        // 64 块 × 常见 10ms 回调 ≈ 0.6s 缓冲，消费方 50ms 一轮绰绰有余
        let (data_tx, data_rx) = sync_channel::<Vec<f32>>(64);

        let join = std::thread::spawn(move || {
            continuous_thread(reply_tx, stop_rx, data_tx);
        });

        match reply_rx.recv() {
            Ok(ThreadReply::Started { sample_rate, channels }) => {
                Ok(ContinuousHandle { stop_tx, join, sample_rate, channels, data_rx })
            }
            Ok(ThreadReply::Failed(err)) => {
                let _ = join.join();
                Err(err)
            }
            Err(_) => Err(CaptureError::ThreadFailed),
        }
    }

    /// 立即停止并释放麦克风。
    pub fn stop(self) {
        match self.stop_tx.try_send(()) {
            Ok(()) | Err(TrySendError::Disconnected(_)) | Err(TrySendError::Full(_)) => {}
        }
        let _ = self.join.join();
    }
}

fn continuous_thread(
    reply_tx: SyncSender<ThreadReply>,
    stop_rx: Receiver<()>,
    data_tx: SyncSender<Vec<f32>>,
) {
    // iOS 必须先把音频会话切到可录音的类别，否则 cpal 一路成功、样本全是零
    // （见 audio_session.rs 文件头的真机实测）。非 iOS 是 no-op。
    // `_session` 要活到线程结束：持有期间哨兵不会把档位还掉（见 release 的文档）。
    let _session = match crate::audio_session::ensure_recording_session() {
        Ok(s) => s,
        Err(e) => {
            let _ = reply_tx.send(ThreadReply::Failed(CaptureError::DeviceUnavailable(e)));
            return;
        }
    };
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        let _ = reply_tx.send(ThreadReply::Failed(CaptureError::NoDevice));
        return;
    };
    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = reply_tx
                .send(ThreadReply::Failed(CaptureError::DeviceUnavailable(e.to_string())));
            return;
        }
    };
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    let stream = device.build_input_stream(
        &config.clone().into(),
        move |data: &[f32], _| {
            // 满了就丢（见 ContinuousHandle 文档）；断开说明消费方已退出，忽略
            let _ = data_tx.try_send(data.to_vec());
        },
        |err| eprintln!("[carlife-media] sentinel stream error: {err}"),
        None,
    );
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = reply_tx
                .send(ThreadReply::Failed(CaptureError::DeviceUnavailable(e.to_string())));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = reply_tx.send(ThreadReply::Failed(CaptureError::DeviceUnavailable(e.to_string())));
        return;
    }
    let _ = reply_tx.send(ThreadReply::Started { sample_rate, channels });

    let _ = stop_rx.recv();
    drop(stream); // 立即释放麦克风——总开关关闭时占用必须消失（AC-52-6）
}

fn capture_thread(
    reply_tx: SyncSender<ThreadReply>,
    stop_rx: Receiver<()>,
    result_tx: SyncSender<RawCapture>,
) {
    // 同 continuous_thread：iOS 上不先切会话就只能录到零样本，而且不报错。
    // `_session` 同上：长按期间它挡着哨兵的归还，否则录到的全是零（2026-09-02 真机）。
    let _session = match crate::audio_session::ensure_recording_session() {
        Ok(s) => s,
        Err(e) => {
            let _ = reply_tx.send(ThreadReply::Failed(CaptureError::DeviceUnavailable(e)));
            return;
        }
    };
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        let _ = reply_tx.send(ThreadReply::Failed(CaptureError::NoDevice));
        return;
    };
    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = reply_tx
                .send(ThreadReply::Failed(CaptureError::DeviceUnavailable(e.to_string())));
            return;
        }
    };
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    let buffer = Arc::new(Mutex::new(CaptureBuffer::new(sample_rate, channels)));
    let cb_buffer = Arc::clone(&buffer);
    let overflowed = Arc::new(AtomicBool::new(false));
    let cb_overflowed = Arc::clone(&overflowed);

    let stream = device.build_input_stream(
        &config.clone().into(),
        move |data: &[f32], _| {
            let mut buf = cb_buffer.lock().expect("capture buffer poisoned");
            buf.push(data);
            if buf.is_truncated() {
                cb_overflowed.store(true, Ordering::Relaxed);
            }
        },
        |err| eprintln!("[carlife-media] input stream error: {err}"),
        None,
    );
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = reply_tx
                .send(ThreadReply::Failed(CaptureError::DeviceUnavailable(e.to_string())));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = reply_tx.send(ThreadReply::Failed(CaptureError::DeviceUnavailable(e.to_string())));
        return;
    }
    let _ = reply_tx.send(ThreadReply::Started { sample_rate, channels });

    // 等停止指令；60s 截断后即使不松手也不再累积（缓冲自截断），
    // 采集线程仍等 stop 以保证"松手才结束"的交互语义。
    let _ = stop_rx.recv();

    drop(stream); // 立即释放麦克风（AC-02-3 的实现点）

    let capture = {
        let mut guard = buffer.lock().expect("capture buffer poisoned");
        std::mem::replace(&mut *guard, CaptureBuffer::new(1, 1))
            .into_capture(sample_rate, channels)
    };
    let _ = result_tx.send(capture);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_truncates_at_60s_cap() {
        // 1kHz 单声道 → 上限 60_000 个样本
        let mut buf = CaptureBuffer::new(1000, 1);
        buf.push(&vec![0.0; 59_999]);
        assert!(!buf.is_truncated());
        buf.push(&[0.1, 0.2, 0.3]); // 越界：只收 1 个
        assert!(buf.is_truncated());
        let cap = buf.into_capture(1000, 1);
        assert_eq!(cap.samples.len(), 60_000);
        assert!(cap.truncated);
        assert_eq!(cap.duration_ms(), 60_000);
    }

    #[test]
    fn truncated_buffer_ignores_further_pushes() {
        let mut buf = CaptureBuffer::new(1, 1); // 上限 60 个样本
        buf.push(&vec![0.0; 100]);
        assert!(buf.is_truncated());
        buf.push(&vec![0.0; 100]);
        let cap = buf.into_capture(1, 1);
        assert_eq!(cap.samples.len(), 60);
    }

    #[test]
    fn duration_accounts_for_channels() {
        let cap = RawCapture {
            samples: vec![0.0; 48_000 * 2], // 双声道 1 秒
            sample_rate: 48_000,
            channels: 2,
            truncated: false,
        };
        assert_eq!(cap.duration_ms(), 1000);
    }
}
