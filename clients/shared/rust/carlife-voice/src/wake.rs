//! 唤醒词判定（施工单 M25-02，F-52-02/04/05；M60-01 从车机端移入本共享 crate）。
//!
//! 纯文本函数：不碰网络、不碰设备、不碰状态——`classify` 进一段转写文本，
//! 出三类结果之一。判定顺序是纪律（M25-02 约束 2）：
//!
//! 1. 先剥唤醒词（「暖暖」/「你好暖暖」，拼音归一，同音近音计命中）；
//! 2. 再查控制口令（「退下」「没事了」等，**精确集合匹配**，防止
//!    "查一下退下高速的路线"这类误伤）；
//! 3. 剩下的才是业务指令。
//!
//! 拼音归一：逐字转无声调拼音（离线数据表，`pinyin` crate），
//! 「暖」的音节接受 n/l/r 声母混淆（ASR 对 nuan 的常见误写是
//! 「软软」ruan、「乱乱」luan——鼻边音不分是中文 ASR 的经典错位）。
//! **不做任何模型化判定**——置信度门槛等 §13-22 的误唤醒数据回来再说。
//!
//! 未命中的文本由调用方丢弃；本模块不留任何副本（AC-52-5）。

use pinyin::ToPinyin;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakeOutcome {
    /// 与暖暖无关的话——调用方必须就地丢弃。
    Miss,
    /// 控制口令：退下（软关闭，等价于按钮）。
    Dismiss,
    /// 控制口令：**打断**（施工单 M33-03，F-52-02）。
    ///
    /// 与 `Dismiss` / `SidecarOff` 都不同：退下是"这段对话结束了"，
    /// 关旁路是"以后少说点"，而这条是"**这一句现在就停**"——
    /// 会话继续、旁路开关不变，只是眼下这一轮被掐掉。
    Interrupt,
    /// 控制口令：关掉闲聊旁路（施工单 M33-04，F-45-08）。
    ///
    /// **与 `Dismiss` 是两件事**：退下是"这段对话结束了"，
    /// 这条是"你话太多了，少说点"——会话继续，主回答照答。
    SidecarOff,
    /// 控制口令：把闲聊旁路开回来。
    SidecarOn,
    /// 唤醒。`command` 是唤醒词之后的指令（None = 只喊了名字）。
    Wake { command: Option<String> },
}

/// 控制口令表（一期固定、代码内维护；精确匹配，见模块注释）。
const DISMISS_PHRASES: &[&str] = &[
    "退下",
    "退下吧",
    "你退下吧",
    "先退下",
    "先退下吧",
    "没事了",
    "没事啦",
    "没事",
    "没事儿了",
    "没什么事了",
];

/**
 * 打断的口令（施工单 M33-03）。**精确集合匹配**，理由同下。
 *
 * # 这张表比另外两张更要克制
 *
 * 它是**播报期间**唯一放行的一类判定（见车机端 `voice/mod.rs` 的窄通道），
 * 而那段时间麦克风里大部分是暖暖自己的声音。误判一次的现象是
 * "她自己把自己打断了"——用户什么都没做，她说到一半停了，
 * 这比"喊停没反应"看起来严重得多。
 *
 * 回采由车机端 `voice::echo::is_echo` 先挡一道，这张表是第二道。
 *
 * 手机端没有本地播报，因此那一路判定在它那边永远不会被触发——
 * 但这张表仍然是共用的，见 `lib.rs` 文件头。
 */
const INTERRUPT_PHRASES: &[&str] = &[
    "停",
    "停一下",
    "先停",
    "先停一下",
    "别说了",
    "别说啦",
    "不用说了",
    "不说了",
    "等一下",
    "等等",
];

/**
 * 关掉闲聊旁路的口令（施工单 M33-04）。**精确集合匹配**，理由与 `DISMISS_PHRASES`
 * 完全相同（见模块注释里那个「查一下退下高速的路线」的反例）。
 *
 * # 取向是「宁可漏，不可误」
 *
 * 说法变体很多，而精确匹配天生漏。但两边的代价不对称：
 * **误关的代价是车主以为功能坏了，而且他不知道怎么开回来**；
 * 漏的代价只是再说一遍。所以这张表只收那些"除了拨这个开关不可能是别的意思"的说法。
 *
 * 不做模糊 / 语义匹配：那要过一次 LLM，而这条判定必须在端上瞬时生效——
 * 车主正是因为嫌她话多才说的这句话，再等一轮 LLM 是同一个错误的延续。
 */
