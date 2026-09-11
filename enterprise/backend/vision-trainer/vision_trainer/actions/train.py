"""训练：ultralytics 直接把产物写进任务目录（weights/、results.csv、results.png），训完对 best.pt 跑一次 val 填指标。"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from ..paths import SERVICE_DIR, Paths
from ..progress import make_epoch_callback
from .common import pick_device, val_metrics


def resolve_base(paths: Paths, base: str) -> str:
    """基座：内置 yolo11n/s（服务目录下已缓存或由 ultralytics 下载），或既有模型的 best.pt（继续训）。"""
    if base in ("yolo11n.pt", "yolo11s.pt", "yolo11m.pt"):
        cached = SERVICE_DIR / base
        return str(cached) if cached.exists() else base
    w = paths.job_dir(base) / "weights" / "best.pt"
    if not w.exists():
        raise FileNotFoundError(f"基座模型不存在：{base}")
    return str(w)


def run_train(paths: Paths, job_id: str, params: dict[str, Any]) -> dict[str, Any]:
    from ultralytics import YOLO

    job_dir = paths.job_dir(job_id)
    data = paths.dataset_yaml(str(params["dataset"]))
    if not data.exists():
        raise FileNotFoundError(f"数据集不存在：{params['dataset']}")
    device = params.get("device") or pick_device()

    model = YOLO(resolve_base(paths, str(params.get("base") or "yolo11n.pt")))
    model.add_callback("on_fit_epoch_end", make_epoch_callback(job_dir / "progress.jsonl"))
    t0 = time.perf_counter()
    model.train(
        data=str(data),
        epochs=int(params.get("epochs", 30)),
        patience=int(params.get("patience", 10)),
        imgsz=int(params.get("imgsz", 640)),
        batch=int(params.get("batch", 16)),
        device=device,
        project=str(paths.runs),
        name=job_id,
        exist_ok=True,
        seed=0,
        deterministic=True,
        verbose=False,
        plots=True,
    )
    train_s = time.perf_counter() - t0
    csv = job_dir / "results.csv"
    epochs_run = max(0, len(csv.read_text(encoding="utf-8").strip().splitlines()) - 1) if csv.exists() else None
    best = job_dir / "weights" / "best.pt"

    t1 = time.perf_counter()
    trained = YOLO(str(best))
    metrics = val_metrics(trained, str(data), device, job_dir, "val")  # 验证图表进任务目录的 val/，不在 runs/ 下另开目录
    return {
        "device": device,
        "classes": [trained.names[i] for i in sorted(trained.names)],
        "steps": {
            "train": {"seconds": round(train_s, 1), "epochs_run": epochs_run, "weights": str(best)},
            "val": {"seconds": round(time.perf_counter() - t1, 1), **metrics},
        },
    }
