"""
给真实正样本候选认名字——**结构规则版**（施工单 M80-08）。

# 为什么不是手册目录那套

先试过与生产链路同一套匹配（`evals/vision-observe/tools/label-positives.mts`：向量召回 → 闸门 → 成对核验）。
2026-09-10 实测在 GoPro 远拍的真实帧上**一枚都认不出**：一枚灯只有约 30 px，向量把近光灯与驻车灯排在
前两名却分不开（`below_delta`），DeepSeek 拿手册图标逐枚核验也答 `unsure`。放大到 320 px 更糟——糊成一团后
向量把它们排成了远光灯。那套在车主近拍（tesla-01，一枚 84 px）上是好的，在这批远拍上不是。

# 规则，以及它为什么站得住

行车录像里图标列亮着的几乎只有两盏：近光灯与驻车灯。两个**互相独立**的信号都指向同一个答案：

1. **位置**：Tesla 把近光灯排在驻车灯上面（tesla-01 真值：近光灯 y=195、驻车灯 y=362，中间是待机的自适应远光）。
2. **形状**：近光灯图形近似方形，驻车灯是两枚背靠背的灯、明显更宽。tesla-01 真值：1.45 vs 1.92；
   本批 114 张两盏灯的帧上：上面那枚宽高比中位 1.20（99/114 落在 1.0–1.4），下面那枚 1.68（109/114 落在 1.4–2.0），
   95% 的帧下面比上面宽 0.15 以上。

# v2（2026-09-17）：按颜色 + 形状 + 列序认名，不再数盏数

v1 只收"恰好两盏"的帧，把 36 帧丢了。2026-09-17 把丢掉的逐帧看过：10 帧是两盏好灯（宽高比门槛太紧）、
4 帧是两盏灯 + 路边雪糕筒（橙色，被颜色判据当成灯）、**2 帧亮着红色安全带**（GoPro 这批里仅有的真安全带样本）、
20 帧是屏幕定位偏了裁到车窗的废片。v2 逐枚看颜色：
- 绿色：一帧恰好两枚绿 → 上 `low_beam`、下 `parking_lights`（下比上宽 ≥ 0.05）；不是两枚 → 都不标
- 红色小人、且紧挨着驻车灯下方（≤ 2.5 个灯高）→ `seatbelt_unfastened`；雪糕筒离得远（5–8 个灯高）被这一条排除
- 橙色（雪糕筒）与其它颜色 → 不标，不影响同帧其它灯
标完照样出按类别分组的联系表，人眼过一遍再进训练集。

用法（在 enterprise/backend/vision-trainer 下）：
  uv run python -m vision_trainer.tools.label_positives_rule <positives 目录>   # 读 candidates.json，写 labels.json
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path



def aspect(c: dict) -> float:
    x0, y0, x1, y1 = c["bbox"]
    return (x1 - x0) / max(1, (y1 - y0))


def pixel_color(frame: str, bbox: list[int]) -> str:
    """crop 的主色（green / red / amber / other），**相对屏幕底色**判：
    GoPro 帧整体偏蓝紫，绿灯的绝对色相落在 180–210°、红灯在 270–300°，绝对阈值全错；
    减掉框外一圈的中位底色后再看残差哪个通道占优（与 pick_negatives 的 chroma 判据同一思路）。"""
    from PIL import Image

    x0, y0, x1, y1 = bbox
    pad = max(4, (x1 - x0) // 3)
    im = Image.open(frame).convert("RGB")
    outer = im.crop((max(0, x0 - pad), max(0, y0 - pad), min(im.width, x1 + pad), min(im.height, y1 + pad)))
    W, H = outer.size
    px = list(outer.getdata())
    ring = [px[j * W + i] for j in range(H) for i in range(W) if i < pad or j < pad or i >= W - pad or j >= H - pad]
    if not ring:
        return "other"
    bg = tuple(sorted(c[k] for c in ring)[len(ring) // 2] for k in range(3))
    votes = {"green": 0, "red": 0, "amber": 0}
    n = 0
    for j in range(pad, H - pad):
        for i in range(pad, W - pad):
            r, g, b = px[j * W + i]
            dr, dg, db = r - bg[0], g - bg[1], b - bg[2]
            if max(abs(dr), abs(dg), abs(db)) < 25:
                continue
            n += 1
            if dg > dr + 10 and dg > db + 10:
                votes["green"] += 1
            elif dr > dg + 25 and dr > db + 10:
                votes["red"] += 1
            elif dr > db + 15 and dg > db + 10 and abs(dr - dg) <= 25:
                votes["amber"] += 1
    if n == 0:
        return "other"
    col, v = max(votes.items(), key=lambda kv: kv[1])
    return col if v > n * 0.4 else "other"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("positives", type=Path, help="含 candidates.json 的目录，或一份 labels/candidates json 文件")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    src = args.positives / "candidates.json" if args.positives.is_dir() else args.positives
    doc = json.loads(src.read_text(encoding="utf-8"))
    cands = doc.get("candidates") or doc["labels"]
    by_frame: dict[str, list[dict]] = defaultdict(list)
    for c in cands:
        by_frame[c["frame"]].append(c)

    labels: list[dict] = []
    reasons: Counter[str] = Counter()
    for frame, items in by_frame.items():
        items.sort(key=lambda c: c["bbox"][1])
        for c in items:
            c["color"] = pixel_color(frame, c["bbox"])
        greens = [c for c in items if c["color"] == "green"]
        named: dict[str, tuple[str, str]] = {}
        if len(greens) == 2 and aspect(greens[1]) - aspect(greens[0]) >= 0.05:
            named[greens[0]["id"]] = ("low_beam", f"绿、在上、较方（{aspect(greens[0]):.2f}）")
            named[greens[1]["id"]] = ("parking_lights", f"绿、在下、较宽（{aspect(greens[1]):.2f}）")
        # 红色小人只认「紧挨着驻车灯下方」的：GoPro 帧里路边雪糕筒也是红/橙的，但离图标列 5–8 个灯高远
        # （实测：两枚真安全带在 0.9 / 1.2 个灯高，两只雪糕筒在 5.2 / 8.0）
        if len(greens) == 2:
            bottom = greens[1]["bbox"][3]
            hgt = max(1, greens[1]["bbox"][3] - greens[1]["bbox"][1])
            for c in items:
                if c["color"] == "red" and 0 <= (c["bbox"][1] - bottom) / hgt <= 2.5:
                    named[c["id"]] = ("seatbelt_unfastened", f"红、驻车灯下方 {(c['bbox'][1] - bottom) / hgt:.1f} 个灯高")
        for c in items:
            sid, why = named.get(c["id"], (None, f"{c['color']}，不在规则内" if c["color"] != "green" else f"这一帧有 {len(greens)} 枚绿灯，规则只认恰好两枚"))
            labels.append({**{k: v for k, v in c.items() if k not in ("symbolId", "verified", "reason", "top3", "sim")}, "symbolId": sid, "verified": sid is not None, "reason": why, "top3": [], "sim": None})
        reasons["有认出" if named else "整帧不标"] += 1

    summary = Counter(l["symbolId"] or "（未认出）" for l in labels)
    out = args.out or (args.positives / "labels.json" if args.positives.is_dir() else args.positives.with_name("labels-v2.json"))
    out.write_text(json.dumps({"summary": dict(summary), "frames": dict(reasons), "labels": labels}, ensure_ascii=False, indent=1))
    print(json.dumps({"frames": dict(reasons), "labels": dict(summary), "out": str(out)}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
