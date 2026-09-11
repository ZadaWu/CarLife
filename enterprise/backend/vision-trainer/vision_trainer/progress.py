"""
训练进度：子进程每轮往 `progress.jsonl` 追加一行，父进程读最后一行推 SSE。

**本模块不 import torch / ultralytics。** 回调拿到的 `trainer` 只当鸭子用（`epoch`、`epochs`、`metrics`），
所以单测能用一个普通对象驱动它。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

METRIC_KEYS = {
    "mAP50": "metrics/mAP50(B)",
    "mAP50_95": "metrics/mAP50-95(B)",
    "precision": "metrics/precision(B)",
    "recall": "metrics/recall(B)",
    "box_loss": "val/box_loss",
    "cls_loss": "val/cls_loss",
}


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # NaN → None


def epoch_line(trainer: Any) -> dict[str, Any]:
    """从 ultralytics 的 trainer（或形状相同的假对象）取一轮的进度。epoch 是 0 起的，对外写 1 起。"""
    metrics: dict[str, Any] = getattr(trainer, "metrics", None) or {}
    line: dict[str, Any] = {
        "epoch": int(getattr(trainer, "epoch", -1)) + 1,
        "epochs": int(getattr(trainer, "epochs", 0)),
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    for out_key, in_key in METRIC_KEYS.items():
        v = _num(metrics.get(in_key))
        if v is not None:
            line[out_key] = round(v, 5)
    return line


def make_epoch_callback(progress_path: Path) -> Callable[[Any], None]:
    def on_fit_epoch_end(trainer: Any) -> None:
        line = epoch_line(trainer)
        # 训完后 ultralytics 会对 best.pt 再跑一次最终验证并再触发一次本回调，epoch 会比 epochs 大 1——那不是一轮，不写。
        if line["epochs"] and line["epoch"] > line["epochs"]:
            return
        with progress_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")

    return on_fit_epoch_end


def tail(progress_path: Path) -> dict[str, Any] | None:
    """最后一行；文件不存在或空 → None。只读尾部 64 KB，训练几百轮也不至于读整个文件。"""
    if not progress_path.exists():
        return None
    with progress_path.open("rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 65536))
        chunk = f.read().decode("utf-8", errors="replace")
    lines = [ln for ln in chunk.splitlines() if ln.strip()]
    if not lines:
        return None
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        return None


def read_all(progress_path: Path) -> list[dict[str, Any]]:
    if not progress_path.exists():
        return []
    out: list[dict[str, Any]] = []
    for ln in progress_path.read_text(encoding="utf-8").splitlines():
        if not ln.strip():
            continue
        try:
            out.append(json.loads(ln))
        except json.JSONDecodeError:
            continue
    return out
