//! ⑥用车流水上报（施工单 M11-01，§7⑥ 两段式的第一段）。
//!
//! # 为什么在 carlife-net 而不是 carlife-telemetry
//!
//! 两者管的不是同一件事，名字容易让人以为是：
//!  - `carlife-telemetry` 是**崩溃与诊断埋点**，且它的文件头明确写了刻意不含网络发送
//!    （"发明一个上传协议会让端侧埋点已完成这句话在没人接收的情况下成立"）；
//!  - 本模块是**业务数据**：行程里程、路况、充电 SOC，服务端有明确的接收端点
//!    （`POST /v1/telemetry/trips`）与消费方（双路检索的第二路、用车画像聚合）。
//!
//! 端点路径里的 "telemetry" 是网关侧的命名，与那个 crate 无关。
//!
//! # id 由端上生成，且重试时必须不变
//!
//! 服务端 `append` 是 upsert 语义——**这是幂等的全部依赖**。
//! 若每次重试换一个 id，一次弱网重发就会变成两条重复行程，
//! 而重复行程会把日均里程直接算成两倍（服务端算不出这是重复，它只看到两段路）。
//! 所以 id 在**行程记录产生时**生成一次，随行程一起排队，重试沿用同一个。

use serde::{Deserialize, Serialize};

use crate::upload::{GatewayClient, NetError};

/// 一段行程。字段与服务端 `TripInput` 对齐（camelCase 上线）。
///
/// **不含 userId**：归属由服务端按鉴权上下文注入，端上给了也会被丢弃。
/// 这不是冗余保护——它意味着端上无法（也不需要）知道自己是谁，少一处能写错的地方。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TripReport {
    /// 端上生成的稳定 id；重试沿用。
    pub id: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub distance_km: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vin: Option<String>,
    /// `city` / `highway` / `mixed`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub road_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ambient_temp_c: Option<f64>,
    /// 本次行程折算的满电续航表现（km）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_range_km: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charge: Option<ChargeSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChargeSegment {
    pub start_soc: f64,
    pub end_soc: f64,
    pub at: i64,
}

/// 服务端逐条结果。**部分成功是正常返回**，不是错误。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TripReportResult {
    pub accepted: usize,
    pub rejected: Vec<RejectedTrip>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RejectedTrip {
    pub id: String,
    pub reason: String,
}

/// 单批上限，与服务端 `MAX_BATCH` 对齐。超了服务端返回 413，整批不落库。
pub const MAX_BATCH: usize = 100;

impl GatewayClient {
    /// 上报一批行程（`POST /v1/telemetry/trips`）。
    ///
    /// 返回逐条结果：**被拒的那几条不要重试**——它们是校验不通过（脏数据），
    /// 重试多少次都一样，只会让队列永远清不空。真正该重试的是网络错误与 5xx，
    /// 那两种以 `Err` 返回。
    pub async fn report_trips(&self, trips: &[TripReport]) -> Result<TripReportResult, NetError> {
        if trips.is_empty() {
            return Ok(TripReportResult { accepted: 0, rejected: Vec::new() });
        }
        if trips.len() > MAX_BATCH {
            return Err(NetError::Rejected {
                status: 413,
                body: format!("单批最多 {MAX_BATCH} 条，本次 {}", trips.len()),
            });
        }

        let res = self
            .post_trips_once(trips)
            .await
            .map_err(crate::upload::net_err)?;

        let status = res.status();
        if status.is_success() {
            return res
                .json::<TripReportResult>()
                .await
                .map_err(|e| NetError::BadResponse(e.to_string()));
        }
        if status.is_client_error() {
            let body = res.text().await.unwrap_or_default();
            // 4xx 是请求本身的问题，重试无意义——由调用方丢弃这一批并记录。
            return Err(NetError::Rejected { status: status.as_u16(), body });
        }
        Err(NetError::Server(status.as_u16()))
    }
}

/// 待上报队列。
///
/// # 为什么要有它
///
/// 车机断网是常态（地库、隧道）。没有队列的话，断网期间的行程直接丢失，
/// 而⑥的价值恰恰在于连续性——缺几天的数据会让"日均里程"算出一个偏低的数，
/// **看起来正常但是错的**。
///
/// # 为什么有上限
///
/// 车机可能连开数天不重启。无界队列在长时间断网后会吃满内存。
/// 溢出时**丢最旧的**：新数据对画像更有价值，且旧数据越旧越可能已被别的途径覆盖。
/// 丢弃要计数——静默丢弃会让"为什么少了几天"变成无法回答的问题。
#[derive(Debug, Default)]
pub struct TripQueue {
    pending: Vec<TripReport>,
    capacity: usize,
    dropped: usize,
}

