"""
任务：目录即真相（`evals/runs/vision-trainer/<id>/job.json`）。

# 为什么训练和验证在子进程

训练会占满 GPU，而且 ultralytics 没有优雅停止；杀子进程是唯一干净的取消。父进程从不 import torch，
它只负责：写 `job.json`、排队、spawn `python -m vision_trainer.worker`、探活、取消。

# 一次只跑一个

train / val / export 共用 GPU，串行；队列在内存里，服务重启后：`queued` 的标 failed(service_restarted)，
`running` 且 pid 已死的标 failed(orphaned)。不排队会让人忘了自己起过什么（M67 的教训反过来用：这里允许排队，
因为训练动辄几十分钟，"等前一个跑完再点"不现实）。
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .paths import SERVICE_DIR, Paths
from .progress import tail

KINDS = ("train", "val", "export")
TERMINAL = ("done", "failed", "cancelled")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_job_id(kind: str) -> str:
    return f"{kind}-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_json(path: Path, data: dict[str, Any]) -> None:
    """先写临时文件再 rename：父进程读的时候子进程可能正在写。"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def update_job(job_dir: Path, **fields: Any) -> dict[str, Any]:
    job = read_json(job_dir / "job.json") or {}
    job.update(fields)
    write_json(job_dir / "job.json", job)
    return job


def pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


SpawnFn = Callable[[str, Path, Paths], int | None]


def default_spawn(job_id: str, job_dir: Path, paths: Paths) -> int | None:
    log = (job_dir / "worker.log").open("ab")
    proc = subprocess.Popen(
        [sys.executable, "-m", "vision_trainer.worker", "--job", job_id, "--root", str(paths.root)],
        cwd=str(SERVICE_DIR),
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    return proc.pid


class JobStore:
    def __init__(self, paths: Paths, spawn: SpawnFn | None = None, kill: Callable[[int, int], None] | None = None) -> None:
        self.paths = paths
        self.spawn = spawn or default_spawn
        self.kill = kill or (lambda pid, sig: os.kill(pid, sig))
        self._lock = threading.Lock()
        self._ticker: threading.Thread | None = None
        self._stop = threading.Event()
        paths.runs.mkdir(parents=True, exist_ok=True)

    # ── 读

    def list(self) -> list[dict[str, Any]]:
        out = []
        for d in sorted(self.paths.runs.iterdir(), reverse=True) if self.paths.runs.exists() else []:
            if not d.is_dir():
                continue
            v = self.view(d.name)
            if v:
                out.append(v)
        return out

    def view(self, job_id: str) -> dict[str, Any] | None:
        d = self.paths.job_dir(job_id)
        job = read_json(d / "job.json")
        if not job:
            return None
        job = dict(job)
        job["progress"] = tail(d / "progress.jsonl")
        report = read_json(d / "report.json")
        if report is not None:
            job["report"] = report
        job["hasWeights"] = (d / "weights" / "best.pt").exists()
        job["hasOnnx"] = (d / "weights" / "best.onnx").exists()
        return job

    # ── 写

    def create(self, kind: str, params: dict[str, Any]) -> dict[str, Any]:
        if kind not in KINDS:
            raise ValueError(f"unknown kind {kind}")
        job_id = new_job_id(kind)
        d = self.paths.job_dir(job_id)
        d.mkdir(parents=True, exist_ok=False)
        job = {"id": job_id, "kind": kind, "params": params, "status": "queued", "createdAt": now_iso()}
        write_json(d / "job.json", job)
        self.tick()
        return job

    def cancel_or_delete(self, job_id: str) -> str:
        """running / queued → cancel；已结束 → 删目录。返回做了哪个。"""
        d = self.paths.job_dir(job_id)
        job = read_json(d / "job.json")
        if not job:
            raise FileNotFoundError(job_id)
        status = job.get("status")
        if status == "queued":
            update_job(d, status="cancelled", endedAt=now_iso(), error="cancelled_before_start")
            return "cancelled"
        if status == "running":
            pid = job.get("pid")
            if pid_alive(pid):
                self.kill(pid, signal.SIGTERM)
                for _ in range(20):
                    if not pid_alive(pid):
                        break
                    time.sleep(0.1)
                if pid_alive(pid):
                    self.kill(pid, signal.SIGKILL)
            update_job(d, status="cancelled", endedAt=now_iso(), error="cancelled")
            self.tick()
            return "cancelled"
        shutil.rmtree(d)
        return "deleted"

    # ── 队列

    def running(self) -> dict[str, Any] | None:
        for j in self.list():
            if j.get("status") == "running":
                return j
        return None

    def tick(self) -> None:
        """探活正在跑的、把下一个 queued 变成 running。可重入（加锁）。"""
        with self._lock:
            jobs = self.list()
            active = None
            for j in jobs:
                if j.get("status") != "running":
                    continue
                if pid_alive(j.get("pid")):
                    active = j
                else:
                    update_job(self.paths.job_dir(j["id"]), status="failed", endedAt=now_iso(), error="orphaned")
            if active:
                return
            queued = [j for j in jobs if j.get("status") == "queued"]
            if not queued:
                return
            nxt = sorted(queued, key=lambda j: j.get("createdAt", ""))[0]
            d = self.paths.job_dir(nxt["id"])
            update_job(d, status="running", startedAt=now_iso())
            pid = self.spawn(nxt["id"], d, self.paths)
            if pid is None:
                update_job(d, status="failed", endedAt=now_iso(), error="spawn_failed")
            else:
                update_job(d, pid=pid)

    def recover(self) -> None:
        """服务启动时：上次没跑完的任务如实标失败，不假装它们还在跑。"""
        for j in self.list():
            d = self.paths.job_dir(j["id"])
            if j.get("status") == "queued":
                update_job(d, status="failed", endedAt=now_iso(), error="service_restarted")
            elif j.get("status") == "running" and not pid_alive(j.get("pid")):
                update_job(d, status="failed", endedAt=now_iso(), error="orphaned")

    def start_ticker(self, interval: float = 1.0) -> None:
        if self._ticker:
            return

        def loop() -> None:
            while not self._stop.wait(interval):
                try:
                    self.tick()
                except Exception as e:  # noqa: BLE001 —— 队列线程不能因为一个坏目录死掉
                    print(f"[jobs] tick 失败：{e}", file=sys.stderr)

        self._ticker = threading.Thread(target=loop, name="jobs-ticker", daemon=True)
        self._ticker.start()

    def shutdown(self) -> None:
        """服务停：正在跑的子进程一起停，标 cancelled(service_stopped)——留着它会占着 GPU 没人管。"""
        self._stop.set()
        j = self.running()
        if j and pid_alive(j.get("pid")):
            self.kill(j["pid"], signal.SIGTERM)
            update_job(self.paths.job_dir(j["id"]), status="cancelled", endedAt=now_iso(), error="service_stopped")
