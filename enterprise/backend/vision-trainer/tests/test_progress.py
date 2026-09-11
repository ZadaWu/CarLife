"""进度回调：用假 trainer 驱动，不 import torch。"""

from __future__ import annotations

import json
import sys
from types import SimpleNamespace

from vision_trainer.progress import make_epoch_callback, read_all, tail


def test_callback_appends_one_line_per_epoch(tmp_path):
    p = tmp_path / "progress.jsonl"
    cb = make_epoch_callback(p)
    cb(SimpleNamespace(epoch=0, epochs=30, metrics={"metrics/mAP50(B)": 0.3371, "metrics/mAP50-95(B)": 0.21, "val/box_loss": 1.9, "junk": "x"}))
    cb(SimpleNamespace(epoch=1, epochs=30, metrics={"metrics/mAP50(B)": float("nan")}))
    lines = read_all(p)
    assert len(lines) == 2
    assert lines[0]["epoch"] == 1 and lines[0]["epochs"] == 30
    assert lines[0]["mAP50"] == 0.3371 and lines[0]["box_loss"] == 1.9 and "junk" not in lines[0]
    assert "mAP50" not in lines[1]  # NaN 不写
    assert tail(p)["epoch"] == 2
    cb(SimpleNamespace(epoch=30, epochs=30, metrics={}))  # 训完后的最终验证再触发一次：epoch 31 > 30，不写
    assert len(read_all(p)) == 2


def test_tail_handles_missing_and_partial(tmp_path):
    p = tmp_path / "progress.jsonl"
    assert tail(p) is None
    p.write_text('{"epoch":1}\n{"epoch":2', encoding="utf-8")
    assert tail(p) is None  # 半行还没写完 → None，不抛


def test_no_torch_imported_by_parent_modules():
    import vision_trainer.app  # noqa: F401
    import vision_trainer.catalog  # noqa: F401
    import vision_trainer.jobs  # noqa: F401

    assert "torch" not in sys.modules and "ultralytics" not in sys.modules
