"""导出：ONNX 写在模型自己的 weights/ 旁边（ultralytics 的默认位置），任务目录只留 report.json。"""

from __future__ import annotations

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
    out = YOLO(str(weights)).export(format="onnx", imgsz=int(params.get("imgsz", 640)), device="cpu", simplify=True)
    p = Path(str(out))
    return {"model": model_id, "steps": {"export": {"seconds": round(time.perf_counter() - t0, 1), "format": fmt, "path": str(p), "bytes": p.stat().st_size}}}
