//! 声学回声消除（施工单 M47-01，变更单 ACR-010）。
//!
//! # 它解决的是什么，为什么不是文本层能解决的
//!
//! 车机外放时，麦克风采到的一大半是**暖暖自己的声音**。此前挡这件事的是
//! `clients/cockpit/src-tauri/src/voice/echo.rs`——把转写结果与"正在播的那句原文"
//! 做拼音音节比对。那一层是事后猜：ASR 已经把声音转成字了，才回过头判断
//! "这些字是不是她自己说的"。它的三条已知边界（`docs/optimizations.md` 有账）：
//! ASR 错到拼音都对不上时回声漏进对话；播完 8s 内车主逐字复述会被误判成回采；
//! 快速追问与播报尾音并进同一段时转写带尾音前缀。
//!
//! 根因在声学层——**麦克风信号里混着扬声器信号**——所以在声学层解决：
//! 我们手上有正在播的那段 PCM（参考信号），把它从采集信号里减掉即可。
//! 这不是猜，是确定性的信号处理。
//!
//! # 为什么不自研 NLMS
//!
//! ACR-010 方案评估里自研一栏的判定是 reject，理由是「回声路径估计、双讲检测、
//! 非线性残余抑制是专业信号处理领域，自研质量不可控」。车载场景恰恰把这三件事
//! 全占了：音量大、扬声器离麦克风近（非线性失真重）、车主经常在播报中途插话（双讲）。
//! WebRTC 的 AEC3 是工业界验证过的实现，且与我们已在用的 `webrtc-vad` 同源同栈。
//!
//! # echo.rs 不删，降为第二道防线
//!
//! AEC 收敛需要时间、对 `say` 降级路径（macOS 的系统合成，音频在别的进程里，
//! 拿不到参考信号）完全无效。文本比对兜的就是这些漏网的。两层是并联不是串联。
//!
//! # 本模块的边界
//!
//! 只做"信号进、信号出"，不认识会话、播报状态、VAD。接线在 M47-02。

use thiserror::Error;
use webrtc_audio_processing::{
    config::{Config, EchoCanceller},
    Processor,
};

/// 链路采样率——与 `sentinel.rs` 的 `SENTINEL_RATE`、VAD、上传契约同一个值。
pub const AEC_SAMPLE_RATE: u32 = 16_000;

/// i16 满量程 ↔ f32 ±1.0 的换算因子。
///
/// APM 的 f32 接口要的是**归一化**样本（上游测试里写死 `1.0 / 32768.0`），
/// 不是 i16 的原始数值。传错的表现不是报错，是 AEC 完全不工作——
/// 送进去的信号在它眼里全部严重削顶。
const I16_FULL_SCALE: f32 = 32_768.0;

#[derive(Debug, Error)]
pub enum AecError {
    /// APM 初始化失败（绑定层的错误码原样带出）。
    #[error("aec_init_failed: {0}")]
    Init(String),
    /// 处理某一帧时 APM 返回错误。
    #[error("aec_process_failed: {0}")]
    Process(String),
    /// 采集侧传入的样本数不是 10ms 帧的整数倍。见 `process_capture` 的说明。
    #[error("aec_capture_frame_misaligned: {got} 不是 {frame} 的整数倍")]
    CaptureMisaligned { got: usize, frame: usize },
}

/// 回声消除器：一侧喂"正在播的声音"，另一侧就地消掉采集信号里的回声。
///
/// # 两侧的对称性是假的，别照搬
///
/// `feed_render` 允许任意长度（内部攒够 10ms 再喂 APM，余数留到下次），
/// `process_capture` 却要求整数倍——这个不对称是有意的，理由写在
/// `process_capture` 上：就地修改的缓冲区调用方立刻就要拿走，
/// 攒不了余数。
pub struct AecProcessor {
    inner: Processor,
    /// 10ms 一帧的样本数（16k 下 160）。APM 只吃这个长度，多一个少一个都 panic。
    frame_samples: usize,
    /// render 侧攒不满一帧的余数。**不能丢**：丢了等于参考信号出现空洞，
    /// AEC3 估出来的回声路径会跟着错位。
    render_pending: Vec<i16>,
    /// 复用的 f32 缓冲（1 通道 × 10ms），避免每帧两次堆分配。
    /// 采集链上每 30ms 就要走三趟，分配开销不该进这条路径。
    scratch: Vec<Vec<f32>>,
    /// 当前延迟提示，`set_stream_delay_ms` 改它并重下 config。
    stream_delay_ms: Option<u16>,
}

