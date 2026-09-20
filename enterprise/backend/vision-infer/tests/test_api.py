"""接口契约（ACR-050）：与 vision-trainer 的 `/predict` 同形，`yolo.ts` 才能一行不改。"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from vision_infer.app import DEFAULT_MODEL_DIR, create_app, model_id_from_doc

FIXTURE = DEFAULT_MODEL_DIR.parent / "tests" / "fixtures" / "store-03-parked.jpg"
MODEL = model_id_from_doc(DEFAULT_MODEL_DIR)


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(create_app())


def test_模型号来自端上那份_MODEL_md() -> None:
    assert MODEL and MODEL.startswith("train-")


def test_health_自报模型号与尺寸(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["ok"] is True and body["model"] == MODEL and body["imgsz"] == 960 and body["classes"] == 27


def test_predict_响应形状与训练服务一致(client: TestClient) -> None:
    r = client.post(f"/predict?model={MODEL}&conf=0.3&imgsz=960", content=FIXTURE.read_bytes(), headers={"content-type": "image/jpeg"})
    assert r.status_code == 200
    body = r.json()
    # yolo.ts 的 PredictResponse 取的就是这几个字段
    assert body["ok"] is True and body["imageW"] > 0 and body["imageH"] > 0 and body["model"] == MODEL
    assert len(body["detections"]) >= 1
    d = body["detections"][0]
    assert set(d) >= {"name", "conf", "xyxy"} and len(d["xyxy"]) == 4
    assert 0 <= d["xyxy"][0] < d["xyxy"][2] <= body["imageW"]
    # 像素框，不是 0–1000：归一化在 yolo.ts 的 toNormalizedBBox 里做，这里做了就是归一化两次。
    # 夹具里 parking_lights 的归一化框是 [79,182,107,203]，图宽 2856 → 左边约 225 px；回 79 上下就是归一化过了
    lights = next(x for x in body["detections"] if x["name"] == "parking_lights")
    assert 200 < lights["xyxy"][0] < 250, lights


def test_模型号对不上就_404_不来者不拒(client: TestClient) -> None:
    r = client.post("/predict?model=train-20990101-000000-dead&imgsz=960", content=FIXTURE.read_bytes(), headers={"content-type": "image/jpeg"})
    assert r.status_code == 404
    assert r.json() == {"error": "model_not_found", "serving": MODEL}


def test_尺寸与导出尺寸不一致就_400(client: TestClient) -> None:
    r = client.post(f"/predict?model={MODEL}&imgsz=1280", content=FIXTURE.read_bytes(), headers={"content-type": "image/jpeg"})
    assert r.status_code == 400 and r.json()["error"] == "imgsz_unsupported"


def test_坏输入各有各的错误码(client: TestClient) -> None:
    url = f"/predict?model={MODEL}&imgsz=960"
    assert client.post(url, content=b"x", headers={"content-type": "text/plain"}).status_code == 415
    assert client.post(url, content=b"", headers={"content-type": "image/png"}).json()["error"] == "empty_body"
    # 声明是 PNG、内容不是图片：400 而不是 500——上游据此知道是这张图的问题，不是服务坏了
    r = client.post(url, content=b"not an image at all", headers={"content-type": "image/png"})
    assert r.status_code == 400 and r.json()["error"] == "undecodable_image"


def test_没有灯的图回零框而不是报错(client: TestClient) -> None:
    buf = io.BytesIO()
    Image.new("RGB", (640, 480), (40, 40, 40)).save(buf, format="PNG")
    body = client.post(f"/predict?model={MODEL}&imgsz=960", content=buf.getvalue(), headers={"content-type": "image/png"}).json()
    assert body["ok"] is True and body["detections"] == [] and (body["imageW"], body["imageH"]) == (640, 480)
