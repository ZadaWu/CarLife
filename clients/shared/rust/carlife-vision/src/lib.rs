//! 端侧指示灯检测（施工单见 ACR-044）：照片字节 → 框 + 疑似类别 + 置信度。
//!
//! # 与服务端同一口径
//!
//! 服务端 `yolo.ts` 经训练服务 `/predict` 出的框是 **按 EXIF 转正后的坐标系、0–1000 归一化**。
//! 这里三步与之逐一对齐，缺一步就是另一套坐标：
//! 1. 解码后按 EXIF Orientation 转正（`decode_upright`）；
//! 2. letterbox 到 imgsz×imgsz（灰 114、居中、双线性）——与 ultralytics `LetterBox(auto=False)` 同算法；
//! 3. 解码 [1, 4+nc, N] 输出、按类 NMS（iou 0.7）、映射回原图、归一化到 0–1000 取整。
//!
//! 平行测试（`tests/parity.rs`）拿同一张照片对照 ultralytics 在同一个 ONNX 上的结果。
//!
//! # 这里不知道的事
//!
//! 名称与级别的最终判定不在端上：`name` 只是检测器的类别标签（训练 data.yaml 的顺序），
//! 上行后由服务端按手册图标目录核验（ACR-025 的规矩不变）。

use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageReader, RgbImage};
use serde::{Deserialize, Serialize};
use tract_onnx::prelude::*;

/// 推理边长 = 训练尺寸（M80-08：离训练尺寸越远越差，不是越大越清楚）。
pub const DEFAULT_IMGSZ: u32 = 960;
/// 置信阈值，与服务端 `CARLIFE_VISION_YOLO_CONF` 缺省同一个数（ACR-045 起 0.3：G 版权重 0.3 与 0.25 认对相同、多报更少）。
pub const DEFAULT_CONF: f32 = 0.3;
/// NMS 的 IoU 阈值，ultralytics 预测缺省。
pub const DEFAULT_IOU: f32 = 0.7;
/// letterbox 填充灰度，ultralytics 缺省 114。
const PAD_GRAY: u8 = 114;

#[derive(Debug, thiserror::Error)]
pub enum VisionError {
    #[error("model: {0}")]
    Model(String),
    #[error("image: {0}")]
    Image(String),
    #[error("infer: {0}")]
    Infer(String),
}

/// 一枚框。`bbox` 是转正后坐标系里的 0–1000 归一化 `[x0, y0, x1, y1]`，与服务端 `BBox` 同形。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Detection {
    pub bbox: [u16; 4],
    pub class_id: usize,
    pub name: String,
    pub conf: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectOutput {
    /// 转正后的像素尺寸（不是文件里存储的尺寸）。
    pub width: u32,
    pub height: u32,
    pub detections: Vec<Detection>,
    pub infer_ms: u64,
}

/// 内置的 ONNX 与类别表（`models/`）。编进二进制（约 11 MB）而不是走 Tauri resource：
/// dev、模拟器、真机、两端都是同一条加载路径，少一类"资源没打进包"的故障；换模型 = 发版，ACR-044 已定。
pub const BUILTIN_ONNX: &[u8] = include_bytes!("../models/indicator-yolo11n.onnx");
pub const BUILTIN_NAMES_JSON: &str = include_str!("../models/indicator-yolo11n.names.json");

pub struct Detector {
    model: Arc<TypedRunnableModel>,
    names: Vec<String>,
    imgsz: u32,
}

impl Detector {
    /// 从 ONNX 字节与类别表构造；模型加载 + 优化一次约 100 ms，端上做成常驻。
    pub fn from_bytes(onnx: &[u8], names: Vec<String>, imgsz: u32) -> Result<Self, VisionError> {
        let s = imgsz as usize;
        let model = tract_onnx::onnx()
            .model_for_read(&mut Cursor::new(onnx))
            .map_err(|e| VisionError::Model(e.to_string()))?
            .with_input_fact(0, f32::fact([1, 3, s, s]).into())
            .map_err(|e| VisionError::Model(e.to_string()))?
            .into_optimized()
            .map_err(|e| VisionError::Model(e.to_string()))?
            .into_runnable()
            .map_err(|e| VisionError::Model(e.to_string()))?;
        Ok(Self { model, names, imgsz })
    }

