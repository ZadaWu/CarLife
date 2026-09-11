"""
FastAPI 路由（ACR-026 / M76-01）。只绑 127.0.0.1，没有鉴权——鉴权在网关的 `/console/vision-trainer/*` 代理上。

本进程不 import torch / ultralytics：训练、验证、导出在子进程（`worker.py`），试推理在常驻推理子进程（`infer.py`）。
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from . import catalog
from .infer import InferClient
from .jobs import TERMINAL, JobStore
from .paths import Paths

VERSION = "0.1.0"
HEARTBEAT_S = 15
POLL_S = 1.0
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
FILE_WHITELIST = re.compile(r"^(?:[A-Za-z0-9_\-]+\.(?:png|jpg|csv|json|jsonl|log)|weights/(?:best|last)\.(?:pt|onnx))$")
SAFE_ID = re.compile(r"^[A-Za-z0-9_\-]{1,80}$")


class TrainParams(BaseModel):
    dataset: str = Field(min_length=1, max_length=80)
    base: str = Field(default="yolo11n.pt", max_length=80)
    epochs: int = Field(default=30, ge=1, le=300)
    patience: int = Field(default=10, ge=1, le=100)
    imgsz: Literal[320, 480, 640, 960] = 640
    batch: int = Field(default=16, ge=1, le=64)
    name: str | None = Field(default=None, max_length=60)


class ValParams(BaseModel):
    model: str = Field(min_length=1, max_length=80)
    dataset: str | None = Field(default=None, max_length=80)


class ExportParams(BaseModel):
    model: str = Field(min_length=1, max_length=80)
    format: Literal["onnx"] = "onnx"


class JobCreate(BaseModel):
    kind: Literal["train", "val", "export"]
    params: dict[str, Any]


def create_app(paths: Paths | None = None, store: JobStore | None = None, infer: InferClient | None = None) -> FastAPI:
    paths = paths or Paths.from_env()
    store = store or JobStore(paths)
    infer = infer or InferClient()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        store.recover()
        store.start_ticker()
        yield
        store.shutdown()
        infer.close()

    app = FastAPI(title="carlife-vision-trainer", version=VERSION, lifespan=lifespan)
    app.state.paths = paths
    app.state.store = store
    app.state.infer = infer

    def ensure_id(v: str) -> str:
        if not SAFE_ID.match(v):
            raise HTTPException(400, detail={"error": "bad_id"})
        return v

    @app.get("/health")
    def health() -> dict[str, Any]:
        running = store.running()
        return {"ok": True, "version": VERSION, "root": str(paths.root), "runningJob": running["id"] if running else None, "inferWorker": infer.alive()}

    @app.get("/models")
    def models() -> list[dict[str, Any]]:
        return catalog.models(paths)

    @app.get("/datasets")
    def datasets() -> list[dict[str, Any]]:
        return catalog.datasets(paths)

    @app.get("/photos")
    def photos() -> list[dict[str, Any]]:
        return catalog.photos(paths)

    @app.get("/photos/{photo_id}/image")
    def photo_image(photo_id: str) -> FileResponse:
        p = catalog.photo_path(paths, ensure_id(photo_id))
        if not p:
            raise HTTPException(404, detail={"error": "photo_not_found"})
        return FileResponse(p)

    @app.get("/jobs")
    def jobs() -> list[dict[str, Any]]:
        return store.list()

    @app.get("/jobs/{job_id}")
    def job(job_id: str) -> dict[str, Any]:
        v = store.view(ensure_id(job_id))
        if not v:
            raise HTTPException(404, detail={"error": "job_not_found"})
        return v

    @app.post("/jobs", status_code=201)
    def create_job(body: JobCreate) -> dict[str, Any]:
        try:
            params = _validate_params(body)
        except ValidationError as e:
            raise HTTPException(422, detail={"error": "invalid_params", "detail": e.errors(include_url=False)}) from None
        created = store.create(body.kind, params)
        return {"id": created["id"], "status": store.view(created["id"])["status"]}

    def _validate_params(body: JobCreate) -> dict[str, Any]:
        if body.kind == "train":
            p = TrainParams(**body.params)
            if not paths.dataset_yaml(p.dataset).exists():
                raise HTTPException(404, detail={"error": "dataset_not_found"})
            if p.base not in ("yolo11n.pt", "yolo11s.pt", "yolo11m.pt") and not catalog.model_weights(paths, ensure_id(p.base)):
                raise HTTPException(404, detail={"error": "base_model_not_found"})
            params = p.model_dump()
        elif body.kind == "val":
            v = ValParams(**body.params)
            if not catalog.model_weights(paths, ensure_id(v.model)):
                raise HTTPException(404, detail={"error": "model_not_found"})
            if v.dataset and not paths.dataset_yaml(v.dataset).exists():
                raise HTTPException(404, detail={"error": "dataset_not_found"})
            params = v.model_dump()
        else:
            e = ExportParams(**body.params)
            if not catalog.model_weights(paths, ensure_id(e.model)):
                raise HTTPException(404, detail={"error": "model_not_found"})
            params = e.model_dump()
        return params

    @app.delete("/jobs/{job_id}", status_code=200)
    def delete_job(job_id: str) -> dict[str, str]:
        try:
            action = store.cancel_or_delete(ensure_id(job_id))
        except FileNotFoundError:
            raise HTTPException(404, detail={"error": "job_not_found"}) from None
        return {"action": action}

    @app.get("/jobs/{job_id}/files/{name:path}")
    def job_file(job_id: str, name: str) -> FileResponse:
        ensure_id(job_id)
        if not FILE_WHITELIST.match(name):
            raise HTTPException(400, detail={"error": "file_not_allowed"})
        p = paths.job_dir(job_id) / name
        if not p.exists():
            raise HTTPException(404, detail={"error": "file_not_found"})
        return FileResponse(p)

    @app.get("/jobs/{job_id}/stream")
    async def job_stream(job_id: str) -> StreamingResponse:
        ensure_id(job_id)
        if not store.view(job_id):
            raise HTTPException(404, detail={"error": "job_not_found"})

        async def gen() -> AsyncIterator[str]:
            yield ": connected\n\n"
            last = ""
            last_beat = time.monotonic()
            while True:
                v = store.view(job_id)
                if not v:
                    yield "event: done\ndata: {\"status\":\"deleted\"}\n\n"
                    return
                payload = json.dumps(v, ensure_ascii=False)
                if payload != last:
                    last = payload
                    yield f"event: progress\ndata: {payload}\n\n"
                if v.get("status") in TERMINAL:
                    yield f"event: done\ndata: {json.dumps({'status': v.get('status'), 'error': v.get('error')})}\n\n"
                    return
                if time.monotonic() - last_beat > HEARTBEAT_S:
                    last_beat = time.monotonic()
                    yield ": hb\n\n"
                await asyncio.sleep(POLL_S)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache", "x-accel-buffering": "no"})

    @app.post("/predict")
    async def predict(
        request: Request,
        model: str = Query(min_length=1, max_length=80),
        conf: float = Query(default=0.25, ge=0.01, le=0.99),
        imgsz: int = Query(default=1280, ge=320, le=1920),
        photo: str | None = Query(default=None, max_length=80),
    ) -> dict[str, Any]:
        weights = catalog.model_weights(paths, ensure_id(model))
        if not weights:
            raise HTTPException(404, detail={"error": "model_not_found"})
        tmp: Path | None = None
        if photo:
            image = catalog.photo_path(paths, ensure_id(photo))
            if not image:
                raise HTTPException(404, detail={"error": "photo_not_found"})
        else:
            ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
            if ctype not in IMAGE_TYPES:
                raise HTTPException(415, detail={"error": "unsupported_image_type"})
            body = await request.body()
            if not body:
                raise HTTPException(400, detail={"error": "empty_body"})
            if len(body) > 20 * 1024 * 1024:
                raise HTTPException(413, detail={"error": "image_too_large"})
            tmp = Path(tempfile.gettempdir()) / f"vision-trainer-predict-{secrets.token_hex(6)}{IMAGE_TYPES[ctype]}"
            tmp.write_bytes(body)
            image = tmp
        try:
            resp = await asyncio.to_thread(infer.predict, weights, image, conf, imgsz)
        finally:
            if tmp:
                tmp.unlink(missing_ok=True)
        if not resp.get("ok"):
            raise HTTPException(500, detail={"error": "predict_failed", "detail": resp.get("error")})
        resp["model"] = model
        resp["conf"] = conf
        return resp

    @app.exception_handler(HTTPException)
    async def http_error(_req: Request, exc: HTTPException) -> Response:
        detail = exc.detail if isinstance(exc.detail, dict) else {"error": str(exc.detail)}
        return Response(content=json.dumps(detail, ensure_ascii=False), status_code=exc.status_code, media_type="application/json")

    return app
