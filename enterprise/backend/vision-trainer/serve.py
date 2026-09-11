"""起服务：`uv run serve.py`。只绑 127.0.0.1:8799（可用 VISION_TRAINER_PORT 改），鉴权在网关。"""

from __future__ import annotations

import os

import uvicorn

from vision_trainer.app import create_app

app = create_app()

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("VISION_TRAINER_PORT") or 8799), log_level="info")
