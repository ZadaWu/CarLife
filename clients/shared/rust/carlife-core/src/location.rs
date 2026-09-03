//! 端上定位状态：授权（能不能知道你在哪）与地图视图（屏幕上次停在哪）。
//!
//! # 两件事，一个文件，一条分界
//!
//! - **授权** `LocationConsent`：总开关 + 粒度（精确 / 模糊）。关掉之后端上
//!   不再发起任何定位，**已经存下的坐标也一并丢掉**。
//! - **地图视图** `MapViewport`：用户自己拖出来的那一格地图，**与他在哪无关**。
//!   所以 `set_enabled(false)` 绝不能把它一起清掉——那会把"我不想被定位"
//!   变成"每次开地图都回到深圳市中心"。`关闭定位不清地图视图` 那条单测钉的就是它。
//!
//! # 为什么在 carlife-core 而不是各端各写一份
//!
//! 车机与手机的这套行为必须**逐字一致**（同一个用户、同一份预期）。偏好读写
//! 这类小逻辑此前是各端各抄一遍（`commands/prefs.rs` 与 `commands/profile.rs`），
//! 抄的那两份现在已经不一样了。定位涉及隐私承诺，不适合再来一次。
//! 各端只剩 `#[tauri::command]` 那层壳。
//!
//! # 时间戳为什么是毫秒不是 ISO
//!
//! 这个 crate 不依赖 chrono，而**自己编一个假的 ISO 串比不写时间更糟**。
//! 沿用仓库既有约定（`carlife-telemetry::now_ms`、`commands/trips.rs`）存
//! epoch 毫秒，ISO 由 WebView 侧在边界上转——那一侧本来就有时钟与 Intl。
//!
//! # 与 `clients/*/src-tauri/src/settings.rs` 的分工
//!
//! 那边是"网关在哪"（连不上就什么都没有，必须先于一切存在）；这边是
//! "能不能定位、上次地图停在哪"。两份文件、两个 JSON，互不影响启动。

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 模糊定位的网格边长（度）。0.01° ≈ 纬向 1.11 km。
///
/// ⚠️ 与 `contracts/src/domain/location.ts` 的 `COARSE_GRID_DEG` 必须同值。
pub const COARSE_GRID_DEG: f64 = 0.01;

/// 模糊定位对外声明的最小精度（米）。取整后的最大偏差约 757 m，
/// 报 1100 是宁可说得更不准——报 12 m 会让上层拿模糊坐标去画米级的圈。
///
/// ⚠️ 与 TS 侧 `COARSE_MIN_ACCURACY_M` 必须同值。
pub const COARSE_MIN_ACCURACY_M: f64 = 1100.0;

/// 缩放上下限。⚠️ 与 TS 侧 `MAP_ZOOM_MIN/MAX` 必须同值。
pub const MAP_ZOOM_MIN: f64 = 3.0;
pub const MAP_ZOOM_MAX: f64 = 20.0;

/// 授权粒度。序列化成 `"coarse"` / `"precise"`，与 TS 侧 `LocationPrecision` 同形。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Precision {
    /// 先按网格取整再交出去。**不是"精度差一点的 GPS"，是一次有意的信息丢弃。**
    #[default]
    Coarse,
    Precise,
}

