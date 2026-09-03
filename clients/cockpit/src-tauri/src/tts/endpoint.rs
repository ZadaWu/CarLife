//! 合成端点的端上缓存 —— 后台那个引擎开关的「最后一公里」。
//!
//! # 为什么端上要主动拉
//!
//! 合成客户端在端上（`carlife_net::TtsClient`），它原来只认本进程的环境变量。
//! 那意味着运营在后台把引擎从 mock 切到豆包之后，**要等到有人重启客户端才生效**——
//! 而车机是长跑进程，演示当天没人会去重启它。所以端上按 TTL 复查一次
//! `GET /v1/tts/config`，把 URL / 音色 / 资源 id 套到客户端上。
//!
//! # 拉不到时沿用旧值，而不是回落默认
//!
//! 网关抖一下就把端点重置成"默认"曾经是个很贵的错误：`TtsClient` 那时有个
//! 默认端点，而它是**豆包**，于是一次网络抖动会把一台本来跑 mock 的开发机
//! 悄悄接上计费引擎。ACR-018 之后端上**已经没有默认端点**（`TtsClient` 连
//! `new` 都没有了，URL 只能来自下发），这一半由类型系统兜着。
//!
//! 降级顺序不变，因为它还防着另一半——每次问不到都当"没有端点"会让一次
//! 网络抖动变成一次静音：新值 → 上一次的值（哪怕过期）→ `None`（本次不合成，
//! 交给调用方降级系统 say）。**降级的方向永远是更省的那个。**
//!
//! # 它绝不能拖住播报
//!
//! 与 `ducking.rs` 同一条纪律：播报是功能，配置刷新是装饰。这一跳带 1.5s 超时，
//! 超时即用旧值继续。**不要把它改成"拿不到就不播"**——那等于把一个诊断性
//! 的服务端调用接进了"助手还说不说话"的关键路径。

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
    let guard = CACHE.lock().expect("tts endpoint cache poisoned");
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
    *CACHE.lock().expect("tts endpoint cache poisoned") = None;
}

/// 当前该用的合成端点；`None` 表示服务端问不到且本地没有旧值。
///
/// **锁不跨 await**：命中判断与写回各自取一次锁，中间那次网络调用不持锁。
/// 写成"锁着去发请求"的话，一次网关卡顿会把所有想说话的任务一起挂住，
/// 现象是助手集体哑掉——而根因在一个名字里带 config 的文件里。
pub async fn effective() -> Option<TtsRuntimeConfig> {
    if let Some(cfg) = cached(false) {
        return Some(cfg);
    }

    // 统一走设置层（ACR-004 第 3 步）——iOS 没有环境变量，各自读 env 在 iPad 上必错。
    let (base_url, token) = crate::settings::gateway();

    let fetched = tokio::time::timeout(
        FETCH_TIMEOUT,
        GatewayClient::new(base_url, token).fetch_tts_config(),
    )
    .await;

    match fetched {
        Ok(Ok(cfg)) => {
            let changed = cached(true).is_none_or(|prev| prev.url != cfg.url);
            if changed {
                // 换端点是**要留痕的**：事后对账时"这段时间到底在用哪个引擎"
                // 只能靠这一行。计费与不计费的分界就在这里。
                eprintln!(
                    "[tts] 合成端点更新：{}（{}）{}",
                    cfg.engine,
                    cfg.url,
                    if cfg.billed { " ⚠️ 按合成字数计费" } else { "" }
                );
            }
            *CACHE.lock().expect("tts endpoint cache poisoned") = Some((cfg.clone(), Instant::now()));
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

    /// 串行闸：本模块的用例共享进程级的 `CACHE`，**必须一个一个来**。
    ///
    /// 不加这把锁的表现极难定位：单独跑过、`cargo test -p cockpit --bin cockpit`
    /// 全量跑也过、`--test-threads=1` 更是必过，**只在 `cargo test --workspace`
    /// 下偶发**——那时几十个测试二进制同时抢 CPU，调度一挤，
    /// `stale_entry_…` 写完 CACHE 还没断言，`fresh_entry_…` 的 `__reset()` 就把它抹了，
    /// 于是 `cached(true).unwrap()` 空指针一样地炸。2026-08-27 在 ACR-003 跑回归基线时
    /// 抓到一次，重跑六次全绿，差点被当成偶然。
    ///
    /// 用测试专用锁而不是把 `CACHE` 改成可注入：生产代码一行不动，
    /// 而这里要的只是"别同时跑"。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// 取串行闸。**中毒也照常拿**——某个用例 panic 后锁会被标记为 poisoned，
    /// 若在这里 `unwrap()`，后续用例会全部以 `PoisonError` 失败，
    /// 把"一个用例挂了"放大成"一片用例挂了"，真正的头一个失败反而淹没在噪声里。
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
        // TTL 1ms 且已过期：新鲜读拿不到，允许陈旧则拿得到。
        *CACHE.lock().unwrap() = Some((cfg("http://a", 1), Instant::now() - Duration::from_secs(1)));
        assert!(cached(false).is_none());
        assert_eq!(cached(true).unwrap().url, "http://a");
        __reset();
    }

    #[test]
    fn missing_refresh_ms_falls_back_to_default_ttl() {
        let _serial = serial();
        // 服务端漏发 refreshMs 时不能退化成"每次都拉"——那是每句播报一次往返。
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
