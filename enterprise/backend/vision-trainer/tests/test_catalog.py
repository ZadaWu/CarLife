from __future__ import annotations

import json

from vision_trainer import catalog

from .conftest import write_cases, write_dataset, write_job, write_weights


def test_models_lists_only_dirs_with_best_pt(paths):
    d1 = write_job(paths, "train-a", params={"dataset": "ds", "name": "第一版"})
    write_weights(d1, onnx=True)
    (d1 / "report.json").write_text(json.dumps({"classes": ["a", "b"], "steps": {"train": {"epochs_run": 12}, "val": {"mAP50": 0.9, "mAP50-95": 0.8, "per_class_mAP50": {"a": 0.95}}}}), encoding="utf-8")
    write_job(paths, "train-b")  # 没有权重
    ms = catalog.models(paths)
    assert [m["id"] for m in ms] == ["train-a"]
    m = ms[0]
    assert m["name"] == "第一版" and m["epochsRun"] == 12 and m["mAP50"] == 0.9 and m["classes"] == ["a", "b"] and m["onnx"] and m["onnxBytes"] == 20


def test_datasets_reads_names_and_counts(paths):
    write_dataset(paths, "synth", ["low_beam", "seatbelt"], train=3, val=1)
    (paths.datasets / "broken").mkdir()
    ds = catalog.datasets(paths)
    assert len(ds) == 1
    assert ds[0]["name"] == "synth" and ds[0]["classes"] == ["low_beam", "seatbelt"] and ds[0]["train"] == 3 and ds[0]["val"] == 1


def test_photos_parses_cases_and_resolves_path(paths):
    write_cases(paths)
    ps = catalog.photos(paths)
    assert len(ps) == 1 and ps[0]["id"] == "p1" and ps[0]["items"][0]["symbol_id"] == "low_beam"
    assert catalog.photo_path(paths, "p1") == (paths.photos / "p1.png").resolve()
    assert catalog.photo_path(paths, "nope") is None
