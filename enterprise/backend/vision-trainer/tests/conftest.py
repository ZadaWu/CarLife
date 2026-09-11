from __future__ import annotations

import json
from pathlib import Path

import pytest

from vision_trainer.paths import Paths


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    p = Paths(root=tmp_path)
    p.runs.mkdir(parents=True)
    p.datasets.mkdir(parents=True)
    p.photos.mkdir(parents=True)
    return p


def write_job(paths: Paths, job_id: str, **fields) -> Path:
    d = paths.job_dir(job_id)
    d.mkdir(parents=True, exist_ok=True)
    job = {"id": job_id, "kind": fields.pop("kind", "train"), "params": fields.pop("params", {"dataset": "ds"}), "status": fields.pop("status", "done"), "createdAt": fields.pop("createdAt", "2026-09-08T00:00:00+00:00")}
    job.update(fields)
    (d / "job.json").write_text(json.dumps(job), encoding="utf-8")
    return d


def write_weights(job_dir: Path, onnx: bool = False) -> None:
    (job_dir / "weights").mkdir(exist_ok=True)
    (job_dir / "weights" / "best.pt").write_bytes(b"\x00" * 10)
    if onnx:
        (job_dir / "weights" / "best.onnx").write_bytes(b"\x00" * 20)


def write_dataset(paths: Paths, name: str, classes: list[str], train: int = 2, val: int = 1) -> Path:
    d = paths.datasets / name
    for split, n in (("train", train), ("val", val)):
        (d / "images" / split).mkdir(parents=True)
        for i in range(n):
            (d / "images" / split / f"{split}-{i}.jpg").write_bytes(b"jpg")
    (d / "data.yaml").write_text("path: " + str(d) + "\ntrain: images/train\nval: images/val\nnames:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(classes)), encoding="utf-8")
    return d


def write_cases(paths: Paths) -> None:
    (paths.photos / "p1.png").write_bytes(b"\x89PNG")
    paths.cases.write_text(
        "// 注释行\n"
        + json.dumps({"id": "p1", "file": "photos/p1.png", "vehicle": "Tesla Model 3/Y", "negative": False, "items": [{"category": "warning_light", "bbox": [552, 195, 594, 238], "symbol_id": "low_beam", "color": "green", "state": "lit"}, {"category": "readout", "bbox": [1, 2, 3, 4]}]})
        + "\n",
        encoding="utf-8",
    )
