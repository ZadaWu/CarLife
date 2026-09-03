//! ⑥用车流水的端上采集与上报（施工单 M11-01）。
//!
//! # POC 期这是**模拟触发**，不是真实车辆信号
//!
//! 真实采集要接车辆信号（点火/熄火、里程表、SOC），而 `vehicle_signal.rs` 目前是空的，
//! 本机也没有车。所以这里由界面上一个显式动作触发一段合成行程。
//!
//! **这件事必须在界面上说出来**（工单 M11-01 任务 2）：一个标着"上报行程"的按钮
//! 会让人以为系统在自动采集，而"以为在采集其实没有"正是⑥这类数据最坏的失真——
//! 画像会按一份不完整的样本算出看起来正常的数字。
//!
//! # 采集开关
//!
//! 关掉之后**不产生任何请求**（不是发出去再让服务端丢弃）。
//! 与播报开关同一形态：端上偏好、跨重启保持、放应用数据目录。

use std::sync::{Arc, Mutex};

use carlife_net::{GatewayClient, TripQueue, TripReport};
use tauri::{AppHandle, Manager, State};

/// 队列上限：车机可能连开数天不重启，无界队列在长时间断网后会吃满内存。
const QUEUE_CAPACITY: usize = 500;

pub struct TripState {
    queue: Mutex<TripQueue>,
    enabled: Mutex<bool>,
}

impl Default for TripState {
    fn default() -> Self {
        Self {
            queue: Mutex::new(TripQueue::with_capacity(QUEUE_CAPACITY)),
            // 默认开启：⑥是产品的核心数据。关闭的选择权在用户手里，
            // 但默认关闭会让绝大多数用户永远拿不到个性化，而他们并没有做过这个选择。
            enabled: Mutex::new(true),
        }
    }
}

impl TripState {
    pub fn is_enabled(&self) -> bool {
        *self.enabled.lock().expect("trip enabled poisoned")
    }
    pub fn set_enabled(&self, on: bool) {
        *self.enabled.lock().expect("trip enabled poisoned") = on;
    }
    pub fn load_prefs(&self, path: std::path::PathBuf) {
        if let Ok(s) = std::fs::read_to_string(&path) {
            self.set_enabled(s.trim() != "off");
        }
    }
    fn persist(&self, app: &AppHandle) {
        if let Some(p) = collect_pref_path(app) {
            let _ = std::fs::write(p, if self.is_enabled() { "on" } else { "off" });
        }
    }
}

pub fn collect_pref_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("trip-collect-pref"))
}

fn gateway_env() -> (String, String) {
    // 统一走设置层（ACR-004 第 3 步）：env → 端上持久化 → 默认。
    crate::settings::gateway()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushOutcome {
    pub accepted: usize,
    pub rejected: usize,
    /// 仍在队列里等下次重试的条数（网络失败时不为 0）。
    pub pending: usize,
    /// 因队列溢出被丢弃的累计条数——**要能被看到**。
    pub dropped: usize,
    pub note: String,
}

/// 采集开关。
#[tauri::command]
pub fn get_trip_collect_enabled(state: State<'_, Arc<TripState>>) -> bool {
    state.is_enabled()
}

#[tauri::command]
pub fn set_trip_collect_enabled(
    app: AppHandle,
    state: State<'_, Arc<TripState>>,
    enabled: bool,
) -> bool {
    state.set_enabled(enabled);
    state.persist(&app);
    enabled
}

/// 记录一段行程并尝试上报（POC 期由界面显式触发，见文件头）。
///
/// `id` 由这里生成一次，随行程进队列；**重试沿用同一个 id**——
/// 换 id 会让一次弱网重发变成两条重复行程，日均里程直接翻倍。
#[tauri::command]
pub async fn record_trip(
    state: State<'_, Arc<TripState>>,
    distance_km: f64,
    minutes: i64,
    road_type: Option<String>,
    ambient_temp_c: Option<f64>,
) -> Result<FlushOutcome, String> {
    if !state.is_enabled() {
        // 关掉就**不产生请求**，也不入队——入队等于"关了但攒着，一开就全发出去"，
        // 那不是用户关闭采集时期待的行为。
        return Ok(FlushOutcome {
            accepted: 0,
            rejected: 0,
            pending: state.queue.lock().map_err(|e| e.to_string())?.len(),
            dropped: state.queue.lock().map_err(|e| e.to_string())?.dropped(),
            note: "采集已关闭，本次未记录也未上报".into(),
        });
    }

    let now = chrono_now_ms();
    let trip = TripReport {
        id: format!("cockpit-{now}"),
        started_at: now - minutes.max(1) * 60_000,
        ended_at: now,
        distance_km,
        vin: None,
        road_type,
        ambient_temp_c,
        observed_range_km: None,
        charge: None,
    };
    state.queue.lock().map_err(|e| e.to_string())?.push(trip);

    flush(state).await
}

/// 把队列里的行程发出去。网络失败时**保留在队列里**等下次。
#[tauri::command]
pub async fn flush_trips(state: State<'_, Arc<TripState>>) -> Result<FlushOutcome, String> {
    flush(state).await
}

async fn flush(state: State<'_, Arc<TripState>>) -> Result<FlushOutcome, String> {
    let batch = { state.queue.lock().map_err(|e| e.to_string())?.peek_batch() };
    if batch.is_empty() {
        let q = state.queue.lock().map_err(|e| e.to_string())?;
        return Ok(FlushOutcome {
            accepted: 0,
            rejected: 0,
            pending: 0,
            dropped: q.dropped(),
            note: "队列为空".into(),
        });
    }

    let (base, token) = gateway_env();
    match GatewayClient::new(base, token).report_trips(&batch).await {
        Ok(res) => {
            // 被拒的也要 ack：它们是校验不通过的脏数据，重试多少次都一样，
            // 留在队列里只会让它永远清不空。
            let mut ids: Vec<String> = res.rejected.iter().map(|r| r.id.clone()).collect();
            ids.extend(
                batch
                    .iter()
                    .map(|t| t.id.clone())
                    .filter(|id| !res.rejected.iter().any(|r| &r.id == id)),
            );
            let mut q = state.queue.lock().map_err(|e| e.to_string())?;
            q.ack(&ids);
            let note = if res.rejected.is_empty() {
                "上报成功".into()
            } else {
                format!(
                    "部分被拒（不再重试）：{}",
                    res.rejected
                        .iter()
                        .map(|r| format!("{}: {}", r.id, r.reason))
                        .collect::<Vec<_>>()
                        .join("; ")
                )
            };
            Ok(FlushOutcome {
                accepted: res.accepted,
                rejected: res.rejected.len(),
                pending: q.len(),
                dropped: q.dropped(),
                note,
            })
        }
        Err(e) => {
            // 网络/5xx：**留在队列里**。这里返回 Ok 而不是 Err——
            // 断网不是错误，是常态；报错会让界面弹一个用户无从处理的失败。
            let q = state.queue.lock().map_err(|e| e.to_string())?;
            Ok(FlushOutcome {
                accepted: 0,
                rejected: 0,
                pending: q.len(),
                dropped: q.dropped(),
                note: format!("上报失败，已留在队列等下次重试：{e}"),
            })
        }
    }
}

fn chrono_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
