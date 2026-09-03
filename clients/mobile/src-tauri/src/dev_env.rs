//! 开发期环境加载（手机端；与 `clients/cockpit/src-tauri/src/dev_env.rs` 逐字一致，
//! 改一处必须同步改另一处）：把仓库根 `.env` 里**属于客户端的那几项**读进进程环境。
//!
//! 仅服务于 `tauri dev`（免去每次手动 source）。已存在的环境变量优先，
//! 不覆盖外部注入。打包分发时环境由运行环境提供，此逻辑找不到文件即静默跳过。
//!
//! # 为什么是白名单，不是"整份 .env 灌进来"
//!
//! 原来这里逐行 `set_var`，**不区分是谁的配置**。而仓库根那份 `.env` 有 52 项，
//! 其中约 87% 是纯服务端的：`DATABASE_URL`、`CARLIFE_JWT_SECRET`、
//! `CARLIFE_PII_MASTER_KEY`、`DEEPSEEK_API_KEY`、阿里云与火山的 AK/SK、
//! S3 凭证……它们**全都会进到客户端进程的环境空间里**。
//!
//! 客户端代码不读它们不等于安全：环境变量对整个进程可见，
//! 一次内存转储、一个第三方 crate 的 debug 打印、一份崩溃报告就够了。
//! 车机与手机是**面向车主的消费端**，它们只该知道一件事——网关在哪。
//!
//! 所以改成白名单：**只有这里列出的键会被载入，其余一律忽略并计数。**
//! 加新的客户端配置项要主动来这里加一行——这个"麻烦"正是它的作用：
//! 让"往客户端塞一个服务端配置"变成一个需要动手的、看得见的动作。

use std::path::PathBuf;

/// 客户端自己的配置项。**只增不滥**：新增前先问一句"车主的设备为什么要知道它"。
const CLIENT_KEYS: &[&str] = &[
    // 网关在哪——客户端唯一必需的配置（`settings.rs`，取值顺序见那里）。
    "CARLIFE_GATEWAY_URL",
    // 端侧播报/语音的本地开关与调参，都是"这台设备怎么表现"，与服务端无关。
    "CARLIFE_TTS_SAY_VOICE",
    "CARLIFE_AEC_ENABLED",
    "CARLIFE_AEC_DELAY_MS",
    "CARLIFE_SENTINEL_DEBUG",
    // 已废弃但仍要读到才能打那句告警（`lib.rs`，ACR-017）。
    // 不载入的话告警永远不触发，而 `.env` 里那行会一直留着误导人。
    "CARLIFE_TTS",
];

/// 载入结果，仅用于启动横幅。
struct Loaded {
    taken: usize,
    ignored: usize,
}

pub fn load_repo_env() {
    // 编译期已知的 crate 目录 → 仓库根（clients/mobile/src-tauri → ../../..）
    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.env"),
        PathBuf::from(".env"),
    ];
    for path in candidates {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let stat = apply(&content);
        /*
         * 把"忽略了多少"打出来。这行不是装饰：它是"白名单确实在起作用"的
         * 唯一现场证据，也让人一眼看到客户端进程里**没有**那几十项服务端密钥。
         */
        eprintln!(
            "[dev-env] 载入 {} 项客户端配置，忽略 {} 项（服务端配置不进客户端进程）",
            stat.taken, stat.ignored
        );
        return;
    }
}

/// 纯函数芯：解析 + 按白名单注入，返回计数（可单测，不依赖仓库里那份 .env）。
fn apply(content: &str) -> Loaded {
    let mut taken = 0;
    let mut ignored = 0;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !CLIENT_KEYS.contains(&key) {
            ignored += 1;
            continue;
        }
        let value = value.trim().trim_matches('"');
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
        taken += 1;
    }
    Loaded { taken, ignored }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单的全部契约：列上的进来，没列的一个都不进来。
    /// 这条断言的价值在于它挡住的那类改动——"顺手把某个 key 也载进来吧"。
    #[test]
    fn 服务端配置不会进客户端进程() {
        let env = "\
# 注释行
DATABASE_URL=\"postgres://u:p@h/db\"
CARLIFE_JWT_SECRET=\"super-secret\"
DEEPSEEK_API_KEY=\"sk-xxx\"
CARLIFE_GATEWAY_URL=\"http://127.0.0.1:8790\"
";
        let stat = apply(env);
        assert_eq!(stat.taken, 1, "只有 CARLIFE_GATEWAY_URL 该被载入");
        assert_eq!(stat.ignored, 3, "另外三项是服务端的，必须被忽略");
        // 关键断言：进程环境里不该出现它们（本测试进程即客户端进程的替身）。
        for key in ["DATABASE_URL", "CARLIFE_JWT_SECRET", "DEEPSEEK_API_KEY"] {
            assert!(
                std::env::var_os(key).is_none(),
                "{key} 不该出现在客户端进程环境里"
            );
        }
    }

    /// 白名单里不许出现 vendor 密钥。写死这条断言是因为"临时加一下"最容易发生
    /// 在赶演示的时候，而它的代价要到很久以后才显形。
    #[test]
    fn 白名单里没有任何供应商密钥() {
        for key in CLIENT_KEYS {
            let k = key.to_ascii_uppercase();
            assert!(
                !k.contains("KEY") && !k.contains("SECRET") && !k.contains("TOKEN"),
                "{key} 看起来是凭证——客户端不持有任何 vendor 凭证"
            );
        }
    }
}
