//! 边收边播（M77 走查追修第二步，2026-09-12）。**默认关**，由后台
//! `TTS_STREAM_SPEECH` 经 `/v1/tts/config` 下发。
//!
//! # 它省的是另一段时间
//!
//! 第一步（`segment.rs`）解决的是"文字都到齐了，还要等 14 秒才出声"。
//! 而在那之前还有一段：模型把话说完本身就要十几秒。整段模式下这两段是串行的。
//!
//! 这里把它们叠起来：模型每吐出一句，就送去合成。首声约等于"模型说完第一句"，
//! 而不是"说完整段"。
//!
//! # 为什么敢拿 delta 去播
//!
//! 因为 delta **已经是脱敏后的文本**：runtime 那侧是 `createStreamRedactor()`
//! 逐片 push 的（`turn-runner.ts`），网关把 delta 累加成 `assistantText` 再落库，
//! 落库那份与播出去的这份**一字不差**。换句话说，边播不会念出最终正文里没有的东西。
//! 这条性质是本模块成立的前提，改动那条链路时要一起看。
//!
//! # 队列而不是"每句调一次 play"
//!
//! `play()` 的语义是"停掉正在播的，换成这一段"——一轮里调多次会互相掐断。
//! 所以流式走一条队列：句子陆续入队，一个消费任务顺序取、合成、播放。
//! 打断仍然只有一个入口（`stop()` 推代际），消费任务看到代际变了就整体退出。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

use super::{segment, strip_markdown_for_speech};

/// 一轮流式播报的全部状态。挂在 `TtsState` 上，一轮用完即 `reset`。
#[derive(Debug, Default)]
pub struct StreamSpeech {
    /// 还不成段的半句（下一批 delta 直接拼在它后面）。
    tail: Mutex<String>,
    /// 待播队列。
    queue: Mutex<VecDeque<String>>,
    /// 已经切出过几段——决定下一段用哪一档上限（首段窄、次段中、其余宽）。
    sent: AtomicUsize,
    /// 这一轮的文字到齐了（`turn_end`）。
    input_done: AtomicBool,
    /// 这一轮归哪一代。与 `TtsState::generation` 同一个值。
    generation: AtomicU64,
    /// 到目前为止**已经送去播**的全文。
    ///
    /// 回采判定要它：`is_echo` 找的是转写音节在播报文本里的连续子串，
    /// 而哨兵采到的一段常横跨两段边界——只给当前段，跨界的回采就找不到，
    /// 现象是"她自己把自己打断了"。
    spoken: Mutex<String>,
    /// 这一轮的 turnId。**turn_end 靠它判"这一轮是不是走了流式"**——
    /// 判错的后果是整段又播一遍（听到两遍）或者干脆不播，两种都很难查。
    ///
    /// **归属也是防重的唯一依据**：同一轮的后续 delta 看到 owns 为真就直接返回（幂等），
    /// 换轮时先 stop 再 begin，旧的消费任务看到代际变化自己退出。
    turn: Mutex<Option<String>>,
}

impl StreamSpeech {
    /// 一轮开始：清空上一轮的残留，认领这一代。
    pub fn begin(&self, generation: u64, turn_id: &str) {
        self.tail.lock().expect("stream poisoned").clear();
        self.queue.lock().expect("stream poisoned").clear();
        self.spoken.lock().expect("stream poisoned").clear();
        self.sent.store(0, Ordering::SeqCst);
        self.input_done.store(false, Ordering::SeqCst);
        self.generation.store(generation, Ordering::SeqCst);
        *self.turn.lock().expect("stream poisoned") = Some(turn_id.to_string());
    }

    /// 这一轮是不是本模块在播。
    pub fn owns(&self, turn_id: &str) -> bool {
        self.turn.lock().expect("stream poisoned").as_deref() == Some(turn_id)
    }

    /// 喂一段增量文本，把其中**已经成段**的部分入队。返回入队了几段。
    ///
    /// **只认当前这一轮的**：不是它的一律丢弃。少了这道门，上一轮的消费任务
    /// 还没退时，新一轮的句子会被推进旧队列，两轮的话连着播出来——
    /// 实测听感是"先说上一轮的结尾，再说这一轮的开头，中间还夹着别的"（2026-09-13）。
    pub fn push(&self, turn_id: &str, delta: &str) -> usize {
        if !self.owns(turn_id) {
            return 0;
        }
        let mut tail = self.tail.lock().expect("stream poisoned");
        tail.push_str(delta);
        let done = self.sent.load(Ordering::SeqCst);
        let (parts, rest) = segment::take_complete(&tail, done);
        *tail = rest;
        drop(tail);
        if parts.is_empty() {
            return 0;
        }
        let n = parts.len();
        self.sent.fetch_add(n, Ordering::SeqCst);
        let mut q = self.queue.lock().expect("stream poisoned");
        q.extend(parts);
        n
    }

