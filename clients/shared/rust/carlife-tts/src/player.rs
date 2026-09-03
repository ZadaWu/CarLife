//! rodio 从内存直解 mp3 进声卡（ACR-004 第 2 步）。
//!
//! 换掉的是"写临时文件 → afplay 子进程"那条路：iOS 沙盒禁止 spawn，且临时文件带来过
//! 一整类事故（同名文件并发互踩、/tmp 清扫）。内存直解之后这一类问题结构性消失。
//! 输出流每次新开：流的生命周期就是这一次播报的生命周期，与 `Playback` 一起被 halt/drop 回收。
//!
//! **没有 AEC 参考信号旁路**（车机 M47-02 的 `RenderTap`）：那是车机差异项。

use crate::state::Playback;

pub fn start_mp3_playback(audio: Vec<u8>) -> Result<Playback, String> {
    let device = rodio::DeviceSinkBuilder::open_default_sink()
        .map_err(|e| format!("打开音频输出失败: {e}"))?;
    let player = rodio::Player::connect_new(device.mixer());
    let decoder = rodio::Decoder::new(std::io::Cursor::new(audio))
        .map_err(|e| format!("mp3 解码失败: {e}"))?;
    player.append(decoder);
    Ok(Playback { player, _device: device })
}
