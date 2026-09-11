"""
把认好名字的真实正样本写成 YOLO 训练集，并与合成集合并（施工单 M80-08）。

# 形状与合成集完全一致

输出的是**屏幕裁剪**（屏幕框外扩 3%），不是整帧——与 `composite.py` 同一条理由：整帧里一枚灯只有 30 px，
裁到屏幕后配 imgsz 960 才有 21 px。类别顺序**照抄合成集的 data.yaml**，两份数据才能混在一起训。

# 按视频段分 train / val

同一段视频相邻帧几乎一样，随机分会让 val 里全是 train 的翻版、指标虚高。这里按视频号整段分：
`--val-videos` 列的段整段进 val，其余进 train。

# 只收核验过的标签

`labels.json` 里 `symbolId` 为 null 的一律不写——没认出来的灯写进训练集等于教模型"这里没有灯"。
同一帧里若有一枚没认出来，整帧跳过：留着的话那枚灯就成了"背景"，比少一帧更糟。

用法（在 enterprise/backend/vision-trainer 下）：
  uv run python -m vision_trainer.tools.build_real_dataset <positives 目录> --name real-synth-mix \\
      --synth synth-real-bg --val-videos GX030024,GH139598,GX090025,GX050024,GH099598
"""

from __future__ import annotations

import argparse
import json
import shutil
from collections import defaultdict
from pathlib import Path

from PIL import Image

from ..paths import Paths

PATHS = Paths.from_env()


def read_names(yaml_path: Path) -> list[str]:
    names: dict[int, str] = {}
    in_names = False
    for line in yaml_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("names:"):
            in_names = True
            continue
        if in_names:
            s = line.strip()
            if not s or ":" not in s or not line.startswith(" "):
                break
            k, v = s.split(":", 1)
            names[int(k)] = v.strip()
    return [names[i] for i in range(len(names))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("positives", type=Path)
    ap.add_argument("--name", default="real-synth-mix")
    ap.add_argument("--synth", default="synth-real-bg")
    ap.add_argument("--val-videos", default="")
    ap.add_argument("--pad", type=float, default=0.03)
    args = ap.parse_args()

    synth_dir = PATHS.datasets / args.synth
    names = read_names(synth_dir / "data.yaml")
    idx = {n: i for i, n in enumerate(names)}
    val_videos = {v.strip() for v in args.val_videos.split(",") if v.strip()}

    labels = json.loads((args.positives / "labels.json").read_text(encoding="utf-8"))["labels"]
    by_frame: dict[str, list[dict]] = defaultdict(list)
    for l in labels:
        by_frame[l["frame"]].append(l)

    out = PATHS.datasets / args.name
    if out.exists():
        shutil.rmtree(out)
    for split in ("train", "val"):
        (out / "images" / split).mkdir(parents=True)
        (out / "labels" / split).mkdir(parents=True)

    stats = {"frames_written": 0, "frames_skipped_unlabeled": 0, "boxes": 0, "per_class": defaultdict(int), "split": defaultdict(int)}
    manifest = []
    for frame, items in sorted(by_frame.items()):
        if any(i["symbolId"] is None for i in items):
            stats["frames_skipped_unlabeled"] += 1
            continue
        if any(i["symbolId"] not in idx for i in items):
            stats["frames_skipped_unlabeled"] += 1
            continue
        video = items[0]["video"]
        split = "val" if video in val_videos else "train"
        im = Image.open(frame).convert("RGB")
        sx0, sy0, sx1, sy1 = items[0]["screen"]
        pad = int(min(sx1 - sx0, sy1 - sy0) * args.pad)
        cx0, cy0 = max(0, sx0 - pad), max(0, sy0 - pad)
        cx1, cy1 = min(im.width, sx1 + pad), min(im.height, sy1 + pad)
        crop = im.crop((cx0, cy0, cx1, cy1))
        ow, oh = crop.size
        stem = f"real-{Path(frame).stem[:28]}"
        crop.save(out / "images" / split / f"{stem}.jpg", quality=90)
        lines = []
        for i in items:
            x0, y0, x1, y1 = i["bbox"]
            cx, cy = (x0 - cx0 + (x1 - x0) / 2) / ow, (y0 - cy0 + (y1 - y0) / 2) / oh
            lines.append(f"{idx[i['symbolId']]} {cx:.6f} {cy:.6f} {(x1 - x0) / ow:.6f} {(y1 - y0) / oh:.6f}")
            stats["per_class"][i["symbolId"]] += 1
            stats["boxes"] += 1
        (out / "labels" / split / f"{stem}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        stats["frames_written"] += 1
        stats["split"][split] += 1
        manifest.append({"image": f"{stem}.jpg", "split": split, "video": video, "frame": Path(frame).name, "icons": [i["symbolId"] for i in items]})

    # 合成集原样并入（复制，不用软链——ultralytics 按 images→labels 路径替换找标签，软链目录容易让缓存路径乱）
    synth_stats = defaultdict(int)
    for split in ("train", "val"):
        for img in sorted((synth_dir / "images" / split).glob("*.jpg")):
            shutil.copy2(img, out / "images" / split / img.name)
            lbl = synth_dir / "labels" / split / f"{img.stem}.txt"
            if lbl.exists():
                shutil.copy2(lbl, out / "labels" / split / lbl.name)
            synth_stats[split] += 1

    (out / "data.yaml").write_text(
        f"path: {out}\ntrain: images/train\nval: images/val\nnames:\n" + "".join(f"  {i}: {n}\n" for i, n in enumerate(names)),
        encoding="utf-8",
    )
    (out / "manifest.json").write_text(json.dumps({"real": manifest, "synth_from": args.synth, "val_videos": sorted(val_videos)}, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "README.md").write_text(
        f"# {args.name}\n\n真实正样本（`pick_positives` + `label-positives` 认名并核验，M80-08）+ 合成集 `{args.synth}` 原样并入。\n"
        f"按视频段分 train / val（val 段：{', '.join(sorted(val_videos)) or '无'}）。真实帧的来源与许可同 `roboflow-tesla-new-hmi`（CC BY 4.0，署名 tesla-new-hmi workspace）。\n"
        "评测集 `../cases.jsonl` 里一张都没有进来。\n",
        encoding="utf-8",
    )
    stats["synth"] = dict(synth_stats)
    stats["per_class"] = dict(stats["per_class"])
    stats["split"] = dict(stats["split"])
    print(json.dumps(stats, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