    /// 这一轮的文字到齐了：把最后那半句也送进队列。
    ///
    /// `final_text` 是落库的那份正文。**它与累加的 delta 应当一字不差**
    /// （见模块头），不一致时以它为准补一次差额——宁可多播一点，
    /// 也不能让车主听到的比屏幕上少。
    pub fn finish(&self, turn_id: &str, final_text: Option<&str>) {
        // 迟到的 turn_end 不该把**新一轮**标成"说完了"——那会让新一轮的消费任务
        // 在文字还没到齐时就收场。
        if !self.owns(turn_id) {
            return;
        }
        let mut tail = self.tail.lock().expect("stream poisoned");
        if let Some(full) = final_text {
            let spoken = self.spoken.lock().expect("stream poisoned").clone();
            let played_and_queued: String = {
                let q = self.queue.lock().expect("stream poisoned");
                spoken + &q.iter().cloned().collect::<String>() + tail.as_str()
            };
            // 累加的 delta 比落库正文短（丢过片），差额补进尾巴。
            if full.chars().count() > played_and_queued.chars().count()
                && full.starts_with(played_and_queued.trim_end())
            {
                let extra: String = full.chars().skip(played_and_queued.chars().count()).collect();
                if !extra.trim().is_empty() {
                    eprintln!("[tts][stream] delta 比落库正文少 {} 字，补上", extra.chars().count());
                    tail.push_str(&extra);
                }
            }
        }
        let rest = tail.trim().to_string();
        tail.clear();
        drop(tail);
        if !rest.is_empty() {
            self.sent.fetch_add(1, Ordering::SeqCst);
            self.queue.lock().expect("stream poisoned").push_back(rest);
        }
        self.input_done.store(true, Ordering::SeqCst);
    }

    /// 取一段待播的；没有就 None（不阻塞）。
    pub fn try_take(&self) -> Option<String> {
        let seg = self.queue.lock().expect("stream poisoned").pop_front()?;
        let mut spoken = self.spoken.lock().expect("stream poisoned");
        spoken.push_str(&seg);
        Some(seg)
    }

    /// 到目前为止已送播的全文（回采比对的语料）。
    pub fn spoken_so_far(&self) -> String {
        self.spoken.lock().expect("stream poisoned").clone()
    }

    pub fn input_done(&self) -> bool {
        self.input_done.load(Ordering::SeqCst)
    }

    /// 打断：清队列、停止接收。**不清 `spoken`**——刚播出去的那些
    /// 还要留给回采比对用（用户此刻说的话正压着它们的尾音）。
    pub fn abandon(&self) {
        self.queue.lock().expect("stream poisoned").clear();
        self.tail.lock().expect("stream poisoned").clear();
        self.input_done.store(true, Ordering::SeqCst);
    }
}

/// 消费任务问"下一段呢"的三种回答。
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    Seg(String),
    /// 还没成段，等模型继续吐字。
    Wait,
    /// 文字到齐且队列确实空了——这一轮说完了。
    Done,
}

impl StreamSpeech {
    /// 取下一段。**"确实空了"要问两次**。
    ///
    /// `finish()` 的顺序是"先把最后半句入队、再置 input_done"；朴素的消费者读顺序是
    /// "先 try_take、再读 input_done"。两者之间有一个窗口：try_take 时队列还空，
    /// 等读到标志时 finish 已经把最后半句放进去了——于是直接 Done，那一句再也没人取。
    ///
    /// 现象正是"读不完就中断"，且**只在最后一句上发生**，最难和别的截断分开
    /// （2026-09-13 实测）。所以判 Done 之前再取一次。
    pub fn next_segment(&self) -> Next {
        if let Some(s) = self.try_take() {
            return Next::Seg(s);
        }
        if !self.input_done() {
            return Next::Wait;
        }
        match self.try_take() {
            Some(s) => Next::Seg(s),
            None => Next::Done,
        }
    }

