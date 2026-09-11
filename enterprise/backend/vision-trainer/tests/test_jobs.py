"""任务队列：一次一个、取消即杀、重启恢复如实标失败。spawn / kill 用替身，不起真子进程。"""

from __future__ import annotations

import os
from pathlib import Path

from vision_trainer.jobs import JobStore, read_json

from .conftest import write_job


def fake_spawn_factory(pids: list[int]):
    calls: list[str] = []

    def spawn(job_id: str, job_dir: Path, paths) -> int | None:
        calls.append(job_id)
        return pids[len(calls) - 1] if len(calls) - 1 < len(pids) else None

    spawn.calls = calls  # type: ignore[attr-defined]
    return spawn


def test_create_writes_queued_then_running_one_at_a_time(paths, monkeypatch):
    alive = {os.getpid()}
    monkeypatch.setattr("vision_trainer.jobs.pid_alive", lambda pid: pid in alive)
    spawn = fake_spawn_factory([os.getpid(), 99999])
    store = JobStore(paths, spawn=spawn, kill=lambda pid, sig: None)
    a = store.create("train", {"dataset": "ds"})
    b = store.create("val", {"model": a["id"]})
    va, vb = store.view(a["id"]), store.view(b["id"])
    assert va["status"] == "running" and va["pid"] == os.getpid()
    assert vb["status"] == "queued"
    assert spawn.calls == [a["id"]]
    # 第一个结束（pid 死）→ tick 把它标 orphaned，并把第二个放出去
    alive.clear()
    store.tick()
    assert store.view(a["id"])["status"] == "failed" and store.view(a["id"])["error"] == "orphaned"
    assert store.view(b["id"])["status"] == "running"


def test_worker_marks_done_and_tick_keeps_it(paths, monkeypatch):
    monkeypatch.setattr("vision_trainer.jobs.pid_alive", lambda pid: False)
    d = write_job(paths, "train-x", status="done", pid=1)
    store = JobStore(paths, spawn=lambda *_: 1, kill=lambda *_: None)
    store.tick()
    assert read_json(d / "job.json")["status"] == "done"


def test_cancel_running_kills_and_marks(paths, monkeypatch):
    killed: list[tuple[int, int]] = []
    state = {"alive": True}
    monkeypatch.setattr("vision_trainer.jobs.pid_alive", lambda pid: state["alive"])

    def kill(pid: int, sig: int) -> None:
        killed.append((pid, sig))
        state["alive"] = False

    write_job(paths, "train-run", status="running", pid=4242)
    store = JobStore(paths, spawn=lambda *_: None, kill=kill)
    assert store.cancel_or_delete("train-run") == "cancelled"
    assert killed and killed[0][0] == 4242
    assert store.view("train-run")["status"] == "cancelled"


def test_cancel_queued_and_delete_finished(paths, monkeypatch):
    monkeypatch.setattr("vision_trainer.jobs.pid_alive", lambda pid: False)
    write_job(paths, "train-q", status="queued")
    write_job(paths, "train-old", status="done")
    store = JobStore(paths, spawn=lambda *_: None, kill=lambda *_: None)
    assert store.cancel_or_delete("train-q") == "cancelled"
    assert store.view("train-q")["error"] == "cancelled_before_start"
    assert store.cancel_or_delete("train-old") == "deleted"
    assert not paths.job_dir("train-old").exists()


def test_recover_marks_queued_and_dead_running_failed(paths, monkeypatch):
    monkeypatch.setattr("vision_trainer.jobs.pid_alive", lambda pid: pid == 7)
    write_job(paths, "a", status="queued")
    write_job(paths, "b", status="running", pid=99999)
    write_job(paths, "c", status="running", pid=7)
    store = JobStore(paths, spawn=lambda *_: None, kill=lambda *_: None)
    store.recover()
    assert store.view("a")["error"] == "service_restarted"
    assert store.view("b")["error"] == "orphaned"
    assert store.view("c")["status"] == "running"


def test_view_attaches_progress_report_and_weights(paths):
    d = write_job(paths, "train-v", status="done")
    (d / "progress.jsonl").write_text('{"epoch":1,"mAP50":0.5}\n{"epoch":2,"mAP50":0.7}\n', encoding="utf-8")
    (d / "report.json").write_text('{"steps":{"train":{"epochs_run":2}}}', encoding="utf-8")
    (d / "weights").mkdir()
    (d / "weights" / "best.pt").write_bytes(b"x")
    v = JobStore(paths, spawn=lambda *_: None, kill=lambda *_: None).view("train-v")
    assert v["progress"] == {"epoch": 2, "mAP50": 0.7}
    assert v["report"]["steps"]["train"]["epochs_run"] == 2
    assert v["hasWeights"] and not v["hasOnnx"]