impl Precision {
    /// 从端上传来的字符串解析。**认不出来一律回落 `Coarse`**：
    /// 拼错一个字母就升级成精确定位，是这个模块最不该有的失败方向。
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "precise" => Precision::Precise,
            _ => Precision::Coarse,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Precision::Coarse => "coarse",
            Precision::Precise => "precise",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationConsent {
    pub enabled: bool,
    pub precision: Precision,
    /// 用户最后一次做出选择的 epoch 毫秒。没选过 = `None`（此刻用的是默认值）。
    pub decided_at_ms: Option<i64>,
}

impl Default for LocationConsent {
    /// **默认关、默认模糊**：默认开的话，用户第一次打开 App 就已经被定位过一次，
    /// "允许用户授权"这句话就成了摆设。
    fn default() -> Self {
        Self { enabled: false, precision: Precision::Coarse, decided_at_ms: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationFix {
    pub lat: f64,
    pub lon: f64,
    /// 水平精度（米）。`coarse` 下不小于 [`COARSE_MIN_ACCURACY_M`]。
    pub accuracy_m: f64,
    pub precision: Precision,
    /// 来源（`gps` / `network` / `ip` / `manual`）。只用于如实告诉用户这个位置怎么来的。
    pub source: String,
    pub at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapViewport {
    pub lat: f64,
    pub lon: f64,
    pub zoom: f64,
    pub at_ms: Option<i64>,
}

/// 落盘的那一份整体。
///
/// `#[serde(default)]` 是给**升级中间态**准备的：老版本写的文件缺新字段时，
/// 缺的那几项走默认值，而不是整份解析失败——整份失败的表现是
/// "升级之后地图视图丢了"，而那正是这个功能要解决的问题本身。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocationState {
    pub consent: LocationConsent,
    pub viewport: Option<MapViewport>,
    /// 最近一次定位结果。**关掉定位时清空**（见文件头）。
    pub last_fix: Option<LocationFix>,
}

/// 按 [`COARSE_GRID_DEG`] 网格吸附。
///
/// 四舍五入而不是截断：截断会让整格里的点都偏向西南角，连续采样看起来
/// 像"位置总往一个方向漂"。
pub fn coarsen(lat: f64, lon: f64) -> (f64, f64) {
    let snap = |v: f64| {
        let g = (v / COARSE_GRID_DEG).round() * COARSE_GRID_DEG;
        // 乘除会留下 0.30000000000000004 这类尾巴，落进 JSON 既难看又难比对。
        (g * 1e6).round() / 1e6
    };
    (snap(lat), snap(lon))
}

/// 坐标是否落在地球上。脏坐标进了存储，下次恢复就是一张空白图，
/// 而空白图与"地图没加载出来"长得一模一样。
pub fn is_valid_lat_lon(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite() && (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)
}

/// 按授权粒度加工一次原始定位结果。**所有交给上层的 fix 都必须过这一道。**
pub fn apply_precision(
    lat: f64,
    lon: f64,
    accuracy_m: f64,
    source: &str,
    at_ms: i64,
    precision: Precision,
) -> LocationFix {
    match precision {
        Precision::Precise => LocationFix {
            lat,
            lon,
            accuracy_m: accuracy_m.max(0.0),
            precision,
            source: source.to_string(),
            at_ms,
        },
        Precision::Coarse => {
            let (lat, lon) = coarsen(lat, lon);
            LocationFix {
                lat,
                lon,
                accuracy_m: accuracy_m.max(COARSE_MIN_ACCURACY_M),
                precision,
                source: source.to_string(),
                at_ms,
            }
        }
    }
}

/// 端上定位状态的持久化。
///
/// 写失败**不回滚内存值**：开关在本次会话内已经生效，回滚成旧值会让用户
/// 看到"点了没反应"，比"重启后没保持住"更糟（与 `commands/profile.rs` 同一条纪律）。
pub struct LocationStore {
    path: Option<PathBuf>,
    state: Mutex<LocationState>,
}

impl LocationStore {
    /// 从文件载入。**文件不存在 / 损坏 / 半截一律按"没配过"处理**——
    /// 设置页还能救回来，启动崩溃就什么都救不了（与 `settings::init` 同形）。
    pub fn open(path: PathBuf) -> Self {
        let state = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<LocationState>(&s).ok())
            .unwrap_or_default();
        // 存进来的视图也要过校验：上一版写的、或被手改过的脏值不许进入恢复路径。
        let state = LocationState { viewport: state.viewport.and_then(sanitize_viewport), ..state };
        Self { path: Some(path), state: Mutex::new(state) }
    }

    /// 不落盘的实例（单测与"拿不到 app 数据目录"时用）。
    pub fn in_memory() -> Self {
        Self { path: None, state: Mutex::new(LocationState::default()) }
    }

    pub fn snapshot(&self) -> LocationState {
        self.state.lock().expect("location store poisoned").clone()
    }

    pub fn consent(&self) -> LocationConsent {
        self.snapshot().consent
    }

    /// 开 / 关定位。
    ///
    /// **关掉时清空 `last_fix`**：用户关掉定位的意思是"别再知道我在哪"，
    /// 而不是"别再更新我在哪"。`viewport` 不动——它不是定位数据。
    pub fn set_enabled(&self, enabled: bool, now_ms: i64) -> LocationState {
        let mut guard = self.state.lock().expect("location store poisoned");
        guard.consent.enabled = enabled;
        guard.consent.decided_at_ms = Some(now_ms);
        if !enabled {
            guard.last_fix = None;
        }
        let snapshot = guard.clone();
        drop(guard);
        self.persist(&snapshot);
        snapshot
    }

    /// 切换粒度。
    ///
    /// **从精确降到模糊时，把已经存着的那个精确坐标也降级**——否则"我改成模糊了"
    /// 之后，屏幕上和存储里躺着的仍然是刚才那个米级坐标，且没有任何症状。
    pub fn set_precision(&self, precision: Precision, now_ms: i64) -> LocationState {
        let mut guard = self.state.lock().expect("location store poisoned");
        guard.consent.precision = precision;
        guard.consent.decided_at_ms = Some(now_ms);
        if let Some(fix) = guard.last_fix.take() {
            guard.last_fix =
                Some(apply_precision(fix.lat, fix.lon, fix.accuracy_m, &fix.source, fix.at_ms, precision));
        }
        let snapshot = guard.clone();
        drop(guard);
        self.persist(&snapshot);
        snapshot
    }

    /// 记一次定位结果。
    ///
    /// 三道闸门，顺序不能换：
    ///  1. **没授权直接拒**——权限门在存储这一层也要有一道，不能只靠 UI 不去调；
    ///  2. 脏坐标拒；
    ///  3. 按当前粒度加工（模糊即在这里丢掉小数位）。
    pub fn record_fix(
        &self,
        lat: f64,
        lon: f64,
        accuracy_m: f64,
        source: &str,
        at_ms: i64,
    ) -> Result<LocationFix, String> {
        let mut guard = self.state.lock().expect("location store poisoned");
        if !guard.consent.enabled {
            return Err("定位已停用".into());
        }
        if !is_valid_lat_lon(lat, lon) {
            return Err("坐标不合法".into());
        }
        let fix = apply_precision(lat, lon, accuracy_m, source, at_ms, guard.consent.precision);
        guard.last_fix = Some(fix.clone());
        let snapshot = guard.clone();
        drop(guard);
        self.persist(&snapshot);
        Ok(fix)
    }

    pub fn viewport(&self) -> Option<MapViewport> {
        self.snapshot().viewport
    }

    /// 记住"屏幕这一刻停在哪"。**不看授权开关**——见文件头那条分界。
    pub fn remember_viewport(
        &self,
        lat: f64,
        lon: f64,
        zoom: f64,
        at_ms: i64,
    ) -> Result<MapViewport, String> {
        let candidate = MapViewport { lat, lon, zoom, at_ms: Some(at_ms) };
        let Some(viewport) = sanitize_viewport(candidate) else {
            return Err("地图视图不合法".into());
        };
        let mut guard = self.state.lock().expect("location store poisoned");
        guard.viewport = Some(viewport.clone());
        let snapshot = guard.clone();
        drop(guard);
        self.persist(&snapshot);
        Ok(viewport)
    }

    fn persist(&self, state: &LocationState) {
        let Some(path) = self.path.as_ref() else { return };
        let Ok(json) = serde_json::to_string_pretty(state) else { return };
        // 写失败只丢"跨重启保持"，不影响本次会话——见结构体文档。
        let _ = std::fs::write(path, json);
    }
}

impl Default for LocationStore {
    fn default() -> Self {
        Self::in_memory()
    }
}

/// 校验 + 夹缩放。越界的 zoom **夹回区间而不是整份丢掉**：
/// 丢掉的话用户回到深圳市中心，夹回去只是缩放差一档，中心还在他自己那儿。
fn sanitize_viewport(v: MapViewport) -> Option<MapViewport> {
    if !is_valid_lat_lon(v.lat, v.lon) || !v.zoom.is_finite() {
        return None;
    }
    Some(MapViewport { zoom: v.zoom.clamp(MAP_ZOOM_MIN, MAP_ZOOM_MAX), ..v })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("carlife-location-{}-{}.json", tag, std::process::id()))
    }

