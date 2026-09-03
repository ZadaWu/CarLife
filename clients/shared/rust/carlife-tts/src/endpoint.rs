//! 合成端点的端上缓存 —— 后台那个引擎开关的「最后一公里」。
//!
//! 运营在后台把引擎从 mock 切到豆包之后不该等谁重启客户端才生效，所以端上按 TTL
//! 复查 `GET /v1/tts/config`。**拉不到时沿用旧值，而不是回落默认**：ACR-018 之后端上
//! 已经没有默认端点（`TtsClient` 连 `new` 都没有），一次网络抖动只能变成"这次不说"，
//! 不会变成"悄悄接上计费引擎"。降级顺序：新值 → 上一次的值（哪怕过期）→ `None`。
//!
//! 它绝不能拖住播报：这一跳带 1.5s 超时，超时即用旧值。**不要改成"拿不到就不播"**。
//!
//! 与车机那份的唯一差别：网关地址与设备 JWT 由调用方传进来（车机读 `crate::settings`，
//! 共享 crate 不能反向依赖端）。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use carlife_net::{GatewayClient, TtsRuntimeConfig};

/// 拉取超时。见文件头：宁可用旧值也不让播报等。
const FETCH_TIMEOUT: Duration = Duration::from_millis(1_500);
/// 服务端没给 `refreshMs` 时的兜底复查间隔。
const FALLBACK_TTL: Duration = Duration::from_secs(30);

static CACHE: Mutex<Option<(TtsRuntimeConfig, Instant)>> = Mutex::new(None);

fn ttl(cfg: &TtsRuntimeConfig) -> Duration {
    if cfg.refresh_ms == 0 {
        FALLBACK_TTL
    } else {
        Duration::from_millis(cfg.refresh_ms)
    }
}

fn cached(allow_stale: bool) -> Option<TtsRuntimeConfig> {
    let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let (cfg, at) = guard.as_ref()?;
    if allow_stale || at.elapsed() < ttl(cfg) {
        Some(cfg.clone())
    } else {
        None
    }
}

/// 仅供测试与重启：清掉缓存。
#[cfg(test)]
pub fn __reset() {
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 当前该用的合成端点；`None` 表示服务端问不到且本地没有旧值。
///
/// **锁不跨 await**：命中判断与写回各自取一次锁，中间那次网络调用不持锁——
/// 锁着去发请求的话，一次网关卡顿会把所有想说话的任务一起挂住。
pub async fn effective(base_url: &str, token: &str) -> Option<TtsRuntimeConfig> {
    if let Some(cfg) = cached(false) {
        return Some(cfg);
    }
    let fetched = tokio::time::timeout(
        FETCH_TIMEOUT,
        GatewayClient::new(base_url.to_string(), token.to_string()).fetch_tts_config(),
    )
    .await;
    match fetched {
        Ok(Ok(cfg)) => {
            let changed = cached(true).is_none_or(|prev| prev.url != cfg.url);
            if changed {
                // 换端点是要留痕的：事后对账"这段时间到底在用哪个引擎"只能靠这一行。
                eprintln!(
                    "[tts] 合成端点更新：{}（{}）{}",
                    cfg.engine,
                    cfg.url,
                    if cfg.billed { " ⚠️ 按合成字数计费" } else { "" }
                );
            }
            *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((cfg.clone(), Instant::now()));
            Some(cfg)
        }
        Ok(Err(e)) => {
            eprintln!("[tts] 取合成端点失败，沿用上一次的值：{e}");
            cached(true)
        }
        Err(_) => {
            eprintln!("[tts] 取合成端点超时（{FETCH_TIMEOUT:?}），沿用上一次的值");
            cached(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 串行闸：本模块的用例共享进程级的 `CACHE`，必须一个一个来（车机同款，
    /// 那边在 `cargo test --workspace` 下偶发过一次抢写）。中毒也照常拿。
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cfg(url: &str, refresh_ms: u64) -> TtsRuntimeConfig {
        TtsRuntimeConfig {
            engine: "mock".into(),
            url: url.into(),
            resource_id: "seed-tts-2.0".into(),
            speaker: "zh_female_vv_uranus_bigtts".into(),
            billed: false,
            refresh_ms,
        }
    }

    #[test]
    fn stale_entry_is_still_returned_when_allowed() {
        let _serial = serial();
        __reset();
        *CACHE.lock().unwrap() = Some((cfg("http://a", 1), Instant::now() - Duration::from_secs(1)));
        assert!(cached(false).is_none());
        assert_eq!(cached(true).unwrap().url, "http://a");
        __reset();
    }

    #[test]
    fn missing_refresh_ms_falls_back_to_default_ttl() {
        let _serial = serial();
        assert_eq!(ttl(&cfg("http://a", 0)), FALLBACK_TTL);
        assert_eq!(ttl(&cfg("http://a", 5_000)), Duration::from_millis(5_000));
    }

    #[test]
    fn fresh_entry_hits_cache() {
        let _serial = serial();
        __reset();
        *CACHE.lock().unwrap() = Some((cfg("http://b", 60_000), Instant::now()));
        assert_eq!(cached(false).unwrap().url, "http://b");
        __reset();
    }
}
