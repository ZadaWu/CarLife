//! 车内音乐的端上通路（施工单 M63-03）。
//!
//! 三个端点，全部经网关——端只认识一个后端地址（ACR-018），不直连 mock-cabin：
//!
//!   `GET  /v1/cabin/media/player`       播放器现状
//!   `POST /v1/cabin/media/sink`         认领 + 心跳，响应体**也是**播放器现状
//!   `GET  /v1/cabin/media/tracks/:id`   曲目字节
//!
//! # 为什么心跳与取状态是同一个端点
//!
//! 端每秒打一次，为的就是拿回最新状态去 diff。分成两个端点只会让端每秒打两次，
//! 而且两次之间状态还可能变——"该放哪首"与"我刚上报的进度"会对不上。
//!
//! # 只声明我们消费的字段
//!
//! serde 默认忽略多余字段。服务端往 `PlayerView` 加东西不会让端上编译红，
//! 也不会在运行期炸——**这条链上服务端总是先于端部署**，反过来才是常态。

use serde::{Deserialize, Serialize};

use crate::upload::{failure_from, net_err, GatewayClient, NetError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerStatus {
    Playing,
    Paused,
    #[default]
    Stopped,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerTrack {
    pub track_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub duration_sec: Option<f64>,
}

/// 出声位现状。`kind` 是 `client` / `host` / `none`——**字符串而不是枚举**：
/// 服务端加一种出声位时端上不该编译红，它只需要认得出"是不是我"。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkView {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub sink_id: Option<String>,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerView {
    #[serde(default)]
    pub status: PlayerStatus,
    #[serde(default)]
    pub audible: bool,
    #[serde(default)]
    pub now_playing: Option<PlayerTrack>,
    /// 真正该送到喇叭的音量（已经夹过分区上限、也算过服务端那侧的让路）。
    #[serde(default)]
    pub output_volume: u32,
    #[serde(default)]
    pub sink: Option<SinkView>,
    /// 车机侧车辆被重建过——队列跟着没了，端要重新认领而不是接着心跳。
    #[serde(default)]
    pub rebuilt: bool,
}

impl PlayerView {
    /// 出声位是不是我的。`sink` 缺失（旧服务端）时当作不是——
    /// **宁可不放，也不要两台机器同时放**。
    pub fn sink_is(&self, sink_id: &str) -> bool {
        self.sink
            .as_ref()
            .is_some_and(|s| s.kind == "client" && s.sink_id.as_deref() == Some(sink_id))
    }
}

/// 一次心跳。`claim` 只在**要抢占**时为 true——续租带上它会让两个端每秒互抢一次。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkBeat {
    pub sink_id: String,
    #[serde(skip_serializing_if = "is_false")]
    pub claim: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<PlayerStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position_sec: Option<f64>,
    /// 本曲在端上自然播完。服务端听不见，队列只能靠这一句往前走。
    #[serde(skip_serializing_if = "is_false")]
    pub ended: bool,
    /// 端上的失败原因。**原样上报，不吞**——车主听不到声时得查得到原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl GatewayClient {
    /// 播放器现状。只读，不改变出声位。
    pub async fn get_cabin_media_player(&self) -> Result<PlayerView, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/cabin/media/player", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.json().await.map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 认领 / 心跳。响应体就是最新的播放器现状——端拿它去 diff。
    pub async fn post_cabin_media_sink(&self, beat: &SinkBeat) -> Result<PlayerView, NetError> {
        let res = self
            .http
            .post(format!("{}/v1/cabin/media/sink", self.base_url))
            .header("authorization", format!("Bearer {}", self.token))
            .json(beat)
            .send()
            .await
            .map_err(net_err)?;
        if res.status().as_u16() != 200 {
            return Err(failure_from(res).await);
        }
        res.json().await.map_err(|e| NetError::BadResponse(e.to_string()))
    }

    /// 曲目字节。
    ///
    /// **整曲进内存**，与 TTS 的 `play_bytes` 同形：解码器要 `Read + Seek`，
    /// 而流式喂给 rodio 得先有一层带缓冲的 `Seek` 适配——单曲上限由服务端的
    /// 20 MB 挡着，不值得为它先造那一层。真要做流式播放是另一张单的事。
    pub async fn get_cabin_media_track(&self, track_id: &str) -> Result<Vec<u8>, NetError> {
        let res = self
            .http
            .get(format!("{}/v1/cabin/media/tracks/{}", self.base_url, track_id))
            .header("authorization", format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(net_err)?;
        let status = res.status().as_u16();
        // 200 整曲、206 部分——本方法不发 Range，收到 206 也照收（服务端有权只给一段）。
        if status != 200 && status != 206 {
            return Err(failure_from(res).await);
        }
        res.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| NetError::BadResponse(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 服务端加字段不能让端上炸。这条用例守的是"服务端总是先于端部署"这件事。
    #[test]
    fn 多余字段被忽略而不是解析失败() {
        let v: PlayerView = serde_json::from_str(
            r#"{"status":"playing","audible":true,"outputVolume":30,
                "sink":{"kind":"client","sinkId":"c1","note":"","clientStatus":"playing"},
                "nowPlaying":{"trackId":"t-1","title":"夜路","artist":null,"durationSec":42.5,"bytes":9},
                "queue":[],"cursor":0,"zone":"cabin","这个字段端上从来没听说过":1}"#,
        )
        .expect("多余字段应当被忽略");
        assert_eq!(v.status, PlayerStatus::Playing);
        assert_eq!(v.output_volume, 30);
        assert_eq!(v.now_playing.as_ref().unwrap().title, "夜路");
        assert!(v.sink_is("c1"));
    }

    /// 旧服务端不回 `sink`。此时**不能**认为出声位是自己的——
    /// 认了就会出现"服务端在放、端也在放"的两首歌叠在一起。
    #[test]
    fn 没有_sink_段时不认为出声位是自己的() {
        let v: PlayerView = serde_json::from_str(r#"{"status":"playing","audible":true}"#).unwrap();
        assert!(!v.sink_is("c1"));
    }

    /// `claim` 与 `ended` 为假时不进请求体：续租每秒一次，
    /// 带一个恒为 false 的 `claim` 只会让服务端多读一个字段，也容易被误读成"要抢"。
    #[test]
    fn 心跳只发有意义的字段() {
        let beat = SinkBeat {
            sink_id: "c1".into(),
            status: Some(PlayerStatus::Playing),
            position_sec: Some(12.0),
            ..Default::default()
        };
        let j = serde_json::to_string(&beat).unwrap();
        assert!(j.contains("\"sinkId\":\"c1\""));
        assert!(j.contains("\"status\":\"playing\""));
        assert!(!j.contains("claim"), "续租不该带 claim：{j}");
        assert!(!j.contains("ended"));
        assert!(!j.contains("error"));
    }

    #[test]
    fn 认领时才带_claim() {
        let beat = SinkBeat { sink_id: "c1".into(), claim: true, ..Default::default() };
        assert!(serde_json::to_string(&beat).unwrap().contains("\"claim\":true"));
    }
}
