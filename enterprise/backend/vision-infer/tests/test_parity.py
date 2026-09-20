"""
与端上同一份夹具对账（ACR-050）。

`clients/shared/rust/carlife-vision/tests/fixtures/*.expected.json` 是 ultralytics 在同一个 ONNX 上的结果，
端上的 Rust 运行时（tract）拿它做平行测试；这里用**同一份、同一组容差**守 Python 这一侧。
三个运行时对同一张照片说的是同一件事——这是"网页版走服务端、原生端走端上"可以成立的前提。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from vision_infer.app import DEFAULT_MODEL_DIR, MODEL_STEM
from vision_infer.detector import Detector

FIXTURES = DEFAULT_MODEL_DIR.parent / "tests" / "fixtures"
STEMS = sorted(p.name.removesuffix(".expected.json") for p in FIXTURES.glob("*.expected.json"))


@pytest.fixture(scope="module")
def detector() -> Detector:
    return Detector.from_paths(DEFAULT_MODEL_DIR / f"{MODEL_STEM}.onnx", DEFAULT_MODEL_DIR / f"{MODEL_STEM}.names.json")


def norm_iou(a: list[float], b: list[float]) -> float:
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def test_夹具在场() -> None:
    # 夹具目录挪了 / 改名了要在这里红，而不是让下面的参数化测试静默变成 0 条
    assert len(STEMS) >= 2, f"{FIXTURES} 下没找到 *.expected.json"


@pytest.mark.parametrize("stem", STEMS)
def test_与端上夹具一致(detector: Detector, stem: str) -> None:
    exp = json.loads((FIXTURES / f"{stem}.expected.json").read_text(encoding="utf-8"))
    out = detector.detect((FIXTURES / f"{stem}.jpg").read_bytes(), conf=exp["conf"], iou=exp["iou"])
    # EXIF 转正后的尺寸：store-01-exif6 文件里存的是横图，Orientation=6，转正后应是竖的
    assert (out["imageW"], out["imageH"]) == (exp["width"], exp["height"]), f"{stem}: 转正后尺寸不一致"
    assert len(out["detections"]) == len(exp["detections"]), f"{stem}: 框数不一致：{out['detections']}"
    w, h = out["imageW"], out["imageH"]
    got = [
        {"name": d["name"], "conf": d["conf"], "bbox": [d["xyxy"][0] / w * 1000, d["xyxy"][1] / h * 1000, d["xyxy"][2] / w * 1000, d["xyxy"][3] / h * 1000]}
        for d in out["detections"]
    ]
    for e in exp["detections"]:
        hit = max(got, key=lambda g: norm_iou(g["bbox"], e["bbox"]))
        assert norm_iou(hit["bbox"], e["bbox"]) > 0.85, f"{stem}: {e['name']} 的框对不上：{hit['bbox']} vs {e['bbox']}"
        assert hit["name"] == e["name"]
        assert abs(hit["conf"] - e["conf"]) < 0.05, f"{stem}: {e['name']} 置信 {hit['conf']} vs {e['conf']}"
