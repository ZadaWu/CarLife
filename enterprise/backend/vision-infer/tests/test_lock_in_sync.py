"""`requirements.lock.txt` 必须与 `uv.lock` 同步（ACR-050）。

镜像按前者装依赖（理由见 infra/images/Dockerfile.vision-infer）。改了 pyproject / uv.lock 却忘了重新导出，
表现是"本机测试全绿、镜像里跑的是另一组版本"——所以在这里红，而不是在 ECS 上。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SERVICE_DIR = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("uv") is None, reason="没有 uv，无从导出对照")
def test_requirements_与_uv_lock_同步() -> None:
    fresh = subprocess.run(
        ["uv", "export", "--frozen", "--no-dev", "--no-emit-project", "-q"],
        cwd=SERVICE_DIR, capture_output=True, text=True, check=True,
    ).stdout
    body = lambda s: [ln for ln in s.splitlines() if not ln.startswith("#")]  # noqa: E731 —— 头部注释里有命令行，不比
    committed = (SERVICE_DIR / "requirements.lock.txt").read_text(encoding="utf-8")
    assert body(committed) == body(fresh), "重新导出：uv export --frozen --no-dev --no-emit-project -o requirements.lock.txt"
