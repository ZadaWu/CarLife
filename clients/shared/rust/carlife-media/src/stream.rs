//! 设备流 → VAD 帧的增量转换（施工单 M25-01，F-52-01）。
//!
//! 哨兵监听是持续流：设备给的是任意采样率/声道的 f32 小块，
//! `VadGate` 要的是 16kHz 单声道 i16 的 30ms 定长帧。`encode.rs` 的
//! 整段式转换（收完再转）在这里不适用——哨兵永远"收不完"。
//!
//! 重采样与 `encode.rs` 同为线性插值，但**跨块保持相位**（`pos` 带小数进位）：
//! 逐块独立重采样会在块边界产生台阶，VAD 对此不敏感，但同一份样本还要拼成
//! 上传段送 ASR，接缝会变成可闻的咔哒声。

use crate::vad::VadGate;

/// 目标格式与契约一致（16kHz 单声道），帧长跟 `VadGate` 走。
const TARGET_RATE: u32 = 16_000;

pub struct StreamConverter {
    src_rate: u32,
    channels: u16,
    /// 已下混、待重采样的源采样（保留上一块尾部一个样本做插值衔接）。
    mono: Vec<f32>,
    /// 相对 `mono[0]` 的小数读位置。
    pos: f64,
    /// 已重采样、未凑满一帧的目标采样。
    pending: Vec<i16>,
    frame_len: usize,
}

impl StreamConverter {
    pub fn new(src_rate: u32, channels: u16) -> Self {
        Self {
            src_rate,
            channels: channels.max(1),
            mono: Vec::new(),
            pos: 0.0,
            pending: Vec::new(),
            frame_len: VadGate::frame_samples(TARGET_RATE),
        }
    }

    /// 送入一块设备采样（交错多声道 f32），返回凑满的 30ms 帧（16k 单声道 i16）。
    pub fn push(&mut self, interleaved: &[f32]) -> Vec<Vec<i16>> {
        // 下混
        let ch = self.channels as usize;
        if ch <= 1 {
            self.mono.extend_from_slice(interleaved);
        } else {
            self.mono.extend(
                interleaved
                    .chunks_exact(ch)
                    .map(|f| f.iter().sum::<f32>() / ch as f32),
            );
        }

        // 重采样（线性插值，跨块保持 pos）
        let ratio = self.src_rate as f64 / TARGET_RATE as f64;
        while (self.pos.floor() as usize) + 1 < self.mono.len() {
            let idx = self.pos.floor() as usize;
            let frac = (self.pos - idx as f64) as f32;
            let a = self.mono[idx];
            let b = self.mono[idx + 1];
            let s = (a + (b - a) * frac).clamp(-1.0, 1.0);
            self.pending.push((s * i16::MAX as f32) as i16);
            self.pos += ratio;
        }
        // 丢掉已消费的前缀，保留插值仍要用的那一个样本
        let consumed = (self.pos.floor() as usize).min(self.mono.len().saturating_sub(1));
        if consumed > 0 {
            self.mono.drain(..consumed);
            self.pos -= consumed as f64;
        }

        // 切帧
        let mut frames = Vec::new();
        while self.pending.len() >= self.frame_len {
            frames.push(self.pending.drain(..self.frame_len).collect());
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同率单声道_一秒进一秒出() {
        let mut c = StreamConverter::new(16_000, 1);
        let mut total = 0usize;
        // 100 块 × 160 样本 = 1s
        for _ in 0..100 {
            let chunk = vec![0.1f32; 160];
            for f in c.push(&chunk) {
                assert_eq!(f.len(), 480);
                total += f.len();
            }
        }
        // 线性插值尾部留一个样本衔接，允许差一帧以内
        assert!(total >= 16_000 - 480 && total <= 16_000, "total={total}");
    }

    #[test]
    fn 双声道_48k_下混重采样到_16k() {
        let mut c = StreamConverter::new(48_000, 2);
        let mut total = 0usize;
        // 1 秒：48k × 2ch，交错
        for _ in 0..100 {
            let chunk = vec![0.2f32; 960]; // 480 帧 × 2ch = 10ms
            for f in c.push(&chunk) {
                assert_eq!(f.len(), 480);
                total += f.len();
            }
        }
        assert!(total >= 16_000 - 480 && total <= 16_000, "total={total}");
    }

    #[test]
    fn 跨块相位连续_正弦波无台阶() {
        // 44.1k（非整数比）单声道，1kHz 正弦，按 441 样本一块送
        let src = 44_100u32;
        let mut c = StreamConverter::new(src, 1);
        let samples: Vec<f32> = (0..src as usize)
            .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / src as f32).sin() * 0.8)
            .collect();
        let mut out = Vec::new();
        for chunk in samples.chunks(441) {
            for f in c.push(chunk) {
                out.extend(f);
            }
        }
        assert!(out.len() >= 15_000, "out={}", out.len());
        // 无台阶：相邻样本差不超过 1kHz@16k 正弦的理论最大斜率（约 0.39 幅值）加余量
        let max_step = out
            .windows(2)
            .map(|w| (w[1] as i32 - w[0] as i32).unsigned_abs())
            .max()
            .unwrap();
        let limit = (0.8 * 0.45 * i16::MAX as f32) as u32;
        assert!(max_step < limit, "块边界出现台阶：max_step={max_step} limit={limit}");
    }

    #[test]
    fn 零声道输入按单声道处理_不除零() {
        let mut c = StreamConverter::new(16_000, 0);
        let _ = c.push(&vec![0.0f32; 480]);
    }
}
