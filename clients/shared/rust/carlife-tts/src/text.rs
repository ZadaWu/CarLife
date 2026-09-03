//! 送合成前把 markdown 记号剥掉。**两条入口（正文/垫场）都要走它**——车机那边的
//! 教训是只在一条上剥，降级到 say 的那天那些记号会悄悄回来，被一字一字念出来。

/// 行首 `#`/`>`/列表记号、成对的 `**`/`__`/`*`/`_`/`` ` ``、`[文字](链接)` 只留文字。
pub fn strip_markdown_for_speech(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
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

#[cfg(test)]
mod tests {
    use super::strip_markdown_for_speech;

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
