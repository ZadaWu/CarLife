//! 自采回环判定（施工单 M33-03，F-52-02）。
//!
//! # 它挡的是什么
//!
//! 播报期间不再整段丢帧之后（那是 AC-45-6「用户开口即停播」的前提），
//! 麦克风采到的**大部分是暖暖自己的声音**。不挡的话，她会被自己的话打断——
//! 那比"听不见"严重得多：用户什么都没做，她自己说到一半停了。
//!
//! # 为什么是纯函数 + 子串比对，而不是声学回声消除
//!
//! AEC 要改整条音频链路（参考信号、延迟对齐、自适应滤波），是一次
//! `/arch-revision` 级别的改动。而这里有一个**别人没有的便宜条件**：
//! 我们手上有"此刻正在播的那句话的原文"。转写回来的如果是它的一部分，
//! 那就是回采——判据确定、可逐条断言，不引入任何新依赖。
//!
//! # 为什么比拼音不比汉字
//!
//! ASR 把播报回采成文字时错字很多（车内噪声 + 扬声器染色），汉字层对不上；
//! 但**音节层大多对得上**。归一化复用 `wake.rs` 已经在用的 `pinyin` crate，
//! 不新增依赖。
//!
//! # 取向：宁可漏，不可误
//!
//! 判成回采 = 丢掉这一段，代价是"这次打断没生效，再说一遍"。
//! 判成用户说话 = 暖暖被自己打断，代价是一个看起来像故障的现象。
//! 两边不对称，所以所有边界情况都往"这是回采"那边倒。

use pinyin::ToPinyin;

/// 短于这个音节数的转写，只做**全等**比对，不做子串。
///
/// # 这条是本模块最难的一格
///
/// 「停」归一化后是 `ting`，而回答里出现「停车场」时归一化含 `tingchechang`——
/// `ting` 是它的子串，于是车主真说的「停」会被判成回采、打断永远不生效。
/// 反过来若完全不做子串，回采的长句片段又挡不住。
///
/// 4 个音节是分界：打断词最长的「不用说了」是 4 个音节（buyongshuole），
/// 而有意义的回采片段普遍更长。短句走全等，长句走子串。
const SUBSTR_MIN_SYLLABLES: usize = 4;

/// 短于这个音节数一律判回采。
///
/// 一两个音节的转写没有信息量（噪声、气口、半个字），而它恰恰是最容易被
/// 误判成「停」的那一类——`is_interrupt` 的口令表里就有单字口令。
const NOISE_MAX_SYLLABLES: usize = 1;

/// 逐字转无声调拼音，丢掉标点、空白与非汉字。
///
/// 返回的是**音节数组**而不是拼接后的字符串：拼接会让
/// 「西安」(xi-an) 与「先」(xian) 撞在一起，子串比对就会出现假命中。
pub fn syllables(text: &str) -> Vec<String> {
    text.to_pinyin().flatten().map(|p| p.plain().to_string()).collect()
}

/// 这段转写是不是暖暖自己的声音被采回来了。
///
/// `speaking` 是**此刻正在播的那句原文**；没有在播时传 `None`。
pub fn is_echo(transcript: &str, speaking: Option<&str>) -> bool {
    let heard = syllables(transcript);

    // 没有信息量的段：一律丢。见 `NOISE_MAX_SYLLABLES`。
    if heard.len() <= NOISE_MAX_SYLLABLES {
        return true;
    }

    let Some(said) = speaking else {
        // 没在播就不可能是回采。此时判定权交给打断口令那一支。
        return false;
    };
    let said = syllables(said);
    if said.is_empty() {
        return false;
    }

    if heard.len() < SUBSTR_MIN_SYLLABLES {
        // 短句只认全等：`ting` 不该因为回答里有「停车场」就被吞掉。
        return said == heard;
    }
    contains_slice(&said, &heard)
}

/// `haystack` 里有没有连续出现 `needle`。
fn contains_slice(haystack: &[String], needle: &[String]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAID: &str =
        "冬天续航下降主要有几个原因：一是电池活性降低，二是暖风系统特别费电，三是轮胎阻力增加。";

    #[test]
    fn 完整回采_判回采() {
        assert!(is_echo("冬天续航下降主要有几个原因", Some(SAID)));
    }

    #[test]
    fn 片段回采_判回采() {
        assert!(is_echo("二是暖风系统特别费电", Some(SAID)));
        assert!(is_echo("轮胎阻力增加", Some(SAID)));
    }

    /// ASR 把播报回采成文字时错字很多，汉字层对不上、音节层对得上——
    /// 这正是比拼音不比汉字的理由。
    #[test]
    fn 同音错字的回采也判回采() {
        // 「电池活性」→ ASR 常写成「电迟活性」/「点池活性」
        assert!(is_echo("点池活性降低", Some(SAID)));
    }

    #[test]
    fn 用户真说的打断词不被误判() {
        assert!(!is_echo("别说了", Some(SAID)));
        assert!(!is_echo("停一下", Some(SAID)));
    }

    /// **本模块最难的一格**：`停` 的音节是 `ting`，而回答里有「停车场」
    /// （`ting-che-chang`）。不做长度门的话，车主真说的「停」会被吞掉，
    /// 表现是"喊停没用"，而日志里它被记成一次正常的回采过滤。
    #[test]
    fn 单字口令不被回答里的同音词吞掉() {
        let said = "前面那个停车场可以停，我给你导过去。";
        // 「停」只有 1 个音节 → 走 NOISE 分支被判回采（宁可漏）
        assert!(is_echo("停", Some(said)), "单音节没有信息量，本来就该丢");
        // 「停一下」3 个音节 → 走全等分支，不会被「停车场」吞掉
        assert!(!is_echo("停一下", Some(said)));
        assert!(!is_echo("先停一下", Some(said)));
    }

    #[test]
    fn 没在播时一律不是回采() {
        assert!(!is_echo("别说了", None));
        assert!(!is_echo("今天路上车真多", None));
    }

    #[test]
    fn 太短的段一律丢_它最容易被误判成口令() {
        assert!(is_echo("嗯", Some(SAID)));
        assert!(is_echo("啊", None), "没在播也丢——一个音节说明不了任何事");
        assert!(is_echo("", Some(SAID)));
    }

    #[test]
    fn 与播报无关的长句不判回采() {
        assert!(!is_echo("我们等下去吃点东西吧", Some(SAID)));
    }

    /// 音节数组而不是拼接串：拼接会让「西安」与「先」撞在一起。
    #[test]
    fn 音节不拼接_西安不等于先() {
        assert_eq!(syllables("西安"), vec!["xi", "an"]);
        assert_eq!(syllables("先"), vec!["xian"]);
        assert!(!contains_slice(&syllables("西安"), &syllables("先")));
    }

    #[test]
    fn 标点与非汉字被剥掉() {
        assert_eq!(syllables("停，一下！"), syllables("停一下"));
        assert_eq!(syllables("ok 停一下"), syllables("停一下"));
    }
}