impl AecProcessor {
    /// 按链路采样率建一个消除器。
    pub fn new() -> Result<Self, AecError> {
        Self::with_sample_rate(AEC_SAMPLE_RATE)
    }

    /// 指定采样率（APM 支持 16k / 32k / 48k）。测试与将来换率用。
    pub fn with_sample_rate(sample_rate: u32) -> Result<Self, AecError> {
        let inner =
            Processor::new(sample_rate).map_err(|e| AecError::Init(format!("{e:?}")))?;
        // 10ms 帧长的定义来自 APM 自己：`sample_rate_hz / 100`。
        let frame_samples = sample_rate as usize / 100;

        let this = Self {
            inner,
            frame_samples,
            render_pending: Vec::with_capacity(frame_samples),
            scratch: vec![vec![0.0; frame_samples]],
            stream_delay_ms: None,
        };
        // 默认 Config 把所有子模块都关着——**不显式开就等于没装 AEC**，
        // 而且不会有任何报错，只是回声原样通过。
        this.apply_config();
        Ok(this)
    }

    /// 10ms 帧的样本数。接线方按它对齐缓冲。
    pub fn frame_samples(&self) -> usize {
        self.frame_samples
    }

    /// 设定「播出去」到「采回来」的延迟提示（毫秒）。
    ///
    /// `None` 表示让 AEC3 自己估。真机调参把实测值填进来——上游测试实测
    /// 对齐正确时的抑制比错齐好三个数量级，是本 Sprint 成败的关键参数
    /// （M47-03 macOS / M47-05 iPad 各存一份，两个平台的 IO 缓冲不是一个量级）。
    pub fn set_stream_delay_ms(&mut self, delay_ms: Option<u16>) {
        self.stream_delay_ms = delay_ms;
        self.apply_config();
    }

    fn apply_config(&self) {
        self.inner.set_config(Config {
            echo_canceller: Some(EchoCanceller::Full { stream_delay_ms: self.stream_delay_ms }),
            ..Default::default()
        });
    }

    /// 喂一段**正在播放**的参考信号。长度任意，内部按 10ms 切。
    ///
    /// 调用方在把 PCM 送进声卡的同时送一份到这里；两侧的时间差由
    /// `set_stream_delay_ms` 或 AEC3 的自适应估计器负责对齐。
    pub fn feed_render(&mut self, samples: &[i16]) -> Result<(), AecError> {
        let frame = self.frame_samples;
        // 先把上次的余数接上，再按帧切。
        self.render_pending.extend_from_slice(samples);

        let full = self.render_pending.len() / frame;
        for i in 0..full {
            let start = i * frame;
            load_scratch(&mut self.scratch[0], &self.render_pending[start..start + frame]);
            self.inner
                .process_render_frame(&mut self.scratch)
                .map_err(|e| AecError::Process(format!("{e:?}")))?;
        }
        // 整帧部分已消费，留下不足一帧的尾巴。
        self.render_pending.drain(..full * frame);
        Ok(())
    }

