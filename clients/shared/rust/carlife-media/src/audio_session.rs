//! iOS 音频会话（M39-02 真机实测抓出）。
//!
//! # 为什么必须有这一步
//!
//! iOS 应用默认的 `AVAudioSession` 类别是 `SoloAmbient`，**那一档没有输入**。
//! 而 cpal 在这种状态下**不报错**：设备枚举得到、输入流建得起来、回调照常来，
//! 只是每一帧都是零样本——与 `permission.rs` 文件头记的 macOS 未授权表现完全一样，
//! 一路空音频送进 ASR、转出空文本、端上毫无反应。
//!
//! 真机实测（2026-08-30，iPad Pro 12.9"）：长按后暖暖显示"正在聆听"、松开无任何反应，
//! 网关侧**一条 `POST /v1/asr/transcribe` 都没有**——录到的全是零，被
//! `commands/media.rs` 的 `empty_capture` 判定拦在了上传之前。那道判定是对的，
//! 它挡住了垃圾；但根因在这里：**从来没有人把音频会话切到能录音的类别**。
//!
//! # 为什么放在 Rust 而不是 `main.mm`
//!
//! Tauri 生成的 `gen/apple/Sources/cockpit/main.mm` 看着更适合放这三行，
//! 但整个 `**/src-tauri/gen/` 在 `.gitignore` 里——**改在那儿既进不了版本库、
//! 也会被下一次 `tauri ios init` 抹掉**。放进采集这一侧还有个好处：会话配置与
//! "谁要录音"待在一起，不会有人在别处加一条采集路径却忘了配会话。
//!
//! # 失败就报错，不静默继续
//!
//! 配置失败时返回 `Err`，让 `PttHandle::start` 直接失败。**沉默地录一段零样本
//! 比明确失败糟得多**——前者要靠翻网关日志才能发现，后者端上立刻看得见。

use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// 当前有几条采集正在用录音档位（PTT 一条、哨兵一条，可能并存）。
///
/// 它存在的唯一理由是 [`release_recording_session`] 要回答"现在还能不能还"，
/// 而**调用归还的人（哨兵）看不见别人的采集**——见那个函数的文档。
static ACTIVE_CAPTURES: AtomicUsize = AtomicUsize::new(0);

/// 此刻的类别是不是 `playAndRecord`。用来短路重复归还（同上文档）。
static SESSION_RECORDING: AtomicBool = AtomicBool::new(false);

/// 「我正在用录音档位」的凭据。**持有期间任何人都归还不了档位**。
///
/// 做成 RAII 而不是一对 `enter()` / `leave()`：采集线程有十来个 early return
/// （设备没了、配置失败、建流失败……），手写配对必漏一条，而漏掉的表现是
/// 档位再也还不回去——系统麦克风指示永久亮着，和 M60-02 要修的病症一模一样。
#[must_use = "凭据一 drop 就等于宣告采集结束，必须绑在采集线程的整个生命周期上"]
pub struct RecordingSession(());

