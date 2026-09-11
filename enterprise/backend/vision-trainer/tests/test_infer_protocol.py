from __future__ import annotations

import json

from vision_trainer.infer import decode, encode, handle


def test_encode_decode_roundtrip():
    line = encode({"op": "predict", "weights": "w", "conf": 0.3})
    assert line.endswith("\n") and decode(line) == {"op": "predict", "weights": "w", "conf": 0.3}
    assert decode("not json")["ok"] is False
    assert decode("[1,2]")["ok"] is False


def test_handle_rejects_before_touching_model(tmp_path):
    assert handle({"op": "nope"}, {})["error"].startswith("unknown_op")
    assert handle({"op": "predict", "weights": str(tmp_path / "no.pt"), "image": str(tmp_path / "x.png")}, {})["error"] == "weights_not_found"
    (tmp_path / "w.pt").write_bytes(b"x")
    assert handle({"op": "predict", "weights": str(tmp_path / "w.pt"), "image": str(tmp_path / "x.png")}, {})["error"] == "image_not_found"