    /// `models/<x>.onnx` + `models/<x>.names.json`（训练服务导出时一起写的）。
    pub fn from_paths(onnx: impl AsRef<Path>, names_json: impl AsRef<Path>) -> Result<Self, VisionError> {
        let bytes = std::fs::read(onnx).map_err(|e| VisionError::Model(e.to_string()))?;
        let names: Vec<String> = serde_json::from_slice(&std::fs::read(names_json).map_err(|e| VisionError::Model(e.to_string()))?)
            .map_err(|e| VisionError::Model(format!("names.json: {e}")))?;
        Self::from_bytes(&bytes, names, DEFAULT_IMGSZ)
    }

    /// 用内置模型构造（两端 Tauri 命令用这个）。
    pub fn builtin() -> Result<Self, VisionError> {
        let names: Vec<String> = serde_json::from_str(BUILTIN_NAMES_JSON).map_err(|e| VisionError::Model(format!("names.json: {e}")))?;
        Self::from_bytes(BUILTIN_ONNX, names, DEFAULT_IMGSZ)
    }

    pub fn names(&self) -> &[String] {
        &self.names
    }

    pub fn detect(&self, image_bytes: &[u8], conf: f32, iou: f32) -> Result<DetectOutput, VisionError> {
        let img = decode_upright(image_bytes)?;
        let (w0, h0) = img.dimensions();
        let lb = letterbox(&img, self.imgsz);
        let t0 = Instant::now();
        let result = self
            .model
            .run(tvec!(lb.tensor.into_tvalue()))
            .map_err(|e| VisionError::Infer(e.to_string()))?;
        let infer_ms = t0.elapsed().as_millis() as u64;
        let out = result[0]
            .to_plain_array_view::<f32>()
            .map_err(|e| VisionError::Infer(e.to_string()))?;
        // [1, 4+nc, N]：前 4 行 cx cy w h（letterbox 像素），其余每行一个类的分数
        let shape = out.shape();
        if shape.len() != 3 || shape[1] < 5 {
            return Err(VisionError::Infer(format!("unexpected output shape {shape:?}")));
        }
        let nc = shape[1] - 4;
        let n = shape[2];
        let mut cands: Vec<Cand> = Vec::new();
        for j in 0..n {
            let (mut best, mut bi) = (0f32, 0usize);
            for k in 0..nc {
                let s = out[[0, 4 + k, j]];
                if s > best {
                    best = s;
                    bi = k;
                }
            }
            if best < conf {
                continue;
            }
            let (cx, cy, w, h) = (out[[0, 0, j]], out[[0, 1, j]], out[[0, 2, j]], out[[0, 3, j]]);
            let x0 = ((cx - w / 2.0 - lb.dx) / lb.scale).clamp(0.0, w0 as f32);
            let y0 = ((cy - h / 2.0 - lb.dy) / lb.scale).clamp(0.0, h0 as f32);
            let x1 = ((cx + w / 2.0 - lb.dx) / lb.scale).clamp(0.0, w0 as f32);
            let y1 = ((cy + h / 2.0 - lb.dy) / lb.scale).clamp(0.0, h0 as f32);
            cands.push(Cand { xyxy: [x0, y0, x1, y1], conf: best, class_id: bi });
        }
        let kept = nms_per_class(cands, iou);
        let norm = |v: f32, d: u32| -> u16 { (v / d as f32 * 1000.0).round().clamp(0.0, 1000.0) as u16 };
        let detections = kept
            .into_iter()
            .map(|c| Detection {
                bbox: [norm(c.xyxy[0], w0), norm(c.xyxy[1], h0), norm(c.xyxy[2], w0), norm(c.xyxy[3], h0)],
                class_id: c.class_id,
                name: self.names.get(c.class_id).cloned().unwrap_or_else(|| format!("class_{}", c.class_id)),
                conf: c.conf,
            })
            .collect();
        Ok(DetectOutput { width: w0, height: h0, detections, infer_ms })
    }
}

#[derive(Clone, Copy)]
struct Cand {
    xyxy: [f32; 4],
    conf: f32,
    class_id: usize,
}

