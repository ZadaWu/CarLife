//! 附件命令（施工单 M80-03，F-09-07 / F-09-09）：上传照片或视频、取回原件。
//!
//! # 字节走原始 IPC，不走 JSON 数组
//!
//! 一段 40 MB 的视频按 `number[]` 序列化是 200 MB 的 JSON 文本，WebView 会卡几秒；
//! Tauri 2 的 raw IPC（`invoke(cmd, Uint8Array, { headers })`）把它当二进制直接递过来，
//! 元数据放请求头。Android 不支持 raw body（tauri `InvokeBody` 文档明写），那边退回
//! JSON 体里的 `bytesBase64`——两种形状这里都收。
//!
//! # 令牌不进 WebView
//!
//! 与 `chat.rs` 同一条纪律：网络与鉴权在 Rust。取件也是命令，字节以 `ipc::Response`
//! 原样回去，WebView 自己包成 blob URL 给 `<img>` / `<video>`。

use base64::Engine;
use carlife_net::{GatewayClient, UploadedAttachment};
use tauri::ipc::{InvokeBody, Request, Response};

use super::chat::gateway_env;

fn header<'a>(req: &'a Request<'_>, name: &str) -> Option<&'a str> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty())
}

/// percent-decode（`%XX` → 字节，再按 UTF-8 组回字符串）。
///
/// 解不动就**原样返回**：文件名只用于展示，不该因为一个名字编码坏了就把用户拍的照片拒掉
/// （与网关 `decodeFilename` 同一条纪律，F-09-05 边界）。
fn percent_decode(raw: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| raw.to_string())
}

/// 上传一个附件到当前会话。请求头：`x-session-id`（必填）、`content-type`、
/// `x-filename`（**percent-encoded 的原始文件名**，见下）、`x-idempotency-key`。
/// 返回网关回执（句柄 / 类别 / 字节数）。
///
/// # 文件名在这一跳是编码过的（M80-04）
///
/// WebView 那侧必须先编码——请求头是 ByteString，「特斯拉.png」会让 `new Headers` 当场抛
/// `TypeError: Type error`（2026-09-09 真机上就是这么失败的，INC-0130）。这里解回真名，
/// 再交给 `upload_attachment`，由它按网关的约定重新编码。**每一跳各自负责自己的编码**。
#[tauri::command]
pub async fn upload_attachment(request: Request<'_>) -> Result<UploadedAttachment, String> {
    let session_id = header(&request, "x-session-id")
        .ok_or_else(|| "缺少 x-session-id".to_string())?
        .to_string();
    let content_type = header(&request, "content-type")
        .unwrap_or("application/octet-stream")
        .to_string();
    let filename = header(&request, "x-filename").map(percent_decode);
    let idempotency_key = header(&request, "x-idempotency-key").map(|s| s.to_string());
    let bytes: Vec<u8> = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(v) => {
            let b64 = v
                .get("bytesBase64")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "JSON 体缺少 bytesBase64".to_string())?;
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| format!("bytesBase64 不是合法 base64：{e}"))?
        }
    };
    if bytes.is_empty() {
        return Err("文件是空的".into());
    }
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .upload_attachment(
            &session_id,
            &content_type,
            filename.as_deref(),
            idempotency_key.as_deref(),
            bytes,
        )
        .await
        .map_err(|e| e.to_string())
}

/// 取回附件原件，字节原样回 WebView（`ArrayBuffer`）。MIME 由调用方从 `AttachmentRef.contentType` 取。
#[tauri::command]
pub async fn fetch_attachment(handle: String) -> Result<Response, String> {
    let (base_url, token) = gateway_env();
    let (_content_type, bytes) = GatewayClient::new(base_url, token)
        .fetch_attachment(&handle)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn 解码中文文件名() {
        assert_eq!(percent_decode("%E7%89%B9%E6%96%AF%E6%8B%89.png"), "特斯拉.png");
    }

    #[test]
    fn 纯_ascii_原样返回() {
        assert_eq!(percent_decode("IMG_0001.HEIC"), "IMG_0001.HEIC");
    }

    #[test]
    fn 坏编码不吞文件名() {
        // 半截的 %E7、非法十六进制、结尾孤零零一个 % —— 都不该让上传失败
        assert_eq!(percent_decode("a%zz.png"), "a%zz.png");
        assert_eq!(percent_decode("tail%"), "tail%");
        assert_eq!(percent_decode("%E7%89"), "%E7%89");
    }

    #[test]
    fn 空格与加号不被当成编码字符() {
        // encodeURIComponent 把空格编成 %20；`+` 是原样的字面量，不该被解成空格
        assert_eq!(percent_decode("my%20photo+1.jpg"), "my photo+1.jpg");
    }
}
