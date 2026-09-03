//! tts — 语音播报（施工单 M2-05，F-02-06，§2.2 C6）。
//!
//! 【引擎拍板（2026-08 实测切换）】**豆包 seed-tts-2.0**（云端合成，
//! 客户端在 `carlife-net::tts`）+ 端上播放。合成失败时降级到系统 `say`
//! （macOS），保证播报链路不因网络中断而完全失效（FL-05 离线兜底方向）。
//!
//! 与架构 §2.2 C6"本地播报"的差异：C6 的动机是离线可用与低延迟，
//! 车机目标平台（§13-2）未定案前，云端合成的中文自然度显著更好；
//! 本地引擎作为降级路径保留，平台定案后按 C6 补齐。已回填架构文档。
//!
//! 【speaking 对齐（M2-05 约束 2）】`speaking` 由**播放起止**驱动，
//! 不由 token 流驱动；代际计数守卫防止旧播放的结束事件覆盖新状态。
//!
//! 引擎由网关下发（后台 TTS_ENGINE 热切，ACR-017 起唯一开关）；出不出声归
//! 端上播报开关（M3-07，设置页）。音色 `BYTEDANCE_TTS_SPEAKER`（豆包档）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use carlife_core::contract::AssistantState;
use carlife_core::fanout::EVENT_ASSISTANT_STATE;
use carlife_net::TtsClient;
use tauri::{AppHandle, Emitter};

/// 让路：播报期间压低车内音乐（M27）。
///
/// **本模块里所有 `TTS_PLAYING` 的写入都走它的 `set_tts_playing`**，
/// 不再直接 `store` —— 置位与让路必须同边沿，分两处写迟早对不齐，
/// 而对不齐的表现是音乐一直压着没恢复，且不报任何错。
pub mod ducking;

/// 合成端点的端上缓存（后台 TTS 引擎开关的端上一侧）。
pub mod endpoint;

/// 一次在播的播报（ACR-004 第 2 步）。
///
/// # 为什么是枚举而不是把 `Child` 换成 `Sink` 了事
///
/// 播放走 rodio（mp3 字节直接进声卡，macOS/iOS 同一条路径——iOS 沙盒
/// 禁止 spawn 子进程，afplay 那条路在 iPad 上物理不存在）；但 macOS 的
/// `say` 降级**仍然是子进程**——它是"没有云端密钥也能出声"的兜底，
/// 不值得为它养一套本地合成。两种句柄的生命周期语义不同，枚举各管各的。
///
/// 状态机（代际守卫、replace 必杀旧者、轮询收尾）一行不动：
/// 本枚举只是把「kill / 是否播完」两个动作从 `Child` 上抽象出来。
enum Playback {
    /// rodio 输出。`_device` 必须一起存着——drop 掉设备槽，声音立刻断。
    Sink {
        player: rodio::Player,
        _device: rodio::MixerDeviceSink,
    },
    /// macOS `say` 子进程（降级路径）。
    #[cfg(target_os = "macos")]
    Proc(std::process::Child),
}

