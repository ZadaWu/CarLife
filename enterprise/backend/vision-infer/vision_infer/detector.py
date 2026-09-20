"""
指示灯检测的前后处理 + onnxruntime 推理（ACR-050）。

# 与端上逐步对齐

`clients/shared/rust/carlife-vision/src/lib.rs` 是同一份 ONNX 的另一个运行时，这里的三步与它一一对应，
缺一步就是另一套坐标：

1. 解码后按 EXIF Orientation 转正——手机竖拍的照片文件里存的是横的；
2. letterbox 到 imgsz×imgsz：r = min(s/h, s/w)，缩放后居中，边距 `round(d - 0.1)`，灰 114
   （ultralytics `LetterBox(auto=False, scaleup=True, center=True)` 的同算法）；
3. 解码 [1, 4+nc, N] 输出、按类贪心 NMS（iou 0.7）、映射回转正后的原图像素。

返回的是**像素框**（`xyxy`）+ 转正后的宽高：0–1000 的归一化在调用方 `yolo.ts` 的 `toNormalizedBBox` 里做，
这与 vision-trainer 的 `/predict` 同形——`yolo.ts` 因此一行不用改。

# 这里不知道的事

`name` 只是训练 data.yaml 顺序下的类别标签，上游只拿它当 `symbolHint`；
名称与级别的结论仍只来自手册图标目录（ACR-025 的规矩不变）。
"""

from __future__ import annotations

import io
import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

DEFAULT_IMGSZ = 960
DEFAULT_CONF = 0.3
DEFAULT_IOU = 0.7
PAD_GRAY = 114


class ImageError(ValueError):
    """不是可解码的图片。"""


@dataclass(frozen=True)
class Letterboxed:
    tensor: np.ndarray  # [1, 3, s, s] float32, 0–1, RGB
    scale: float
    dx: int
    dy: int


def decode_upright(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:  # noqa: BLE001 —— PIL 的解码错误族很散，对调用方都是同一件事
        raise ImageError(str(e)) from e
    return ImageOps.exif_transpose(img).convert("RGB")


def letterbox(img: Image.Image, imgsz: int) -> Letterboxed:
    w, h = img.size
    r = min(imgsz / h, imgsz / w)
    nw, nh = max(1, round(w * r)), max(1, round(h * r))
    left = max(0, round((imgsz - nw) / 2 - 0.1))
    top = max(0, round((imgsz - nh) / 2 - 0.1))
    # reducing_gap 不给：PIL 的 BILINEAR 缩小时按比例放宽支撑（带抗锯齿），与端上 `image` crate 的 Triangle 同类
    resized = np.asarray(img.resize((nw, nh), Image.BILINEAR), dtype=np.float32) / 255.0
    canvas = np.full((imgsz, imgsz, 3), PAD_GRAY / 255.0, dtype=np.float32)
    canvas[top : top + nh, left : left + nw] = resized[: imgsz - top, : imgsz - left]
    return Letterboxed(tensor=np.ascontiguousarray(canvas.transpose(2, 0, 1)[None]), scale=r, dx=left, dy=top)


def _iou_one_to_many(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    x0 = np.maximum(a[0], b[:, 0])
    y0 = np.maximum(a[1], b[:, 1])
    x1 = np.minimum(a[2], b[:, 2])
    y1 = np.minimum(a[3], b[:, 3])
    inter = np.clip(x1 - x0, 0, None) * np.clip(y1 - y0, 0, None)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1]) - inter
    return np.where(union > 0, inter / np.maximum(union, 1e-9), 0.0)


def nms_per_class(boxes: np.ndarray, scores: np.ndarray, classes: np.ndarray, iou: float) -> list[int]:
    """按类贪心 NMS（ultralytics 缺省 `agnostic=False`）。返回保留下来的下标，按置信度降序。"""
    order = np.argsort(-scores, kind="stable")
    kept: list[int] = []
    for i in order:
        same = [k for k in kept if classes[k] == classes[i]]
        if same and np.any(_iou_one_to_many(boxes[i], boxes[same]) > iou):
            continue
        kept.append(int(i))
    return kept


class Detector:
    """常驻的检测器。onnxruntime 的 session 线程安全；加一把锁只为让 2 核的机器上推理串行、时延可预期。"""

    def __init__(self, onnx_path: Path, names: list[str], imgsz: int = DEFAULT_IMGSZ, threads: int | None = None) -> None:
        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = threads
        self._session = ort.InferenceSession(str(onnx_path), sess_options=opts, providers=["CPUExecutionProvider"])
        self._input = self._session.get_inputs()[0].name
        self._lock = threading.Lock()
        self.names = names
        self.imgsz = imgsz

    @staticmethod
    def from_paths(onnx_path: Path, names_path: Path, imgsz: int = DEFAULT_IMGSZ, threads: int | None = None) -> "Detector":
        names = json.loads(names_path.read_text(encoding="utf-8"))
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            raise ValueError(f"{names_path} 不是字符串数组")
        return Detector(onnx_path, names, imgsz, threads)

    def detect(self, data: bytes, conf: float = DEFAULT_CONF, iou: float = DEFAULT_IOU) -> dict[str, Any]:
        img = decode_upright(data)
        w0, h0 = img.size
        lb = letterbox(img, self.imgsz)
        t0 = time.perf_counter()
        with self._lock:
            out = self._session.run(None, {self._input: lb.tensor})[0]
        ms = (time.perf_counter() - t0) * 1000
        if out.ndim != 3 or out.shape[1] < 5:
            raise RuntimeError(f"unexpected output shape {out.shape}")
        pred = out[0]  # [4+nc, N]
        scores_all = pred[4:]
        classes = scores_all.argmax(axis=0)
        scores = scores_all.max(axis=0)
        keep = scores >= conf
        cx, cy, bw, bh = (pred[i][keep] for i in range(4))
        classes, scores = classes[keep], scores[keep]
        boxes = np.stack(
            [
                np.clip((cx - bw / 2 - lb.dx) / lb.scale, 0, w0),
                np.clip((cy - bh / 2 - lb.dy) / lb.scale, 0, h0),
                np.clip((cx + bw / 2 - lb.dx) / lb.scale, 0, w0),
                np.clip((cy + bh / 2 - lb.dy) / lb.scale, 0, h0),
            ],
            axis=1,
        ) if scores.size else np.zeros((0, 4), dtype=np.float32)
        detections = [
            {
                "cls": int(classes[i]),
                "name": self.names[int(classes[i])] if int(classes[i]) < len(self.names) else f"class_{int(classes[i])}",
                "conf": round(float(scores[i]), 4),
                "xyxy": [round(float(v), 2) for v in boxes[i]],
            }
            for i in nms_per_class(boxes, scores, classes, iou)
        ]
        return {"ok": True, "detections": detections, "imageW": w0, "imageH": h0, "ms": round(ms, 1)}
