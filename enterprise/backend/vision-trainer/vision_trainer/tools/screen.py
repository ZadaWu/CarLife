"""
在车内照片里定位中控屏（施工单 M79-02）。

# 为什么必须定得出来才贴

合成的价值全在「图标出现在它真实会出现的地方」。随机贴会让模型学到「图标可能出现在任何位置」，
而真实约束是「只在屏幕左侧那一列」。位置错了，负样本误接受率会假性变好——模型在无关图片上也敢报。
**定不出来就跳过这张底图，不猜。**

# 判据

屏幕是暗车内背景上的一大块亮矩形。灰度阈值取「均值 + 一档」，取最大连通域的外接框，
再用三条几何约束筛：占画面面积 20%–80%、宽高比 1.2–2.6、框内平均亮度显著高于框外。
三条都是为了拒掉「车窗外的天光」这类同样很亮的大块——它不是矩形、也不在画面中部。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image


@dataclass(frozen=True)
class ScreenBox:
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0

    def as_tuple(self) -> tuple[int, int, int, int]:
        return (self.x0, self.y0, self.x1, self.y1)


def _largest_component(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    """最大连通域的外接框。按行程合并做，比逐像素 BFS 快一个量级，够用。"""
    h, w = mask.shape
    labels = np.zeros((h, w), np.int32)
    parent: list[int] = [0]

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    nxt = 1
    for y in range(h):
        row = mask[y]
        for x in np.flatnonzero(row):
            left = labels[y, x - 1] if x > 0 else 0
            up = labels[y - 1, x] if y > 0 else 0
            if left and up:
                labels[y, x] = min(left, up)
                union(left, up)
            elif left or up:
                labels[y, x] = left or up
            else:
                labels[y, x] = nxt
                parent.append(nxt)
                nxt += 1
    if nxt == 1:
        return None
    flat = labels.ravel()
    nz = flat > 0
    roots = np.array([find(int(v)) for v in flat[nz]])
    best = np.bincount(roots).argmax()
    ys, xs = np.nonzero(labels > 0)
    keep = roots == best
    ys, xs = ys[keep], xs[keep]
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def locate_screen(img: Image.Image, *, downscale: int = 8) -> ScreenBox | None:
    """定位中控屏；定不出来返回 None。先缩小再找——屏幕是大目标，全分辨率纯属浪费。"""
    small = img.convert("L")
    sw, sh = max(1, small.width // downscale), max(1, small.height // downscale)
    small = small.resize((sw, sh), Image.BILINEAR)
    a = np.asarray(small).astype(np.float32)
    thresh = max(a.mean() + 18.0, 70.0)
    box = _largest_component(a > thresh)
    if box is None:
        return None
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    if bw < 4 or bh < 4:
        return None
    area = (bw * bh) / (sw * sh)
    ratio = bw / bh
    if not (0.20 <= area <= 0.80):
        return None
    if not (1.2 <= ratio <= 2.6):
        return None
    inside = a[y0:y1, x0:x1].mean()
    outside_sum = a.sum() - a[y0:y1, x0:x1].sum()
    outside_n = a.size - bw * bh
    if outside_n > 0 and inside <= (outside_sum / outside_n) + 15:
        return None  # 框内不比框外亮多少 —— 找到的多半是整幅过曝，不是屏幕
    s = downscale
    return ScreenBox(x0 * s, y0 * s, min(img.width, x1 * s), min(img.height, y1 * s))
