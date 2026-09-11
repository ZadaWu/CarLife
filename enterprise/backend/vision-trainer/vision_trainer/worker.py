"""
子进程入口：`python -m vision_trainer.worker --job <id> --root <仓库根>`。

读 `job.json` 的 kind 与 params，调对应动作，把结果写成 `report.json`，最后把 `job.json` 标 done / failed。
被 SIGTERM 杀掉时什么都不写——父进程负责把它标成 cancelled / orphaned。
"""

from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

from .jobs import now_iso, read_json, update_job, write_json
from .paths import Paths


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--root", required=True)
    args = ap.parse_args(argv)

    paths = Paths(root=Path(args.root))
    job_dir = paths.job_dir(args.job)
    job = read_json(job_dir / "job.json")
    if not job:
        print(f"没有 job.json：{job_dir}", file=sys.stderr)
        return 2
    kind, params = job.get("kind"), job.get("params") or {}
    try:
        if kind == "train":
            from .actions.train import run_train

            report = run_train(paths, args.job, params)
        elif kind == "val":
            from .actions.val import run_val

            report = run_val(paths, args.job, params)
        elif kind == "export":
            from .actions.export import run_export

            report = run_export(paths, args.job, params)
        else:
            raise ValueError(f"unknown kind {kind}")
        report["job"] = args.job
        report["kind"] = kind
        report["params"] = params
        report["at"] = now_iso()
        write_json(job_dir / "report.json", report)
        update_job(job_dir, status="done", endedAt=now_iso())
        return 0
    except Exception as e:  # noqa: BLE001 —— 失败原因要进 job.json，不能只留在日志里
        traceback.print_exc()
        update_job(job_dir, status="failed", endedAt=now_iso(), error=f"{type(e).__name__}: {e}"[:500])
        return 1


if __name__ == "__main__":
    sys.exit(main())