impl TripQueue {
    pub fn with_capacity(capacity: usize) -> Self {
        Self { pending: Vec::new(), capacity: capacity.max(1), dropped: 0 }
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
    /// 因溢出被丢弃的条数——**必须能被看到**。
    pub fn dropped(&self) -> usize {
        self.dropped
    }

    /// 入队。同 id 视为同一段行程的更新（覆盖），不产生第二条。
    pub fn push(&mut self, trip: TripReport) {
        if let Some(slot) = self.pending.iter_mut().find(|t| t.id == trip.id) {
            *slot = trip;
            return;
        }
        if self.pending.len() >= self.capacity {
            self.pending.remove(0);
            self.dropped += 1;
        }
        self.pending.push(trip);
    }

    /// 取一批待发（不移除——**发成功了才移除**，否则网络失败就丢数据）。
    pub fn peek_batch(&self) -> Vec<TripReport> {
        self.pending.iter().take(MAX_BATCH).cloned().collect()
    }

    /// 按 id 移除已确认处理的条目（含被拒的：重试无意义，见 `report_trips`）。
    pub fn ack(&mut self, ids: &[String]) {
        self.pending.retain(|t| !ids.iter().any(|i| i == &t.id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trip(id: &str) -> TripReport {
        TripReport {
            id: id.into(),
            started_at: 1_700_000_000_000,
            ended_at: 1_700_000_600_000,
            distance_km: 12.5,
            vin: None,
            road_type: Some("city".into()),
            ambient_temp_c: None,
            observed_range_km: None,
            charge: None,
        }
    }

    /// 同一段行程重复记录不该变成两条——服务端靠 id 幂等，端上也别先制造重复。
    #[test]
    fn same_id_updates_in_place() {
        let mut q = TripQueue::with_capacity(10);
        q.push(trip("a"));
        let mut updated = trip("a");
        updated.distance_km = 20.0;
        q.push(updated);
        assert_eq!(q.len(), 1);
        assert_eq!(q.peek_batch()[0].distance_km, 20.0);
    }

    /// 溢出丢最旧的，且**计数可见**——静默丢弃会让"为什么少了几天"无法回答。
    #[test]
    fn overflow_drops_oldest_and_counts() {
        let mut q = TripQueue::with_capacity(2);
        q.push(trip("a"));
        q.push(trip("b"));
        q.push(trip("c"));
        assert_eq!(q.len(), 2);
        assert_eq!(q.dropped(), 1);
        let ids: Vec<_> = q.peek_batch().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["b", "c"], "丢的应该是最旧的 a");
    }

    /// 发送前不移除：网络失败时数据必须还在队列里。
    #[test]
    fn peek_does_not_remove() {
        let mut q = TripQueue::with_capacity(10);
        q.push(trip("a"));
        let _ = q.peek_batch();
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn ack_removes_only_acked() {
        let mut q = TripQueue::with_capacity(10);
        q.push(trip("a"));
        q.push(trip("b"));
        q.ack(&["a".to_string()]);
        assert_eq!(q.len(), 1);
        assert_eq!(q.peek_batch()[0].id, "b");
    }

    /// 打真实网关的联调（默认跳过，需显式 `--ignored` 运行）。
    ///
    /// 单测里的队列逻辑证明不了"这条 HTTP 真的通"——契约对不上时
    /// 两边各自的测试都是绿的，只有真发一次才知道。
    ///
    /// 前置：网关在 CARLIFE_GATEWAY_URL（默认 8790）上跑着。
    #[tokio::test]
    #[ignore = "需要真实网关，用 cargo test -p carlife-net -- --ignored 跑"]
    async fn live_report_against_gateway() {
        let base = std::env::var("CARLIFE_GATEWAY_URL")
            .unwrap_or_else(|_| "http://localhost:8790".into());
        let token = std::env::var("CARLIFE_DEMO_TOKEN").unwrap_or_else(|_| "demo-token".into());
        let client = GatewayClient::new(base, token);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let good = TripReport {
            id: format!("rust-live-{now}"),
            started_at: now - 40 * 60_000,
            ended_at: now,
            distance_km: 21.7,
            vin: None,
            road_type: Some("highway".into()),
            ambient_temp_c: Some(26.0),
            observed_range_km: None,
            charge: None,
        };
        // 故意混一条脏数据：验证"部分成功"而不是整批失败。
        let bad = TripReport { id: format!("rust-live-bad-{now}"), distance_km: -1.0, ..good.clone() };

        let r = client.report_trips(&[good.clone(), bad]).await.expect("上报应当返回结果");
        assert_eq!(r.accepted, 1, "合法那条应被接受");
        assert_eq!(r.rejected.len(), 1, "非法那条应被拒且不拖垮整批");
        assert!(r.rejected[0].reason.contains("distanceKm"), "拒绝原因要指到具体规则：{:?}", r.rejected);

        // 幂等：同一 id 重发，服务端仍报 accepted（upsert），但库里不会多一行。
        let again = client.report_trips(&[good]).await.expect("重发应当成功");
        assert_eq!(again.accepted, 1);
    }

    /// 端上不发 userId：归属由服务端按鉴权注入，序列化里根本不该出现这个字段。
    #[test]
    fn payload_has_no_user_id() {
        let json = serde_json::to_string(&trip("a")).unwrap();
        assert!(!json.contains("userId"), "端上不得自报归属：{json}");
        assert!(json.contains("\"distanceKm\""), "字段必须是 camelCase：{json}");
    }

    /// 未设置的可选字段不序列化——省带宽是次要的，
    /// 主要是别把 null 发给服务端让它去区分"没有"与"显式为空"。
    #[test]
    fn optional_fields_omitted_when_absent() {
        let json = serde_json::to_string(&trip("a")).unwrap();
        assert!(!json.contains("charge"));
        assert!(!json.contains("vin"));
    }
}
