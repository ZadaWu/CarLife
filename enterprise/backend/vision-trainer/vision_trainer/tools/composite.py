"""
把手册图标合成到真实屏幕上，出带 YOLO 标注的训练集（施工单 M79-02）。

# 为什么要这个

红色与琥珀色故障灯在正常行车的录像里永远拍不到——制动失效、动力电池故障没人开着上路。
这类正样本只能合成。

# 与 `synth.py` 的区别，以及那一版错在哪

`synth.py`（M76）从 `tesla-01.png` 抠出 4 枚图标，贴回**同一张照片**裁出的底图。2026-09-09 实测：
这样训出的模型在 7 张与车无关的 UI 截图上 7/7 误报 `seatbelt_unfastened`，框在一个橙色应用图标上。
它学到的是「浅底上一块橙红色的小图形」，不是图标形状——因为每个类只有一个真实样本、底图也只有一张。

这一版换成：27 枚**手册**图标 × 815 张**真实**屏幕帧，位置按屏幕相对坐标，尺度按屏幕宽，
再加亮度对齐、模糊、噪点、JPEG 四道随机化。

# 四道融合缺一不可

直接 alpha 贴上去边缘太干净，模型一眼就能靠"边缘锐利度"作弊：
① 亮度对齐——把图标整体亮度按底图局部亮度缩放；② 高斯模糊 0.3–1.2 px；
③ 加与底图同强度的噪点；④ 整图最后走一次 JPEG（质量 70–92）。

# 红线

合成图**只进训练集**。`evals/vision-observe/cases.jsonl`（评测真值）一条都不能进——
评测集混进合成图，等于用自己的作业给自己打分。
"""

from __future__ import annotations

import argparse
import json
import random
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from ..paths import Paths
from .screen import locate_screen

PATHS = Paths.from_env()
ICONS_ROOT = PATHS.root / "data" / "kb-src" / "icons"
FRAMES = PATHS.datasets / "roboflow-tesla-new-hmi"

# 尺度与位置是**从真实帧上量的**（2026-09-09，GH019597_00005：屏幕 1360×800，两枚绿色指示灯）：
#   单枚宽 30 px = 屏幕宽的 2.2%；列在 x 1.7%–3.9%；第一枚 y 21.6%，竖排间距 5.7%。
# 一开始按 tesla-01 量成了 x 48%–58%，合成出来图标落在地图面板上——那张照片是**裁掉大半屏幕**的特写，
# 「屏幕宽」的分母根本不同。教训：相对坐标必须在完整屏幕上量。
ICON_W_MIN, ICON_W_MAX = 0.018, 0.030
COL_X_MIN, COL_X_MAX = 0.014, 0.042
COL_Y_MIN, COL_Y_MAX = 0.19, 0.60
ROW_GAP_MIN, ROW_GAP_MAX = 0.050, 0.075

FULL_FRAME = False  # 由 --full-frame 置位；见 write_split 里的取舍注释

ROW = re.compile(r"^\|\s*([a-z0-9_]+)\s*\|(?:[^|]*\|){9}\s*([a-z-]+)\s*\|\s*([^|]*?)\s*\|\s*$")


@dataclass(frozen=True)
class Icon:
    symbol_id: str
    image: Image.Image


def load_icons(catalog: Path) -> list[Icon]:
    """读目录 md：只取非 deprecated 且有图片的条目。类别顺序 = 文件里的顺序，写进 data.yaml。"""
    icons: list[Icon] = []
    dir_name = catalog.name[: -len("-indicators.md")]
    for line in catalog.read_text(encoding="utf-8").splitlines():
        m = ROW.match(line)
        if not m:
            continue
        symbol_id, source, image = m.groups()
        if source == "deprecated" or image in ("", "-"):
            continue
        p = catalog.parent / dir_name / image
        if not p.exists():
            continue
        icons.append(Icon(symbol_id, Image.open(p).convert("RGBA")))
    if not icons:
        raise SystemExit(f"目录里一枚可用图标都没有：{catalog}")
    return icons


