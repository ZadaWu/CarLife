//! 编码：设备采样 → 契约音频格式（施工单 M2-03，F-02-04）。
//!
//! 目标格式取自契约常量（`carlife-core::contract::voice`，勿在此硬编码第二份）：
//! pcm_s16le / 16kHz / 单声道（M2-02 ASR 拍板前的开发期假定值）。
//!
//! 重采样用线性插值：对语音 + Paraformer 类 ASR 足够，且零额外依赖；
//! 若实测识别质量不足再换 sinc 类重采样库（关键技术决策，回报项）。

use carlife_core::contract::{
    AudioMeta, DEFAULT_AUDIO_CHANNELS, DEFAULT_AUDIO_FORMAT, DEFAULT_AUDIO_SAMPLE_RATE_HZ,
};

/// 多声道交错样本 → 单声道（逐帧取声道均值）。
fn downmix_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let ch = channels as usize;
    samples
        .chunks_exact(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect()
}

/// 线性插值重采样。
fn resample_linear(mono: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || mono.is_empty() {
        return mono.to_vec();
    }
    let ratio = src_rate as f64 / dst_rate as f64;
    let out_len = ((mono.len() as f64) / ratio).floor() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let idx = pos.floor() as usize;
            let frac = (pos - idx as f64) as f32;
            let a = mono[idx];
            let b = *mono.get(idx + 1).unwrap_or(&a);
            a + (b - a) * frac
        })
        .collect()
}

/// f32 [-1,1] → i16 LE 字节。
fn to_s16le(mono: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(mono.len() * 2);
    for &s in mono {
        let clamped = s.clamp(-1.0, 1.0);
        let v = (clamped * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// 已是契约格式（16kHz 单声道 i16）的采样 → 字节 + 元数据（施工单 M25-01）。
///
/// 哨兵段经 `StreamConverter` 产出时就已经是目标格式，再走 `encode_pcm_s16le`
/// 会重复下混/重采样一遍——这里只做字节化。
pub fn encode_mono16k_i16(samples: &[i16]) -> (Vec<u8>, AudioMeta) {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    let duration_ms = (samples.len() as u64 * 1000 / DEFAULT_AUDIO_SAMPLE_RATE_HZ as u64) as u32;
    let meta = AudioMeta {
        duration_ms,
        format: DEFAULT_AUDIO_FORMAT.to_string(),
        sample_rate_hz: DEFAULT_AUDIO_SAMPLE_RATE_HZ,
        channels: DEFAULT_AUDIO_CHANNELS,
    };
    (bytes, meta)
}

/// 设备原始采样 → 契约格式字节 + 元数据。
pub fn encode_pcm_s16le(samples: &[f32], src_rate: u32, src_channels: u16) -> (Vec<u8>, AudioMeta) {
    let mono = downmix_mono(samples, src_channels);
    let resampled = resample_linear(&mono, src_rate, DEFAULT_AUDIO_SAMPLE_RATE_HZ);
    let duration_ms =
        (resampled.len() as u64 * 1000 / DEFAULT_AUDIO_SAMPLE_RATE_HZ as u64) as u32;
    let bytes = to_s16le(&resampled);
    let meta = AudioMeta {
        duration_ms,
        format: DEFAULT_AUDIO_FORMAT.to_string(),
        sample_rate_hz: DEFAULT_AUDIO_SAMPLE_RATE_HZ,
        channels: DEFAULT_AUDIO_CHANNELS,
    };
    (bytes, meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_channels() {
        // 双声道帧 (0.5, -0.5) → 0.0；(1.0, 0.0) → 0.5
        let mixed = downmix_mono(&[0.5, -0.5, 1.0, 0.0], 2);
        assert_eq!(mixed, vec![0.0, 0.5]);
    }

    #[test]
    fn resample_halves_length_from_32k_to_16k() {
        let src: Vec<f32> = (0..3200).map(|i| (i as f32 / 3200.0).sin()).collect();
        let out = resample_linear(&src, 32_000, 16_000);
        assert_eq!(out.len(), 1600);
    }

    #[test]
    fn identity_when_rates_match() {
        let src = vec![0.1, 0.2, 0.3];
        assert_eq!(resample_linear(&src, 16_000, 16_000), src);
    }

    #[test]
    fn s16le_clamps_and_encodes() {
        let bytes = to_s16le(&[0.0, 1.0, -1.0, 2.0]);
        assert_eq!(bytes.len(), 8);
        let v1 = i16::from_le_bytes([bytes[2], bytes[3]]);
        let v3 = i16::from_le_bytes([bytes[6], bytes[7]]);
        assert_eq!(v1, i16::MAX);
        assert_eq!(v3, i16::MAX, "超界样本应被截幅");
    }

    #[test]
    fn encode_produces_contract_meta_and_duration() {
        // 48kHz 双声道 1 秒 → 16kHz 单声道 1000ms
        let samples = vec![0.0f32; 48_000 * 2];
        let (bytes, meta) = encode_pcm_s16le(&samples, 48_000, 2);
        assert_eq!(meta.format, DEFAULT_AUDIO_FORMAT);
        assert_eq!(meta.sample_rate_hz, DEFAULT_AUDIO_SAMPLE_RATE_HZ);
        assert_eq!(meta.channels, DEFAULT_AUDIO_CHANNELS);
        assert_eq!(meta.duration_ms, 1000);
        assert_eq!(bytes.len(), 16_000 * 2);
    }
}