impl Drop for RecordingSession {
    fn drop(&mut self) {
        ACTIVE_CAPTURES.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 把系统音频会话切到可录音的类别并激活，并登记"我在录"。非 iOS 平台只做后者。
///
/// 幂等：每次采集前调用一次，重复设置同一类别在 iOS 上不产生副作用。
///
/// 返回的凭据必须**持有到采集结束**（见 [`RecordingSession`]）：
/// 它是 [`release_recording_session`] 判断"现在能不能还"的唯一依据。
pub fn ensure_recording_session() -> Result<RecordingSession, String> {
    imp::ensure_recording_session()?;
    SESSION_RECORDING.store(true, Ordering::Release);
    ACTIVE_CAPTURES.fetch_add(1, Ordering::AcqRel);
    Ok(RecordingSession(()))
}

/// 归还录音档位：把系统音频会话切回**只播不录**（`playback`）。非 iOS 平台是 no-op。
///
/// # 为什么这一步不能省（M60-02，iPad 真机实测）
///
/// [`ensure_recording_session`] 把会话切到 `playAndRecord` 并激活，而在此之前
/// **全仓没有任何地方把它切回去**。于是哨兵关掉、cpal 输入流也确实停了之后，
/// iPadOS 状态栏的麦克风指示**仍然亮着**——系统看的是会话的类别，
/// 不是我们有没有在读采样。
///
/// 这比"少熄一盏灯"严重：`MicIndicator` 的纪律是"显示没在听、实际在听"
/// 比没有指示灯更糟，而这里是它的镜像——**我们说关了，系统说还在用**。
/// 车主没有办法判断哪一边是真的，而这正是隐私承诺要回答的那个问题。
///
/// # 为什么是换类别，不是 `setActive(false)`
///
/// 停用整个会话会把**播报也一起停掉**（rodio 的输出流走同一个会话）。
/// 关掉语音唤醒不该顺带让暖暖哑掉。`playback` 只去掉输入这一半：
/// 指示随之熄灭，播报照常。下一次 [`ensure_recording_session`] 会把它切回来。
///
/// # 为什么"此刻没有采集在进行"不能交给调用方保证（2026-09-02 iPad 真机）
///
/// 原来这里写的是"调用方需自己保证"，而唯一的调用方——哨兵循环——**恰恰是
/// 看不见 PTT 的那个人**：它只知道自己那条流 `active.is_none()`，
/// 长按说话用的是另一条流。于是语音唤醒关着（默认关）时，哨兵每 50ms 一拍
/// 都在归还档位，长按刚把类别切到 `playAndRecord`，60ms 内就被切回
/// `playback`——输入这一半被系统拿走，cpal 不报错、录到的全是零，
/// 被 `is_silent_capture` 拦在上传之前，**端上表现为"长按说话没有任何反应"**。
///
/// 真机证据（`idevicesyslog`，iPad Pro 12.9 / iPadOS 26.5.2）：21.9 秒里
/// `AudioSessionServer` 记录本 App 的 `AudioCategory` 被设成 `MediaPlayback`
/// **370 次**，间隔 ~60ms。桌面看不见这条：非 iOS 分支是 no-op。
///
/// 所以判据收回本模块：**只要还有采集持着 [`RecordingSession`] 就不还**。
/// 调用方不需要知道有几条采集，也就不可能漏掉别人那条。
///
/// # 返回值
///
/// `Ok(true)` 真的还了；`Ok(false)` 这次不用还（有采集在进行，或档位本来就还着）。
/// 调用方拿到 `false` 应当**留着"待归还"的意愿**，等采集结束后的某一拍再还——
/// 直接清掉的话，长按一次之后麦克风指示就再也熄不掉了。
///
/// 幂等：已经是 `playback` 时直接短路，不发第二次 `setCategory`。
pub fn release_recording_session() -> Result<bool, String> {
    // 有人在录：这一半麦克风此刻归 PTT / 哨兵，抢回来就是"手指还按着、只录到零"。
    if ACTIVE_CAPTURES.load(Ordering::Acquire) > 0 {
        return Ok(false);
    }
    // 已经是只播不录：再发一次 setCategory 没有任何效果，只有 370 次那样的噪声。
    if !SESSION_RECORDING.load(Ordering::Acquire) {
        return Ok(false);
    }
    imp::release_recording_session()?;
    SESSION_RECORDING.store(false, Ordering::Release);
    Ok(true)
}

/// 此刻是不是录音档位（测试与排障用）。
pub fn is_recording_session() -> bool {
    SESSION_RECORDING.load(Ordering::Acquire)
}

/// 系统报告的音频往返延迟读数（施工单 M47-05）。**只读，不改任何配置。**
///
/// # 它是给 AEC 调参用的起点，不是最终答案
///
/// `AecProcessor::set_stream_delay_ms` 要的是"播出去"到"采回来"的延迟。
/// 系统这三个读数只覆盖其中的硬件与驱动那一段——**不含 rodio 的解码缓冲、
/// 我们自己的队列、以及重采样引入的延迟**，所以它是扫描的起点而不是终点。
///
/// 有它比盲扫省一半时间：iOS 的 IO buffer duration 由 `AVAudioSession` 决定，
/// 与桌面不是一个量级（ACR-010 已写明两平台的值不共用），
/// 不读一次就只能从 20/40/60/100ms 一档档试。
#[derive(Debug, Clone, Copy, Default)]
pub struct AudioLatency {
    /// 输出延迟（毫秒）。
    pub output_ms: f64,
    /// 输入延迟（毫秒）。
    pub input_ms: f64,
    /// 单个 IO 缓冲的时长（毫秒）。
    pub io_buffer_ms: f64,
}

impl AudioLatency {
    /// 往返延迟的粗估：输出 + 输入 + 一个缓冲。作为 `set_stream_delay_ms` 的扫描起点。
    pub fn round_trip_ms(&self) -> f64 {
        self.output_ms + self.input_ms + self.io_buffer_ms
    }
}

/// 读系统音频延迟。非 iOS 平台返回 `None`（没有 `AVAudioSession` 这一层）。
pub fn audio_latency() -> Option<AudioLatency> {
    imp::audio_latency()
}

#[cfg(target_os = "ios")]
mod imp {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};

    /*
     * 类别常量取**框架里的符号**而不是写字面量。
     *
     * `permission.rs` 那边用字面量是因为 `AVMediaTypeAudio` 的值是 FourCC `"soun"`，
     * 和符号名对不上、写死反而清楚。这里相反：类别常量的值就是符号名本身，
     * 但一旦某天 Apple 改了值，字面量会**静默失配**（setCategory 返回 NO，
     * 我们只能拿到一个没有细节的失败）。取符号则是链接期就能发现问题。
     */
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVAudioSessionCategoryPlayAndRecord: *const AnyObject;
        /// 只播不录。哨兵关掉后切到它，系统的麦克风指示才会熄灭（M60-02）。
        static AVAudioSessionCategoryPlayback: *const AnyObject;
    }