# 对比度与饱和度的目标区间**来自实测**（2026-09-09，把真实图标与背景逐像素量出来的）：
#   GoPro 远拍：对比度 18–19、笔画饱和度 14–15；车主近拍（tesla-01）：对比度 32–67、饱和度 46–100。
# 第一版合成挤在对比度 18–27、饱和度 31–44 —— 数值本身不算错，错在**分布太窄**：
# 真实世界从"远拍糊成一团"到"近拍鲜艳"跨了三四倍，模型只见过中间那一段就学不到两头。
# 注意这里填的是**贴之前的目标**，比想要的实测值高一档：后面的模糊与 JPEG 会吃掉约三成对比度
# （第一版按实测值直接填，出来的中位对比度只有 16，低于真实的 18–67）。下面这组是补偿后校准出来的。
CONTRAST_MIN, CONTRAST_MAX = 26.0, 105.0
SAT_MIN, SAT_MAX = 22.0, 175.0


def _gauss(a: np.ndarray, radius: float) -> np.ndarray:
    """对单通道做高斯模糊。走 PIL 是为了不引 scipy——这个包的依赖只有 numpy 与 pillow。"""
    lo, hi = float(a.min()), float(a.max())
    if hi - lo < 1e-6:
        return a
    norm = (a - lo) * (255.0 / (hi - lo))
    blurred = np.asarray(Image.fromarray(norm.astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(radius))).astype(np.float32)
    return blurred * ((hi - lo) / 255.0) + lo


def blend(bg: Image.Image, icon: Image.Image, xy: tuple[int, int], rng: random.Random) -> None:
    """把图标融进底图：按实测区间调对比度与饱和度 → 模糊 → 噪点 → 贴。"""
    x, y = xy
    patch = np.asarray(bg.crop((x, y, x + icon.width, y + icon.height)).convert("RGB")).astype(np.float32)
    local = float(patch.mean()) or 1.0

    rgb = np.asarray(icon.convert("RGB")).astype(np.float32)
    alpha = np.asarray(icon.split()[3]).astype(np.float32) / 255.0
    ink = alpha > 0.5
    if ink.any():
        lum = rgb.mean(2)
        chroma = rgb - lum[..., None]
        ink_lum = float(lum[ink].mean()) or 1.0
        ink_sat = float((rgb.max(2) - rgb.min(2))[ink].mean()) or 1.0
        # 目标：笔画亮度落在 局部背景 − 目标对比度；笔画饱和度落在目标值。
        # 色度**先抹一道再放大**：手册图标是 PNG 抠白底来的，笔画边缘留着一圈弱色噪；
        # 直接乘上 10 倍以上的系数，那圈噪声会长成红绿麻点——真实照片里没有这种东西，
        # 2026-09-09 第一版对照图上一眼就能认出哪五条是合成的。所以先高斯 0.8 px 再放大，
        # 并把系数封在 8 倍：放大倍数本身就是"这枚图标源色有多淡"的产物，不该无上限。
        chroma = np.stack([_gauss(chroma[..., k], 0.8) for k in range(3)], axis=-1)
        # 浅底：笔画比底暗；深底（夜间模式，local < 100）：笔画比底亮。原先只有前一条，
        # 贴到黑底上的图标会被压成暗灰疙瘩（2026-09-17 黑底合成第一版一眼就看出来）。
        contrast = rng.uniform(CONTRAST_MIN, CONTRAST_MAX)
        target_lum = min(240.0, local + contrast) if local < 100.0 else max(8.0, local - contrast)
        sat_scale = min(8.0, rng.uniform(SAT_MIN, SAT_MAX) / ink_sat)
        rgb = lum[..., None] * (target_lum / ink_lum) + chroma * sat_scale
    rgb += np.random.default_rng(rng.randrange(1 << 30)).normal(0, rng.uniform(1.5, 5.0), rgb.shape)
    merged = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")
    merged.putalpha(Image.fromarray((alpha * 255).astype(np.uint8), "L"))
    # 图标只有 30 px 上下，真实照片里边缘是糊的；模糊范围按 GoPro 远拍那一档放宽
    merged = merged.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.8)))
    bg.alpha_composite(merged, dest=(x, y))