    /// 取下一段**可以直接送去合成**的文本：记号已剥、剥完为空的段已跳过。
    ///
    /// # 为什么流式要单独剥一次
    ///
    /// 整段模式在 `play()` 的第一行就剥了，而流式这条路是
    /// `delta → 队列 → synthesize`，**根本不经过 `play()`**。
    /// 于是后台把 `TTS_STREAM_SPEECH` 打开之后，`**加粗**` 的星号、行首的 `- `
    /// 又被一字一字念出来了——而整段模式听起来完全正常，两条路只差这一步
    /// （2026-09-18 车机实测）。模块头那句"delta 与落库正文一字不差"说的是
    /// **内容**不差，它管不到记号。
    ///
    /// # 为什么剥在出队之后而不是入队之前
    ///
    /// 队列、`tail` 与 `spoken` 里存的必须仍是原文：`finish()` 拿落库正文补差额时
    /// 比的是字符数与前缀（`full.starts_with(played_and_queued)`），
    /// 一侧剥了另一侧没剥，那道安全网就永远不成立且不报错。
    /// 回采比对不受影响——`syllables()` 本来就把非汉字全丢掉。
    pub fn next_speech_segment(&self) -> Next {
        loop {
            match self.next_segment() {
                Next::Seg(s) => {
                    let clean = strip_markdown_for_speech(&s);
                    // 整段只有记号（`---`、单独一行的 `**`）：剥完是空的。
                    // 空文本送合成是白花一次钱，直接取下一段。
                    if clean.trim().is_empty() {
                        continue;
                    }
                    return Next::Seg(clean);
                }
                other => return other,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 逐批喂进去_成段的才入队_半句留着() {
        let s = StreamSpeech::default();
        s.begin(1, "t1");
        assert_eq!(s.push("t1", "好的，"), 0, "太短，等");
        assert_eq!(s.push("t1", "我帮你看了一下。"), 0, "11 字仍低于首段下限");
        assert!(s.push("t1", "第一天从上海出发走沪昆高速到杭州，") > 0, "够了，出段");
        let first = s.try_take().expect("有段");
        assert!(first.starts_with("好的，我帮你看了一下。"), "首段：{first}");
        assert!(first.chars().count() >= 12);
    }

    #[test]
    fn 小数不会在半路被送出去() {
        let s = StreamSpeech::default();
        s.begin(1, "t1");
        s.push("t1", "第一天全程 3.");
        // 此刻队列里不该有任何含"3."结尾的段
        assert!(s.try_take().is_none(), "半个小数不该送去合成");
        s.push("t1", "5 小时，中途在嘉兴服务区休息一次。");
        let seg = s.try_take().expect("凑齐了");
        assert!(seg.contains("3.5"), "小数被拆了：{seg}");
    }

    #[test]
    fn finish_把最后半句也送出去_并标记输入结束() {
        let s = StreamSpeech::default();
        s.begin(1, "t1");
        s.push("t1", "这一句足够长了，可以先送出去一段。");
        while s.try_take().is_some() {}
        s.push("t1", "还有半句没说完");
        assert!(!s.input_done());
        s.finish("t1", None);
        assert!(s.input_done());
        assert_eq!(s.try_take().as_deref(), Some("还有半句没说完"));
    }

    #[test]
    fn finish_按落库正文补差额_不让听到的比屏幕上少() {
        let s = StreamSpeech::default();
        s.begin(1, "t1");
        s.push("t1", "前半段已经到了，这里写够长度好让它成段。");
        let taken = s.try_take().unwrap_or_default();
        // 落库正文比 delta 多一截（模拟丢片）
        let full = format!("{taken}后面这一截 delta 没送到。");
        s.finish("t1", Some(&full));
        let rest = s.try_take().expect("补上的差额");
        assert!(rest.contains("后面这一截"), "差额没补：{rest}");
    }

    #[test]
    fn 送去合成的段不带markdown记号() {
        let s = StreamSpeech::default();
        s.begin(1, "t1");
        s.push(
            "t1",
            "好的，**里白酒店**评分`4.9`，离景区很近很方便。\n- 第一天先去越秀公园看看。",
        );
        s.finish("t1", None);
        let mut spoken = String::new();
        while let Next::Seg(seg) = s.next_speech_segment() {
            assert!(
                !seg.contains('*') && !seg.contains('`') && !seg.contains('#'),
                "记号进了合成文本：{seg}"
            );
            spoken.push_str(&seg);
        }
        assert!(spoken.contains("里白酒店"), "内容被剥掉了：{spoken}");
        assert!(spoken.contains("越秀公园"), "内容被剥掉了：{spoken}");
    }

    #[test]
    fn 整段只有记号的跳过_不白花一次合成() {
        let s = StreamSpeech::default();
        s.begin(1, "t1");
        // 分隔线自成一段：剥完是空的，不该送去合成，也不该被当成"这一轮说完了"。
        s.queue.lock().expect("stream poisoned").push_back("---".to_string());
        s.queue.lock().expect("stream poisoned").push_back("那就这么定了。".to_string());
        s.finish("t1", None);
        assert_eq!(s.next_speech_segment(), Next::Seg("那就这么定了。".to_string()));
        assert_eq!(s.next_speech_segment(), Next::Done);
    }

    #[test]
    fn spoken_累积全文_供回采比对跨段命中() {
        let s = StreamSpeech::default();
        s.begin(1, "t1");
        s.push("t1", "第一句话写得足够长可以成段。第二句话也写得足够长可以成段。");
        let mut all = String::new();
        while let Some(seg) = s.try_take() {
            all.push_str(&seg);
        }
        assert_eq!(s.spoken_so_far(), all, "spoken 必须等于已送播的全文");
        assert!(all.contains("第一句话"), "跨段回采要在这份语料里找得到");
    }

    #[test]
    fn 按_turn_id_判归属_短回答播完后仍认得出是流式() {
        let s = StreamSpeech::default();
        s.begin(7, "turn-a");
        assert!(s.owns("turn-a"));
        assert!(!s.owns("turn-b"), "别的轮不归它");
        // 消费任务早早退出（短回答）——归属判定不受它影响
        assert!(s.owns("turn-a"), "播完了也还是这一轮播的");
    }

    #[test]
    fn 置位与入队之间的窗口_不丢最后一句() {
        let s = StreamSpeech::default();
        s.begin(1, "t1");
        // 消费者问："下一段呢" → 还没成段，等
        assert_eq!(s.next_segment(), Next::Wait);
        // 此刻 turn_end 到了：finish 把最后半句入队并置位
        s.push("t1", "最后半句");
        s.finish("t1", None);
        // 消费者再问：必须拿到那一句，而不是 Done——丢的就是它
        assert_eq!(s.next_segment(), Next::Seg("最后半句".to_string()));
        assert_eq!(s.next_segment(), Next::Done);
    }

    #[test]
    fn 队列还有货时_input_done_也不算说完() {
        let s = StreamSpeech::default();
        s.begin(1, "t1");
        s.push("t1", "第一句话写得足够长可以成段。第二句话也写得足够长可以成段。");
        s.finish("t1", None);
        let mut got = 0;
        while let Next::Seg(_) = s.next_segment() {
            got += 1;
            assert!(got < 10, "取不完，死循环");
        }
        assert!(got >= 2, "只取到 {got} 段，队列里的没取干净");
        assert_eq!(s.next_segment(), Next::Done);
    }

    #[test]
    fn 换轮时_旧队列不收新轮的话() {
        let s = StreamSpeech::default();
        s.begin(1, "turn-a");
        s.push("turn-a", "第一轮的话写得足够长可以成段。");
        // 上一轮的消费任务还没退，新一轮的 delta 先到了——**不能进旧队列**
        s.push("turn-b", "第二轮的话也写得足够长可以成段。");
        let mut all = String::new();
        while let Next::Seg(x) = s.next_segment() {
            all.push_str(&x);
        }
        assert!(all.contains("第一轮"), "第一轮的话该在");
        assert!(!all.contains("第二轮"), "第二轮的话混进来了：{all}");
    }

    #[test]
    fn begin_换轮_清掉上一轮的残留() {
        let s = StreamSpeech::default();
        s.begin(1, "turn-a");
        s.push("turn-a", "第一轮排了一句足够长的话在队列里。还有第二句也足够长。");
        // 换轮：begin 清空，旧的一句都不许留下
        s.begin(2, "turn-b");
        assert!(!s.owns("turn-a"));
        assert!(s.owns("turn-b"));
        assert_eq!(s.next_segment(), Next::Wait, "旧队列该清空了");
        s.push("turn-b", "第二轮自己的话写得足够长可以成段。");
        assert!(matches!(s.next_segment(), Next::Seg(x) if x.contains("第二轮")));
    }

    #[test]
    fn finish_也只认当前这一轮() {
        let s = StreamSpeech::default();
        s.begin(1, "turn-a");
        s.push("turn-a", "半句");
        // 上一轮的 turn_end 迟到了，此时已经换到 turn-b
        s.begin(2, "turn-b");
        s.finish("turn-a", None);
        assert!(!s.input_done(), "迟到的 turn_end 不该把新一轮标成说完了");
    }


    #[test]
    fn 打断清队列但留下已播语料() {
        let s = StreamSpeech::default();
        s.begin(1, "t1");
        s.push("t1", "这一句足够长了，可以先送出去一段。后面还有一段也足够长可以成段。");
        let first = s.try_take().expect("有段");
        s.abandon();
        assert!(s.try_take().is_none(), "队列该清空");
        assert!(s.input_done(), "打断后不再等新文字");
        assert!(s.spoken_so_far().contains(&first), "已播语料要留着给回采比对");
    }
}