impl Playback {
    /// 立刻停止并回收。对子进程是 kill+wait（drop 一个 `Child` **不会**杀进程，
    /// 那正是"杀不掉的孤儿播放进程"的来路）；对 rodio 是 `stop`。
    fn halt(&mut self) {
        match self {
            Playback::Sink { player, .. } => player.stop(),
            #[cfg(target_os = "macos")]
            Playback::Proc(child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    /// 是否已自然播完。rodio 播完即队列空；子进程看退出状态。
    /// 判定失败（try_wait 出错）按"已结束"处理——与旧实现同一取向：
    /// 卡在"永远在播"会吞掉后面所有播报，比提前收尾糟。
    fn is_finished(&mut self) -> bool {
        match self {
            Playback::Sink { player, .. } => player.empty(),
            #[cfg(target_os = "macos")]
            Playback::Proc(child) => !matches!(child.try_wait(), Ok(None)),
        }
    }
}

#[derive(Default)]
pub struct TtsState {
    current: Mutex<Option<Playback>>,
    generation: AtomicU64,
    /// 用户侧播报总开关（施工单 M3-07 承接 M2-06 F-02-12）。
    ///
    /// 这是**用户偏好**不是运维配置——所以持久化在端上，
    /// 不进 M3-02 的配置注册表（那里只放 A/B 类运维项）。
    /// "夜间克制/别跟我说话"这类**情境化**偏好依赖 Mem0 ③（FL-21 未动工），
    /// 本 Sprint 只做全局开关。
    muted: AtomicBool,
    prefs_path: Mutex<Option<PathBuf>>,
    /// 当前播的是不是垫场话（施工单 M18-05，F-45-07）。
    ///
    /// `current` 只知道"有个子进程在播"，不知道播的是什么。没有这个标志就只能
    /// "收到 delta 就无条件 stop"——那会误杀**正文自己的播报**。
    speaking_filler: AtomicBool,
    /**
     * 已经有一句垫场在等前一句播完（M18-09 走查第六轮）。
     *
     * 没有它的话，服务端连发三句时会有三个协程同时挂在 `await_filler_end` 上，
     * 前一句一结束就三个一起抢——现象仍然是互相掐断，只是换了个地方发生。
     */
    filler_pending: AtomicBool,
    /// 垫场话开关。与 `muted` 分开：用户可能要正文播报但不要垫场。
    filler_muted: AtomicBool,
    filler_prefs_path: Mutex<Option<PathBuf>>,
    /// 垫场话的收尾方式（施工单 M18-06）。`false` = 衔接（默认），`true` = 抢占。
    ///
    /// 存成 bool 而不是枚举是因为 `AtomicBool` 够用且默认值天然正确
    /// （`Default` 给 false = `AfterSentence`）；对外仍以 `FillerPreemptMode` 表达。
    preempt_immediate: AtomicBool,
    preempt_prefs_path: Mutex<Option<PathBuf>>,
    /**
     * 一段**正文**从进入等待到播完的整个生命周期（iPad 走查修复）。
     *
     * # 它挡的是"垫场把正文顶掉"的竞态
     *
     * 衔接模式下正文等垫场①说完；此时垫场②已在排队——**两个协程挂在同一个
     * `await_filler_end` 上**。垫场①一结束两者同时醒来，各自 `stop()` 再各自
     * 起播，谁后 `replace` 谁赢：垫场②赢了就把刚起播的正文当场顶掉，
     * 而正文没有重试，这一轮就再也听不到它。
     *
     * 从前从没暴露，是因为回复到得慢：turn_end 落地时垫场早就播完了，
     * 正文根本不用等（wait=false）。回复一快（M30 提交即收工），turn_end
     * 正落在垫场①还在播、垫场②已排队的窗口里，竞态每次都被踩中——
     * 症状就是"一直在放旁路的语音，正文永远不响"。
     *
     * 本标志在位期间：新垫场一律 Drop、排队中的垫场醒来后自行退出。
     * **在位要覆盖正文的整个播放期**，不能在起播时就清——否则排队垫场
     * 晚醒一微秒就又钻回那条缝。
     */
    body_active: AtomicBool,
    /// 当前这句垫场话的**内容属性**（契约 `UpdateFiller.interruptible`）。
    /// 与 `preempt_mode` 是两码事，见 `should_preempt` 的说明。
    ///
    /// 初值是 `false`（`AtomicBool` 的 `Default`），但**这个值永远不会被用到**：
    /// 抢占判定里它与 `stop_if_filler` 串联，而后者要求 `speaking_filler` 为真——
    /// 也就是说必然有一句垫场正在播，而 `speak_filler` 在播之前就写过这个字段了。
    filler_interruptible: AtomicBool,
    /**
     * 此刻正在播的那句话的原文（施工单 M33-03）。
     *
     * 播报期哨兵不再整段丢帧之后（AC-45-6 的前提），麦克风采到的大部分是
     * 暖暖自己的声音。`voice::echo::is_echo` 靠这句原文把回采挡下来——
     * **我们手上有"她正在说什么"，这是做回采判定最便宜的条件**，
     * 比声学回声消除省一整条音频链路。
     *
     * 起播时写、`stop()` 与自然结束时清。垫场与正文都写：它们同样从扬声器出来。
     */
    speaking_text: Mutex<Option<String>>,
    /**
     * 刚播完的那句原文 + 播完时刻（走查 2026-08-29 ④）。
     *
     * 回采段**必然在播报结束后才判定**：VAD 要 750ms 静音才收段，再加一趟
     * ASR——那时 `speaking_text` 已被清空，`is_echo(text, None)` 一律放行，
     * 播报每句话的尾巴于是都成了"用户说的话"。这一档就是给迟到的比对用的：
     * 段与播报重叠（哨兵按时间重叠判，见 sentinel_loop）但转写晚到时，
     * 拿它当原文。只在窄通道消费，正常路径永远不拿旧话比对新语音。
     */
    last_spoken: Mutex<Option<(String, std::time::Instant)>>,
}

/// 垫场话被正文接管的方式（施工单 M18-06）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillerPreemptMode {
    /// 正文首字到达即掐断，允许句中（M18-05 的行为）。
    Immediate,
    /// 垫场话自然说完，正文接在它后面。**默认**——
    /// 一句话说到一半没了，比没说过更像出故障。
    AfterSentence,
}

impl Default for FillerPreemptMode {
    fn default() -> Self {
        Self::AfterSentence
    }
}

/// 该不该掐断。**纯函数**，两个条件都要成立。
///
/// `interruptible` 是**内容属性**（这句话本身能不能被打断），
/// `mode` 是**用户偏好**。将来出现告警类垫场（"前方急弯"）时
/// `interruptible` 会是 `false`，那与用户选了哪种模式无关——
/// 所以两者是独立的两个开关，不是一个。
pub fn should_preempt(mode: FillerPreemptMode, interruptible: bool) -> bool {
    matches!(mode, FillerPreemptMode::Immediate) && interruptible
}

/// 一句新垫场该怎么处置（M18-09 走查第六轮）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillerSlot {
    /// 没人在播，直接播。
    Play,
    /// 正在播上一句垫场——**等它播完**，不是把它掐掉。
    Queue,
    /// 已经有一句在等了，丢掉这一句。
    Drop,
}

/// 判定放在纯函数里（照 `should_preempt` 的先例），这样它可以被逐条断言——
/// `speak_filler` 要 `AppHandle`，在单测里造不出来。
///
/// # 为什么 `Queue` 而不是原来的"顶掉"
///
/// 原实现无条件 `stop()`，注释写的理由是"两者都是垫场，没有等自己说完的道理"。
/// 那条理由在服务端间隔还是 4000ms 时成立：`speakingUntil` 是**按字数估算**的，
/// 4 秒余量兜得住估算误差。走查把间隔定到 500ms 之后余量没了，
/// **估算短一点就是一刀**，用户听到的是自己被自己截断的半句。
///
/// 服务端的估算只能是估算（它拿不到播完回执，也不该为此加一条上行通道），
/// **端上才知道真相**。
///
/// # 为什么第三句是 `Drop` 而不是继续排
///
/// 排队叠起来的话，前一句一结束几个协程会一起抢，现象仍是互相掐断，
/// 只是换了个地方发生。丢掉是安全的——服务端下一拍还会再产一句。
pub fn filler_slot(speaking_filler: bool, filler_pending: bool, body_active: bool) -> FillerSlot {
    // 正文在场（等垫场让位，或正在播）：垫场一律丢弃。它是配角——
    // 排进队里就会在正文起播的窗口边缘跟它抢 stop/replace，赢了就把正文顶掉。
    if body_active {
        return FillerSlot::Drop;
    }
    match (speaking_filler, filler_pending) {
        (false, _) => FillerSlot::Play,
        (true, false) => FillerSlot::Queue,
        (true, true) => FillerSlot::Drop,
    }
}

/// 正文等垫场自然结束的上限（施工单 M18-06 约束 2，M18-09 放宽到 12 秒）。
///
/// 没有上限就是**正文永远播不出来**：垫场的播放进程若因合成失败、`afplay` 卡住
/// 等原因不结束，用户会以为助手死了——那比句中截断严重得多。
/// 所以它是**故障兜底**，不是"最多让垫场说这么久"的策略闸。
///
/// 3 秒是 M18-06 按当时每句 9 个字（约 2 秒）取的。M18-09 之后第 1 句带上
/// 进度前缀有 45~49 字，约 9~10 秒——3 秒的上限会**每次都撞上**，
/// 于是"等垫场讲完再接管"这条约定实际上从不生效，而现象只是句中被截，
/// 与没做这个功能长得一模一样。12 秒 = 最长一句（约 10 秒）留两秒余量。
const FILLER_WAIT_CAP_MS: u64 = 12_000;

impl TtsState {
    /// 绑定持久化路径并载入上次的选择（跨重启保持）。
    pub fn load_prefs(&self, path: PathBuf) {
        let muted = std::fs::read_to_string(&path)
            .map(|c| c.trim() == "muted")
            .unwrap_or(false);
        self.muted.store(muted, Ordering::SeqCst);
        *self.prefs_path.lock().expect("tts prefs poisoned") = Some(path);
    }

    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::SeqCst)
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::SeqCst);
        if let Some(path) = self.prefs_path.lock().expect("tts prefs poisoned").as_ref() {
            if let Err(e) = std::fs::write(path, if muted { "muted" } else { "on" }) {
                eprintln!("[tts] 播报偏好持久化失败: {e}");
            }
        }
    }

    /// 垫场话开关的持久化路径（M18-05）。与播报开关同一形状，分开存。
    pub fn load_filler_prefs(&self, path: PathBuf) {
        let muted = std::fs::read_to_string(&path)
            .map(|c| c.trim() == "muted")
            .unwrap_or(false);
        self.filler_muted.store(muted, Ordering::SeqCst);
        *self.filler_prefs_path.lock().expect("tts prefs poisoned") = Some(path);
    }

    pub fn is_filler_muted(&self) -> bool {
        self.filler_muted.load(Ordering::SeqCst)
    }

    /**
     * 把垫场槽位的三个标志复位（施工单 M33-02）。
     *
     * # 为什么打断必须做这一下
     *
     * `body_active` 的语义是"正文从进入等待到播完的整个生命周期"，
     * 它由 `speak()` 自己置起与清掉。而**打断是在播放中途把播放掐掉的**——
     * `speak()` 的那条协程被 `stop()` 的代际判定挡在原地，
     * 于是这个标志再也没人清。
     *
     * 后果不是"少复位一个 bool"：`filler_slot()` 第一条就是
     * `if body_active { return Drop }`——**打断过一次之后，这个进程里
     * 再也不会有任何一句垫场播出来**，而且全程零报错。
     * `stop()` 清了另外两个标志（M18-09 那次走查补的），偏偏没清这一个。
     * 只有 `sidecarCounters` 的 dropped 计数才看得出来，而那是服务端的数，
     * 端上丢的这一批连那里都不会记。
     *
     * `speaking_filler` 与 `filler_pending` **`stop()` 已经清过**（见它的实现），
     * 这里一并置一次是为了让本函数自成一体：将来有人换了调用顺序、
     * 或者在没有 `stop()` 的路径上复用它，不会又漏掉那两个。
     */
    /// 记下 / 清掉"此刻正在播的那句"（M33-03）。
    /// 清掉时把原文挪进 `last_spoken`（走查 2026-08-29 ④）——迟到的回采比对要用。
    pub fn set_speaking_text(&self, text: Option<&str>) {
        let mut cur = self.speaking_text.lock().expect("tts state poisoned");
        if text.is_none() {
            if let Some(prev) = cur.take() {
                *self.last_spoken.lock().expect("tts state poisoned") =
                    Some((prev, std::time::Instant::now()));
            }
        }
        *cur = text.map(str::to_string);
    }

    /// 正在播的那句；没在播时，`within` 内刚播完的那句也算（走查 2026-08-29 ④）。
    ///
    /// **只给窄通道用**：窄通道里的段都与播报重叠过，拿刚播完的原文比对是
    /// 判回采的正解。正常路径不许调它——拿旧话去比对新语音，挡掉的会是真指令
    /// （M33-03 在 `stop()` 里清 `speaking_text` 防的正是这一手）。
    pub fn recently_spoken(&self, within: std::time::Duration) -> Option<String> {
        if let Some(cur) = self.speaking_text.lock().expect("tts state poisoned").clone() {
            return Some(cur);
        }
        self.last_spoken
            .lock()
            .expect("tts state poisoned")
            .as_ref()
            .filter(|(_, at)| at.elapsed() <= within)
            .map(|(text, _)| text.clone())
    }

    pub fn reset_filler_slots(&self) {
        self.body_active.store(false, Ordering::SeqCst);
        self.speaking_filler.store(false, Ordering::SeqCst);
        self.filler_pending.store(false, Ordering::SeqCst);
        self.set_speaking_text(None);
    }

    pub fn set_filler_muted(&self, muted: bool) {
        self.filler_muted.store(muted, Ordering::SeqCst);
        if let Some(path) = self
            .filler_prefs_path
            .lock()
            .expect("tts prefs poisoned")
            .as_ref()
        {
            if let Err(e) = std::fs::write(path, if muted { "muted" } else { "on" }) {
                eprintln!("[tts] 垫场偏好持久化失败: {e}");
            }
        }
    }

    pub fn filler_interruptible(&self) -> bool {
        self.filler_interruptible.load(Ordering::SeqCst)
    }

    pub fn is_speaking_filler(&self) -> bool {
        self.speaking_filler.load(Ordering::SeqCst)
    }

    pub fn is_filler_pending(&self) -> bool {
        self.filler_pending.load(Ordering::SeqCst)
    }

    /// 收尾方式的持久化（M18-06）。**单独一个文件**，不与 `filler-pref` 合并——
    /// 合并后想单独重置其中一个就没法做。
    pub fn load_preempt_prefs(&self, path: PathBuf) {
        let immediate = std::fs::read_to_string(&path)
            .map(|c| c.trim() == "immediate")
            .unwrap_or(false); // 读不到 / 没这个文件 ⇒ 默认衔接
        self.preempt_immediate.store(immediate, Ordering::SeqCst);
        *self.preempt_prefs_path.lock().expect("tts prefs poisoned") = Some(path);
    }

    pub fn preempt_mode(&self) -> FillerPreemptMode {
        if self.preempt_immediate.load(Ordering::SeqCst) {
            FillerPreemptMode::Immediate
        } else {
            FillerPreemptMode::AfterSentence
        }
    }

    pub fn set_preempt_mode(&self, mode: FillerPreemptMode) {
        let immediate = matches!(mode, FillerPreemptMode::Immediate);
        self.preempt_immediate.store(immediate, Ordering::SeqCst);
        if let Some(path) = self
            .preempt_prefs_path
            .lock()
            .expect("tts prefs poisoned")
            .as_ref()
        {
            if let Err(e) = std::fs::write(path, if immediate { "immediate" } else { "after_sentence" })
            {
                eprintln!("[tts] 垫场收尾偏好持久化失败: {e}");
            }
        }
    }
}