    /// `AVAudioSessionCategoryOptionDefaultToSpeaker` = 1<<3；
    /// `AVAudioSessionCategoryOptionAllowBluetooth` = 1<<2。
    ///
    /// 两个都要：不加 `DefaultToSpeaker` 时 `playAndRecord` 会把播报送到听筒
    /// （iPad 上等于"几乎听不见"），而车里演示恰恰要外放。
    const OPT_DEFAULT_TO_SPEAKER: usize = 1 << 3;
    const OPT_ALLOW_BLUETOOTH: usize = 1 << 2;

    /*
     * 首选采样率与输入声道数——**这两项不是调优，是让 cpal 能起来的前提**。
     *
     * cpal 0.16 的 iOS 后端有一处不对称（`src/host/coreaudio/ios/mod.rs`）：
     * `default_input_asbd()` 从 `(Scope::Input, Element::Input)` 读格式——那是
     * **硬件侧**的 ASBD；`build_input_stream_raw()` 却把它原样写到
     * `(Scope::Output, Element::Input)`——那是**客户端侧**。iPad 内建麦克风报出来的
     * 硬件格式拿去当客户端格式，`set_property` 不报错，**单元一 start 就失败**：
     *
     *     audiomxd  AQME Default-InputOutput: client stopping after failed start
     *
     * （2026-08-30 真机日志原文。cpal 源码里那句 TODO 自己也承认了这一点：
     * "some values like sample rate and buffer size probably need to actually be set"。）
     *
     * 改 cpal 要换依赖、得走变更单；在会话这一侧把硬件格式**定成单声道 48k**，
     * 读出来的 ASBD 就是客户端也能用的那一种，绕过了这处不对称。
     */
    const PREFERRED_SAMPLE_RATE: f64 = 48_000.0;
    const PREFERRED_INPUT_CHANNELS: isize = 1;

    pub fn ensure_recording_session() -> Result<(), String> {
        unsafe {
            let cls = AnyClass::get(c"AVAudioSession").ok_or("AVAudioSession 类不可用")?;
            let session: *mut AnyObject = msg_send![cls, sharedInstance];
            if session.is_null() {
                return Err("AVAudioSession sharedInstance 为空".into());
            }

            let category = AVAudioSessionCategoryPlayAndRecord;
            let null_err = core::ptr::null_mut::<*mut AnyObject>();
            let set: Bool = msg_send![
                session,
                setCategory: category,
                withOptions: OPT_DEFAULT_TO_SPEAKER | OPT_ALLOW_BLUETOOTH,
                error: null_err,
            ];
            if !set.as_bool() {
                return Err("setCategory(playAndRecord) 失败".into());
            }

            // 采样率要在激活**之前**提，激活时才会按它去配硬件。
            let _: Bool =
                msg_send![session, setPreferredSampleRate: PREFERRED_SAMPLE_RATE, error: null_err];

            let active: Bool = msg_send![session, setActive: true, error: null_err];
            if !active.as_bool() {
                return Err("setActive(true) 失败".into());
            }

            /*
             * 声道数只能在**激活之后**提（Apple 文档：要有可用输入才谈得上几个声道）。
             *
             * 这两项都**尽力而为、不因失败中止采集**：它们是 preferred 不是 required，
             * 系统在别的应用占着输入时有权拒绝。为了一个没被采纳的偏好就拒绝录音，
             * 比按系统给的格式录下去糟得多——真正兜底的是采集侧的空样本判定。
             */
            let _: Bool = msg_send![
                session,
                setPreferredInputNumberOfChannels: PREFERRED_INPUT_CHANNELS,
                error: null_err,
            ];
        }
        Ok(())
    }