    #[test]
    fn 默认关且默认模糊() {
        let c = LocationConsent::default();
        assert!(!c.enabled, "默认开 = 用户还没授权就已经被定位过一次");
        assert_eq!(c.precision, Precision::Coarse);
    }

    #[test]
    fn 粒度认不出来时回落模糊() {
        assert_eq!(Precision::parse("precise"), Precision::Precise);
        assert_eq!(Precision::parse("PRECISE"), Precision::Precise);
        // 拼错一个字母就升级成精确定位，是这个模块最不该有的失败方向。
        assert_eq!(Precision::parse("percise"), Precision::Coarse);
        assert_eq!(Precision::parse(""), Precision::Coarse);
    }

    #[test]
    fn 模糊定位必须丢掉小数位且不许自称米级() {
        let fix = apply_precision(22.543123, 114.057912, 12.0, "gps", 1, Precision::Coarse);
        assert_ne!(fix.lat, 22.543123, "模糊定位交出了精确坐标——这种坏法没有任何症状");
        assert_eq!(fix.lat, 22.54);
        assert_eq!(fix.lon, 114.06);
        assert_eq!(fix.accuracy_m, COARSE_MIN_ACCURACY_M);
    }

    #[test]
    fn 网格常量与ts侧对齐() {
        // 两侧各一份常量，改一边忘另一边的表现是"车机模糊、手机精确"。
        assert_eq!(COARSE_GRID_DEG, 0.01);
        assert_eq!(COARSE_MIN_ACCURACY_M, 1100.0);
        assert_eq!((MAP_ZOOM_MIN, MAP_ZOOM_MAX), (3.0, 20.0));
    }