def place(bg: Image.Image, box, icons: list[Icon], rng: random.Random, weights: list[float]) -> list[tuple[int, int, int, int, int]]:
    """在屏幕左侧那一列竖排放 1–5 枚图标；返回 (类别序号, x0, y0, x1, y1)。"""
    sw, sh = box.width, box.height
    n = rng.randint(1, 5)
    chosen = rng.choices(range(len(icons)), weights=weights, k=n)
    col_x = box.x0 + int(sw * rng.uniform(COL_X_MIN, COL_X_MAX))
    y = box.y0 + int(sh * rng.uniform(COL_Y_MIN, COL_Y_MIN + 0.08))
    y_limit = box.y0 + int(sh * COL_Y_MAX)
    out: list[tuple[int, int, int, int, int]] = []
    for ci in chosen:
        icon = icons[ci]
        w = int(sw * rng.uniform(ICON_W_MIN, ICON_W_MAX))
        h = max(1, round(w * icon.image.height / icon.image.width))
        if y + h > y_limit or col_x + w > bg.width or y + h > bg.height:
            break
        scaled = icon.image.resize((w, h), Image.LANCZOS)
        x = col_x + rng.randint(-int(sw * 0.01), int(sw * 0.01))
        x = max(box.x0, min(x, bg.width - w))
        blend(bg, scaled, (x, y), rng)
        out.append((ci, x, y, x + w, y + h))
        y += h + int(sh * rng.uniform(ROW_GAP_MIN, ROW_GAP_MAX))  # 竖排间距按实测，随机但不重叠
    return out


