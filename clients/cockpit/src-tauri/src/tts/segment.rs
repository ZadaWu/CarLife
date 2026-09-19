//! 播报文本的分段（M77 走查追修，2026-09-12）。
//!
//! # 为什么要切
//!
//! 此前正文是**整段**送去合成、合成完才起播。真跑实测（直接打上游，两点拟合）：
//!
//! ```text
//! 合成耗时 ≈ 723 ms + 30.3 ms × 字数
//! ```
//!
//! | 字数 | 实测 | 备注 |
//! |---|---|---|
//! | 13 | 1117 ms | 固定开销占了大头 |
//! | 252 | 8369 ms | |
//! | 484 | 14380 ms | 事故那一次，网关日志 |
//!
//! 于是一段 484 字的行程方案，车主要等 14 秒才听到第一个字。
//!
//! # 那 723 ms 的固定开销是这里所有取舍的由来
//!
//! 只看「30 ms 一个字」会得出"首段越短越好"，但**每一段都要单付一次 723 ms**。
//! 中文播报约 4.5 字/秒（222 ms 一个字），所以段 N 要赶在段 N-1 播完之前合成好：
//!
//! ```text
//! 723 + 30.3·len(N) < 222·len(N-1)
//! ```
//!
//! 代进去算就知道首段不能太短：**8 字的首段配 64 字的次段会断 888 ms**——
//! 那正是车主能听出来的"卡一下"。所以次段夹一个缓冲档（32 字），
//! 第三段起才放开到 64：
//!
//! | 首段 | 次段 | 结果 |
//! |---|---|---|
//! | 8 字 | 64 字 | 断 888 ms |
//! | 12 字 | 64 字 | 刚好为 0，没有余量 |
//! | 12 字 | 32 字 | 余 970 ms ✓ |
//!
//! 第三段之后余量只会更大（前一段 32 字要播 7.1 s，而 64 字合成只要 2.6 s），
//! 所以再往后不必继续升档。
//!
//! # 边界
//!
//! 切的是**送去合成的单位**，不是句子学意义上的句子。判据抄自 Pipecat 的
//! 两分法（见 `is_cjk_terminator`），不引入分词模型——中文播报的句末标点
//! 本来就无歧义，真正需要看上下文的只有 ASCII 的 `.`。

/// 首段下限。低于它，次段就接不上（见文件头那张表）。
const FIRST_MIN: usize = 12;
/// 首段上限。首声延迟 ≈ 723 + 30×字数，24 字约 1.4 s。
const FIRST_MAX: usize = 24;
/// 次段上限：首段播放时间很短，这一段必须也短，否则会断。
const RAMP_MAX: usize = 32;
/// 第三段起的上限。此时前一段足够长，余量充裕。
const REST_MAX: usize = 64;
/// 末段并回前一段的阈值，也是软切点的最小长度：不为三个字单发一次请求
/// ——那一次就要付 723 ms。
const TAIL_MIN: usize = 8;

/// 第 `done` 段（0 起）的字数上限。
fn cap_for(done: usize) -> usize {
    match done {
        0 => FIRST_MAX,
        1 => RAMP_MAX,
        _ => REST_MAX,
    }
}

/// 句末标点，**无歧义的那一类**：出现即是句末，不必看上下文。
///
/// 判据抄自 Pipecat 的 `UNAMBIGUOUS_SENTENCE_ENDING_PUNCTUATION`（它把标点分成
/// 两类：东亚 / 印度 / 阿拉伯等文种的句末标点无歧义，直接切；拉丁的 `.!?;`
/// 有歧义，要交给 NLTK punkt 那样的模型消歧）。我们的播报文本以中文为主，
/// 正好落在无歧义那一侧——所以这里不需要引入任何分词模型。
fn is_cjk_terminator(c: char) -> bool {
    matches!(c, '。' | '！' | '？' | '；' | '…' | '．' | '｡')
}

/// 句中停顿：只在一句话超过上限时才用它续切。
fn is_soft_break(c: char) -> bool {
    matches!(c, '，' | '、' | '：' | ',' | ':' | '—')
}

