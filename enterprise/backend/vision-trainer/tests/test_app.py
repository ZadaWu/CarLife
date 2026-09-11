"""HTTP 面：参数校验、白名单、SSE 收尾、试推理经推理客户端替身。"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from vision_trainer.app import create_app
from vision_trainer.jobs import JobStore

from .conftest import write_cases, write_dataset, write_job, write_weights


class FakeInfer:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def predict(self, weights: Path, image: Path, conf: float, imgsz: int, device: str = "cpu") -> dict:
        self.calls.append({"weights": str(weights), "bytes": image.read_bytes(), "conf": conf, "imgsz": imgsz})
        return {"ok": True, "detections": [{"cls": 0, "name": "low_beam", "conf": 0.9, "xyxy": [1, 2, 3, 4]}], "imageW": 10, "imageH": 5, "ms": 3}

    def alive(self) -> bool:
        return True

    def close(self) -> None:
        pass


def client(paths, monkeypatch):
    monkeypatch.setattr("vision_trainer.jobs.pid_alive", lambda pid: False)
    store = JobStore(paths, spawn=lambda *_: 1234, kill=lambda *_: None)
    infer = FakeInfer()
    app = create_app(paths=paths, store=store, infer=infer)
    return TestClient(app), store, infer


def test_health_and_catalog(paths, monkeypatch):
    write_dataset(paths, "synth", ["a"])
    write_cases(paths)
    c, _, _ = client(paths, monkeypatch)
    with c:
        assert c.get("/health").json()["ok"] is True
        assert c.get("/datasets").json()[0]["name"] == "synth"
        assert c.get("/photos").json()[0]["id"] == "p1"
        assert c.get("/photos/p1/image").content == b"\x89PNG"
        assert c.get("/photos/zzz/image").status_code == 404


def test_create_job_validation(paths, monkeypatch):
    write_dataset(paths, "synth", ["a"])
    c, store, _ = client(paths, monkeypatch)
    with c:
        assert c.post("/jobs", json={"kind": "train", "params": {"dataset": "synth", "epochs": 301}}).status_code == 422
        assert c.post("/jobs", json={"kind": "train", "params": {"dataset": "nope"}}).json() == {"error": "dataset_not_found"}
        assert c.post("/jobs", json={"kind": "export", "params": {"model": "m1", "format": "coreml"}}).status_code == 422
        assert c.post("/jobs", json={"kind": "val", "params": {"model": "m1"}}).status_code == 404
        r = c.post("/jobs", json={"kind": "train", "params": {"dataset": "synth", "epochs": 3}})
        assert r.status_code == 201
        jid = r.json()["id"]
        assert jid.startswith("train-")
        assert c.get(f"/jobs/{jid}").json()["params"]["epochs"] == 3
        assert c.get("/jobs/../x").status_code in (400, 404)


def test_files_whitelist(paths, monkeypatch):
    d = write_job(paths, "train-f")
    (d / "results.png").write_bytes(b"png")
    write_weights(d)
    c, _, _ = client(paths, monkeypatch)
    with c:
        assert c.get("/jobs/train-f/files/results.png").content == b"png"
        assert c.get("/jobs/train-f/files/weights/best.pt").status_code == 200
        assert c.get("/jobs/train-f/files/..%2Fjob.json").status_code == 400
        assert c.get("/jobs/train-f/files/weights/evil.pt").status_code == 400
        assert c.get("/jobs/train-f/files/nope.png").status_code == 404


def test_stream_ends_with_done_for_finished_job(paths, monkeypatch):
    write_job(paths, "train-done", status="done")
    c, _, _ = client(paths, monkeypatch)
    with c:
        with c.stream("GET", "/jobs/train-done/stream") as r:
            body = "".join(r.iter_text())
    frames = [f for f in body.split("\n\n") if f.strip()]
    assert frames[0] == ": connected"
    assert frames[1].startswith("event: progress")
    assert frames[-1].startswith("event: done") and '"status": "done"' in frames[-1].replace("\n", " ") or '"status":"done"' in frames[-1]


def test_delete_cancels_or_deletes(paths, monkeypatch):
    write_job(paths, "train-old", status="done")
    c, _, _ = client(paths, monkeypatch)
    with c:
        assert c.delete("/jobs/train-old").json() == {"action": "deleted"}
        assert c.delete("/jobs/train-old").status_code == 404


def test_predict_upload_and_photo(paths, monkeypatch):
    d = write_job(paths, "train-m")
    write_weights(d)
    write_cases(paths)
    c, _, infer = client(paths, monkeypatch)
    with c:
        r = c.post("/predict?model=train-m&conf=0.4", content=b"\x89PNGbytes", headers={"content-type": "image/png"})
        assert r.status_code == 200 and r.json()["detections"][0]["name"] == "low_beam" and r.json()["conf"] == 0.4
        assert infer.calls[-1]["bytes"] == b"\x89PNGbytes" and infer.calls[-1]["conf"] == 0.4
        r2 = c.post("/predict?model=train-m&photo=p1")
        assert r2.status_code == 200 and infer.calls[-1]["bytes"] == b"\x89PNG"
        assert c.post("/predict?model=train-m", content=b"x", headers={"content-type": "text/plain"}).status_code == 415
        assert c.post("/predict?model=nope", content=b"x", headers={"content-type": "image/png"}).status_code == 404