const SIDECAR_OFF_PHRASES: &[&str] = &[
    "不要废话了",
    "不要废话",
    "别废话了",
    "别废话",
    "少说两句",
    "少说点",
    "别聊了",
    "安静点",
    "安静会儿",
    "关掉闲聊",
    "别闲聊了",
];

/// 把闲聊旁路开回来的口令（施工单 M33-04）。
///
/// **必须有反向口令**：只给关不给开，等于让车主一次误触就永久失去这个功能，
/// 而车机上他多半也找不到那个设置在哪（设置页是 M33-05 才有的）。
const SIDECAR_ON_PHRASES: &[&str] =
    &["打开闲聊", "开启闲聊", "可以聊天了", "陪我聊聊", "说说话吧", "跟我聊聊"];

/// 「暖」的归一音节：nuan 及其 n/l/r 声母混淆。
fn is_nuan(syllable: &str) -> bool {
    matches!(syllable, "nuan" | "luan" | "ruan")
}

/// 标点与空白——指令剥离和口令匹配前都要去掉。
fn is_separator(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '，' | '。' | '！' | '？' | '、' | '；' | '：' | '…' | '～'
                | ',' | '.' | '!' | '?' | ';' | ':' | '~' | '"' | '\'' | '「' | '」'
        )
}

fn strip_separators(text: &str) -> String {
    text.chars().filter(|c| !is_separator(*c)).collect()
}

fn is_dismiss(text: &str) -> bool {
    matches_phrase(text, DISMISS_PHRASES)
}

fn matches_phrase(text: &str, table: &[&str]) -> bool {
    let norm = strip_separators(text);
    table.contains(&norm.as_str())
}

/// 四张控制口令表的统一判定（施工单 M33-03 / M33-04）。
///
/// **顺序即优先级**，且这个顺序是有理由的：
///  1. 打断最急——车主说这句话的时候暖暖正在出声，晚一步就没意义了；
///  2. 旁路开关次之，同样是"对说话这件事本身"下指令；
///  3. 退下排最后——它的代价最大（整段对话软关闭），判松了最难受。
///
/// 返回 None 表示三张表都没命中，交给业务指令那一支。
fn control_of(text: &str) -> Option<WakeOutcome> {
    if matches_phrase(text, INTERRUPT_PHRASES) {
        return Some(WakeOutcome::Interrupt);
    }
    if matches_phrase(text, SIDECAR_OFF_PHRASES) {
        return Some(WakeOutcome::SidecarOff);
    }
    if matches_phrase(text, SIDECAR_ON_PHRASES) {
        return Some(WakeOutcome::SidecarOn);
    }
    if is_dismiss(text) {
        return Some(WakeOutcome::Dismiss);
    }
    None
}

/// 播报期窄通道用的窄判定（施工单 M33-03）。
///
/// **只问一件事：这是不是打断**。播报期间的转写只有这一个去向，
/// 其余一律就地丢弃——AC-52-5 的丢弃纪律在窄通道里原样适用。
///
/// 带唤醒词的说法也认（「暖暖，停」），因为约束 1 的降级方案
/// （`barge_in_require_wake`）正是"播报期只放行唤醒词开头的段"。
pub fn is_interrupt(text: &str) -> bool {
    matches!(classify(text), WakeOutcome::Interrupt)
}

/// 这段文本里第一处「暖暖」在第几个字（拼音归一，同音近音计命中）。
///
/// 抽出来是因为 M33-03 的降级判据要单独问这一件事：
/// `classify` 对「暖暖，停」返回 `Interrupt`，**唤醒词命中这个事实被吃掉了**，
/// 而窄通道要用它决定放不放行。
fn wake_hit(text: &str) -> Option<usize> {
    let syllables: Vec<Option<String>> = text
        .to_pinyin()
        .map(|p| p.map(|py| py.plain().to_string()))
        .collect();
    syllables.windows(2).position(|w| {
        matches!(
            (w[0].as_deref(), w[1].as_deref()),
            (Some(a), Some(b)) if is_nuan(a) && is_nuan(b)
        )
    })
}

/// 这段转写里有没有喊名字（施工单 M33-03 约束 1 的降级判据）。
///
/// 回采比对挡不住时，把窄通道收紧成"只放行喊了名字的"——
/// 代价是打断要多说两个字（「暖暖，停」），但暖暖不会被自己的话打断。
pub fn has_wake_word(text: &str) -> bool {
    wake_hit(text).is_some()
}