/// ASCII 句末标点该不该在这里切——**这是有歧义的那一类**，要看前后。
///
/// 不看的话会切出洋相，而且全是中文播报里真会出现的形状：
///
/// | 文本 | 切错的后果 |
/// |---|---|
/// | `3.5 小时` | 「三」「五小时」 |
/// | `第 1. 天` | 序号与内容被拆开 |
/// | `example.com` | 域名读一半 |
///
/// 判据：`.` 只在**前一个不是数字**且**后一个是空白或结尾**时才算句末；
/// `!` `?` `;` 在中文文本里没有这种歧义，直接算。
fn ascii_terminates(text: &[char], i: usize) -> bool {
    match text[i] {
        '!' | '?' | ';' => true,
        '.' => {
            let prev_digit = i > 0 && text[i - 1].is_ascii_digit();
            let next_ends = text.get(i + 1).is_none_or(|c| c.is_whitespace());
            !prev_digit && next_ends
        }
        _ => false,
    }
}

/// 把播报文本切成若干合成单位。**返回的段拼起来等于去掉首尾空白的原文**
/// （标点保留——TTS 要靠它断句；换行本身不发音，会被吃掉）。
///
/// 文本短于首段上限时原样返回一段，行为与分段之前逐字相同。
///
/// 两趟做完，各自独立：先切成**不超过首段上限的最小单位**（`atoms`），
/// 再贪心装段（`pack`）。一趟做完的写法要让"当前段还剩多少"穿过切分逻辑，
/// 而那个状态在循环里一直在变——第一版就是这么写的，读起来像对的、
/// 但闭包捕获的是装配到一半的进度。
pub fn split_for_speech(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.chars().count() <= FIRST_MAX {
        return vec![trimmed.to_string()];
    }
    let mut out = pack(atoms(trimmed));
    // 末段过短就并回前一段：最后一次请求为三个字单独跑一趟不值得。
    if out.len() >= 2 && out.last().is_some_and(|s| s.chars().count() < TAIL_MIN) {
        let tail = out.pop().expect("len >= 2");
        out.last_mut().expect("len >= 1").push_str(&tail);
    }
    out
}

/// 段的下限：首段要够长才接得上次段（见文件头），其余段只要别短到白付一次固定开销。
fn floor_for(done: usize) -> usize {
    if done == 0 { FIRST_MIN } else { TAIL_MIN }
}

/// 硬上限：没有任何标点可切时的兜底。给一个单位的余量，
/// 免得"再等等说不定就有标点了"变成无限等。
fn hard_cap(done: usize) -> usize {
    cap_for(done) + FIRST_MAX
}

/// 从**流式缓冲**里切出已经完整的段，剩下的原样留给下一批（M77 走查追修第二步）。
///
/// `done` 是这一轮已经送去合成的段数——它决定当前段用哪一档上限。
/// 返回 `(完整段, 尾巴)`；尾巴是 `buf` 的**字符后缀**，一个字符都不丢：
/// 下一批 delta 直接拼在它后面即可。
///
/// # 为什么不复用 `split_for_speech`
///
/// 那个函数假定"文本已经完整"，于是末尾不足一段的部分也会被当成一段发出去。
/// 流式下这正是要避免的：`全程 3.` 刚到手时把它当一段送去合成，
/// 车主会听到「全程三点」，而下一批才带来「5 小时」。
/// 这里的规矩是**宁可等**——只有落在标点上、或确实超长了，才认为一段结束。
pub fn take_complete(buf: &str, done: usize) -> (Vec<String>, String) {
    let chars: Vec<char> = buf.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut seg_start = 0usize;
    let mut consumed = 0usize;

    for i in 0..chars.len() {
        let c = chars[i];
        let n = i - seg_start + 1;
        let idx = done + out.len();
        let terminator = is_cjk_terminator(c) || ascii_terminates(&chars, i);
        // 三种收段理由，从好到差：落在句末标点上、超限了落在句中标点上、实在没标点。
        let cut = (terminator && n >= floor_for(idx))
            || (is_soft_break(c) && n >= cap_for(idx))
            || n >= hard_cap(idx);
        if cut {
            let seg: String = chars[seg_start..=i].iter().collect();
            let seg = seg.trim().to_string();
            if !seg.is_empty() {
                out.push(seg);
            }
            seg_start = i + 1;
            consumed = i + 1;
        }
    }

    (out, chars[consumed..].iter().collect())
}

