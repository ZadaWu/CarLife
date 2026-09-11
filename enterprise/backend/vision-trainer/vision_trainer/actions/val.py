"""验证：对某个模型（任务目录里的 best.pt）在某个数据集上跑一次 val。数据集缺省用它训练时那份。"""

from __future__ import annotations

import time
from typing import Any

from ..jobs import read_json
from ..paths import Paths
from .common import pick_device, val_metrics


def run_val(paths: Paths, job_id: str, params: dict[str, Any]) -> dict[str, Any]:
    from ultralytics import YOLO

    model_id = str(params["model"])
    weights = paths.job_dir(model_id) / "weights" / "best.pt"
    if not weights.exists():
        raise FileNotFoundError(f"模型不存在：{model_id}")
    dataset = params.get("dataset")
    if not dataset:
        src = read_json(paths.job_dir(model_id) / "job.json") or {}
        dataset = (src.get("params") or {}).get("dataset")
    data = paths.dataset_yaml(str(dataset))
    if not data.exists():
        raise FileNotFoundError(f"数据集不存在：{dataset}")
    device = params.get("device") or pick_device()
    t0 = time.perf_counter()
    model = YOLO(str(weights))
    metrics = val_metrics(model, str(data), device, paths.runs, job_id)
    return {
        "device": device,
        "model": model_id,
        "dataset": dataset,
        "classes": [model.names[i] for i in sorted(model.names)],
        "steps": {"val": {"seconds": round(time.perf_counter() - t0, 1), **metrics}},
    }
