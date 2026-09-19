# indicator-yolo11n.onnx

来源：训练服务任务 `train-20260917-120344-e7b9`（数据集 fullframe-v4，M80 G 版：真实帧 + 干净底图合成 + 黑底合成；2026-09-17 没见过的 12 张上 26/35，白底 25/28，安全带 6/6）。
导出：ultralytics `export(format=onnx, imgsz=960, opset=17, simplify=True, dynamic=False, half=False)`，不带 NMS。
输入 `images` [1,3,960,960] f32 RGB/255（letterbox 灰 114）；输出 `output0` [1, 4+27, 18900]（cx,cy,w,h + 类分数，letterbox 像素坐标）。
类别表 `indicator-yolo11n.names.json`（顺序 = 训练 data.yaml）。
换模型：重新导出后覆盖这两个文件、更新本文与 `tests/fixtures/*.expected.json`。
