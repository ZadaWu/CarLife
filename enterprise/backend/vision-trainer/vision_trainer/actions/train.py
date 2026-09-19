"""训练：ultralytics 直接把产物写进任务目录（weights/、results.csv、results.png），训完对 best.pt 跑一次 val 填指标。"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from ..paths import SERVICE_DIR, Paths
from ..progress import make_epoch_callback
from .common import pick_device, val_metrics


#: 允许直接从架构 yaml 起训的基座（M80-13）。
#: **Ultralytics 没有发布过 P2 的预训练权重**——网上说的 `yolov8s-p2.pt` 并不存在，
#: 只有架构 yaml。所以这里的做法是：按 yaml 搭网络，再把同名非 P2 权重里形状对得上的层迁移进来
#: （主干与颈部能对上，新增的步长 4 检测头是随机初始化的）。
ARCH_BASES: dict[str, str] = {
    "yolov8n-p2.yaml": "yolov8n.pt",
    "yolov8s-p2.yaml": "yolov8s.pt",
    "yolov8m-p2.yaml": "yolov8m.pt",
}
BUILTIN_BASES = ("yolo11n.pt", "yolo11s.pt", "yolo11m.pt")


def resolve_base(paths: Paths, base: str) -> str:
    """基座：内置 yolo11n/s、架构 yaml（见 ARCH_BASES）、或既有模型的 best.pt（继续训）。"""
    if base in BUILTIN_BASES or base in ARCH_BASES:
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

    base = str(params.get("base") or "yolo11n.pt")
    model = YOLO(resolve_base(paths, base))
    if base in ARCH_BASES:
        # 从 yaml 搭出来的网络是随机权重；把能对上的层从同规格的非 P2 预训练权重迁移过来。
        # 迁移多少层由 ultralytics 自己按形状匹配决定，迁不动的（新的 P2 头）保持随机。
        model = model.load(ARCH_BASES[base])
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
        # 显式给了才覆盖 ultralytics 缺省；没给的键不进 kwargs，行为与改动前一致（M80-12）
        **{k: float(params[k]) for k in
           ("degrees", "perspective", "shear", "translate", "scale", "fliplr", "flipud", "hsv_v", "hsv_s")
           if params.get(k) is not None},
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
