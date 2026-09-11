/**
 * 「模型训练」页纯函数（施工单 M76-03）：真值框换算、叠框缩放、进度、错误码文案。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyProgress, detectionBoxes, errorMessage, fitBoxes, normalizeTruthBox, percentOf, truthBoxes, type JobView } from "../src/pages/vision-trainer/model";

describe("[M76-03] 坐标换算", () => {
  it("normalizeTruthBox：0–1000 归一化 → 原图像素（tesla-01 的近光灯）", () => {
    const px = normalizeTruthBox([552, 195, 594, 238], 2000, 1333);
    assert.deepEqual(px.map((v) => Math.round(v)), [1104, 260, 1188, 317]);
  });
  it("fitBoxes：等比缩放到画布宽，画布高按原图比例", () => {
    const r = fitBoxes([{ x1: 1000, y1: 500, x2: 1200, y2: 700, label: "a" }], 2000, 1000, 500);
    assert.equal(r.scale, 0.25);
    assert.equal(r.canvasH, 250);
    assert.deepEqual(r.boxes[0], { x1: 250, y1: 125, x2: 300, y2: 175, label: "a" });
    assert.deepEqual(fitBoxes([], 0, 0, 500), { scale: 1, canvasH: 0, boxes: [] });
  });
  it("truthBoxes 只取警示灯；detectionBoxes 标签带置信度", () => {
    const t = truthBoxes({ id: "p", file: "", vehicle: null, negative: false, items: [{ bbox: [0, 0, 500, 500], category: "warning_light", symbol_id: "low_beam" }, { bbox: [0, 0, 10, 10], category: "readout", symbol_id: null }] }, 100, 100);
    assert.equal(t.length, 1);
    assert.equal(t[0].label, "low_beam");
    assert.equal(t[0].x2, 50);
    assert.equal(detectionBoxes([{ cls: 0, name: "seatbelt", conf: 0.984, xyxy: [1, 2, 3, 4] }])[0].label, "seatbelt 0.98");
  });
});

describe("[M76-03] 进度与文案", () => {
  const job: JobView = { id: "t", kind: "train", status: "running", params: {}, createdAt: "", progress: { epoch: 3, epochs: 10, mAP50: 0.5 }, hasWeights: false, hasOnnx: false };
  it("percentOf：训练按轮数；验证 running 无进度；done 100", () => {
    assert.equal(percentOf(job), 30);
    assert.equal(percentOf({ ...job, kind: "val", progress: null }), null);
    assert.equal(percentOf({ ...job, status: "done" }), 100);
  });
  it("applyProgress：progress 帧换任务；done 帧标结束并带错误", () => {
    const s1 = applyProgress({ job: null, finished: false }, { type: "progress", job });
    assert.equal(s1.job?.progress?.epoch, 3);
    const s2 = applyProgress(s1, { type: "done", status: "failed", error: "orphaned" });
    assert.equal(s2.finished, true);
    assert.equal(s2.job?.status, "failed");
    assert.equal(s2.job?.error, "orphaned");
  });
  it("两个 503 各给出能复制的命令", () => {
    assert.ok(errorMessage("vision_trainer_not_configured").includes("VISION_TRAINER_URL=http://localhost:8799"));
    assert.ok(errorMessage("vision_trainer_unreachable").includes("dev:restart vision-trainer"));
    assert.ok(errorMessage("forbidden").includes("管理员"));
  });
});