    #[test]
    fn 未授权时拒绝记录坐标() {
        let store = LocationStore::in_memory();
        assert!(store.record_fix(22.5, 114.0, 10.0, "gps", 1).is_err());
        store.set_enabled(true, 1);
        assert!(store.record_fix(22.5, 114.0, 10.0, "gps", 2).is_ok());
    }

    #[test]
    fn 关闭定位清掉坐标但不清地图视图() {
        let store = LocationStore::in_memory();
        store.set_enabled(true, 1);
        store.set_precision(Precision::Precise, 1);
        store.record_fix(31.23, 121.47, 8.0, "gps", 2).unwrap();
        store.remember_viewport(31.23, 121.47, 15.0, 3).unwrap();

        store.set_enabled(false, 4);
        let s = store.snapshot();
        assert!(s.last_fix.is_none(), "关掉定位 = 别再知道我在哪");
        assert!(
            s.viewport.is_some(),
            "地图视图是用户自己拖出来的，与定位无关——清掉它=每次开图都回深圳",
        );
        assert_eq!(s.viewport.unwrap().zoom, 15.0);
    }

    #[test]
    fn 降级到模糊会把已存的精确坐标一起降级() {
        let store = LocationStore::in_memory();
        store.set_enabled(true, 1);
        store.set_precision(Precision::Precise, 1);
        store.record_fix(22.543123, 114.057912, 8.0, "gps", 2).unwrap();

        store.set_precision(Precision::Coarse, 3);
        let fix = store.snapshot().last_fix.unwrap();
        assert_eq!(fix.lat, 22.54, "改成模糊之后，存储里还躺着刚才那个米级坐标");
        assert_eq!(fix.precision, Precision::Coarse);
    }

    #[test]
    fn 脏视图不进存储越界缩放夹回区间() {
        let store = LocationStore::in_memory();
        assert!(store.remember_viewport(999.0, 114.0, 12.0, 1).is_err());
        assert!(store.remember_viewport(f64::NAN, 114.0, 12.0, 1).is_err());
        let v = store.remember_viewport(31.2, 121.5, 999.0, 1).unwrap();
        assert_eq!(v.zoom, MAP_ZOOM_MAX);
        assert_eq!(v.lat, 31.2, "缩放越界不该连中心一起丢");
    }

    #[test]
    fn 跨重启保持视图与授权() {
        let path = temp_path("roundtrip");
        let _ = std::fs::remove_file(&path);
        {
            let store = LocationStore::open(path.clone());
            store.set_enabled(true, 10);
            store.set_precision(Precision::Precise, 10);
            store.remember_viewport(39.9, 116.4, 14.0, 11).unwrap();
        }
        let reopened = LocationStore::open(path.clone());
        let s = reopened.snapshot();
        assert!(s.consent.enabled);
        assert_eq!(s.consent.precision, Precision::Precise);
        let v = s.viewport.expect("上次的地图视图应当还在");
        assert_eq!((v.lat, v.lon, v.zoom), (39.9, 116.4, 14.0));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn 文件损坏按没配过处理而不是崩溃() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "{ 这不是 JSON").unwrap();
        let store = LocationStore::open(path.clone());
        assert_eq!(store.snapshot(), LocationState::default());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn 老版本写的半截文件只丢缺的那几项() {
        // 升级中间态：整份解析失败的表现正是"升级之后地图视图丢了"。
        let path = temp_path("partial");
        std::fs::write(&path, r#"{"viewport":{"lat":30.0,"lon":120.0,"zoom":13.0}}"#).unwrap();
        let store = LocationStore::open(path.clone());
        let s = store.snapshot();
        assert_eq!(s.viewport.unwrap().lat, 30.0);
        assert!(!s.consent.enabled, "缺的那项走默认，而不是整份失败");
        let _ = std::fs::remove_file(path);
    }
}