def write_split(out: Path, split: str, count: int, frames: list[Path], icons: list[Icon], rng: random.Random, weights: list[float]) -> dict:
    img_dir, lbl_dir = out / "images" / split, out / "labels" / split
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)
    made, skipped, boxes = 0, 0, 0
    per_class: dict[str, int] = {}
    manifest: list[dict] = []
    tries = 0
    while made < count and tries < count * 4:
        tries += 1
        f = rng.choice(frames)
        im = Image.open(f).convert("RGB")
        box = locate_screen(im)
        if box is None:
            skipped += 1
            continue  # 定不出屏幕就跳过——贴错位置的样本比没有样本更糟
        canvas = im.convert("RGBA")
        placed = place(canvas, box, icons, rng, weights)
        if not placed:
            skipped += 1
            continue
        name = f"{split}-{made:05d}"
        # 输出**屏幕裁剪**还是**整帧**——这一条 2026-09-16 被真机照片推翻过一次，两种都留着。
        #
        # 原来只出屏幕裁剪，理由是「整帧 1920×1080 里一枚图标只有 30 px，缩到训练尺寸就学不到」。
        # 代价是模型**从没见过带环境的构图**：车主举着手机拍，屏幕只占画面一半，周围是展厅、车窗、方向盘。
        # 2026-09-16 实测：同一个模型在「屏幕拍满」的网图上 4 个框全中，在门店实拍上框全部落到地图区，
        # 一盏灯都没框住。所以 --full-frame 出整帧版，让训练构图和车主的拍法对齐。
        if FULL_FRAME:
            cx0, cy0, cx1, cy1 = 0, 0, canvas.width, canvas.height
        else:
            pad = int(min(box.width, box.height) * 0.03)
            cx0, cy0 = max(0, box.x0 - pad), max(0, box.y0 - pad)
            cx1, cy1 = min(canvas.width, box.x1 + pad), min(canvas.height, box.y1 + pad)
        out_im = canvas.convert("RGB").crop((cx0, cy0, cx1, cy1))
        ow, oh = out_im.size
        out_im.save(img_dir / f"{name}.jpg", quality=rng.randint(70, 92))
        lines = []
        for ci, x0, y0, x1, y1 in placed:
            cx, cy = (x0 - cx0 + (x1 - x0) / 2) / ow, (y0 - cy0 + (y1 - y0) / 2) / oh
            lines.append(f"{ci} {cx:.6f} {cy:.6f} {(x1 - x0) / ow:.6f} {(y1 - y0) / oh:.6f}")
            per_class[icons[ci].symbol_id] = per_class.get(icons[ci].symbol_id, 0) + 1
        (lbl_dir / f"{name}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        manifest.append({"image": f"{name}.jpg", "background": f.name, "icons": [icons[ci].symbol_id for ci, *_ in placed]})
        boxes += len(placed)
        made += 1
    return {"images": made, "boxes": boxes, "skipped_frames": skipped, "per_class": per_class, "manifest": manifest}


def result_sheet(out: Path, split: str, names: list[str], dest: Path, n: int = 12, cols: int = 4) -> None:
    """合成结果联系表：把 YOLO 标注画回图上。要看的是「框贴不贴图标」与「图标像不像拍的」。"""
    imgs = sorted((out / "images" / split).glob("*.jpg"))[:n]
    if not imgs:
        raise SystemExit(f"没有合成图：{out / 'images' / split}")
    tiles: list[Image.Image] = []
    for f in imgs:
        im = Image.open(f).convert("RGB")
        dr = ImageDraw.Draw(im)
        for line in (out / "labels" / split / f"{f.stem}.txt").read_text(encoding="utf-8").split("\n"):
            if not line.strip():
                continue
            ci, cx, cy, w, h = line.split()
            cx, cy, w, h = float(cx) * im.width, float(cy) * im.height, float(w) * im.width, float(h) * im.height
            dr.rectangle((cx - w / 2 - 2, cy - h / 2 - 2, cx + w / 2 + 2, cy + h / 2 + 2), outline="#00ff66", width=2)
            dr.text((cx + w / 2 + 5, cy - h / 2), names[int(ci)], fill="#00ff66")
        im.thumbnail((640, 640))
        tiles.append(im)
    w = max(t.width for t in tiles)
    h = max(t.height for t in tiles)
    rows = (len(tiles) + cols - 1) // cols
    canvas = Image.new("RGB", (cols * (w + 8) + 8, rows * (h + 26) + 8), "#dddddd")
    dr = ImageDraw.Draw(canvas)
    for i, t in enumerate(tiles):
        x, y = 8 + (i % cols) * (w + 8), 8 + (i // cols) * (h + 26)
        canvas.paste(t, (x, y + 20))
        dr.text((x, y + 4), f"#{i} {imgs[i].name}", fill="black")
    dest.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(dest, quality=90)


def compare_sheet(out: Path, frames: list[Path], dest: Path, rng: random.Random, per_side: int = 5) -> dict:
    """
    真实 vs 合成的并排对照——本单最要紧的一张图。

    左半是**真实亮着灯**的图标列（按颜色判据挑彩色像素最多的帧），右半是合成图的图标列。
    并排放大到同一高度，人眼直接比边缘锐利度、对比度、饱和度。分得出来就说明融合还不够。
    """
    from .pick_negatives import icon_column, lit_pixels  # 局部导入：pick_negatives 反过来依赖本模块

    # 只按彩色像素数**降序**取会全是废片：定位偏到车窗外或木纹饰板上的裁图，整条都是"彩色"。
    # 亮着的指示灯在这一列里只占**很小一块**——所以判据是**占比落在一个窄带里**，不是数量最大。
    real: list[Image.Image] = []
    for f in rng.sample(frames, min(240, len(frames))):
        im = Image.open(f).convert("RGB")
        n = lit_pixels(im)
        col = icon_column(im)
        if n is None or col is None:
            continue
        frac = n / max(1, col.width * col.height)
        if 0.004 <= frac <= 0.05:
            real.append(col)
        if len(real) >= per_side:
            break

    synth: list[Image.Image] = []
    for f in sorted((out / "images" / "train").glob("*.jpg")):
        lines = [l for l in (out / "labels" / "train" / f"{f.stem}.txt").read_text(encoding="utf-8").split("\n") if l.strip()]
        if len(lines) < 2:
            continue
        im = Image.open(f).convert("RGB")
        xs, ys = [], []
        for line in lines:
            _, cx, cy, w, h = line.split()
            xs += [(float(cx) - float(w) / 2) * im.width, (float(cx) + float(w) / 2) * im.width]
            ys += [(float(cy) - float(h) / 2) * im.height, (float(cy) + float(h) / 2) * im.height]
        pad = im.width * 0.012
        synth.append(im.crop((max(0, min(xs) - pad), max(0, min(ys) - pad), min(im.width, max(xs) + pad), min(im.height, max(ys) + pad))))
        if len(synth) >= per_side:
            break
    if not real or not synth:
        raise SystemExit(f"对照图凑不齐：真实 {len(real)} 张、合成 {len(synth)} 张")

    target_h = 420
    def norm(c: Image.Image) -> Image.Image:
        return c.resize((max(1, round(c.width * target_h / c.height)), target_h), Image.LANCZOS)
    left, right = [norm(c) for c in real], [norm(c) for c in synth]
    gap, head = 10, 28
    wl = sum(c.width + gap for c in left)
    wr = sum(c.width + gap for c in right)
    canvas = Image.new("RGB", (wl + wr + 40, target_h + head + 10), "#dddddd")
    dr = ImageDraw.Draw(canvas)
    dr.text((10, 8), f"真实亮灯（{len(left)}）", fill="black")
    dr.text((wl + 40, 8), f"合成（{len(right)}）", fill="black")
    x = 10
    for c in left:
        canvas.paste(c, (x, head)); x += c.width + gap
    dr.line((x + 10, 0, x + 10, canvas.height), fill="#ff0000", width=3)
    x += 30
    for c in right:
        canvas.paste(c, (x, head)); x += c.width + gap
    dest.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(dest, quality=92)
    return {"真实亮灯图标列": len(left), "合成图标列": len(synth), "对照图": str(dest)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full-frame", action="store_true", help="输出整帧（带车内环境）而不是屏幕裁剪")
    ap.add_argument("--catalog", type=Path, default=ICONS_ROOT / "tesla-model3-indicators.md")
    ap.add_argument("--frames", type=Path, default=FRAMES)
    ap.add_argument("--name", default="synth-real-bg")
    ap.add_argument("--train", type=int, default=400)
    ap.add_argument("--val", type=int, default=100)
    ap.add_argument("--seed", type=int, default=20260909)
    ap.add_argument("--check-screen", type=int, default=0, help="只出定位框联系表，不合成")
    ap.add_argument("--sheet", type=Path, help="--check-screen 的定位框联系表输出路径")
    ap.add_argument("--result-sheet", type=Path, help="合成结果联系表（画上 YOLO 标注框）输出路径")
    ap.add_argument("--compare", type=Path, help="真实亮灯图标列 vs 合成图标列的并排对照图输出路径")
    ap.add_argument("--compare-only", action="store_true", help="只出对照图，用已有的数据集，不重新合成")
    args = ap.parse_args()
    global FULL_FRAME
    FULL_FRAME = bool(getattr(args, 'full_frame', False))

    rng = random.Random(args.seed)
    icons = load_icons(args.catalog)
    frames = sorted(args.frames.glob("*/images/*.jpg"))
    if not frames:
        raise SystemExit(f"没有底图：{args.frames}")

    if args.compare_only:
        if not args.compare:
            raise SystemExit("--compare-only 要配 --compare <输出路径>")
        print(json.dumps(compare_sheet(PATHS.datasets / args.name, frames, args.compare, random.Random(args.seed)), ensure_ascii=False, indent=1))
        return

    if args.check_screen:
        picks = rng.sample(frames, min(args.check_screen, len(frames)))
        cell, cols = 400, 5
        rows = (len(picks) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * cell, rows * (cell * 9 // 16 + 24)), "#eee")
        dr = ImageDraw.Draw(sheet)
        ok = 0
        for i, f in enumerate(picks):
            im = Image.open(f).convert("RGB")
            b = locate_screen(im)
            if b:
                ImageDraw.Draw(im).rectangle(b.as_tuple(), outline="#00ff66", width=8)
                ok += 1
            im.thumbnail((cell - 8, cell))
            x, y = (i % cols) * cell, (i // cols) * (cell * 9 // 16 + 24)
            sheet.paste(im, (x + 4, y + 4))
            dr.text((x + 6, y + cell * 9 // 16 + 6), f"#{i} {'OK' if b else '未定位'}", fill="black")
        out = args.sheet or Path("screen-boxes.jpg")
        sheet.save(out, quality=88)
        print(json.dumps({"定位成功": ok, "总数": len(picks), "联系表": str(out)}, ensure_ascii=False, indent=1))
        return

    # 类别权重：红色故障灯这类真实拍不到的给更高权重，绿色状态灯真实帧里本来就有
    rare = {"brake_system_fault", "brake_booster_fault", "abs_fault", "parking_brake_fault", "tpms_warning", "airbag_warning", "system_fault", "system_overheat", "power_limited", "battery_low", "door_open", "esc_active", "esc_off"}
    weights = [3.0 if i.symbol_id in rare else 1.0 for i in icons]

    out = PATHS.datasets / args.name
    stats = {}
    for split, n in (("train", args.train), ("val", args.val)):
        stats[split] = write_split(out, split, n, frames, icons, rng, weights)
    (out / "data.yaml").write_text(
        f"path: {out.resolve()}\ntrain: images/train\nval: images/val\nnames:\n"
        + "".join(f"  {i}: {ic.symbol_id}\n" for i, ic in enumerate(icons)),
        encoding="utf-8",
    )
    manifest = {"seed": args.seed, "icons": [i.symbol_id for i in icons], "splits": {k: {kk: vv for kk, vv in v.items() if kk != "manifest"} for k, v in stats.items()}}
    (out / "manifest.json").write_text(json.dumps({**manifest, "items": {k: v["manifest"] for k, v in stats.items()}}, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "README.md").write_text(
        f"# {args.name}（合成数据）\n\n"
        "手册图标合成到真实屏幕帧上（`vision_trainer.tools.composite`，施工单 M79-02）。\n\n"
        "**指标不能当真实召回**：正样本全是贴上去的，模型可能学到合成痕迹。\n"
        "评测集（`../cases.jsonl`）里一张合成图都没有，那才是唯一能说话的尺子。\n\n"
        f"底图来自 Roboflow「Tesla New HMI」（CC BY 4.0，署名 tesla-new-hmi workspace）；图标来自 Model 3 车主手册。\n"
        f"逐张用了哪些底图与图标见 `manifest.json`；种子 {args.seed}。\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"data.yaml → {out / 'data.yaml'}")
    names = [i.symbol_id for i in icons]
    if args.result_sheet:
        result_sheet(out, "train", names, args.result_sheet)
        print(f"合成联系表 → {args.result_sheet}")
    if args.compare:
        print(json.dumps(compare_sheet(out, frames, args.compare, random.Random(args.seed)), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
