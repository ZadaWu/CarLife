# vision-trainer：警示灯小检测器的训练 / 验证 / 推理 / 导出服务

企业内部工具（ACR-026 / Sprint M76）。
常驻 Python 服务，只绑 `127.0.0.1:8799`，**自己没有鉴权**——鉴权在网关的 `/console/vision-trainer/*` 代理上，
运营控制台「评测 → 模型训练」页经它使用本服务。**不进车机、不进手机、不对车主暴露。**

## 起停

```bash
corepack pnpm dev:restart vision-trainer     # 宿主机起（要 MPS，容器里没有 GPU）；不在默认集合里
corepack pnpm dev:logs vision-trainer
curl -s localhost:8799/health
```

首次要 `uv`（`brew install uv`）；`dev.sh` 会在服务目录里 `uv run serve.py`，uv 自己建 `.venv/`。

## 进程模型

- **父进程不 import torch。** 训练 / 验证 / 导出各起一个子进程（`python -m vision_trainer.worker --job <id>`），排队串行，
  取消 = 杀子进程。试推理走一个**常驻推理子进程**（`python -m vision_trainer.infer`，stdin/stdout JSON 行协议，按权重路径缓存模型）。
- **目录即真相。** 任务 = `evals/runs/vision-trainer/<id>/`（`job.json` 状态、`progress.jsonl` 每轮一行、`report.json` 结果、
  `weights/best.pt`、`results.png`…）。有 `weights/best.pt` 的任务就是模型；数据集 = `evals/vision-observe/datasets/<名>/data.yaml`。
  没有数据库、没有登记文件。
- 服务重启：`queued` 的任务标 `failed(service_restarted)`，`running` 但 pid 已死的标 `failed(orphaned)`；服务停止时正在跑的子进程一起停
  （标 `cancelled(service_stopped)`）——留着它会占着 GPU 没人管。

## 接口

| 方法与路径 | 作用 |
|---|---|
| `GET /health` | 探活 |
| `GET /models` · `GET /datasets` · `GET /photos` · `GET /photos/{id}/image` | 枚举（目录扫描） |
| `POST /jobs` `{kind: train\|val\|export, params}` | 发起；GPU 忙则排队 |
| `GET /jobs` · `GET /jobs/{id}` · `GET /jobs/{id}/stream`（SSE） | 任务与进度 |
| `DELETE /jobs/{id}` | running / queued → 取消；已结束 → 删目录 |
| `GET /jobs/{id}/files/{name}` | 产物（白名单：`*.png/jpg/csv/json/jsonl/log`、`weights/best|last.pt|onnx`） |
| `POST /predict?model=&conf=&imgsz=&photo=` | 试推理：body 是图片字节（`image/png|jpeg|webp`）或 `photo=` 选评测集照片 |

参数上限：`epochs ≤ 300`、`imgsz ∈ {320,480,640,960}`、`batch ≤ 64`、图片 ≤ 20 MB。

## 数据集

```bash
uv run python -m vision_trainer.tools.synth      # 合成集 → evals/vision-observe/datasets/synth-tesla01/
```

合成集从唯一那张真实照片抠图贴底图，**只用来跑通流程**；指标不代表任何真实召回。真实数据集按同样的目录形状放进
`evals/vision-observe/datasets/<名>/`（YOLO 格式：`images/{train,val}`、`labels/{train,val}`、`data.yaml`）。

## 轮数

`epochs` 是**上限**，不是必须跑满的数：验证集 mAP 连续 `patience` 轮不涨就早停。100 是小数据集的常用上限；
合成集第 10 轮就到顶。

## 测试

```bash
uv sync && uv run pytest -q     # 不跑真训练、不 import torch（有一条测试专门断言这一点）
```

## 许可边界（进交付前必须再过一道 ACR）

`ultralytics` 是 **AGPL-3.0**。本服务是内部工具，不分发、不对外提供服务，无 AGPL 义务。
检测器若要进车机端或对客户交付：购买 Ultralytics 商业许可，或换 Apache-2.0 实现（RT-DETR via `transformers`、torchvision 检测头）。
四个动作各是一个函数（`actions/`），换实现不动接口、网关与页面。
