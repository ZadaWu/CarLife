"""
目录约定（ACR-026 / M76-01）。三个根都可用环境变量覆盖，测试用临时目录。

- 仓库根：缺省从本文件反推（enterprise/backend/vision-trainer/vision_trainer → 根）。
- 数据集：`evals/vision-observe/datasets/<名>/data.yaml`。数据不是代码也不是文档，归 evals。
- 产物：`evals/runs/vision-trainer/<任务号>/`，与评测任务目录 `evals/runs/jobs/` 同级，gitignore。
- 评测集照片与真值：`evals/vision-observe/photos/`、`evals/vision-observe/cases.jsonl`，只读。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = SERVICE_DIR.parent.parent.parent


@dataclass(frozen=True)
class Paths:
    root: Path

    @staticmethod
    def from_env() -> "Paths":
        return Paths(root=Path(os.environ.get("VISION_TRAINER_ROOT") or DEFAULT_ROOT).resolve())

    @property
    def datasets(self) -> Path:
        return self.root / "evals" / "vision-observe" / "datasets"

    @property
    def runs(self) -> Path:
        return self.root / "evals" / "runs" / "vision-trainer"

    @property
    def photos(self) -> Path:
        return self.root / "evals" / "vision-observe" / "photos"

    @property
    def cases(self) -> Path:
        return self.root / "evals" / "vision-observe" / "cases.jsonl"

    def job_dir(self, job_id: str) -> Path:
        return self.runs / job_id

    def dataset_yaml(self, name: str) -> Path:
        return self.datasets / name / "data.yaml"
