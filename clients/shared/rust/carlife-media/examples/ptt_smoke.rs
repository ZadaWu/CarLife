//! PTT 采集冒烟（施工单 M2-03 验收辅助）：
//! 录 800ms → 停止 → 编码 → 打印结果。无 UI，用于开发机快速验证采集与编码链。
//! 运行：`cargo run -p carlife-media --example ptt_smoke`
//! 预期：有麦克风权限时打印样本数与 AudioMeta；被拒时打印明确错误（错误路径同样是验收项）。

use carlife_media::{encode_pcm_s16le, PttHandle};

fn main() {
    println!("[smoke] starting capture…");
    match PttHandle::start() {
        Ok(handle) => {
            println!(
                "[smoke] capturing at {} Hz x {} ch",
                handle.sample_rate, handle.channels
            );
            std::thread::sleep(std::time::Duration::from_millis(800));
            match handle.stop() {
                Ok(capture) => {
                    let (bytes, meta) = encode_pcm_s16le(
                        &capture.samples,
                        capture.sample_rate,
                        capture.channels,
                    );
                    println!(
                        "[smoke] raw_samples={} raw_ms={} truncated={}",
                        capture.samples.len(),
                        capture.duration_ms(),
                        capture.truncated
                    );
                    println!(
                        "[smoke] encoded_bytes={} meta={{durationMs:{}, format:{}, rate:{}, ch:{}}}",
                        bytes.len(),
                        meta.duration_ms,
                        meta.format,
                        meta.sample_rate_hz,
                        meta.channels
                    );
                }
                Err(e) => println!("[smoke] stop failed: {e}"),
            }
        }
        Err(e) => println!("[smoke] start failed (预期的权限/设备错误路径): {e}"),
    }
}
