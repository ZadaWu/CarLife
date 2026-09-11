"""屏幕定位（施工单 M79-02）：造合成图断言几何判据，不依赖真实帧。"""

from __future__ import annotations

import numpy as np
from PIL import Image

from vision_trainer.tools.screen import locate_screen


def scene(box: tuple[int, int, int, int], *, size=(960, 540), bg=25, fg=210) -> Image.Image:
    """暗车内 + 一块亮屏幕。"""
    a = np.full((size[1], size[0], 3), bg, np.uint8)
    x0, y0, x1, y1 = box
    a[y0:y1, x0:x1] = fg
    return Image.fromarray(a, "RGB")


def test_locates_a_bright_rectangle():
    box = (200, 100, 760, 440)  # 560x340，占画面 36%，宽高比 1.65
    b = locate_screen(scene(box))
    assert b is not None
    for got, want in zip(b.as_tuple(), box):
        assert abs(got - want) <= 16, f"{b.as_tuple()} vs {box}"


def test_rejects_too_small_too_big_and_wrong_ratio():
    assert locate_screen(scene((10, 10, 90, 60))) is None, "太小：占画面不到 20%"
    assert locate_screen(scene((2, 2, 958, 538))) is None, "太大：几乎整幅都亮，那不是屏幕"
    assert locate_screen(scene((300, 60, 460, 500))) is None, "竖条：宽高比不在 1.2–2.6"


def test_rejects_overall_overexposure():
    """整幅都亮（逆光过曝）时框内不比框外亮多少——这时候宁可不定位。"""
    a = np.full((540, 960, 3), 200, np.uint8)
    a[100:440, 200:760] = 205
    assert locate_screen(Image.fromarray(a, "RGB")) is None


def test_returns_none_when_nothing_is_bright():
    assert locate_screen(scene((200, 100, 760, 440), fg=30)) is None


def test_box_geometry_helpers():
    b = locate_screen(scene((200, 100, 760, 440)))
    assert b is not None
    assert b.width == b.x1 - b.x0 and b.height == b.y1 - b.y0
