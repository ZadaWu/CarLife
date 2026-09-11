"""
合成数据集：从 `photos/tesla-01.png` 的真值框里抠出 4 个警示灯图标，随机贴到底图上，写成 YOLO 格式。

这份数据**只用来跑通训练流程**，不构成任何评测结论——底图和图标都来自同一张照片，
模型学到的是「这张图上的这四个像素块」，不是特斯拉图标。真实数据到位后本脚本作废。

用法（在 enterprise/backend/vision-trainer 下）：
  uv run python -m vision_trainer.tools.synth                 # 默认 240 train / 60 val → evals/vision-observe/datasets/synth-tesla01/
  uv run python -m vision_trainer.tools.synth --train 600 --val 150 --seed 7
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

from ..paths import Paths

PATHS = Paths.from_env()
EVAL_ROOT = PATHS.cases.parent
PHOTO = PATHS.photos / "tesla-01.png"
CASES = PATHS.cases

IMG_SIZE = 640


def load_truth(case_id: str = "tesla-01") -> dict:
    for line in CASES.read_text(encoding="utf-8").splitlines():
        if not line.startswith("{"):
            continue
        case = json.loads(line)
        if case["id"] == case_id:
            return case
    raise SystemExit(f"cases.jsonl 里没有 {case_id}")


def norm_to_px(bbox: list[int], w: int, h: int, pad: float = 0.12) -> tuple[int, int, int, int]:
    """0–1000 归一化 [x1,y1,x2,y2] → 像素框，四边各外扩 pad 比例（图标周围留一点屏幕底色）。"""
    x1, y1, x2, y2 = bbox
    bw, bh = (x2 - x1) * pad, (y2 - y1) * pad
    return (
        max(0, int((x1 - bw) / 1000 * w)),
        max(0, int((y1 - bh) / 1000 * h)),
        min(w, int((x2 + bw) / 1000 * w)),
        min(h, int((y2 + bh) / 1000 * h)),
    )


def cut_icons(photo: Image.Image, truth: dict) -> tuple[list[str], list[tuple[str, Image.Image]], list[Image.Image]]:
    """返回 (类别名表, [(类别名, 图标图)], [干扰物图])。干扰物是读数区（PRND / 电量），贴上去不打标签。"""
    w, h = photo.size
    names: list[str] = []
    icons: list[tuple[str, Image.Image]] = []
    distractors: list[Image.Image] = []
    for item in truth["items"]:
        box = norm_to_px(item["bbox"], w, h)
        crop = photo.crop(box)
        if item["category"] == "warning_light":
            name = item["symbol_id"]
            names.append(name)
            icons.append((name, crop))
        elif item["category"] == "readout":
            distractors.append(crop)
    return names, icons, distractors


def background_pool(photo: Image.Image, rng: random.Random) -> list[Image.Image]:
    """底图：照片里不含图标那一列（x < 44%）的随机裁块，加几张纯色/渐变。"""
    w, h = photo.size
    pool: list[Image.Image] = []
    left = photo.crop((0, 0, int(w * 0.44), h))
    lw, lh = left.size
    for _ in range(40):
        s = rng.randint(int(min(lw, lh) * 0.35), min(lw, lh))
        x = rng.randint(0, lw - s)
        y = rng.randint(0, lh - s)
        tile = left.crop((x, y, x + s, y + s)).resize((IMG_SIZE, IMG_SIZE), Image.BILINEAR)
        if rng.random() < 0.5:
            tile = tile.transpose(Image.FLIP_LEFT_RIGHT)
        pool.append(tile)
    for _ in range(12):
        g = rng.randint(8, 60)
        pool.append(Image.new("RGB", (IMG_SIZE, IMG_SIZE), (g, g, g + rng.randint(0, 10))))
    return pool


def jitter(img: Image.Image, rng: random.Random) -> Image.Image:
    img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.6, 1.4))
    img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.7, 1.3))
    if rng.random() < 0.3:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.2)))
    return img


def place(
    bg: Image.Image,
    icons: list[tuple[str, Image.Image]],
    distractors: list[Image.Image],
    names: list[str],
    rng: random.Random,
) -> tuple[Image.Image, list[str]]:
    """在底图上贴 1–4 个图标（打标签）和 0–2 个干扰物（不打标签），返回 (图, YOLO 标签行)。"""
    canvas = bg.copy()
    labels: list[str] = []
    occupied: list[tuple[int, int, int, int]] = []

    def free(x: int, y: int, w: int, h: int) -> bool:
        for ox, oy, ow, oh in occupied:
            if x < ox + ow and x + w > ox and y < oy + oh and y + h > oy:
                return False
        return True

    def paste(img: Image.Image, label: str | None) -> None:
        scale = rng.uniform(0.6, 1.8)
        w = max(16, int(img.width * scale))
        h = max(16, int(img.height * scale))
        if w >= IMG_SIZE - 8 or h >= IMG_SIZE - 8:
            return
        for _ in range(20):
            x = rng.randint(4, IMG_SIZE - w - 4)
            y = rng.randint(4, IMG_SIZE - h - 4)
            if free(x, y, w, h):
                break
        else:
            return
        patch = jitter(img.resize((w, h), Image.BILINEAR), rng)
        canvas.paste(patch, (x, y))
        occupied.append((x, y, w, h))
        if label is not None:
            cx, cy = (x + w / 2) / IMG_SIZE, (y + h / 2) / IMG_SIZE
            labels.append(f"{names.index(label)} {cx:.6f} {cy:.6f} {w / IMG_SIZE:.6f} {h / IMG_SIZE:.6f}")

    for name, icon in rng.sample(icons, rng.randint(1, len(icons))):
        paste(icon, name)
    for d in rng.sample(distractors, rng.randint(0, min(2, len(distractors)))):
        paste(d, None)
    return jitter(canvas, rng), labels


def write_split(
    out: Path,
    split: str,
    n: int,
    bgs: list[Image.Image],
    icons: list[tuple[str, Image.Image]],
    distractors: list[Image.Image],
    names: list[str],
    rng: random.Random,
) -> int:
    img_dir = out / "images" / split
    lbl_dir = out / "labels" / split
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)
    boxes = 0
    for i in range(n):
        img, labels = place(rng.choice(bgs), icons, distractors, names, rng)
        img.save(img_dir / f"{split}-{i:04d}.jpg", quality=rng.randint(70, 95))
        (lbl_dir / f"{split}-{i:04d}.txt").write_text("\n".join(labels) + ("\n" if labels else ""), encoding="utf-8")
        boxes += len(labels)
    return boxes


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=int, default=240)
    ap.add_argument("--val", type=int, default=60)
    ap.add_argument("--seed", type=int, default=20260908)
    ap.add_argument("--out", type=Path, default=PATHS.datasets / "synth-tesla01")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    photo = Image.open(PHOTO).convert("RGB")
    truth = load_truth()
    names, icons, distractors = cut_icons(photo, truth)
    bgs = background_pool(photo, rng)

    args.out.mkdir(parents=True, exist_ok=True)
    icon_dir = args.out / "icons"
    icon_dir.mkdir(exist_ok=True)
    for name, icon in icons:
        icon.save(icon_dir / f"{name}.png")

    n_train = write_split(args.out, "train", args.train, bgs, icons, distractors, names, rng)
    n_val = write_split(args.out, "val", args.val, bgs, icons, distractors, names, rng)

    data_yaml = args.out / "data.yaml"
    data_yaml.write_text(
        "path: " + str(args.out.resolve()) + "\n"
        "train: images/train\nval: images/val\n"
        "names:\n" + "".join(f"  {i}: {n}\n" for i, n in enumerate(names)),
        encoding="utf-8",
    )
    summary = {
        "source_photo": str(PHOTO.relative_to(EVAL_ROOT)),
        "classes": names,
        "train_images": args.train,
        "train_boxes": n_train,
        "val_images": args.val,
        "val_boxes": n_val,
        "seed": args.seed,
        "note": "合成数据，只用于跑通流程；图标与底图同源于一张照片，指标不代表任何真实召回",
    }
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"data.yaml → {data_yaml}")


if __name__ == "__main__":
    main()
