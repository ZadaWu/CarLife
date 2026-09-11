"""端侧检测器只当「定位器」用时的表现（M80-05）。

# 为什么单量定位

链路里**名称不来自检测器**——名称与级别只能来自手册图标目录（ACR-025）。所以拿这个
在合成集上训出来的 yolo11n 来问的不是「它认得出是哪个灯吗」，而是「它框得准吗」：
框准了，第二遍的视觉模型就只需要描述一个 crop，整图定位那一遍（实测 p50 27 s）才有可能省掉。

# 判据

- 警示灯召回：IoU ≥ 0.5 一对一配对，与 `evals/vision-observe/lib.ts` 同一个阈值。
- 负样本误报：负样本上任何一个框都是误报（那些照片里 27 个符号一个没亮）。
- 类别名只打印不计分。

用法：
    enterprise/backend/vision-trainer/.venv/bin/python evals/vision-observe/tools/detector-localize.py \
        [--conf 0.25] [--weights <best.pt>] [--json evals/runs/vision-observe-detector-localize.json]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_WEIGHTS = ROOT / "evals/runs/vision-trainer/train-20260909-141540-e8c0/weights/best.pt"


def iou(a: list[float], b: list[float]) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    if x2 <= x1 or y2 <= y1:
        return 0.0
    inter = (x2 - x1) * (y2 - y1)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--imgsz", type=int, default=960, help="推理边长，默认 = 训练尺寸")
    ap.add_argument("--weights", default=str(DEFAULT_WEIGHTS))
    ap.add_argument("--json", dest="json_out")
    args = ap.parse_args()

    cases = [json.loads(l) for l in (ROOT / "evals/vision-observe/cases.jsonl").read_text().splitlines() if l.strip() and not l.startswith("//")]
    proc = subprocess.Popen(
        [str(ROOT / "enterprise/backend/vision-trainer/.venv/bin/python"), "-m", "vision_trainer.infer"],
        cwd=ROOT / "enterprise/backend/vision-trainer",
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    assert proc.stdin and proc.stdout
    rows, lat = [], []
    hit = truth = neg_fp = neg_n = 0
    ious: list[float] = []
    for c in cases:
        img = ROOT / "evals/vision-observe" / c["file"]
        proc.stdin.write(json.dumps({"op": "predict", "weights": args.weights, "image": str(img), "conf": args.conf, "imgsz": args.imgsz}) + "\n")
        proc.stdin.flush()
        r = json.loads(proc.stdout.readline())
        if not r.get("ok"):
            print(f"{c['id']}: {r}", file=sys.stderr)
            continue
        lat.append(r["ms"])
        iw, ih = r["imageW"], r["imageH"]
        dets = r["detections"]
        if c.get("negative"):
            neg_n += 1
            neg_fp += len(dets)
            rows.append({"id": c["id"], "negative": True, "falsePositives": len(dets), "names": [d["name"] for d in dets]})
            continue
        used: set[int] = set()
        per = []
        for it in [x for x in c["items"] if x["category"] == "warning_light"]:
            b = it["bbox"]
            t = [b[0] * iw / 1000, b[1] * ih / 1000, b[2] * iw / 1000, b[3] * ih / 1000]
            best, bj = 0.0, None
            for j, d in enumerate(dets):
                if j in used:
                    continue
                v = iou(t, d["xyxy"])
                if v > best:
                    best, bj = v, j
            truth += 1
            if best >= 0.5 and bj is not None:
                used.add(bj)
                ious.append(best)
                hit += 1
                per.append({"symbol": it.get("symbol_id"), "iou": round(best, 3), "detectorCalledIt": dets[bj]["name"], "conf": dets[bj]["conf"]})
            else:
                per.append({"symbol": it.get("symbol_id"), "iou": round(best, 3), "missed": True})
        rows.append({"id": c["id"], "negative": False, "items": per, "unmatchedBoxes": len(dets) - len(used)})
    proc.stdin.close()
    proc.wait()

    summary = {
        "警示灯召回": f"{hit}/{truth}",
        "平均 IoU（已配对）": round(sum(ious) / len(ious), 3) if ious else None,
        "负样本误报框数": neg_fp,
        "负样本张数": neg_n,
        "单张平均 ms": round(sum(lat) / len(lat)) if lat else None,
        "conf": args.conf,
        "imgsz": args.imgsz,
        "weights": args.weights,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.json_out:
        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"suite": "vision-observe-detector-localize", "at": datetime.now(timezone.utc).isoformat(), "summary": summary, "rows": rows}, ensure_ascii=False, indent=2))
        print(f"→ {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
