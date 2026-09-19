//! 端侧指示灯检测命令（ACR-044 第 2 步）：照片字节进、框出，一步都不出端。
//!
//! 字节走 raw IPC（与 `attachments.rs` 同一条理由：几 MB 的照片按 `number[]` 序列化太慢）；
//! Android 没有 raw body，退回 JSON 体的 `bytesBase64`。请求头 `x-conf`（可选，缺省 0.25）。
//!
//! 模型常驻：第一次调用时加载并优化（约 100–300 ms），之后每张只有推理（M4 上约 200 ms，真机待量）。
//! 返回的框是**按 EXIF 转正后坐标系**的 0–1000 归一化值，`name` 只是检测器的类别标签——
//! 名称与级别的最终判定仍在服务端（ACR-025），端上不解读。

use std::sync::{Arc, Mutex};

use base64::Engine;
use carlife_vision::{DetectOutput, Detector, DEFAULT_CONF, DEFAULT_IOU};
use tauri::ipc::{InvokeBody, Request};
use tauri::State;

#[derive(Default)]
pub struct VisionState {
    detector: Mutex<Option<Arc<Detector>>>,
}

impl VisionState {
    fn detector(&self) -> Result<Arc<Detector>, String> {
        let mut slot = self.detector.lock().map_err(|_| "vision state poisoned".to_string())?;
        if let Some(d) = slot.as_ref() {
            return Ok(Arc::clone(d));
        }
        let d = Arc::new(Detector::builtin().map_err(|e| e.to_string())?);
        *slot = Some(Arc::clone(&d));
        Ok(d)
    }
}

fn header<'a>(req: &'a Request<'_>, name: &str) -> Option<&'a str> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty())
}

#[tauri::command]
pub async fn vision_detect(request: Request<'_>, state: State<'_, VisionState>) -> Result<DetectOutput, String> {
    let conf: f32 = header(&request, "x-conf").and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_CONF);
    let bytes: Vec<u8> = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(v) => {
            let b64 = v.get("bytesBase64").and_then(|x| x.as_str()).ok_or_else(|| "JSON 体缺少 bytesBase64".to_string())?;
            base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("bytesBase64 解码失败：{e}"))?
        }
    };
    let detector = state.detector()?;
    // 推理是 CPU 密集的几百毫秒，别占着异步运行时的线程
    tauri::async_runtime::spawn_blocking(move || detector.detect(&bytes, conf, DEFAULT_IOU).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("vision task: {e}"))?
}