/// 引擎层面是否可用（与用户开关无关）。
///
/// `CARLIFE_TTS=off` 的判断已随 ACR-017 退休——"出不出声"是用户偏好，
/// 归 [`TtsState::set_muted`]（M3-07，端上持久化 + 两端设置页 UI），
/// 本函数从此名副其实地只回答平台能力。
pub fn enabled() -> bool {
    /*
     * ACR-018 之后恒为 true。
     *
     * 原判据是 `TtsClient::from_env().is_some()`——"本机配了豆包密钥"。
     * 端上已经没有任何 vendor 密钥了，云端合成对任何平台都只是一次打网关的
     * HTTP；而 `say` 兜底本来就只有 macOS/iOS 有，那是**降级路径不是准入条件**。
     *
     * 保留这个函数而不是删掉调用点：它回答的问题（"这台设备的引擎层能不能
     * 出声"）仍然成立，只是当前所有平台的答案都是能。真不可用会在合成那一步
     * 失败并如实降级（日志 + idle）——在这里拦等于"网关明明能给端点，
     * 端上却永远静音"，ACR-004 已经为 iOS 踩过一次这个坑。
     */
    true
}

fn emit_state(app: &AppHandle, state: AssistantState) {
    if let Err(e) = app.emit(EVENT_ASSISTANT_STATE, state) {
        eprintln!("[tts] emit state failed: {e}");
    }
}