    /// 就地消掉采集信号里的回声。
    ///
    /// # 为什么这里不像 render 那样缓存余数
    ///
    /// 这个函数**就地改调用方的缓冲区**，而调用方拿回去就用（送 VAD / 编码上传）。
    /// 若把不足一帧的尾巴留在内部等下次，这一批样本里就会有一段没被处理过的、
    /// 却已经交回去的数据——回声只消了前面一半，比不消更难查。
    /// 所以宁可明确报错，让接线方按 `frame_samples()` 对齐。
    ///
    /// 我们的链路天然满足：哨兵帧是 30ms @16k = 480 = 3 × 160。
    pub fn process_capture(&mut self, samples: &mut [i16]) -> Result<(), AecError> {
        let frame = self.frame_samples;
        if samples.len() % frame != 0 {
            return Err(AecError::CaptureMisaligned { got: samples.len(), frame });
        }

        for chunk in samples.chunks_mut(frame) {
            load_scratch(&mut self.scratch[0], chunk);
            self.inner
                .process_capture_frame(&mut self.scratch)
                .map_err(|e| AecError::Process(format!("{e:?}")))?;
            store_scratch(&self.scratch[0], chunk);
        }
        Ok(())
    }
}

/// i16 → 归一化 f32。
fn load_scratch(dst: &mut [f32], src: &[i16]) {
    for (d, s) in dst.iter_mut().zip(src) {
        *d = *s as f32 / I16_FULL_SCALE;
    }
}

