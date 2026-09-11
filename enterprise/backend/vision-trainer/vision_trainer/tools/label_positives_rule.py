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

只收**两个信号都同意**的帧（恰好两盏、上面近似方形、下面明显更宽）；一盏或三盏以上、红色、形状不合的一律不标。
标完出按类别分组的联系表（`pick_positives --sheet-by-class`），人眼过一遍再进训练集。

用法（在 enterprise/backend/vision-trainer 下）：
  uv run python -m vision_trainer.tools.label_positives_rule <positives 目录>   # 读 candidates.json，写 labels.json
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

# 阈值来自上面那组分布：上面那枚 < 1.45（tesla-01 的近光灯正好 1.45，取闭区间上沿）、下面那枚 > 1.45、且下比上宽 ≥ 0.15
TOP_MAX_ASPECT = 1.45
BOTTOM_MIN_ASPECT = 1.45
MIN_ASPECT_GAP = 0.15


def aspect(c: dict) -> float:
    x0, y0, x1, y1 = c["bbox"]
    return (x1 - x0) / max(1, (y1 - y0))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("positives", type=Path)
    args = ap.parse_args()
    cands = json.loads((args.positives / "candidates.json").read_text(encoding="utf-8"))["candidates"]
    by_frame: dict[str, list[dict]] = defaultdict(list)
    for c in cands:
        by_frame[c["frame"]].append(c)

    labels: list[dict] = []
    reasons: Counter[str] = Counter()
    for frame, items in by_frame.items():
        items.sort(key=lambda c: c["bbox"][1])
        if len(items) != 2:
            for c in items:
                labels.append({**c, "symbolId": None, "verified": False, "reason": f"这一帧有 {len(items)} 盏灯，规则只认恰好两盏", "top3": [], "sim": None})
            reasons[f"{len(items)} 盏"] += 1
            continue
        top, bot = items
        a_top, a_bot = aspect(top), aspect(bot)
        ok = a_top <= TOP_MAX_ASPECT and a_bot >= BOTTOM_MIN_ASPECT and (a_bot - a_top) >= MIN_ASPECT_GAP
        if ok:
            labels.append({**top, "symbolId": "low_beam", "verified": True, "reason": f"位置在上 + 近似方形（{a_top:.2f}）", "top3": [], "sim": None})
            labels.append({**bot, "symbolId": "parking_lights", "verified": True, "reason": f"位置在下 + 明显更宽（{a_bot:.2f}）", "top3": [], "sim": None})
            reasons["两信号同意"] += 1
        else:
            why = f"形状不合：上 {a_top:.2f} / 下 {a_bot:.2f}"
            for c in (top, bot):
                labels.append({**c, "symbolId": None, "verified": False, "reason": why, "top3": [], "sim": None})
            reasons["形状不合"] += 1

    summary = Counter(l["symbolId"] or "（未认出）" for l in labels)
    (args.positives / "labels.json").write_text(json.dumps({"summary": dict(summary), "frames": dict(reasons), "labels": labels}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"frames": dict(reasons), "labels": dict(summary)}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