/// 停止当前播放（若有）。代际+1，使旧播放的监视线程不再发结束状态。
///
/// **返回停完之后的代际**，调用方必须用这个返回值，不要自己再 `load` 一次
/// （施工单 M27-02）。`stop(); load()` 看着等价，但那是两步：
/// A 线程 `stop()` 把代际推到 5，B 线程紧接着推到 6，然后两个线程各自 `load()`
/// **都拿到 6**——于是两次播放都通过了后面的代际守卫，同时出声。
/// 演示现场的表现是"十几个声音重叠着说同一句话"，而日志里一行异常都没有。
pub fn stop(state: &TtsState) -> u64 {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.speaking_filler.store(false, Ordering::SeqCst);
    // 排队标志跟着清：用户长按打断时若留下一个永远为真的 pending，
    // 之后所有垫场都会被"已经有一句在等"这条判据静默丢掉。
    state.filler_pending.store(false, Ordering::SeqCst);
    // 没在播就没有"正在播的那句"（M33-03）。留着的话，播完之后的第一段
    // 用户语音会拿一句早已结束的话去比对——挡掉的正是真正的打断。
    state.set_speaking_text(None);
    if let Some(mut playback) = state.current.lock().expect("tts state poisoned").take() {
        playback.halt();
    }
    // 声音停了，哨兵恢复收音（M25-03）。若紧接着有新播报，它会自己再置回。
    crate::tts::ducking::set_tts_playing(false);
    generation
}

/// **只在播垫场话时**停（施工单 M18-05，F-45-07 / AC-45-3）。
///
/// 返回是否真的停了——`events.rs` 用它做断言，也用它计"被抢占"这个指标。
///
/// # 为什么不能"收到 delta 就无条件 stop"
///
/// 那会误杀**正文自己的播报**。当前实现里正文在 `turn_end` 才播，
/// 看起来不会撞上；但这个假设不该被固化进抢占逻辑里——
/// 一旦哪天正文改成边流边播，无条件 stop 会把正文自己掐断，
/// 而现象是"助手说半句就没声了"，没人会往抢占逻辑上查。
pub fn stop_if_filler(state: &TtsState) -> bool {
    if !state.speaking_filler.load(Ordering::SeqCst) {
        return false;
    }
    let _ = stop(state);
    true
}

/// 播放 mp3 字节（ACR-004 第 2 步）：rodio 从内存直接解码进声卡。
///
/// 换掉的是"写临时文件 → afplay 子进程"那条路：iOS 沙盒禁止 spawn，
/// 而且临时文件带来过一整类事故（M27-02 的同名文件并发互踩、/tmp 清扫）。
/// 内存直解之后这一类问题**结构性消失**——没有文件就没有文件名冲突。
///
/// 输出流每次新开而不是全局共享：流的生命周期就是这一次播报的生命周期，
/// 与 `Playback` 一起被 `halt`/drop 回收，不用管理"全局流该何时关"。
fn start_mp3_playback(audio: Vec<u8>) -> Result<Playback, String> {
    let device = rodio::DeviceSinkBuilder::open_default_sink()
        .map_err(|e| format!("打开音频输出失败: {e}"))?;
    let player = rodio::Player::connect_new(device.mixer());
    let decoder = rodio::Decoder::new(std::io::Cursor::new(audio))
        .map_err(|e| format!("mp3 解码失败: {e}"))?;
    /*
     * AEC 参考信号旁路（M47-02，ACR-010）。
     *
     * 回声消除要知道"扬声器此刻在放什么"，而这份 PCM 只在这里存在——
     * 解码器的输出直接进声卡，中间没有任何天然的挂钩点。`RenderTap`
     * 逐样本透传给 player、顺手抄一份给哨兵线程。
     *
     * **开关关闭时连包都不包**：`append(decoder)` 与 M47 之前逐字节相同，
     * 播放路径上一次多余的函数调用都没有。
     */
    if crate::voice::aec_bridge::enabled() {
        player.append(crate::voice::aec_bridge::RenderTap::new(decoder));
    } else {
        player.append(decoder);
    }
    Ok(Playback::Sink { player, _device: device })
}

/// macOS 降级：系统 `say`。iOS 上**不存在这条路**（沙盒禁止子进程，
///
/// ⚠️ **这条路径拿不到 AEC 参考信号**（M47-02）：音频在 `say` 自己的进程里合成、
/// 直接进声卡，我们手上没有任何 PCM 可以旁路。所以走 `say` 时回声消除天然无效，
/// `voice/echo.rs` 的文本比对是它唯一的防线——这是边界不是缺陷。
/// iPad 不受影响：iOS 没有 `say` 降级，每一次出声都走 rodio，参考信号覆盖率 100%。
///
/// 系统合成走 AVSpeechSynthesizer 而我们决定不为降级养 Swift 桥——ACR-004
/// 方案评估里否决过）；iOS 合成失败的降级是"文字仍在对话里，静默回 idle"。
#[cfg(target_os = "macos")]
fn spawn_say(text: &str) -> std::io::Result<Playback> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("say");
    if let Ok(voice) = std::env::var("CARLIFE_TTS_SAY_VOICE") {
        cmd.arg("-v").arg(voice);
    }
    cmd.arg(text)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(Playback::Proc)
}

/// 把 markdown 记号从播报文本里剥掉。
///
/// 模型的回答带 `**加粗**`、`- 列表` 这类记号——屏幕上渲染没问题，
/// 但 TTS 会把 `**` 逐字读成「星星」。prompt 里"适合语音播报"的要求挡不住它
/// （实测照写），所以在**唯一的播报入口**用代码剥，不赌模型守规矩。
/// 只删记号不动内容：链接保留可读文字，列表符换成顿号停顿。
fn strip_markdown_for_speech(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        // 行首的标题/引用/列表记号
        let trimmed = line.trim_start();
        let body = trimmed
            .trim_start_matches('#')
            .trim_start_matches('>')
            .trim_start_matches(['-', '*', '+'])
            .trim_start();
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(body);
    }
    // 成对/行内记号：**  __  *  _  `  以及 [文字](链接) 只留文字
    let mut s = out.replace("**", "").replace("__", "").replace('`', "");
    s = s.replace(['*', '_'], "");
    // [text](url) → text：手写小状态机，不引正则依赖
    let mut cleaned = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(open) = rest.find('[') {
        if let Some(close) = rest[open..].find("](") {
            if let Some(end) = rest[open + close + 2..].find(')') {
                cleaned.push_str(&rest[..open]);
                cleaned.push_str(&rest[open + 1..open + close]);
                rest = &rest[open + close + 2 + end + 1..];
                continue;
            }
        }
        break;
    }
    cleaned.push_str(rest);
    cleaned
}

