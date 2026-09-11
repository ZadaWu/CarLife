"""
试推理：一个**常驻的推理子进程**，父进程经 stdin/stdout 的 JSON 行协议调它。

为什么不在父进程里直接 YOLO(...)：父进程要保持不 import torch（否则它与训练子进程共享 MPS 上下文，
而且服务本身会从 60 MB 涨到 1 GB）。推理子进程按权重路径缓存模型，第二张图不再加载。

协议（一行一个 JSON）：
  → {"op":"predict","weights":"…/best.pt","image":"…/x.png","conf":0.25,"imgsz":1280}
  ← {"ok":true,"detections":[{"cls":0,"name":"low_beam","conf":0.99,"xyxy":[x1,y1,x2,y2]}],"imageW":2000,"imageH":1333,"ms":120}
  ← {"ok":false,"error":"…"}
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .paths import SERVICE_DIR


def encode(msg: dict[str, Any]) -> str:
    return json.dumps(msg, ensure_ascii=False) + "\n"


def decode(line: str) -> dict[str, Any]:
    try:
        msg = json.loads(line)
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"bad_line: {e}"}
    if not isinstance(msg, dict):
        return {"ok": False, "error": "bad_line: not an object"}
    return msg


def handle(req: dict[str, Any], cache: dict[str, Any]) -> dict[str, Any]:
    """子进程侧：处理一条请求。只有这里 import ultralytics。"""
    if req.get("op") != "predict":
        return {"ok": False, "error": f"unknown_op: {req.get('op')}"}
    weights = str(req.get("weights") or "")
    image = str(req.get("image") or "")
    if not Path(weights).exists():
        return {"ok": False, "error": "weights_not_found"}
    if not Path(image).exists():
        return {"ok": False, "error": "image_not_found"}
    from ultralytics import YOLO

    model = cache.get(weights)
    if model is None:
        model = YOLO(weights)
        cache[weights] = model
    t0 = time.perf_counter()
    results = model.predict(source=image, conf=float(req.get("conf", 0.25)), imgsz=int(req.get("imgsz", 1280)), verbose=False, device=req.get("device") or "cpu")
    dets = []
    w = h = 0
    for r in results:
        h, w = r.orig_shape
        for b in r.boxes:
            dets.append({"cls": int(b.cls), "name": model.names[int(b.cls)], "conf": round(float(b.conf), 4), "xyxy": [round(v, 1) for v in b.xyxy[0].tolist()]})
    return {"ok": True, "detections": dets, "imageW": int(w), "imageH": int(h), "ms": round((time.perf_counter() - t0) * 1000, 1), "names": {int(k): v for k, v in model.names.items()}}


def worker_main() -> int:
    cache: dict[str, Any] = {}
    for line in sys.stdin:
        if not line.strip():
            continue
        req = decode(line)
        if not req.get("ok", True) and "error" in req and "op" not in req:
            resp = req
        else:
            try:
                resp = handle(req, cache)
            except Exception as e:  # noqa: BLE001
                resp = {"ok": False, "error": f"{type(e).__name__}: {e}"[:500]}
        sys.stdout.write(encode(resp))
        sys.stdout.flush()
    return 0


class InferClient:
    """父进程侧。懒起子进程；一次一个请求（锁）；子进程死了就重起一次。"""

    def __init__(self, timeout_s: float = 120.0) -> None:
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self.timeout_s = timeout_s

    def _ensure(self) -> subprocess.Popen[str]:
        if self._proc is None or self._proc.poll() is not None:
            self._proc = subprocess.Popen(
                [sys.executable, "-m", "vision_trainer.infer"],
                cwd=str(SERVICE_DIR),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        return self._proc

    def predict(self, weights: Path, image: Path, conf: float = 0.25, imgsz: int = 1280, device: str = "cpu") -> dict[str, Any]:
        req = {"op": "predict", "weights": str(weights), "image": str(image), "conf": conf, "imgsz": imgsz, "device": device}
        with self._lock:
            proc = self._ensure()
            assert proc.stdin and proc.stdout
            proc.stdin.write(encode(req))
            proc.stdin.flush()
            line = proc.stdout.readline()
            if not line:
                self._proc = None
                return {"ok": False, "error": "infer_worker_died"}
            return decode(line)

    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def close(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
        self._proc = None


if __name__ == "__main__":
    sys.exit(worker_main())
