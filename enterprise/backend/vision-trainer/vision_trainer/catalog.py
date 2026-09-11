"""
模型 / 数据集 / 评测集照片的枚举——全是目录扫描，不缓存、不建登记文件。

- 模型 = `runs/<id>/weights/best.pt` 存在的任务目录；指标从同目录 `report.json` 读，没有就只给名字。
- 数据集 = `datasets/<名>/data.yaml`；类别从 yaml 的 names 读，图片数从 images/train、images/val 计。
- 照片 = `cases.jsonl` 里的非负样本条目（带真值框，页面叠画用）。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

from .jobs import read_json
from .paths import Paths

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def _count_images(d: Path) -> int:
    return sum(1 for p in d.iterdir() if p.suffix.lower() in IMAGE_EXT) if d.is_dir() else 0


def datasets(paths: Paths) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not paths.datasets.exists():
        return out
    for d in sorted(paths.datasets.iterdir()):
        y = d / "data.yaml"
        if not d.is_dir() or not y.exists():
            continue
        try:
            cfg = yaml.safe_load(y.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError:
            continue
        names = cfg.get("names")
        if isinstance(names, dict):
            classes = [str(names[k]) for k in sorted(names, key=lambda k: int(k))]
        elif isinstance(names, list):
            classes = [str(n) for n in names]
        else:
            classes = []
        base = Path(cfg.get("path") or d)
        out.append(
            {
                "name": d.name,
                "path": str(y),
                "classes": classes,
                "train": _count_images(base / str(cfg.get("train", "images/train"))),
                "val": _count_images(base / str(cfg.get("val", "images/val"))),
            }
        )
    return out


def models(paths: Paths) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not paths.runs.exists():
        return out
    for d in sorted(paths.runs.iterdir(), reverse=True):
        best = d / "weights" / "best.pt"
        if not d.is_dir() or not best.exists():
            continue
        job = read_json(d / "job.json") or {}
        report = read_json(d / "report.json") or {}
        params = job.get("params") or {}
        val = (report.get("steps") or {}).get("val") or {}
        onnx = d / "weights" / "best.onnx"
        out.append(
            {
                "id": d.name,
                "name": params.get("name") or d.name,
                "dataset": params.get("dataset"),
                "base": params.get("base"),
                "createdAt": job.get("createdAt"),
                "status": job.get("status"),
                "epochsRun": (report.get("steps") or {}).get("train", {}).get("epochs_run"),
                "mAP50": val.get("mAP50"),
                "mAP50_95": val.get("mAP50-95"),
                "perClass": val.get("per_class_mAP50"),
                "classes": report.get("classes"),
                "weightsBytes": best.stat().st_size,
                "onnx": onnx.exists(),
                "onnxBytes": onnx.stat().st_size if onnx.exists() else None,
            }
        )
    return out


def model_weights(paths: Paths, model_id: str) -> Path | None:
    p = paths.job_dir(model_id) / "weights" / "best.pt"
    return p if p.exists() else None


def photos(paths: Paths) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not paths.cases.exists():
        return out
    for ln in paths.cases.read_text(encoding="utf-8").splitlines():
        if not ln.startswith("{"):
            continue
        try:
            c = json.loads(ln)
        except json.JSONDecodeError:
            continue
        file = str(c.get("file", ""))
        out.append(
            {
                "id": c.get("id"),
                "file": file,
                "vehicle": c.get("vehicle"),
                "negative": bool(c.get("negative")),
                "items": [
                    {"bbox": it.get("bbox"), "category": it.get("category"), "symbol_id": it.get("symbol_id"), "color": it.get("color"), "state": it.get("state")}
                    for it in (c.get("items") or [])
                ],
            }
        )
    return out


def photo_path(paths: Paths, photo_id: str) -> Path | None:
    for p in photos(paths):
        if p["id"] == photo_id:
            f = (paths.cases.parent / p["file"]).resolve()
            if f.exists() and paths.cases.parent.resolve() in f.parents:
                return f
    return None
