"""
真实正样本候选（施工单 M80-08）：从真实屏幕帧里把**亮着的指示灯**框出来，出候选清单与联系表。

# 为什么要它

M79 的训练集里正样本全是合成的（手册图标贴到真实屏幕上），模型从没见过屏幕上真正渲染出来的那枚灯。
2026-09-10 实测的后果：`low_beam` 在任何阈值下都检不出来（混淆矩阵上 67% 判成背景），
而近光灯与驻车灯恰恰是行车录像里**几乎一直亮着**的——815 张真实帧就是现成的真题。

# 判据与 pick_negatives 同源

同一个 `icon_column()`、同一个「偏离背景色 > 12」的颜色判据（2026-09-09 在 22 张人工标注的图标列上标定），
只是这里取的是**有**彩色像素的那些，并把彩色像素按行投影切成一枚一枚的灯。
灰色未点亮的图标（自适应远光待机那种）颜色判据看不见，这里也不会框——**宁可漏，不能框错**。

# 这里不给类别名

框出来的每一枚灯是什么，交给下一步（`evals/vision-observe/tools/label-positives.mts`）用手册图标目录去认，
与生产链路同一套匹配与核验。本脚本只回答「哪里有一盏亮着的灯」。

用法（在 enterprise/backend/vision-trainer 下）：
  uv run python -m vision_trainer.tools.pick_positives --per-video 8 --exclude-videos GH019597,GH029597,...
  # → candidates.json（每枚灯：帧、屏幕框、灯的像素框）+ crops/<id>.png + contact sheet
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
from .pick_negatives import COLOR_DEVIATION, COLUMN_MIN_LUMA
from .screen import ScreenBox, locate_screen

PATHS = Paths.from_env()
FRAMES = PATHS.datasets / "roboflow-tesla-new-hmi"

# 一枚灯在图标列里的高度范围（原帧像素）。实测单枚约 30 px（屏幕宽 1360 时）；
# 低于 8 px 是噪点或反光，高于 70 px 是两枚挨在一起没切开——都不要。
MIN_ICON_H, MAX_ICON_H = 8, 70
# 一枚灯至少要有这么多彩色像素（pick_negatives 标定：有灯 604–1024，这里按单枚放宽到三分之一）
MIN_LIT_PIXELS = 150
# 行投影里连续空行超过这个数就算两枚分开了
ROW_GAP = 3


def column_box(b: ScreenBox) -> tuple[int, int, int, int]:
    """图标列在整帧里的像素框（与 pick_negatives.icon_column 同一套坐标）。"""
    return (
        b.x0 + int(b.width * max(0.0, COL_X_MIN - 0.004)),
        b.y0 + int(b.height * COL_Y_MIN),
        b.x0 + int(b.width * (COL_X_MAX + 0.02)),
        b.y0 + int(b.height * COL_Y_MAX),
    )


def lit_mask(col: Image.Image) -> np.ndarray | None:
    a = np.asarray(col).astype(np.float32)
    if float(a.mean()) < COLUMN_MIN_LUMA:
        return None
    chroma = a - a.mean(2, keepdims=True)
    bg = np.median(chroma.reshape(-1, 3), axis=0)
    return np.linalg.norm(chroma - bg, axis=2) > COLOR_DEVIATION


def split_rows(mask: np.ndarray) -> list[tuple[int, int]]:
    """把彩色像素按行投影切成竖向的段：每段 = 一枚灯的 y 范围（列内坐标）。"""
    rows = mask.sum(1) >= 2
    runs: list[tuple[int, int]] = []
    start: int | None = None
    gap = 0
    for y, on in enumerate(rows):
        if on:
            if start is None:
                start = y
            gap = 0
        elif start is not None:
            gap += 1
            if gap > ROW_GAP:
                runs.append((start, y - gap))
                start, gap = None, 0
    if start is not None:
        runs.append((start, len(rows) - 1 - gap))
    return runs


def blobs(im: Image.Image) -> tuple[ScreenBox, list[tuple[int, int, int, int]]] | None:
    """整帧 → (屏幕框, [每枚亮灯的整帧像素框])。定不出屏幕 / 屏幕没亮 → None。"""
    b = locate_screen(im)
    if b is None:
        return None
    cx0, cy0, cx1, cy1 = column_box(b)
    mask = lit_mask(im.crop((cx0, cy0, cx1, cy1)))
    if mask is None:
        return None
    out: list[tuple[int, int, int, int]] = []
    for y0, y1 in split_rows(mask):
        h = y1 - y0 + 1
        if not (MIN_ICON_H <= h <= MAX_ICON_H):
            continue
        part = mask[y0 : y1 + 1]
        if int(part.sum()) < MIN_LIT_PIXELS:
            continue
        xs = np.flatnonzero(part.any(0))
        x0, x1 = int(xs.min()), int(xs.max())
        # 外扩 2 px：颜色判据只抓到笔画中心，框要把抗锯齿边也包进去
        out.append((cx0 + x0 - 2, cy0 + y0 - 2, cx0 + x1 + 3, cy0 + y1 + 3))
    return b, out


def frames_by_video() -> dict[str, list[Path]]:
    by: dict[str, list[Path]] = defaultdict(list)
    for f in sorted(FRAMES.glob("*/images/*.jpg")):
        by[f.name.split("_")[0]].append(f)
    return dict(by)


def spread(xs: list[Path], n: int) -> list[Path]:
    """一段视频里均匀取 n 张——相邻帧几乎一样，挤在一起等于一张。"""
    if len(xs) <= n:
        return xs
    step = len(xs) / n
    return [xs[int(i * step)] for i in range(n)]


def sheet_by_class(labels_json: Path) -> None:
    """每个类别一张联系表（最多 80 枚）——人眼一扫就知道有没有认错的混进来。"""
    data = json.loads(labels_json.read_text(encoding="utf-8"))
    by: dict[str, list[dict]] = defaultdict(list)
    for l in data["labels"]:
        by[l["symbolId"] or "unlabeled"].append(l)
    out_dir = labels_json.parent / "by-class"
    out_dir.mkdir(exist_ok=True)
    for cls, rows in by.items():
        tiles = []
        for r in rows[:80]:
            im = Image.open(r["crop"]).convert("RGB")
            s = 96 / max(1, im.height)
            tiles.append(im.resize((max(1, int(im.width * s)), 96), Image.LANCZOS))
        per_row, w = 20, max(t.width for t in tiles) + 6
        n_rows = (len(tiles) + per_row - 1) // per_row
        sheet = Image.new("RGB", (per_row * w + 6, n_rows * 104 + 6), "#dddddd")
        for i, t in enumerate(tiles):
            sheet.paste(t, (6 + (i % per_row) * w, 6 + (i // per_row) * 104))
        sheet.save(out_dir / f"{cls}.jpg", quality=88)
    print(json.dumps({k: len(v) for k, v in by.items()}, ensure_ascii=False))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-video", type=int, default=8)
    ap.add_argument("--exclude-videos", default="", help="逗号分隔的视频号：评测负样本所在的段，整段不进训练")
    ap.add_argument("--out", type=Path, default=Path("positives"))
    ap.add_argument("--pad", type=float, default=0.5, help="crop 外扩比例（与观察层 extractCrop 同一个 0.5）")
    ap.add_argument("--upscale", type=int, default=320, help="crop 短边放大到这么多像素再存（观察层 minCropSide 同一个 320：30 px 的原图向量与核验都不稳）；0 = 不放大")
    ap.add_argument("--sheet-by-class", type=Path, help="只出按类别分组的联系表：给 label-positives 出的 labels.json")
    args = ap.parse_args()
    if args.sheet_by_class:
        sheet_by_class(args.sheet_by_class)
        return
    excluded = {v.strip() for v in args.exclude_videos.split(",") if v.strip()}

    crops_dir = args.out / "crops"
    crops_dir.mkdir(parents=True, exist_ok=True)
    cands: list[dict] = []
    stats = {"videos": 0, "frames_scanned": 0, "no_screen": 0, "no_lit": 0, "frames_with_lit": 0, "excluded_videos": sorted(excluded)}
    for video, files in frames_by_video().items():
        if video in excluded:
            continue
        stats["videos"] += 1
        for f in spread(files, args.per_video):
            stats["frames_scanned"] += 1
            im = Image.open(f).convert("RGB")
            r = blobs(im)
            if r is None:
                stats["no_screen"] += 1
                continue
            screen, boxes = r
            if not boxes:
                stats["no_lit"] += 1
                continue
            stats["frames_with_lit"] += 1
            for i, (x0, y0, x1, y1) in enumerate(boxes):
                bw, bh = x1 - x0, y1 - y0
                cx0, cy0 = max(0, int(x0 - bw * args.pad)), max(0, int(y0 - bh * args.pad))
                cx1, cy1 = min(im.width, int(x1 + bw * args.pad)), min(im.height, int(y1 + bh * args.pad))
                cid = f"{f.stem[:24]}-{i}"
                crop = im.crop((cx0, cy0, cx1, cy1))
                short = min(crop.size)
                if args.upscale and short < args.upscale:
                    k = args.upscale / short
                    crop = crop.resize((max(1, int(crop.width * k)), max(1, int(crop.height * k))), Image.LANCZOS)
                crop.save(crops_dir / f"{cid}.png")
                cands.append({"id": cid, "video": video, "frame": str(f), "screen": screen.as_tuple(), "bbox": [x0, y0, x1, y1], "crop": str(crops_dir / f"{cid}.png")})

    (args.out / "candidates.json").write_text(json.dumps({"stats": stats, "candidates": cands}, ensure_ascii=False, indent=1), encoding="utf-8")

    # 联系表：每枚灯放大到 96 px 高，横排 24 个一行，编号写在上面——人眼过一遍用
    tiles = []
    for c in cands:
        im = Image.open(c["crop"]).convert("RGB")
        s = 96 / max(1, im.height)
        tiles.append((c["id"], im.resize((max(1, int(im.width * s)), 96), Image.LANCZOS)))
    if tiles:
        per_row = 24
        w = max(t.width for _, t in tiles) + 6
        rows = (len(tiles) + per_row - 1) // per_row
        sheet = Image.new("RGB", (per_row * w + 6, rows * 120 + 6), "#dddddd")
        dr = ImageDraw.Draw(sheet)
        for i, (cid, t) in enumerate(tiles):
            x, y = 6 + (i % per_row) * w, 6 + (i // per_row) * 120
            sheet.paste(t, (x, y + 16))
            dr.text((x, y), str(i), fill="black")
        sheet.save(args.out / "contact-sheet.jpg", quality=88)
    print(json.dumps({**stats, "candidates": len(cands)}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
