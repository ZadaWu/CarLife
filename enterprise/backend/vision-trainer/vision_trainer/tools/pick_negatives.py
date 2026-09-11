"""
负样本筛选（施工单 M79-01）：从真实屏幕帧里挑出**一盏指示灯都没亮**的。

# 判据是颜色，不是模型

第一版打算用观察层粗筛（「它说零警示灯的就是候选」）。2026-09-09 实测这条路不成立：
它对 15 张帧全说「零警示灯」，把图标列裁出来放大一看，**其中 7 张明明亮着近光灯与驻车灯两盏**。
整帧 1920×1080 里一枚图标只有 30 px，模型看不见。

所以判据换成确定性的：**图标列里有没有彩色像素**。指示灯亮起来是绿 / 蓝 / 红 / 琥珀，
而屏幕底色是灰白，行车画面那一列除了灯什么都没有。这条又快又免费，而且在这件事上比模型灵。
最后仍要人眼过一遍放大的图标列——一张其实亮着灯的负样本，等于教模型别去认那盏灯，比没有负样本更糟。

用法（在 enterprise/backend/vision-trainer 下）：
  uv run python -m vision_trainer.tools.pick_negatives --scan 24
  # → 最干净的 24 张：清单 JSON + 图标列放大联系表，人眼过完再入库
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from ..paths import Paths
from .composite import COL_X_MAX, COL_X_MIN, COL_Y_MAX, COL_Y_MIN
from .screen import locate_screen

PATHS = Paths.from_env()
FRAMES = PATHS.datasets / "roboflow-tesla-new-hmi"


def frames() -> dict[str, list[Path]]:
    """按来源视频分组（文件名前缀就是视频号）——同一段里相邻帧几乎一样，取样要跨段。"""
    by: dict[str, list[Path]] = defaultdict(list)
    for f in sorted(FRAMES.glob("*/images/*.jpg")):
        by[f.name.split("_")[0]].append(f)
    return dict(by)


def icon_column(im: Image.Image) -> Image.Image | None:
    """屏幕内的图标列（速度读数之下那一条）。定不出屏幕就返回 None——不猜位置。"""
    b = locate_screen(im)
    if b is None:
        return None
    return im.crop(
        (
            b.x0 + int(b.width * max(0.0, COL_X_MIN - 0.004)),
            b.y0 + int(b.height * COL_Y_MIN),
            b.x0 + int(b.width * (COL_X_MAX + 0.02)),
            b.y0 + int(b.height * COL_Y_MAX),
        )
    )


# 判据阈值：像素颜色偏离「这一列的背景色」多远算有东西。
# 2026-09-09 用 22 张人工标注的图标列标定（3 张确实无灯、19 张亮着近光灯与驻车灯）：
#   偏离 > 12 时，无灯的是 0 个像素，有灯的是 604–1024 个——中间是空的，怎么切都对。
# 一开始用的是「饱和度 > 42」，结果 22 张全判成 0：真实图标的饱和度只有 14–15，
# 而屏幕底色本身带粉紫色偏，绝对饱和度根本分不开。要看的是**偏离背景色**，不是饱和度本身。
COLOR_DEVIATION = 12.0
LIT_PIXEL_CUTOFF = 200
# 图标列必须确实落在**亮着的屏幕**上。第一版没这道门，选出来的 18 张里有 5 张整条是黑的——
# 那是屏幕定位偏了、裁到了车内暗处。一张"车内暗处没有灯"当负样本毫无意义：
# 负样本要问的是「屏幕上没有灯时模型会不会乱报」，不是「黑色区域里有没有灯」。
COLUMN_MIN_LUMA = 95.0


def lit_pixels(im: Image.Image) -> int | None:
    """图标列里偏离背景色的像素数。0 就是没灯；定不出屏幕返回 None。"""
    col = icon_column(im)
    if col is None:
        return None
    a = np.asarray(col).astype(np.float32)
    if float(a.mean()) < COLUMN_MIN_LUMA:
        return None                                        # 没落在亮屏上，这张不算候选
    chroma = a - a.mean(2, keepdims=True)                  # 去掉亮度，只留颜色偏向
    bg = np.median(chroma.reshape(-1, 3), axis=0)          # 这一列的底色偏向（粉紫 / 冷白，随环境变）
    return int((np.linalg.norm(chroma - bg, axis=2) > COLOR_DEVIATION).sum())


def scan_all(per_video: int | None = None) -> list[tuple[int, Path]]:
    """全量扫描，按彩色像素数升序。每段视频最多取 per_video 张，避免 10 张全来自同一段。"""
    out: list[tuple[int, Path]] = []
    for group in frames().values():
        scored = []
        for f in group:
            n = lit_pixels(Image.open(f).convert("RGB"))
            if n is not None:
                scored.append((n, f))
        scored.sort(key=lambda t: t[0])
        # 只要真正干净的：超过阈值的一律不要，宁可少几张也不能混进亮着灯的
        clean = [t for t in scored if t[0] < LIT_PIXEL_CUTOFF]
        out.extend(clean[: per_video or len(clean)])
    out.sort(key=lambda t: t[0])
    return out


def sheet(files: list[Path], out: Path, scale: int = 3) -> None:
    """把图标列裁出来放大拼成一条——人眼要看的就是这一列上有没有灯，不是车内环境。"""
    strips: list[Image.Image] = []
    for f in files:
        col = icon_column(Image.open(f).convert("RGB"))
        if col is not None:
            strips.append(col.resize((col.width * scale, col.height * scale), Image.LANCZOS))
    if not strips:
        raise SystemExit("一张图标列都裁不出来")
    w = max(s.width for s in strips)
    h = max(s.height for s in strips)
    canvas = Image.new("RGB", (len(strips) * (w + 8) + 8, h + 28), "#dddddd")
    dr = ImageDraw.Draw(canvas)
    for i, s in enumerate(strips):
        canvas.paste(s, (8 + i * (w + 8), 22))
        dr.text((8 + i * (w + 8), 5), f"#{i}", fill="black")
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, quality=92)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", type=int, default=24, help="取最干净的 N 张")
    ap.add_argument("--per-video", type=int, default=2, help="每段视频最多贡献几张")
    ap.add_argument("--out", type=Path, default=Path("negatives.json"))
    ap.add_argument("--sheet-out", type=Path, default=Path("negatives-columns.jpg"))
    args = ap.parse_args()

    ranked = scan_all(args.per_video)
    if not ranked:
        raise SystemExit(f"没有可用帧：{FRAMES}")
    best = [f for _, f in ranked[: args.scan]]
    sheet(best, args.sheet_out)
    args.out.write_text(json.dumps([str(f) for f in best], ensure_ascii=False, indent=1), encoding="utf-8")
    print(
        json.dumps(
            {
                "扫描": len(ranked),
                "取最干净": len(best),
                "彩色像素数": {"最小": ranked[0][0], f"第 {len(best)} 名": ranked[len(best) - 1][0], "中位": ranked[len(ranked) // 2][0]},
                "清单": str(args.out),
                "联系表": str(args.sheet_out),
            },
            ensure_ascii=False,
            indent=1,
        )
    )


if __name__ == "__main__":
    main()
