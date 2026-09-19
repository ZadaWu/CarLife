//! 平行测试：同一张照片、同一个 ONNX，端上 tract 的框与 ultralytics（onnxruntime，square letterbox）的框逐一对得上。
//! 期望值由 `tests/fixtures/*.expected.json` 记录（生成方式见 models/MODEL.md）；fixture 是团队自拍的门店照缩一半，
//! store-01 带 EXIF Orientation=6（考转正），store-03 无 EXIF（考停车界面）。

use std::path::PathBuf;

use carlife_vision::{Detector, DEFAULT_CONF, DEFAULT_IOU};
use serde::Deserialize;

#[derive(Deserialize)]
struct Expected {
    width: u32,
    height: u32,
    detections: Vec<ExpectedDet>,
}
#[derive(Deserialize)]
struct ExpectedDet {
    bbox: [u16; 4],
    class_id: usize,
    name: String,
    conf: f32,
}

fn iou(a: &[u16; 4], b: &[u16; 4]) -> f32 {
    let (x0, y0) = (a[0].max(b[0]) as f32, a[1].max(b[1]) as f32);
    let (x1, y1) = (a[2].min(b[2]) as f32, a[3].min(b[3]) as f32);
    if x1 <= x0 || y1 <= y0 {
        return 0.0;
    }
    let i = (x1 - x0) * (y1 - y0);
    let area = |r: &[u16; 4]| (r[2] - r[0]) as f32 * (r[3] - r[1]) as f32;
    i / (area(a) + area(b) - i)
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn parity_with_ultralytics_on_fixtures() {
    let d = Detector::from_paths(root().join("models/indicator-yolo11n.onnx"), root().join("models/indicator-yolo11n.names.json"))
        .expect("load model");
    for stem in ["store-01-exif6", "store-03-parked"] {
        let bytes = std::fs::read(root().join(format!("tests/fixtures/{stem}.jpg"))).unwrap();
        let exp: Expected = serde_json::from_slice(&std::fs::read(root().join(format!("tests/fixtures/{stem}.expected.json"))).unwrap()).unwrap();
        let out = d.detect(&bytes, DEFAULT_CONF, DEFAULT_IOU).expect("detect");
        assert_eq!((out.width, out.height), (exp.width, exp.height), "{stem}: 转正后尺寸要与 ultralytics 一致");
        assert_eq!(out.detections.len(), exp.detections.len(), "{stem}: 框数不一致：{:?}", out.detections);
        for e in &exp.detections {
            let hit = out
                .detections
                .iter()
                .find(|o| o.class_id == e.class_id && iou(&o.bbox, &e.bbox) >= 0.9)
                .unwrap_or_else(|| panic!("{stem}: 期望 {} {:?} 没有对上（实际 {:?}）", e.name, e.bbox, out.detections));
            assert_eq!(hit.name, e.name);
            assert!((hit.conf - e.conf).abs() < 0.05, "{stem}: {} 置信 {} vs {}", e.name, hit.conf, e.conf);
        }
        eprintln!("{stem}: {} 框，推理 {} ms", out.detections.len(), out.infer_ms);
    }
}