pub fn classify(text: &str) -> WakeOutcome {
    let chars: Vec<char> = text.chars().collect();

    if let Some(i) = wake_hit(text) {
        // 唤醒词之后的文本 = 指令（唤醒词之前的一律当噪声丢弃——预卷会带进气口）
        let rest: String = chars[i + 2..].iter().collect();
        let command: String = rest
            .trim_start_matches(is_separator)
            .trim_end_matches(is_separator)
            .to_string();
        if command.is_empty() {
            return WakeOutcome::Wake { command: None };
        }
        // 控制口令优先于业务指令：「暖暖退下」是让她走、「暖暖不要废话了」是拨开关，
        // 都不是一条消息
        if let Some(control) = control_of(&command) {
            return control;
        }
        return WakeOutcome::Wake { command: Some(command) };
    }

    // 没有唤醒词：整句是控制口令也认（办公态/追问窗口语境，门禁归调用方）
    if !chars.is_empty() {
        if let Some(control) = control_of(text) {
            return control;
        }
    }
    WakeOutcome::Miss
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wake_with(cmd: &str) -> WakeOutcome {
        WakeOutcome::Wake { command: Some(cmd.to_string()) }
    }

    #[test]
    fn 句首唤醒_指令直达() {
        assert_eq!(
            classify("暖暖，明天早上八点提醒我还图书馆的书"),
            wake_with("明天早上八点提醒我还图书馆的书")
        );
        assert_eq!(classify("你好暖暖 明天要带伞吗"), wake_with("明天要带伞吗"));
    }

    #[test]
    fn 只喊名字_不发空消息() {
        assert_eq!(classify("暖暖"), WakeOutcome::Wake { command: None });
        assert_eq!(classify("你好暖暖"), WakeOutcome::Wake { command: None });
        assert_eq!(classify("暖暖。"), WakeOutcome::Wake { command: None });
    }

    #[test]
    fn 同音近音误写计命中() {
        // ASR 鼻边音不分的经典错位：软软(ruan)、乱乱(luan)
        assert_eq!(classify("你好软软明天提醒我还书"), wake_with("明天提醒我还书"));
        assert_eq!(classify("乱乱，放首歌"), wake_with("放首歌"));
    }

    #[test]
    fn 句中出现也命中_之前的当噪声() {
        assert_eq!(classify("呃那个暖暖帮我看下天气"), wake_with("帮我看下天气"));
    }

    #[test]
    fn 控制口令优先于业务指令() {
        assert_eq!(classify("暖暖退下"), WakeOutcome::Dismiss);
        assert_eq!(classify("暖暖，没事了"), WakeOutcome::Dismiss);
        assert_eq!(classify("你好暖暖退下吧"), WakeOutcome::Dismiss);
        // 无唤醒词的裸口令（追问窗口语境）
        assert_eq!(classify("退下"), WakeOutcome::Dismiss);
        assert_eq!(classify("没事了。"), WakeOutcome::Dismiss);
    }

    #[test]
    fn 口令是精确匹配_不误伤含口令的长句() {
        assert_eq!(classify("查一下退下高速的路线"), WakeOutcome::Miss);
        assert_eq!(classify("暖暖，查一下退下高速的路线"), wake_with("查一下退下高速的路线"));
    }

    /// M33-03：播报期的打断口令。
    ///
    /// 这张表比另外两张更要克制——它是播报期间唯一放行的判定，
    /// 而那段时间麦克风里大部分是暖暖自己的声音。
    #[test]
    fn 打断口令_裸口令与带唤醒词都认() {
        assert_eq!(classify("停"), WakeOutcome::Interrupt);
        assert_eq!(classify("别说了"), WakeOutcome::Interrupt);
        assert_eq!(classify("等一下"), WakeOutcome::Interrupt);
        assert_eq!(classify("暖暖，停"), WakeOutcome::Interrupt);
        assert_eq!(classify("你好暖暖别说了"), WakeOutcome::Interrupt);
        assert!(is_interrupt("先停一下"));
    }

    #[test]
    fn 打断口令不误伤含它的长句() {
        assert_eq!(classify("前面那个停车场停一下车"), WakeOutcome::Miss);
        assert_eq!(classify("等一下我看看导航"), WakeOutcome::Miss);
        assert!(!is_interrupt("你别说了我自己看"));
        // 带唤醒词的长句仍是业务指令
        assert_eq!(classify("暖暖，等一下再提醒我"), wake_with("等一下再提醒我"));
    }

    /// 打断 / 关旁路 / 退下三件事的代价差一个量级，判定不能互相吞。
    #[test]
    fn 三类控制口令互不吞并() {
        assert_eq!(classify("停"), WakeOutcome::Interrupt);
        assert_eq!(classify("别废话"), WakeOutcome::SidecarOff);
        assert_eq!(classify("退下"), WakeOutcome::Dismiss);
        assert_eq!(classify("打开闲聊"), WakeOutcome::SidecarOn);
    }

    /// M33-03 约束 1 的降级判据：窄通道要单独问"有没有喊名字"，
    /// 而 `classify` 对「暖暖，停」返回 Interrupt，把这个事实吃掉了。
    #[test]
    fn has_wake_word_独立于分类结果() {
        assert!(has_wake_word("暖暖，停"), "分类是 Interrupt，但名字确实喊了");
        assert!(has_wake_word("你好暖暖"));
        assert!(has_wake_word("乱乱，放首歌"), "同音近音也算");
        assert!(!has_wake_word("停"));
        assert!(!has_wake_word("今天路上车真多"));
    }

    /// M33-04：闲聊旁路的语音开关。
    ///
    /// 取向是**宁可漏，不可误**——误关的代价是车主以为功能坏了，
    /// 而且他不知道怎么开回来；漏的代价只是再说一遍。
    #[test]
    fn 关旁路口令_带唤醒词与裸口令都认() {
        assert_eq!(classify("不要废话了"), WakeOutcome::SidecarOff);
        assert_eq!(classify("暖暖，不要废话了"), WakeOutcome::SidecarOff);
        assert_eq!(classify("别废话"), WakeOutcome::SidecarOff);
        assert_eq!(classify("安静点。"), WakeOutcome::SidecarOff);
        assert_eq!(classify("你好暖暖，别闲聊了"), WakeOutcome::SidecarOff);
    }

    #[test]
    fn 开旁路口令_必须有反向口令否则一次误触就永久失去这个功能() {
        assert_eq!(classify("打开闲聊"), WakeOutcome::SidecarOn);
        assert_eq!(classify("暖暖，陪我聊聊"), WakeOutcome::SidecarOn);
        assert_eq!(classify("可以聊天了"), WakeOutcome::SidecarOn);
    }

    /// 精确匹配的价值全在这一条上：这些句子**含**口令但意思完全不同。
    #[test]
    fn 旁路口令不误伤含它的长句() {
        assert_eq!(classify("你别说了我自己看导航"), WakeOutcome::Miss);
        assert_eq!(classify("这事不要废话了直接办"), WakeOutcome::Miss);
        assert_eq!(classify("他说安静点的时候我正在开车"), WakeOutcome::Miss);
        assert_eq!(classify("帮我打开闲聊模式的说明书"), WakeOutcome::Miss);
        // 带唤醒词的长句同样只能是业务指令
        assert_eq!(
            classify("暖暖，帮我查一下打开闲聊要怎么设置"),
            wake_with("帮我查一下打开闲聊要怎么设置")
        );
    }

    /// 关旁路 ≠ 退下。两者的代价差一个量级（一个是少说点，一个是整段对话关掉）。
    #[test]
    fn 旁路开关与退下互不吞并() {
        assert_eq!(classify("退下"), WakeOutcome::Dismiss);
        assert_eq!(classify("没事了"), WakeOutcome::Dismiss);
        assert_eq!(classify("少说两句"), WakeOutcome::SidecarOff);
        assert_eq!(classify("暖暖退下"), WakeOutcome::Dismiss);
    }

    #[test]
    fn 未命中一律_miss() {
        assert_eq!(classify("今天我和妈妈一起坐车"), WakeOutcome::Miss);
        assert_eq!(classify("温暖的阳光"), WakeOutcome::Miss, "单个「暖」不构成唤醒");
        assert_eq!(classify(""), WakeOutcome::Miss);
        assert_eq!(classify("，。！"), WakeOutcome::Miss);
        assert_eq!(classify("hello world"), WakeOutcome::Miss);
    }

    #[test]
    fn 指令首尾标点被剥掉() {
        assert_eq!(classify("暖暖，，放首歌！"), wake_with("放首歌"));
    }
}