/// 播报一段文本：合成（豆包）→ 播放；失败降级系统 `say`。
/// 网络合成在后台线程完成，不阻塞事件处理。
/// 播报一段正文。既有行为一行未改，只是把实现挪进 `play`。
pub fn speak(app: &AppHandle, state: &Arc<TtsState>, text: &str) {
    if state.is_muted() {
        return;
    }
    /*
     * 衔接模式（M18-06）：正文要等还在说的垫场话说完。
     *
     * 光把 `events.rs` 的 `stop_if_filler` 关掉是不够的——`play` 的第一件事
     * 就是 `stop()`，`turn_end` 那一下照样会把垫场掐掉。所以这里显式判一次。
     */
    let wait = matches!(state.preempt_mode(), FillerPreemptMode::AfterSentence)
        && state.is_speaking_filler();
    // 正文登场即挂牌（见 body_active 的说明）；生命周期各出口由 play 收。
    state.body_active.store(true, Ordering::SeqCst);
    play(app, state, text, false, wait);
}

/// 播报一句垫场话（施工单 M18-05，F-45-07）。
///
/// 与 `speak` 的两处差别，都刻意：
///  1. 受 `filler_muted` 单独控制——用户可能要正文播报但不要垫场；
///  2. **全程不发 `AssistantState`**。`thinking` 与 `speaking` 同时成立的状态
///     在 §2.3 的状态机里没有定义（架构 §13-16 未决），垫场期保持 `thinking`，
///     不在这里擅自造一个新态。
pub fn speak_filler(app: &AppHandle, state: &Arc<TtsState>, text: &str, interruptible: bool) {
    if state.is_muted() || state.is_filler_muted() {
        return;
    }
    // 记下这一句的**内容属性**，供抢占判定用（M18-06 约束 1）。
    state.filler_interruptible.store(interruptible, Ordering::SeqCst);

    // 播 / 排队 / 丢弃三选一，判据与理由见 `filler_slot`。
    // 排队走的是 M18-06 为"正文等垫场"造的同一套 `await_filler_end`。
    let wait = match filler_slot(
        state.is_speaking_filler(),
        state.is_filler_pending(),
        state.body_active.load(Ordering::SeqCst),
    ) {
        FillerSlot::Drop => return,
        FillerSlot::Queue => {
            state.filler_pending.store(true, Ordering::SeqCst);
            true
        }
        FillerSlot::Play => false,
    };
    play(app, state, text, true, wait);
}