/// 归一化 f32 → i16，带饱和裁剪。
///
/// AEC 的输出可能略微越界（残余抑制与增益是浮点运算），不夹的话 `as i16`
/// 会**回绕**：一个 +1.01 的样本变成大负数，听感上是爆音。
fn store_scratch(src: &[f32], dst: &mut [i16]) {
    for (d, s) in dst.iter_mut().zip(src) {
        let v = (*s * I16_FULL_SCALE).round();
        *d = v.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 语音近似帧：基频 + 谐波。
    ///
    /// 与 `sentinel.rs` / `listen.rs` 的测试同一手法——纯正弦不像语音，
    /// 而这里更实际的理由是：AEC3 对宽带信号的回声路径估计才有意义。
    fn voiced(n: usize, phase: usize) -> Vec<i16> {
        (0..n)
            .map(|i| {
                let t = (i + phase) as f32 / AEC_SAMPLE_RATE as f32;
                let s = (2.0 * std::f32::consts::PI * 150.0 * t).sin() * 0.5
                    + (2.0 * std::f32::consts::PI * 300.0 * t).sin() * 0.3
                    + (2.0 * std::f32::consts::PI * 450.0 * t).sin() * 0.2;
                (s * 12_000.0) as i16
            })
            .collect()
    }

    fn rms(samples: &[i16]) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
        (sum / samples.len() as f64).sqrt()
    }

    /// 10ms @16k = 160 样本，这是 APM 的硬约束（`sample_rate_hz / 100`）。
    #[test]
    fn aec_帧长是十毫秒() {
        let aec = AecProcessor::new().expect("APM 应能初始化");
        assert_eq!(aec.frame_samples(), 160);
    }

    /// **本模块的主判据**：有参考信号时，回声被显著消掉。
    ///
    /// 构造一条 40ms 的回声路径（`DELAY_FRAMES` 帧）、衰减 0.6，
    /// 喂满 2s 让 AEC3 收敛，比较后半段处理前后的 RMS。
    ///
    /// 阈值取"降到一半以下"（≈ -6dB）而不是上游那种 18dB ERLE：
    /// 这条用例测的是**「它在工作」而不是「它有多好」**——后者取决于真机上的
    /// 延迟对齐（M47-03 / M47-05），在合成信号上把阈值定死反而会变成
    /// 一条脆弱的、换台机器就红的测试。
    #[test]
    fn aec_有参考信号时回声被消掉() {
        const DELAY_FRAMES: usize = 4; // 40ms
        let mut aec = AecProcessor::new().expect("APM 应能初始化");
        let frame = aec.frame_samples();

        // 回声路径：render 延迟 DELAY_FRAMES 帧后以 0.6 衰减回到麦克风。
        let mut path: Vec<Vec<i16>> = vec![vec![0; frame]; DELAY_FRAMES];
        let (mut before, mut after) = (0.0_f64, 0.0_f64);

        // 2s = 200 帧；前 100 帧给 AEC3 收敛，后 100 帧才计入判据。
        for i in 0..200 {
            let render = voiced(frame, i * frame);
            path.push(render.iter().map(|s| (*s as f32 * 0.6) as i16).collect());
            let mut capture = path.remove(0);

            aec.feed_render(&render).expect("render 帧应被接受");

            let pre = rms(&capture);
            aec.process_capture(&mut capture).expect("capture 帧应被接受");
            let post = rms(&capture);

            if i >= 100 {
                before += pre;
                after += post;
            }
        }

        // 调参时看得见实际抑制比（`cargo test -- --nocapture`）：阈值只保证
        // "它在工作"，这行才告诉你"工作得多好"。
        eprintln!(
            "[aec] 收敛后 RMS：{before:.1} → {after:.1}（抑制 {:.1} dB）",
            20.0 * (before / after.max(1e-9)).log10()
        );
        assert!(
            after < before * 0.5,
            "回声应被消掉一半以上：处理前 RMS 合计 {before:.1}，处理后 {after:.1}"
        );
    }

    /// 没有参考信号时不能把人声吃掉——这条比上一条更要紧。
    ///
    /// AEC 误伤正常语音的表现是"她好像听不清我说话了"，比回声漏网难查得多：
    /// 回声漏网看得见（自问自答），削人声只是识别率悄悄变差。
    #[test]
    fn aec_无参考信号时不劣化人声() {
        let mut aec = AecProcessor::new().expect("APM 应能初始化");
        let frame = aec.frame_samples();

        let (mut before, mut after) = (0.0_f64, 0.0_f64);
        for i in 0..200 {
            let mut capture = voiced(frame, i * frame);
            let pre = rms(&capture);
            // 刻意不喂 render：这一路只有车主在说话。
            aec.process_capture(&mut capture).expect("capture 帧应被接受");
            let post = rms(&capture);
            if i >= 100 {
                before += pre;
                after += post;
            }
        }

        assert!(
            after > before * 0.7,
            "无回声可消时人声不该被削掉三成以上：处理前 {before:.1}，处理后 {after:.1}"
        );
    }

    /// 30ms 帧（哨兵链路的形状）进出长度不变，一拆三对调用方透明。
    #[test]
    fn aec_三十毫秒帧进出形状不变() {
        let mut aec = AecProcessor::new().expect("APM 应能初始化");
        let mut capture = voiced(480, 0);
        let len = capture.len();
        aec.process_capture(&mut capture).expect("480 = 3 × 160，应被接受");
        assert_eq!(capture.len(), len, "就地处理不该改变长度");
    }

    /// 非整数倍要明确报错，不能默默处理一半。
    #[test]
    fn aec_采集帧不对齐时明确报错() {
        let mut aec = AecProcessor::new().expect("APM 应能初始化");
        let mut capture = voiced(500, 0);
        let err = aec.process_capture(&mut capture).expect_err("500 不是 160 的整数倍");
        assert!(matches!(err, AecError::CaptureMisaligned { got: 500, frame: 160 }));
    }

    /// render 侧相反：任意长度都收，余数留到下次，一个样本都不丢。
    #[test]
    fn aec_render余数不丢样本() {
        let mut aec = AecProcessor::new().expect("APM 应能初始化");
        // 250 = 1 帧(160) + 余 90
        aec.feed_render(&voiced(250, 0)).expect("任意长度都该被接受");
        assert_eq!(aec.render_pending.len(), 90, "余数应留着等下次凑满");

        // 再来 70 个正好凑满第二帧
        aec.feed_render(&voiced(70, 250)).expect("接上余数应凑满一帧");
        assert_eq!(aec.render_pending.len(), 0, "凑满后余数清空");
    }

    /// 延迟提示可改且不影响既有实例的可用性（真机调参会反复调它）。
    #[test]
    fn aec_延迟提示可设置() {
        let mut aec = AecProcessor::new().expect("APM 应能初始化");
        aec.set_stream_delay_ms(Some(80));
        let mut capture = voiced(160, 0);
        aec.process_capture(&mut capture).expect("设过延迟后仍能处理");
        aec.set_stream_delay_ms(None);
        aec.process_capture(&mut capture).expect("改回自适应后仍能处理");
    }
}