fn iou_of(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let (x0, y0) = (a[0].max(b[0]), a[1].max(b[1]));
    let (x1, y1) = (a[2].min(b[2]), a[3].min(b[3]));
    if x1 <= x0 || y1 <= y0 {
        return 0.0;
    }
    let i = (x1 - x0) * (y1 - y0);
    let ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
    if ua <= 0.0 {
        0.0
    } else {
        i / ua
    }
}

/// 按类做贪心 NMS（ultralytics 缺省 `agnostic=False`），结果按置信度降序。
fn nms_per_class(mut cands: Vec<Cand>, iou: f32) -> Vec<Cand> {
    cands.sort_by(|a, b| b.conf.partial_cmp(&a.conf).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<Cand> = Vec::new();
    for c in cands {
        if kept.iter().any(|k| k.class_id == c.class_id && iou_of(&k.xyxy, &c.xyxy) > iou) {
            continue;
        }
        kept.push(c);
    }
    kept
}

/// 解码并按 EXIF Orientation 转正。没有标签或标签为 1 时不动。
pub fn decode_upright(bytes: &[u8]) -> Result<DynamicImage, VisionError> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| VisionError::Image(e.to_string()))?;
    let mut decoder = reader.into_decoder().map_err(|e| VisionError::Image(e.to_string()))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| VisionError::Image(e.to_string()))?;
    img.apply_orientation(orientation);
    Ok(img)
}

struct Letterboxed {
    tensor: Tensor,
    scale: f32,
    dx: f32,
    dy: f32,
}

/// ultralytics `LetterBox(new_shape=(s,s), auto=False, scaleup=True, center=True)` 的同算法实现：
/// r = min(s/h, s/w)；缩放后居中，边距 `round(d - 0.1)`；灰 114；双线性。
fn letterbox(img: &DynamicImage, imgsz: u32) -> Letterboxed {
    let (w, h) = img.dimensions();
    let s = imgsz as f32;
    let r = (s / h as f32).min(s / w as f32);
    let nw = ((w as f32 * r).round() as u32).max(1);
    let nh = ((h as f32 * r).round() as u32).max(1);
    let dw = (s - nw as f32) / 2.0;
    let dh = (s - nh as f32) / 2.0;
    let left = (dw - 0.1).round().max(0.0) as u32;
    let top = (dh - 0.1).round().max(0.0) as u32;
    let resized: RgbImage = img.resize_exact(nw, nh, FilterType::Triangle).to_rgb8();
    let n = imgsz as usize;
    let pad = PAD_GRAY as f32 / 255.0;
    let mut arr = tract_ndarray::Array4::<f32>::from_elem((1, 3, n, n), pad);
    for (x, y, p) in resized.enumerate_pixels() {
        let (xx, yy) = ((x + left) as usize, (y + top) as usize);
        if xx < n && yy < n {
            arr[[0, 0, yy, xx]] = p[0] as f32 / 255.0;
            arr[[0, 1, yy, xx]] = p[1] as f32 / 255.0;
            arr[[0, 2, yy, xx]] = p[2] as f32 / 255.0;
        }
    }
    Letterboxed { tensor: arr.into(), scale: r, dx: left as f32, dy: top as f32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nms_keeps_highest_and_drops_overlaps_of_same_class_only() {
        let a = Cand { xyxy: [0.0, 0.0, 10.0, 10.0], conf: 0.9, class_id: 1 };
        // b 与 a 的 IoU = 0.82 > 0.7 → 同类被压掉；c 同框但异类 → 留着
        let b = Cand { xyxy: [0.5, 0.5, 10.5, 10.5], conf: 0.8, class_id: 1 };
        let c = Cand { xyxy: [0.5, 0.5, 10.5, 10.5], conf: 0.7, class_id: 2 };
        let kept = nms_per_class(vec![b, a, c], 0.7);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].conf, 0.9);
        assert_eq!(kept[1].class_id, 2);
    }

    #[test]
    fn letterbox_centers_and_scales_like_ultralytics() {
        // 1512×2016 竖图 → r = 960/2016，nw = 720，left = round((960-720)/2 - 0.1) = 120，top = 0
        let img = DynamicImage::new_rgb8(1512, 2016);
        let lb = letterbox(&img, 960);
        assert!((lb.scale - 960.0 / 2016.0).abs() < 1e-6);
        assert_eq!(lb.dx, 120.0);
        assert_eq!(lb.dy, 0.0);
    }
}
