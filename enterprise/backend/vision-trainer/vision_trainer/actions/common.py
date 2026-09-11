from __future__ import annotations

from pathlib import Path
from typing import Any


def pick_device() -> str:
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "0"
    return "cpu"


def val_metrics(model: Any, data: str, device: str, project: Path, name: str) -> dict[str, Any]:
    """跑一次 val，把 ultralytics 的指标对象压成可 JSON 的字典（与 spike 的 report.json 同形）。"""
    m = model.val(data=data, device=device, project=str(project), name=name, exist_ok=True, plots=True, verbose=False)
    box = m.box
    return {
        "mAP50": round(float(box.map50), 4),
        "mAP50-95": round(float(box.map), 4),
        "precision": round(float(box.mp), 4),
        "recall": round(float(box.mr), 4),
        "per_class_mAP50": {model.names[i]: round(float(v), 4) for i, v in zip(box.ap_class_index.tolist(), box.ap50.tolist())},
        "plots_dir": str(m.save_dir),
    }
