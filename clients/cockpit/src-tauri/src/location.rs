//! 定位授权与地图视图的读写口（车机端）。
//!
//! 本文件只有壳：判断、加工、落盘全在 `carlife_core::location` ——
//! 手机端 `clients/mobile/src-tauri/src/commands/location.rs` 是同一份壳的镜像，
//! **两端行为逐字一致**是这个功能的要求之一（同一个用户、同一份隐私承诺）。
//! 改这里必须同步改那里；真正的逻辑改在 core 里，两端自动一致。
//!
//! ⚠️ 权限门在 core 的 `record_fix` 里（未授权直接 `Err`），**不在这层**：
//! 放这层的话，手机端那份壳漏抄一行就是"关掉开关照样在记位置"，而且没有症状。

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use carlife_core::location::{LocationFix, LocationState, LocationStore, MapViewport, Precision};
use tauri::State;

/// epoch 毫秒（沿用 `commands/trips.rs` / `carlife-telemetry` 的同款）。
fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[tauri::command]
pub fn get_location_state(store: State<'_, Arc<LocationStore>>) -> LocationState {
    store.snapshot()
}

#[tauri::command]
pub fn set_location_enabled(store: State<'_, Arc<LocationStore>>, enabled: bool) -> LocationState {
    store.set_enabled(enabled, now_ms())
}

/// 粒度用字符串传：端上是 TS 的联合类型，认不出来时 core 回落 `coarse`
/// （拼错一个字母就升级成精确定位是最不该有的失败方向）。
#[tauri::command]
pub fn set_location_precision(
    store: State<'_, Arc<LocationStore>>,
    precision: String,
) -> LocationState {
    store.set_precision(Precision::parse(&precision), now_ms())
}

/// 记一次定位结果。坐标由 WebView 侧采集（系统/浏览器定位或高德 IP 定位），
/// **加工与授权判断在 Rust**——模糊粒度就是在这里丢掉小数位的。
#[tauri::command]
pub fn record_location_fix(
    store: State<'_, Arc<LocationStore>>,
    lat: f64,
    lon: f64,
    accuracy_m: f64,
    source: String,
) -> Result<LocationFix, String> {
    store.record_fix(lat, lon, accuracy_m, &source, now_ms())
}

#[tauri::command]
pub fn get_map_viewport(store: State<'_, Arc<LocationStore>>) -> Option<MapViewport> {
    store.viewport()
}

/// 记住"屏幕这一刻停在哪"。**与定位开关无关**：用户关掉定位不代表
/// 他愿意每次打开地图都回到深圳市中心。
#[tauri::command]
pub fn set_map_viewport(
    store: State<'_, Arc<LocationStore>>,
    lat: f64,
    lon: f64,
    zoom: f64,
) -> Result<MapViewport, String> {
    store.remember_viewport(lat, lon, zoom, now_ms())
}
