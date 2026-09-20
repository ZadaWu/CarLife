"""
线上只推理服务的 HTTP 壳（ACR-050）。

# 它是什么、不是什么

对 runtime 而言它与 `vision-trainer` 是**同一个角色**：`VISION_TRAINER_URL` 指向谁，`yolo.ts` 就向谁要 `POST /predict`，
请求与响应同形。区别在边界：

- `vision-trainer` 是开发机上的内部工具（训练 / 验证 / 导出 / 删任务），依赖 AGPL 的 ultralytics，
  ACR-026 明写"不对外提供服务"；
- 本服务**只推理**：一个模型、两个端点，没有写操作、不落盘，运行时是 MIT 的 onnxruntime。
  跑的是与端上编进二进制的同一份 `indicator-yolo11n.onnx`，所以网页版与原生端的"框在哪"是同一个口径。

# 不报错的坑：配置说 A、服务跑 B

runtime 侧的 `CARLIFE_VISION_YOLO_MODEL` 写的是训练任务号。本服务只有一个模型，
若对它"来者不拒"，换了权重而忘了改某一侧时两边会静默不一致——轨迹里记的模型号是假的。
所以 `model` 参数与服务自报的模型号不一致就 404 `model_not_found`（与 vision-trainer 找不到权重时同一个错误码），
`imgsz` 与导出尺寸不一致就 400——这份 ONNX 是静态 960 导出的，别的尺寸它根本跑不了。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, Response

from .detector import DEFAULT_CONF, DEFAULT_IMGSZ, Detector, ImageError

VERSION = "0.1.0"
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
MAX_BODY = 20 * 1024 * 1024  # 与 vision-trainer 的 /predict 同一个上限

SERVICE_DIR = Path(__file__).resolve().parent.parent
# 模型的唯一存放处是端上那个 crate（它要 include_bytes! 进二进制）。这里不复制第二份：
# 本机从仓库里直接读；容器里由 Dockerfile 从同一路径 COPY 到 /app/models，再用环境变量指过去。
DEFAULT_MODEL_DIR = SERVICE_DIR.parent.parent.parent / "clients" / "shared" / "rust" / "carlife-vision" / "models"
MODEL_STEM = "indicator-yolo11n"


def model_id_from_doc(model_dir: Path) -> str | None:
    """从 `MODEL.md` 读训练任务号（「来源：训练服务任务 `train-…`」）。换模型时那份文档本来就要改，所以它是现成的真相源。"""
    doc = model_dir / "MODEL.md"
    if not doc.exists():
        return None
    m = re.search(r"`(train-[A-Za-z0-9_\-]+)`", doc.read_text(encoding="utf-8"))
    return m.group(1) if m else None


def create_app(detector: Detector | None = None, model_id: str | None = None) -> FastAPI:
    model_dir = Path(os.environ.get("VISION_INFER_MODEL_DIR") or DEFAULT_MODEL_DIR)
    served_id = model_id or os.environ.get("VISION_INFER_MODEL_ID") or model_id_from_doc(model_dir)
    if not served_id:
        # 启动期就抛：没有模型号的服务无法回答"你跑的是不是我要的那个"
        raise RuntimeError(f"读不到模型号：设 VISION_INFER_MODEL_ID，或让 {model_dir}/MODEL.md 写明训练任务号")
    det = detector or Detector.from_paths(
        model_dir / f"{MODEL_STEM}.onnx",
        model_dir / f"{MODEL_STEM}.names.json",
        threads=int(os.environ.get("VISION_INFER_THREADS") or 0) or None,
    )

    app = FastAPI(title="carlife-vision-infer", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "service": "vision-infer", "version": VERSION, "model": served_id, "imgsz": det.imgsz, "classes": len(det.names)}

    @app.post("/predict")
    async def predict(
        request: Request,
        model: str = Query(min_length=1, max_length=80),
        conf: float = Query(default=DEFAULT_CONF, ge=0.01, le=0.99),
        imgsz: int = Query(default=DEFAULT_IMGSZ, ge=320, le=1920),
    ) -> dict[str, Any]:
        if model != served_id:
            raise HTTPException(404, detail={"error": "model_not_found", "serving": served_id})
        if imgsz != det.imgsz:
            raise HTTPException(400, detail={"error": "imgsz_unsupported", "serving": det.imgsz})
        ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
        if ctype not in IMAGE_TYPES:
            raise HTTPException(415, detail={"error": "unsupported_image_type"})
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BODY:
            raise HTTPException(413, detail={"error": "image_too_large"})
        body = await request.body()
        if not body:
            raise HTTPException(400, detail={"error": "empty_body"})
        if len(body) > MAX_BODY:
            raise HTTPException(413, detail={"error": "image_too_large"})
        try:
            resp = await asyncio.to_thread(det.detect, body, conf)
        except ImageError as e:
            raise HTTPException(400, detail={"error": "undecodable_image", "detail": str(e)[:200]}) from e
        except Exception as e:  # noqa: BLE001 —— 推理层的任何意外都按同一个形状回，上游据此降级
            raise HTTPException(500, detail={"error": "predict_failed", "detail": f"{type(e).__name__}: {e}"[:300]}) from e
        resp["model"] = model
        resp["conf"] = conf
        return resp

    @app.exception_handler(HTTPException)
    async def http_error(_req: Request, exc: HTTPException) -> Response:
        detail = exc.detail if isinstance(exc.detail, dict) else {"error": str(exc.detail)}
        return Response(content=json.dumps(detail, ensure_ascii=False), status_code=exc.status_code, media_type="application/json")

    return app