/// 等当前垫场话自然结束。返回 `true` = 它自己结束的；`false` = 撞上限了。
///
/// 轮询间隔与既有播放轮询一致（120ms），不另立一个节奏。
async fn await_filler_end(state: &Arc<TtsState>, cap_ms: u64) -> bool {
    let mut waited = 0u64;
    while state.is_speaking_filler() {
        if waited >= cap_ms {
            eprintln!("[tts] 垫场话超过 {cap_ms}ms 未结束，强制让位给正文");
            return false;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
        waited += 120;
    }
    true
}

/// 合成 → 播放 → 收尾的公共实现。
///
/// 提出来是因为 markdown 剥离与降级路径必须**两条入口同源**——
/// 本文件原注释已经写过这条教训：只在一条上剥的话，降级到 say 的那天
/// 那些记号会悄悄回来。
fn play(app: &AppHandle, state: &Arc<TtsState>, text: &str, is_filler: bool, wait_for_filler: bool) {
    // 记号在这里剥，**两条路径（豆包/say）都吃干净的文本**。
    let text = strip_markdown_for_speech(text);
    let text = text.as_str();
    // 引擎不可用或空文本直接不播。`muted` 已由两个入口各自判过。
    if !enabled() || text.trim().is_empty() {
        // ⚠️ 这条提前 return 必须把排队标志清掉。留成 true 的话，
        // 之后**所有**垫场都会被"已经有一句在等"静默丢弃——
        // 现象是旁路从此彻底哑掉，而日志里一行异常都没有。
        if wait_for_filler {
            state.filler_pending.store(false, Ordering::SeqCst);
        }
        // 正文没播成也要摘牌：挂着不摘，之后所有垫场都被 Drop，旁路彻底哑掉。
        if !is_filler {
            state.body_active.store(false, Ordering::SeqCst);
        }
        return;
    }
    /*
     * 衔接模式（M18-06）下**不在这里 stop**——那正是要避免的那一刀。
     * 改到 spawn 内、合成完成之后再停：合成本来就要 1 秒上下，
     * 多数情况下等待时间是 0。
     */
    // **代际必须取自 `stop()` 的返回值**（M27-02）。原来是 `stop(); load()` 两步，
    // 而 `handle_envelope` 是每条 SSE 流各自的任务在调——多条流同时进来时，
    // A 把代际推到 5、B 推到 6，两个再各自 `load()` 都拿到 6，于是双双通过
    // 下面的守卫、双双起播。现象就是十几个声音重叠着说同一句话。
    let generation = if !wait_for_filler {
        let g = stop(state);
        state.speaking_filler.store(is_filler, Ordering::SeqCst);
        g
    } else {
        state.generation.load(Ordering::SeqCst)
    };

    let app = app.clone();
    let state = Arc::clone(state);
    let text = text.to_string();

    tauri::async_runtime::spawn(async move {
        // CARLIFE_TTS=say 的发 HTTP 前短路已随 ACR-017 退休：它让后台引擎开关
        // 对这台端整个失效（2026-09-01 实际踩到），而"本机免费"由 mock 档承担。
        let audio = {
            // 端点以**服务端下发的为准**（后台可热切 mock ↔ 豆包 ↔ aliyun）。
            let runtime_cfg = endpoint::effective().await;
            /*
             * 客户端构造（ACR-018 之后只剩一句）。
             *
             * 三档都打网关下发的那一个 URL，都带同一个凭证——设备 JWT。
             * 端上没有任何 vendor 密钥，所以也没有了"计费档没密钥就拒绝构造"
             * 那条分支：密钥缺不缺是服务端的事，缺了它回一个 NDJSON 错误行，
             * 端上照旧沿既有路径降级 say，且 message 里说得清是缺哪一把。
             *
             * 未登录时 token 是空串：请求会被网关 401 → 降级 say。
             * 这里不塞占位值蒙混——那会把"没登录"伪装成"合成失败"。
             */
            let client = match &runtime_cfg {
                Some(cfg) => {
                    let (_base, token) = crate::settings::gateway();
                    Some(TtsClient::for_runtime(cfg, token))
                }
                /*
                 * 网关问不到：直接走 say（audio=None 的既有降级路径）。
                 *
                 * ACR-017 删掉了"退回本地环境变量端点"的兜底——它拿的默认端点是
                 * **豆包**，一次网关抖动就把这台端接上计费引擎，且一声不响。
                 * ACR-018 把那个默认端点本身也删了，端上再没有可回落的地址：
                 * 问不到就是问不到。降级的方向永远是更省的那个：say 免费、
                 * 恒可用（macOS）。
                 */
                None => {
                    eprintln!("[tts] 网关问不到合成端点，本次降级 say（端上没有可回落的端点）");
                    None
                }
            };
            match client {
                Some(client) => {
                    match client.synthesize(&text).await {
                    Ok(bytes) => {
                        // **每次计费合成都要留痕**（M27-03）。2026-08-26 的重复播报事故里，
                        // 成功路径零日志——一上午烧掉几十万字当量，事后只能拿消息表反推个
                        // 下界，准确数字只有供应商控制台有。一行字数日志就是本地对账单：
                        // grep '\[tts\] 合成' 再把字数加起来，就是这台机器欠供应商的量。
                        // 引擎名跟着字数一起打：这行日志是**本地对账单**，
                        // 而"这些字算不算钱"取决于当时连的是哪一档。
                        // 只记字数不记引擎，事后对账要靠猜。
                        eprintln!(
                            "[tts] 合成 {} 字（{}，{}），{} bytes",
                            text.chars().count(),
                            if is_filler { "垫场" } else { "正文" },
                            match &runtime_cfg {
                                Some(c) if c.billed => format!("{} **计费**", c.engine),
                                Some(c) => c.engine.clone(),
                                None => "本地配置".to_string(),
                            },
                            bytes.len()
                        );
                        Some(bytes)
                    }
                    Err(e) => {
                        eprintln!("[tts] 合成失败，降级 say: {e}");
                        None
                    }
                    }
                }
                None => None,
            }
        };

        // 合成期间若已被打断（用户长按说话），放弃本次播放。
        if state.generation.load(Ordering::SeqCst) != generation {
            if !is_filler {
                state.body_active.store(false, Ordering::SeqCst);
            }
            return;
        }

        /*
         * 衔接模式：等垫场自然说完，然后才轮到自己（M18-06 约束 2、3）。
         *
         * ⚠️ 等完必须**重取 `generation`**：下面的 `stop()` 会让它 +1，
         * 仍拿旧值往下比对等于自己把自己判成"已被打断"，
         * 现象是"选了衔接模式就没有正文"——而没人会往代际守卫上查。
         */
        let generation = if wait_for_filler {
            await_filler_end(&state, FILLER_WAIT_CAP_MS).await;
            /*
             * **排队垫场醒来后先看正文在不在**（iPad 走查修复，见 body_active）。
             *
             * 正文与排队垫场挂在同一个 await 上、同时醒来。不让位的话，
             * 两者各自 stop/replace，垫场后手就把刚起播的正文顶掉——
             * 正文没有重试，这一轮从此无声。让位是零代价的：
             * 垫场本来就是"回复没来时的填充"，回复都到了，它没有存在理由。
             */
            if is_filler && state.body_active.load(Ordering::SeqCst) {
                state.filler_pending.store(false, Ordering::SeqCst);
                return;
            }
            // 等完了，位置腾给自己：清掉"有一句在等"的标志再往下走，
            // 否则这一句播起来之后新来的垫场会被永久丢弃。
            state.filler_pending.store(false, Ordering::SeqCst);
            let g = stop(&state);
            state.speaking_filler.store(is_filler, Ordering::SeqCst);
            g
        } else {
            generation
        };

        let playback = match audio {
            Some(bytes) => start_mp3_playback(bytes),
            None => {
                // **say 路径此前一行日志都没有**，而云端路径有上面那条「合成 N 字」。
                // 这个不对称的代价在 2026-08-27 兑现：`CARLIFE_TTS=say` 时
                // "暖暖不出声"与"根本没走到播报"在日志上长得一模一样，
                // 只能靠临时插桩才分得开——查了半小时，全在排除本可以一眼看到的东西。
                #[cfg(target_os = "macos")]
                {
                    eprintln!(
                        "[tts] say 播报 {} 字（{}）",
                        text.chars().count(),
                        if is_filler { "垫场" } else { "正文" }
                    );
                    spawn_say(&text).map_err(|e| format!("say 启动失败: {e}"))
                }
                #[cfg(not(target_os = "macos"))]
                {
                    // iOS 没有 say（ACR-004）：文字仍在对话里，这里如实说没出声。
                    Err("本平台无本地合成降级（云端合成不可用），本次不出声".to_string())
                }
            }
        };
        let playback = match playback {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[tts] 播放启动失败: {e}");
                crate::tts::ducking::set_tts_playing(false);
                if !is_filler {
                    state.body_active.store(false, Ordering::SeqCst);
                    emit_state(&app, AssistantState::Idle);
                }
                return;
            }
        };

        // 出声即让哨兵进窄通道（M25-03 起是丢帧，M33-03 改成只听打断词）：
        // 自己的声音不该被自己转写。垫场也算——它同样从扬声器出来。
        crate::tts::ducking::set_tts_playing(true);
        // 回采判定要的那半边（M33-03）：此刻在播的是哪句话。
        state.set_speaking_text(Some(&text));
        if !is_filler {
            emit_state(&app, AssistantState::Speaking);
        }
        /*
         * 占位时**必须把上一个停掉**（M27-02）。
         *
         * `replace` 把旧句柄丢掉：对 say 子进程，drop 一个 `Child` **不会**杀进程
         * ——它会一路播到自然结束，且从此没有任何句柄能停它（"杀不掉的孤儿
         * 播放进程"）；对 rodio，drop 输出流虽然会停声，但显式 halt 让两种
         * 句柄同一语义。代际守卫收紧之后正常路径已经到不了这里，但这一层是
         * 兜底——**孤儿一旦产生就再也收不回来**，代价不对等。
         */
        if let Some(mut prev) = state
            .current
            .lock()
            .expect("tts state poisoned")
            .replace(playback)
        {
            prev.halt();
        }

        // 轮询播放句柄；自然结束且代际未变 → 回落 idle。
        loop {
            tokio::time::sleep(Duration::from_millis(120)).await;
            if state.generation.load(Ordering::SeqCst) != generation {
                if !is_filler {
                    state.body_active.store(false, Ordering::SeqCst);
                }
                return; // 已被打断/替换
            }
            let mut guard = state.current.lock().expect("tts state poisoned");
            let finished = match guard.as_mut() {
                Some(p) => p.is_finished(),
                None => true,
            };
            if finished {
                guard.take();
                drop(guard);
                state.speaking_filler.store(false, Ordering::SeqCst);
                // 正文自然播完，摘牌——垫场（下一轮的）从此恢复正常受理。
                if !is_filler {
                    state.body_active.store(false, Ordering::SeqCst);
                }
                crate::tts::ducking::set_tts_playing(false);
                if state.generation.load(Ordering::SeqCst) == generation && !is_filler {
                    emit_state(&app, AssistantState::Idle);
                    // 播报自然结束：开追问窗口（M25-03）。垫场结束不开——
                    // 垫场不是回复，拿它换免唤醒词的许可说不通。
                    crate::commands::voice::on_tts_finished(&app);
                }
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        await_filler_end, filler_slot, should_preempt, stop, stop_if_filler, strip_markdown_for_speech,
        FillerSlot,
        FillerPreemptMode, TtsState, FILLER_WAIT_CAP_MS,
    };
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    /// [走查 2026-08-29 ④] 播完之后的保留窗内，迟到的回采比对仍拿得到原文。
    #[test]
    fn 刚播完的原文在保留窗内仍可取到() {
        let state = TtsState::default();
        state.set_speaking_text(Some("冬天续航下降主要有几个原因"));
        assert_eq!(
            state.recently_spoken(Duration::ZERO).as_deref(),
            Some("冬天续航下降主要有几个原因"),
            "正在播时不看窗口长短"
        );
        state.set_speaking_text(None);
        assert_eq!(
            state.recently_spoken(Duration::from_secs(8)).as_deref(),
            Some("冬天续航下降主要有几个原因"),
            "刚清掉（自然播完 / stop）之后，窗内仍能比对"
        );
        assert_eq!(
            state.recently_spoken(Duration::ZERO),
            None,
            "窗外不返回——拿旧话比对新语音挡掉的会是真指令"
        );
    }
    use std::sync::Arc;

    // ── M18-06：两种收尾方式 ────────────────────────────────────────────

    /// 默认必须是**衔接**。改默认是本单的产品决策，它值一条断言：
    /// 默认值被谁不小心翻过去，现象是"垫场话又开始被截断了"，很难归因。
    #[test]
    fn 默认收尾方式是衔接() {
        assert_eq!(TtsState::default().preempt_mode(), FillerPreemptMode::AfterSentence);
        assert_eq!(FillerPreemptMode::default(), FillerPreemptMode::AfterSentence);
    }

    /// 掐断要两个条件同时成立：用户偏好 **且** 内容属性（M18-06 约束 1）。
    #[test]
    fn 抢占判定是两个独立开关的与() {
        assert!(should_preempt(FillerPreemptMode::Immediate, true));
        // 用户选了抢占，但这句话本身不可打断（将来的告警类垫场）
        assert!(!should_preempt(FillerPreemptMode::Immediate, false));
        // 内容可打断，但用户选了衔接
        assert!(!should_preempt(FillerPreemptMode::AfterSentence, true));
        assert!(!should_preempt(FillerPreemptMode::AfterSentence, false));
    }

    #[test]
    fn 收尾方式可切换且跨重启保持() {
        let dir = std::env::temp_dir().join(format!("carlife-preempt-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("filler-preempt-pref");
        let _ = std::fs::remove_file(&path);

        let a = TtsState::default();
        a.load_preempt_prefs(path.clone());
        assert_eq!(a.preempt_mode(), FillerPreemptMode::AfterSentence, "文件不存在 ⇒ 默认衔接");

        a.set_preempt_mode(FillerPreemptMode::Immediate);
        assert_eq!(a.preempt_mode(), FillerPreemptMode::Immediate);

        // 换一个实例重新载入——模拟重启
        let b = TtsState::default();
        b.load_preempt_prefs(path.clone());
        assert_eq!(b.preempt_mode(), FillerPreemptMode::Immediate);

        let _ = std::fs::remove_file(&path);
    }

    /// 等待有上限。没有它，垫场的播放进程卡住就等于**正文永远播不出来**——
    /// 比句中截断严重得多，用户会以为助手死了。
    #[test]
    fn 等垫场结束有上限() {
        let state = Arc::new(TtsState::default());
        state.speaking_filler.store(true, Ordering::SeqCst); // 永远不结束

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        let started = std::time::Instant::now();
        let ended_naturally = rt.block_on(await_filler_end(&state, 240));
        assert!(!ended_naturally, "撞上限应返回 false");
        assert!(started.elapsed().as_millis() < 2_000, "不该一直等下去");
        /*
         * 上限必须够念完**最长的那一句**，否则"等垫场讲完再接管"每次都撞上限，
         * 现象与没做这个功能一模一样（M18-09）。
         *
         * 服务端 `sidecar/l1.ts` 的 `FIRST_MAX_CHARS` 是 60 字，
         * `budget.ts` 的 `speechMsPerChar` 是 200ms —— 12 秒是那两个数乘出来的。
         * 任何一边调大，这条会先红。
         */
        assert!(
            FILLER_WAIT_CAP_MS >= 60 * 200,
            "上限念不完最长的第一句（60 字 × 200ms/字），衔接模式会每次都被截断"
        );
    }

    #[test]
    fn 垫场自己结束时立刻返回() {
        let state = Arc::new(TtsState::default());
        // speaking_filler 为 false ⇒ 没有要等的
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        assert!(rt.block_on(await_filler_end(&state, FILLER_WAIT_CAP_MS)));
    }

    /// 衔接路径会在等待之后自己调 `stop()`，代际因此 +1。
    /// 仍拿等待**之前**的代际往下比对，等于自己把自己判成"已被打断"——
    /// 现象是"选了衔接模式就没有正文"，而没人会往代际守卫上查（M18-06 约束 3）。
    #[test]
    fn 衔接路径的代际必须重取() {
        let state = TtsState::default();
        let before = state.generation.load(Ordering::SeqCst);
        stop(&state);
        let after = state.generation.load(Ordering::SeqCst);
        assert_ne!(before, after, "stop 必须让代际前进，否则守卫失效");
    }

    // ── M18-05：抢占本身 ───────────────────────────────────────────────

    /// 抢占只针对垫场话（M18-05，F-45-07 / AC-45-3）。
    #[test]
    fn 抢占只停垫场_不误杀正文() {
        let state = TtsState::default();

        // 没在播任何东西 → 不该报告"停了"
        assert!(!stop_if_filler(&state), "没在播垫场时不该返回 true");

        // 模拟正在播垫场话
        state.speaking_filler.store(true, Ordering::SeqCst);
        let before = state.generation.load(Ordering::SeqCst);
        assert!(stop_if_filler(&state), "正在播垫场 → 必须停");
        assert_eq!(
            state.generation.load(Ordering::SeqCst),
            before + 1,
            "代际必须 +1，否则旧播放的监视线程还会发结束状态"
        );
        assert!(!state.is_speaking_filler());

        // 模拟正在播正文（speaking_filler 为 false）
        state.speaking_filler.store(false, Ordering::SeqCst);
        let g = state.generation.load(Ordering::SeqCst);
        assert!(!stop_if_filler(&state), "正在播正文时收到 delta 不该停");
        assert_eq!(state.generation.load(Ordering::SeqCst), g, "正文不该被打断");
    }

    /// iPad 走查修的那个竞态：正文在场时垫场必须让路，三种入场状态一视同仁。
    /// 判松的症状是"正文永远不响、旁路一直在放"——离根因（replace 竞态）很远。
    #[test]
    fn 正文在场时垫场一律丢弃() {
        assert_eq!(filler_slot(false, false, true), FillerSlot::Drop);
        assert_eq!(filler_slot(true, false, true), FillerSlot::Drop);
        assert_eq!(filler_slot(true, true, true), FillerSlot::Drop);
    }

    /// `stop` 顺带清位——用户长按说话打断时，垫场标志不能留在置位态，
    /// 否则下一次 delta 会误判成"正在播垫场"而多停一次。
    /// 走查（2026-08-14 第六轮）：「正在播放还没结束就被自己打断切掉了」。
    ///
    /// 根因在端上：`speak_filler` 原来无条件 `stop()`，注释写的理由是
    /// "两者都是垫场，没有等自己说完的道理"——那条理由在服务端间隔还是 4000ms
    /// 时成立（有 4 秒余量兜着按字数估算的误差）。间隔定到 500ms 之后余量没了，
    /// **估算短一点就是一刀**。服务端的估算只能是估算，端上才知道真相。
    #[test]
    fn 垫场不掐垫场_三种处置逐条可断言() {
        // 没人在播 → 直接播
        assert_eq!(filler_slot(false, false, false), FillerSlot::Play);
        // 正在播上一句垫场 → **等它播完**，不是把它掐掉（走查报的那一刀）
        assert_eq!(filler_slot(true, false, false), FillerSlot::Queue);
        // 已经有一句在等 → 丢掉。排队叠起来的话前一句一结束几个协程会一起抢，
        // 现象仍是互相掐断，只是换了个地方发生
        assert_eq!(filler_slot(true, true, false), FillerSlot::Drop);
        // pending 为真但没在播（上一句刚自然结束的那个瞬间）→ 照播
        assert_eq!(filler_slot(false, true, false), FillerSlot::Play);
    }

    #[test]
    fn 垫场排队与正文抢占是两套判据_互不影响() {
        // 正文的抢占仍由 should_preempt 决定，与 filler_slot 无关：
        // 一个管"垫场之间怎么让"，一个管"正文来了掐不掐垫场"。
        assert_eq!(filler_slot(true, false, false), FillerSlot::Queue);
        assert!(should_preempt(FillerPreemptMode::Immediate, true));
        assert!(!should_preempt(FillerPreemptMode::AfterSentence, true));
    }

    /// M33-02：打断把 `body_active` 也清掉。
    ///
    /// **`stop()` 清不掉它**——那是本函数存在的全部理由。留成 true 的后果是
    /// `filler_slot()` 第一条判据永远命中 `Drop`：打断过一次之后这个进程里
    /// 再也不会有垫场播出来，全程零报错。
    #[test]
    fn 打断复位垫场槽位_含stop清不掉的body_active() {
        let state = TtsState::default();
        state.body_active.store(true, Ordering::SeqCst);
        state.speaking_filler.store(true, Ordering::SeqCst);
        state.filler_pending.store(true, Ordering::SeqCst);

        // 先证明 stop() 确实清不掉 body_active——不然本函数就是多余的
        stop(&state);
        assert!(
            state.body_active.load(Ordering::SeqCst),
            "stop() 清不掉 body_active；哪天它清了，本测试与 reset_filler_slots 一起删"
        );
        assert_eq!(filler_slot(false, false, true), FillerSlot::Drop, "此刻垫场全被丢");

        state.reset_filler_slots();
        assert!(!state.body_active.load(Ordering::SeqCst));
        assert!(!state.is_speaking_filler());
        assert!(!state.is_filler_pending());
        assert_eq!(filler_slot(false, false, false), FillerSlot::Play, "打断之后垫场回得来");
    }

    /// 留成 true 的后果是旁路从此彻底哑掉，而日志里一行异常都没有。
    #[test]
    fn stop_把排队标志一起清掉() {
        let state = Arc::new(TtsState::default());
        state.speaking_filler.store(true, Ordering::SeqCst);
        state.filler_pending.store(true, Ordering::SeqCst);
        stop(&state);
        assert!(!state.is_speaking_filler());
        assert!(
            !state.is_filler_pending(),
            "用户长按打断后留下一个永远为真的 pending，之后所有垫场都会被静默丢掉"
        );
    }

    /// ACR-017：`CARLIFE_TTS` 退休后 `enabled()` 只回答平台能力，env 不再有话语权。
    /// ACR-018 又把最后一个环境变量判据（有没有豆包密钥）也拿掉了。
    /// 这条断言防的是"有人图方便把某个 env 判断加回来"——加回来的那天，
    /// 后台引擎开关又会被一个看不见的变量静默盖住。
    #[test]
    fn enabled_不受任何环境变量影响() {
        std::env::set_var("CARLIFE_TTS", "off");
        std::env::remove_var("BYTEDANCE_TTS_API_KEY");
        let on = crate::tts::enabled();
        std::env::remove_var("CARLIFE_TTS");
        assert!(on, "引擎层的可用性不该由端上的任何环境变量决定");
    }

    #[test]
    fn stop_清掉垫场标志() {
        let state = TtsState::default();
        state.speaking_filler.store(true, Ordering::SeqCst);
        stop(&state);
        assert!(!state.is_speaking_filler());
    }

    /// 两个开关分开：用户可能要正文播报但不要垫场。
    #[test]
    fn 垫场开关与播报开关互不影响() {
        let state = TtsState::default();
        assert!(!state.is_muted());
        assert!(!state.is_filler_muted());

        state.set_filler_muted(true);
        assert!(state.is_filler_muted());
        assert!(!state.is_muted(), "关垫场不该顺带关掉正文播报");

        state.set_muted(true);
        state.set_filler_muted(false);
        assert!(state.is_muted(), "开垫场不该顺带打开正文播报");
    }

    #[test]
    fn 剥掉加粗与行内记号() {
        assert_eq!(
            strip_markdown_for_speech("换成**里白酒店**，评分`4.9`，*很方便*"),
            "换成里白酒店，评分4.9，很方便"
        );
    }

    #[test]
    fn 剥掉行首列表与标题_保留内容() {
        assert_eq!(
            strip_markdown_for_speech("# 第1天\n- 越秀公园\n> 提示"),
            "第1天\n越秀公园\n提示"
        );
    }

    #[test]
    fn 链接只留文字() {
        assert_eq!(strip_markdown_for_speech("详见[官网](https://x.cn)哦"), "详见官网哦");
    }

    #[test]
    fn 纯文本原样通过() {
        assert_eq!(strip_markdown_for_speech("你好，一路平安"), "你好，一路平安");
    }
}