/// 第一趟：切成最小单位，**每个都 ≤ FIRST_MAX**。
///
/// 按这个粒度切是为了让 `pack` 的首段一定装得下：atom 比首段上限还长的话，
/// 首段就只能超限，而"首段要短"正是整件事的唯一目的。
fn atoms(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut buf = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if c == '\n' {
            // 换行不发音，但它是个天然的断点。
            flush(&mut out, &mut buf);
            continue;
        }
        buf.push(c);
        let n = buf.chars().count();
        let terminator = is_cjk_terminator(c) || ascii_terminates(&chars, i);
        if terminator || (is_soft_break(c) && n >= TAIL_MIN) || n >= FIRST_MAX {
            flush(&mut out, &mut buf);
        }
    }
    flush(&mut out, &mut buf);
    out
}

/// 第二趟：装段。**首段不贪心**，其余贪心吃到 `REST_MAX`。
///
/// 首声延迟就是首段字数 × 30 ms，所以首段够长（`TAIL_MIN`）就立刻收，
/// 哪怕后面还装得下。贪心装满首段会把首声从 0.3 s 推到 0.7 s——
/// 白等 0.4 s 换来少发一次请求，而请求数本来就不是瓶颈。
/// `FIRST_MAX` 因此只是**兜底**：第一句本身很长（没有标点可切）时才轮到它。
fn pack(atoms: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    for a in atoms {
        let limit = cap_for(out.len());
        /*
         * **首段短于下限时不许提前封段**。
         *
         * 这一条是走查（dump_segments）逼出来的：原来只要"装不下下一个单位"就封段，
         * 而那条路绕过了下限检查——实测切出过 9 字的首段，最坏能到 2 字（「好。」后面
         * 跟一个 30 字的长句）。2 字只够播 444 ms，而次段 30 字要合成 1632 ms，
         * 中间断 1.2 秒。宁可让首段略超上限（至多 FIRST_MIN-1 + FIRST_MAX 字，
         * 首声多等 0.3 s），也不能让它短到接不上。
         */
        let too_short = out.is_empty() && buf.chars().count() < FIRST_MIN;
        if !buf.is_empty() && !too_short && buf.chars().count() + a.chars().count() > limit {
            out.push(std::mem::take(&mut buf));
        }
        buf.push_str(&a);
        let n = buf.chars().count();
        // 首段够长就收（不贪心），其余装满才收。
        let full = if out.is_empty() { n >= FIRST_MIN } else { n >= cap_for(out.len()) };
        if full {
            out.push(std::mem::take(&mut buf));
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn flush(out: &mut Vec<String>, buf: &mut String) {
    let t = buf.trim();
    if !t.is_empty() {
        out.push(t.to_string());
    }
    buf.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼回原文——**任何切法都必须满足它**，否则车主会听漏或听重字。
    fn assert_lossless(text: &str, parts: &[String]) {
        assert_eq!(parts.concat(), text.trim().replace('\n', ""), "拼回原文（换行本身不发音）");
    }

    #[test]
    fn 短文本原样一段_与分段之前逐字相同() {
        assert_eq!(split_for_speech("好的。"), vec!["好的。"]);
        assert_eq!(split_for_speech("行程已确认并保存。"), vec!["行程已确认并保存。"]);
        assert!(split_for_speech("").is_empty());
        assert!(split_for_speech("   \n  ").is_empty());
    }

    #[test]
    fn 首段短_让第一声在一秒内出来() {
        let text = "行程已确认并保存。第一天从上海出发，走沪昆高速到杭州，路上大约四个小时，中途在嘉兴服务区休息一次。第二天游西湖与灵隐寺。";
        let parts = split_for_speech(text);
        // 60 字切成两段就够：首段 9 字 0.3 s 出声，次段 51 字 1.5 s 合成，
        // 而首段要念 2 s——追得上。段数不是越多越好，每段都是一次请求。
        assert!(parts.len() >= 2, "长文本要切开，实际 {} 段", parts.len());
        assert!(parts[0].chars().count() <= FIRST_MAX, "首段 {} 字超过上限", parts[0].chars().count());
        // 「行程已确认并保存。」只有 9 字，短于首段下限——续吃一个单位到 18 字。
        // 不续的话次段接不上（文件头那张表）。
        assert!(parts[0].chars().count() >= FIRST_MIN, "首段 {} 字，次段会接不上", parts[0].chars().count());
        assert!(parts[0].starts_with("行程已确认并保存。"), "首段从第一句开始：{:?}", parts[0]);
        assert_lossless(text, &parts);
    }

    #[test]
    fn 首段不贪心_够长就收_不为省一次请求拖慢首声() {
        let parts = split_for_speech("好的。第二句话在这里，它比较长一些用来占位。第三句也来凑个数吧。");
        let first = parts[0].chars().count();
        // 「好的。」3 字远低于下限，续吃到够；但够了就收，不装满 FIRST_MAX。
        assert!(first >= FIRST_MIN, "首段 {first} 字低于下限");
        assert!(first <= FIRST_MAX, "首段 {first} 字超过上限");
        assert!(parts[0].starts_with("好的。"));
    }

    #[test]
    fn 后续段不超上限_且每段都不超过前一段的七倍() {
        let text = "好的。".to_string() + &"这是一段很长的行程说明，".repeat(30);
        let parts = split_for_speech(&text);
        for (i, p) in parts.iter().enumerate() {
            let n = p.chars().count();
            assert!(n <= cap_for(i), "第 {i} 段 {n} 字超过该段上限 {}", cap_for(i));
            if i > 0 {
                // 文件头那条不等式（含 723 ms 固定开销）：段 N 的合成要赶在段 N-1 播完之前。
                let prev = parts[i - 1].chars().count();
                let synth_ms = 723.0 + 30.3 * n as f64;
                let play_ms = 222.0 * prev as f64;
                assert!(synth_ms < play_ms, "第 {i} 段 {n} 字合成 {synth_ms:.0} ms > 前段 {prev} 字播放 {play_ms:.0} ms，会断");
            }
        }
        assert_lossless(&text, &parts);
    }

    #[test]
    fn 没有标点的长文本也能切_不至于卡成一整段() {
        let text = "一".repeat(200);
        let parts = split_for_speech(&text);
        assert!(parts.len() > 1);
        assert!(parts[0].chars().count() <= FIRST_MAX);
        assert_lossless(&text, &parts);
    }

    #[test]
    fn 末段过短并回前一段_不为三个字单发一次请求() {
        let text = "第一段内容要足够长以便触发分段逻辑并且超过首段上限。".to_string()
            + &"第二段也很长很长很长很长很长很长很长很长。".repeat(2)
            + "好。";
        let parts = split_for_speech(&text);
        assert!(parts.last().unwrap().chars().count() >= TAIL_MIN, "末段 {:?} 太短", parts.last());
        assert_lossless(&text, &parts);
    }

    #[test]
    fn 真实长度_首声一秒半内_段数不过分() {
        // 事故原文的量级：484 字、整段合成 14.4 s。
        let text = "行程已确认并保存：广州，共四天。".to_string()
            + &"第一天从上海出发走沪昆高速，路上大约四个小时，中途在嘉兴服务区休息一次。".repeat(12);
        let n = text.chars().count();
        let parts = split_for_speech(&text);
        assert!(n > 400, "先确认这条用例的量级对得上事故（{n} 字）");
        let first = parts[0].chars().count();
        assert!(first <= FIRST_MAX, "首段 {first} 字");
        // 首声延迟 ≈ 723 + 30.3 × 首段字数（实测拟合）。24 字约 1.45 s。
        let first_ms = 723.0 + 30.3 * first as f64;
        assert!(first_ms <= 1_500.0, "首声 {first_ms:.0} ms 太慢（事故那次是 14380 ms）");
        // 段数 = 请求数：别为了更短的首声把它切到几十段
        assert!(parts.len() <= n / 30, "{n} 字切了 {} 段，太碎", parts.len());
        assert_lossless(&text, &parts);
    }

    /// 歧义标点：切错的每一条都是中文播报里真会出现的形状。
    /// 判据见 `ascii_terminates`（Pipecat 把拉丁标点划进"有歧义"那一类）。
    #[test]
    fn 小数点序号域名都不当句末() {
        let chars: Vec<char> = "全程 3.5 小时".chars().collect();
        let dot = chars.iter().position(|c| *c == '.').unwrap();
        assert!(!ascii_terminates(&chars, dot), "小数点不是句末：3.5 会被读成「三」「五小时」");

        let chars: Vec<char> = "第 1. 天".chars().collect();
        let dot = chars.iter().position(|c| *c == '.').unwrap();
        assert!(!ascii_terminates(&chars, dot), "序号点不是句末（前面是数字）");

        let chars: Vec<char> = "打开 example.com 看看".chars().collect();
        let dot = chars.iter().position(|c| *c == '.').unwrap();
        assert!(!ascii_terminates(&chars, dot), "域名中间不是句末（后面不是空白）");

        let chars: Vec<char> = "Hello. World".chars().collect();
        let dot = chars.iter().position(|c| *c == '.').unwrap();
        assert!(ascii_terminates(&chars, dot), "英文句末（后面是空格、前面不是数字）");
    }

    #[test]
    fn 全角句末无歧义_直接切() {
        for c in ['。', '！', '？', '；', '…', '．', '｡'] {
            assert!(is_cjk_terminator(c), "{c} 该是句末");
        }
        for c in ['，', '、', '：', '的', '1'] {
            assert!(!is_cjk_terminator(c), "{c} 不该是句末");
        }
    }

    /// 带小数的真实播报：整句不该被小数点拆开。
    #[test]
    fn 带小数的行程文本不被拆坏() {
        let text = "第一天全程 3.5 小时，第二天 4.2 小时，第三天返程 5.8 小时，路上会经过三个服务区，都可以停下来休息一下。";
        let parts = split_for_speech(text);
        for p in &parts {
            // 任何一段都不该以裸数字结尾——那就是从小数点中间切开了
            let last = p.trim_end();
            assert!(
                !last.ends_with(|c: char| c.is_ascii_digit()) || !last.contains('.'),
                "段 {p:?} 像是从小数点切开的"
            );
        }
        assert_lossless(text, &parts);
    }

    /// 走查用：把真实播报文本的切分结果打出来，人眼过一遍听感。
    /// `cargo test -p cockpit dump_segments -- --nocapture`
    #[test]
    fn dump_segments() {
        let texts = [
            "行程已确认并保存：广州，共4天，2026-10-01出发。已确认的行程会显示在座舱主页（当天的站点与提示）。说「行程取消掉」可以取消，继续说调整诉求仍可修改（改完需再次确认）。",
            "好的，我帮你看了一下。第一天从上海出发走沪昆高速到杭州，全程 3.5 小时，中途在嘉兴服务区休息一次；第二天游西湖和灵隐寺，晚上住西湖边；第三天返程，路上大约 4 小时。要我把它定下来吗？",
        ];
        for (i, t) in texts.iter().enumerate() {
            let parts = split_for_speech(t);
            println!("\n=== 文本 {} （{} 字 → {} 段）", i + 1, t.chars().count(), parts.len());
            let mut acc = 0.0f64;
            for (j, p) in parts.iter().enumerate() {
                let n = p.chars().count();
                let synth = 723.0 + 30.3 * n as f64;
                let play = 222.0 * n as f64;
                if j == 0 {
                    println!("  [{j}] {n:2} 字 合成 {synth:5.0} ms ← 首声延迟");
                    acc = play;
                } else {
                    let ok = if synth < acc { "接得上" } else { "会断!" };
                    println!("  [{j}] {n:2} 字 合成 {synth:5.0} ms / 前段可播 {acc:5.0} ms {ok}");
                    acc = play;
                }
                println!("       {p}");
            }
        }
    }

    /// 走查逼出来的最坏情况：极短的第一句 + 紧跟一个长句。
    /// 原实现会切出 2 字的首段，次段接不上，中间断 1.2 秒。
    #[test]
    fn 首段不会短到接不上_哪怕第一句只有两个字() {
        let text = "好。接下来这一句特意写得很长很长很长，长到装不进首段的上限里去，用来逼出提前封段那条路。再补一句收尾。";
        let parts = split_for_speech(&text);
        let first = parts[0].chars().count();
        assert!(first >= FIRST_MIN, "首段只有 {first} 字，次段接不上：{:?}", parts[0]);
        // 首段允许略超上限——那是为了保住下限而付的代价，但别离谱
        assert!(first <= FIRST_MIN + FIRST_MAX, "首段 {first} 字，超得太多");
        let synth = 723.0 + 30.3 * parts[1].chars().count() as f64;
        let play = 222.0 * first as f64;
        assert!(synth < play, "次段合成 {synth:.0} ms > 首段播放 {play:.0} ms，会断");
        assert_lossless(&text, &parts);
    }

    // ── 流式切句（第二步：边收边播）────────────────────────────

    /// 逐批喂进去，拼回来必须一字不差——**流式最容易在这里丢字**。
    fn feed(chunks: &[&str]) -> (Vec<String>, String) {
        let mut buf = String::new();
        let mut done = 0usize;
        let mut all = Vec::new();
        for c in chunks {
            buf.push_str(c);
            let (parts, tail) = take_complete(&buf, done);
            done += parts.len();
            all.extend(parts);
            buf = tail;
        }
        (all, buf)
    }

    #[test]
    fn 流式_半个小数不会被当成一段送出去() {
        // 「全程 3.」到手时不能送——车主会听到「全程三点」，5 小时在下一批。
        let (parts, tail) = take_complete("全程 3.", 0);
        assert!(parts.is_empty(), "不该送出去：{parts:?}");
        assert_eq!(tail, "全程 3.", "尾巴要原样留着，含那个点");
        let (parts, _) = take_complete("全程 3.5 小时，中途在嘉兴服务区休息一次。", 0);
        assert!(!parts.is_empty());
        assert!(parts[0].contains("3.5"), "凑齐了就不该再拆：{:?}", parts[0]);
    }

    #[test]
    fn 流式_尾巴一字不丢_含空格与换行() {
        let (parts, tail) = feed(&["好的，", "我帮你看了一下。", "第一天全程 ", "3.5 小时。"]);
        let joined = parts.concat() + &tail;
        assert_eq!(
            joined.replace(['\n', ' '], ""),
            "好的，我帮你看了一下。第一天全程3.5小时。".replace(' ', ""),
            "拼回原文（空白不计）"
        );
        assert!(joined.contains("3.5"), "小数没被拆：{joined}");
    }

    #[test]
    fn 流式_首段要够长才送_否则次段接不上() {
        // 「好的。」3 字，远低于下限：等。
        let (parts, tail) = take_complete("好的。", 0);
        assert!(parts.is_empty(), "首段太短不该送");
        assert_eq!(tail, "好的。");
        // 攒够了再送
        let (parts, _) = take_complete("好的。我帮你查了一下路线，大概要四个小时。", 0);
        assert!(!parts.is_empty());
        assert!(parts[0].chars().count() >= FIRST_MIN);
    }

    #[test]
    fn 流式_没有标点也不会无限等() {
        let long: String = "一".repeat(hard_cap(0) + 5);
        let (parts, _) = take_complete(&long, 0);
        assert!(!parts.is_empty(), "超过硬上限必须送，否则永远不出声");
    }

    #[test]
    fn 流式_与整段切出同一个首段() {
        // 同一句话，流式逐字喂 vs 整段切，首段应当一致——两条路的判据是同一份。
        let text = "好的，我帮你看了一下。第一天从上海出发走沪昆高速到杭州，全程 3.5 小时，中途在嘉兴服务区休息一次。";
        let whole = split_for_speech(text);
        let chunks: Vec<&str> = text.split_inclusive('，').collect();
        let (streamed, _) = feed(&chunks);
        assert_eq!(streamed.first(), whole.first(), "首段两条路要一致");
    }

    #[test]
    fn 流式_后续段用后续档的上限() {
        // done=2 时上限是 REST_MAX，不该再按首段的窄档切
        let text = "这是一句中等长度的话，用来检查后续段的上限是不是放开了，不要再按首段那档切。";
        let (parts, _) = take_complete(text, 2);
        if let Some(p) = parts.first() {
            assert!(p.chars().count() > FIRST_MAX, "后续段不该被首段上限卡住：{} 字", p.chars().count());
        }
    }

    #[test]
    fn 分段无损_多种真实文本() {
        for text in [
            "行程已确认并保存：广州，共4天，2026-10-01出发。已确认的行程会显示在座舱主页。说「行程取消掉」可以取消，继续说调整诉求仍可修改。",
            "前面十五公里是云龙湖旅游景区，按计划在这歇一下，预计十四点二十到。",
            "第一天：上海→杭州，四小时车程；第二天：西湖、灵隐寺；第三天：返程。",
        ] {
            let parts = split_for_speech(text);
            assert_lossless(text, &parts);
            assert!(!parts.is_empty());
        }
    }
}
