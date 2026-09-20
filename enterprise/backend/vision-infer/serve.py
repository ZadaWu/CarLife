"""起服务：`uv run serve.py`。

缺省只绑 127.0.0.1:8799——与 vision-trainer 同一个端口，因为两者对 runtime 是同一个角色
（`VISION_TRAINER_URL` 的 `/predict`），本机同时只该起一个。容器里由 VISION_INFER_HOST=0.0.0.0 放开。
"""

from __future__ import annotations

import os

import uvicorn

from vision_infer.app import create_app

app = create_app()

if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.environ.get("VISION_INFER_HOST") or "127.0.0.1",
        port=int(os.environ.get("VISION_INFER_PORT") or 8799),
        log_level="info",
    )
