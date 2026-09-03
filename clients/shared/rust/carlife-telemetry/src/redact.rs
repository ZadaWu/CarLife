//! 写入前脱敏（§8.3 的端侧对应物）。
//!
//! # 为什么在写入时做，而不是发送时
//!
//! 崩溃转储、日志落盘、开发者查看缓冲——这些路径都绕过"发送"。
//! **没进过缓冲的东西，谁也带不走**；留到发送时再洗，等于给每条旁路各留一个口子。
//!
//! # 覆盖面与它的诚实边界
//!
//! 与服务端 §8.3 同口径：手机号 / 身份证 / 银行卡 / 邮箱四类。
//! **这四类之外它认不出来**——"体检""面试"这种敏感语义一个都不在其中。
//! 因此真正的隐私保证靠的是"根本不往埋点里塞用户话术"，脱敏只是最后一道网。

/// 把常见 PII 替换成占位符。返回是否改动过，便于调用方在测试里断言。
pub fn redact(input: &str) -> String {
    let mut s = input.to_string();
    s = redact_digits(&s, 11, is_cn_mobile, "[手机号]");
    s = redact_digits(&s, 18, is_cn_id, "[身份证]");
    // 银行卡放在身份证之后：16~19 位里含 18 位，先判身份证才不会把它吃掉
    s = redact_digits(&s, 16, |d| (16..=19).contains(&d.len()), "[银行卡]");
    redact_email(&s)
}

fn is_cn_mobile(d: &str) -> bool {
    d.len() == 11 && d.starts_with('1') && d.as_bytes()[1] >= b'3' && d.as_bytes()[1] <= b'9'
}

fn is_cn_id(d: &str) -> bool {
    d.len() == 18
}

/// 扫描连续数字段，命中判定则整段替换。
///
/// 手写扫描而不是引正则依赖：本 crate 目前零依赖，为四条规则引入 `regex`
/// 会把它变成端上二进制里最大的一块。
fn redact_digits(input: &str, min_len: usize, is_match: fn(&str) -> bool, tag: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            let run: String = chars[start..i].iter().collect();
            if run.len() >= min_len && is_match(&run) {
                out.push_str(tag);
            } else {
                out.push_str(&run);
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn redact_email(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for (idx, token) in input.split_inclusive(|c: char| c.is_whitespace()).enumerate() {
        let _ = idx;
        let trimmed = token.trim_end();
        let tail = &token[trimmed.len()..];
        if looks_like_email(trimmed) {
            out.push_str("[邮箱]");
            out.push_str(tail);
        } else {
            out.push_str(token);
        }
    }
    out
}

fn looks_like_email(s: &str) -> bool {
    let Some(at) = s.find('@') else { return false };
    let (local, domain) = s.split_at(at);
    let domain = &domain[1..];
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('@')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_cn_mobile() {
        assert_eq!(redact("联系 13800138000 试驾"), "联系 [手机号] 试驾");
    }

    #[test]
    fn keeps_non_pii_numbers() {
        // 里程、SOC、时间戳这些必须原样留下——脱敏过头会让埋点失去诊断价值
        assert_eq!(redact("里程 12345 公里"), "里程 12345 公里");
        assert_eq!(redact("剩余 80%"), "剩余 80%");
    }

    #[test]
    fn masks_id_before_bank_card() {
        // 18 位既满足身份证也落在银行卡的 16~19 区间，顺序错了会打成 [银行卡]
        assert_eq!(redact("证件 110101199003078888"), "证件 [身份证]");
    }

    #[test]
    fn masks_bank_card() {
        assert_eq!(redact("卡号 6222020200112345678"), "卡号 [银行卡]");
    }

    #[test]
    fn masks_email() {
        assert_eq!(redact("发到 a.b@example.com 谢谢"), "发到 [邮箱] 谢谢");
    }

    #[test]
    fn leaves_plain_text_untouched() {
        let s = "HUD 进入 listening 态";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn documented_blind_spot() {
        // 明确记下这条：语义敏感内容它认不出来。真正的保证是不往埋点里塞用户话术。
        let s = "用户说他要去做体检";
        assert_eq!(redact(s), s);
    }
}