    pub fn release_recording_session() -> Result<(), String> {
        unsafe {
            let cls = AnyClass::get(c"AVAudioSession").ok_or("AVAudioSession 类不可用")?;
            let session: *mut AnyObject = msg_send![cls, sharedInstance];
            if session.is_null() {
                return Err("AVAudioSession sharedInstance 为空".into());
            }
            /*
             * 只换类别，**不动激活状态**（理由见公共函数的文档）。
             * options 传 0：`DefaultToSpeaker` 是 `playAndRecord` 专有的选项，
             * 带到 `playback` 上会让 setCategory 直接失败，
             * 而失败的表现就是"指示还亮着"——与没改之前一模一样，查不出来。
             */
            let category = AVAudioSessionCategoryPlayback;
            let null_err = core::ptr::null_mut::<*mut AnyObject>();
            let set: Bool = msg_send![
                session,
                setCategory: category,
                withOptions: 0usize,
                error: null_err,
            ];
            if !set.as_bool() {
                return Err("setCategory(playback) 失败".into());
            }
        }
        Ok(())
    }

    /// 读 `AVAudioSession` 的三个延迟属性（秒 → 毫秒）。**只读，不设任何东西。**
    ///
    /// 会话未激活时这些读数没有意义（系统还没决定路由），所以调用方应在
    /// `ensure_recording_session()` 之后再取。
    pub fn audio_latency() -> Option<super::AudioLatency> {
        unsafe {
            let cls = AnyClass::get(c"AVAudioSession")?;
            let session: *mut AnyObject = msg_send![cls, sharedInstance];
            if session.is_null() {
                return None;
            }
            let output: f64 = msg_send![session, outputLatency];
            let input: f64 = msg_send![session, inputLatency];
            let io_buffer: f64 = msg_send![session, IOBufferDuration];
            Some(super::AudioLatency {
                output_ms: output * 1000.0,
                input_ms: input * 1000.0,
                io_buffer_ms: io_buffer * 1000.0,
            })
        }
    }
}

#[cfg(not(target_os = "ios"))]
mod imp {
    /// macOS / Linux / Windows 没有 `AVAudioSession` 这一层——
    /// 输入设备由系统直接给，不需要先"申请一个能录音的档位"。
    pub fn ensure_recording_session() -> Result<(), String> {
        Ok(())
    }

    /// 同上：没有会话这一层，也就没有"归还录音档位"这件事——
    /// 桌面上停掉输入流，系统的麦克风指示自己就灭了。
    pub fn release_recording_session() -> Result<(), String> {
        Ok(())
    }

    /// 同上：没有 `AVAudioSession` 就没有这三个读数。
    ///
    /// macOS 上等价信息要走 CoreAudio 的 `kAudioDevicePropertyLatency` 等属性，
    /// 是另一套 API。M47-03 的桌面调参用逐档扫描即可（桌面装机成本低，
    /// 不像 iPad 每轮都要重装），所以这里不为它单开一条实现。
    pub fn audio_latency() -> Option<super::AudioLatency> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 四条断言写在**同一个** `#[test]` 里，不拆成四条。
    ///
    /// `ACTIVE_CAPTURES` / `SESSION_RECORDING` 是进程级静态，而 cargo 默认多线程
    /// 并行跑用例——拆开就是四条用例互相踩对方的计数器，表现为偶发红。
    /// 本仓已经为这一类栽过两次（TD-05、TD-13），不再重复。
    #[test]
    fn 有采集在进行时归还不了档位_采集结束后才还_且不重复还() {
        // 起点：桌面上 imp 是 no-op，但计数与状态位是跨平台的真实逻辑。
        assert!(!is_recording_session(), "起点应当是只播不录");

        // 一条采集（比如长按说话）拿到档位。
        let ptt = ensure_recording_session().expect("非 iOS 是 no-op，必然成功");
        assert!(is_recording_session());
        assert_eq!(
            release_recording_session(),
            Ok(false),
            "长按正在录音时归还 = 把输入这一半抢走，cpal 不报错、录到的全是零（2026-09-02 iPad 真机）",
        );
        assert!(is_recording_session(), "没还成就不该改状态位");

        // 两条采集并存（哨兵 + 长按）：先结束的那条也不能把档位还掉。
        let sentinel = ensure_recording_session().expect("no-op");
        drop(ptt);
        assert_eq!(release_recording_session(), Ok(false), "还有一条采集在进行");

        // 全部结束 → 这一次真的还。
        drop(sentinel);
        assert_eq!(release_recording_session(), Ok(true));
        assert!(!is_recording_session());

        // 已经还过就短路，不发第二次 setCategory——真机上那 370 次就是这么来的。
        assert_eq!(release_recording_session(), Ok(false));
    }
}
