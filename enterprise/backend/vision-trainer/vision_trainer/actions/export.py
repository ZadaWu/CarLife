"""导出：ONNX 写在模型自己的 weights/ 旁边（ultralytics 的默认位置），任务目录只留 report.json。"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from ..paths import Paths


def run_export(paths: Paths, job_id: str, params: dict[str, Any]) -> dict[str, Any]:
    from ultralytics import YOLO

    model_id = str(params["model"])
    weights = paths.job_dir(model_id) / "weights" / "best.pt"
    if not weights.exists():
        raise FileNotFoundError(f"模型不存在：{model_id}")
    fmt = str(params.get("format") or "onnx")
    if fmt != "onnx":
        raise ValueError(f"不支持的导出格式：{fmt}")
    t0 = time.perf_counter()
    # 缺省 960 / opset 17：端上 tract 推理（ACR-044）与服务端 /predict 同一尺寸；不带 NMS、不动态、fp32——后处理在端上 Rust 里做
    imgsz = int(params.get("imgsz", 960))
    opset = int(params.get("opset", 17))
    yolo = YOLO(str(weights))
    out = yolo.export(format="onnx", imgsz=imgsz, opset=opset, device="cpu", simplify=True, dynamic=False, half=False)
    p = Path(str(out))
    # 类别表写在 ONNX 旁边：端上按 class id 查名字用（ONNX metadata 里的 names 是 Python dict 字面量，端上不解析它）
    names = [yolo.names[i] for i in range(len(yolo.names))]
    (p.with_suffix(".names.json")).write_text(json.dumps(names, ensure_ascii=False), encoding="utf-8")
    return {"model": model_id, "steps": {"export": {"seconds": round(time.perf_counter() - t0, 1), "format": fmt, "path": str(p), "bytes": p.stat().st_size, "imgsz": imgsz, "opset": opset, "names": len(names)}}}
