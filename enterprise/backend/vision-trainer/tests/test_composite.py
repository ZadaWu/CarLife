"""合成器（施工单 M79-02）：目录读取、放置约束、标注正确性、可复现。全用造出来的图，不碰真实数据集。"""

from __future__ import annotations

import random
from pathlib import Path

import numpy as np
from PIL import Image

from vision_trainer.tools.composite import COL_Y_MAX, ICON_W_MAX, ICON_W_MIN, Icon, load_icons, place, write_split
from vision_trainer.tools.screen import ScreenBox

CATALOG = """# 假目录

vehicle: 测试车

| symbol_id | 名称 | class | severity | shape | color | elements | text | 锚点 | 说明 | 描述子来源 | 图片 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| alpha_light | 甲灯 | status | info | lamp | green | - | - | 手册 › 甲 | 说明 | manual-image | alpha_light.png |
| beta_light | 乙灯 | fault | stop | circle | red | - | - | 手册 › 乙 | 说明 | manual-image | beta_light.png |
| gone_light | 丙灯（已废弃） | status | info | lamp | green | - | - | 手册 › 丙 | 不存在 | deprecated | - |
| no_image | 丁灯 | status | info | lamp | green | - | - | 手册 › 丁 | 没图 | manual-image | missing.png |
"""


def make_catalog(tmp: Path) -> Path:
    md = tmp / "fake-indicators.md"
    md.write_text(CATALOG, encoding="utf-8")
    d = tmp / "fake"
    d.mkdir()
    for name, color in (("alpha_light", (0, 200, 60)), ("beta_light", (220, 30, 30))):
        im = Image.new("RGBA", (64, 64), (255, 255, 255, 0))
        im.paste((*color, 255), (12, 12, 52, 52))
        im.save(d / f"{name}.png")
    return md


def bright_frame(path: Path, box=(120, 60, 840, 480), size=(960, 540)) -> None:
    a = np.full((size[1], size[0], 3), 22, np.uint8)
    x0, y0, x1, y1 = box
    a[y0:y1, x0:x1] = 205
    Image.fromarray(a, "RGB").save(path, quality=95)


def test_load_icons_skips_deprecated_and_missing_files(tmp_path):
    icons = load_icons(make_catalog(tmp_path))
    assert [i.symbol_id for i in icons] == ["alpha_light", "beta_light"], "废弃的与没图的都不该进来"


def test_place_keeps_icons_inside_the_screen_and_apart(tmp_path):
    icons = load_icons(make_catalog(tmp_path))
    box = ScreenBox(120, 60, 840, 480)
    bg = Image.new("RGBA", (960, 540), (205, 205, 205, 255))
    got = place(bg, box, icons, random.Random(1), [1.0] * len(icons))
    assert got, "至少放一枚"
    prev_bottom = -1
    for _, x0, y0, x1, y1 in got:
        assert box.x0 <= x0 and x1 <= box.x1, "横向要在屏幕内"
        assert box.y0 <= y0 and y1 <= box.y0 + box.height * COL_Y_MAX + 2, "纵向不能超出图标列"
        assert y0 > prev_bottom, "竖排不重叠"
        prev_bottom = y1
        w_ratio = (x1 - x0) / box.width
        assert ICON_W_MIN - 0.002 <= w_ratio <= ICON_W_MAX + 0.002, f"尺寸要按屏幕宽等比：{w_ratio:.3f}"


def test_write_split_labels_are_inside_the_crop_and_match_names(tmp_path):
    icons = load_icons(make_catalog(tmp_path))
    frames = tmp_path / "frames"
    frames.mkdir()
    for i in range(3):
        bright_frame(frames / f"f{i}.jpg")
    out = tmp_path / "ds"
    stats = write_split(out, "train", 5, sorted(frames.glob("*.jpg")), icons, random.Random(7), [1.0] * len(icons))
    assert stats["images"] == 5 and stats["boxes"] > 0
    for lbl in sorted((out / "labels" / "train").glob("*.txt")):
        img = Image.open(out / "images" / "train" / f"{lbl.stem}.jpg")
        for line in lbl.read_text(encoding="utf-8").splitlines():
            cls, cx, cy, w, h = line.split()
            assert 0 <= int(cls) < len(icons), "类别序号要落在 names 范围内"
            cx, cy, w, h = float(cx), float(cy), float(w), float(h)
            assert 0 < cx - w / 2 and cx + w / 2 < 1, "框要在图里"
            assert 0 < cy - h / 2 and cy + h / 2 < 1
            assert w * img.width > 4 and h * img.height > 4, "框不能退化成一个点"


def test_same_seed_same_result(tmp_path):
    icons = load_icons(make_catalog(tmp_path))
    frames = tmp_path / "frames"
    frames.mkdir()
    for i in range(3):
        bright_frame(frames / f"f{i}.jpg")
    fs = sorted(frames.glob("*.jpg"))
    a = write_split(tmp_path / "a", "train", 4, fs, icons, random.Random(11), [1.0] * len(icons))
    b = write_split(tmp_path / "b", "train", 4, fs, icons, random.Random(11), [1.0] * len(icons))
    assert a["per_class"] == b["per_class"]
    assert [m["icons"] for m in a["manifest"]] == [m["icons"] for m in b["manifest"]]


def test_frames_without_a_locatable_screen_are_skipped_not_guessed(tmp_path):
    icons = load_icons(make_catalog(tmp_path))
    frames = tmp_path / "frames"
    frames.mkdir()
    # 全黑：定不出屏幕
    Image.fromarray(np.full((540, 960, 3), 20, np.uint8), "RGB").save(frames / "dark.jpg")
    stats = write_split(tmp_path / "ds", "train", 3, sorted(frames.glob("*.jpg")), icons, random.Random(3), [1.0] * len(icons))
    assert stats["images"] == 0, "定不出屏幕就不该产出样本"
    assert stats["skipped_frames"] > 0, "而且要如实记下跳过了多少"
