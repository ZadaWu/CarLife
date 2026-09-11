# 检测器数据集

每个子目录一个数据集，YOLO 格式：`images/{train,val}/`、`labels/{train,val}/`、`data.yaml`（`names` 用 `symbol_id`）。
**内容不提交**（根 `.gitignore`），只留本文件；`enterprise/backend/vision-trainer` 的 `/datasets` 扫这里。

| 数据集 | 来源 | 能不能当证据 |
|---|---|---|
| `synth-tesla01/` | `uv run python -m vision_trainer.tools.synth`：从 `photos/tesla-01.png` 的真值抠 4 个警示灯贴到同一张照片的底图上 | **不能**——图标与底图同源，只用来跑通训练流程 |
| `roboflow-tesla-new-hmi/` | Roboflow Universe「Tesla New HMI」v1（CC BY 4.0，须署名：tesla-new-hmi workspace，https://universe.roboflow.com/tesla-new-hmi/tesla-new-hmi）：815 张 Model 3/Y 中控屏行车实拍（GoPro 帧，1920×1080，约 20 段视频），自带标签是 Warning / AutoPilot / Speed，**不是我们的图标类**；当底图与预标对象用。2026-09-09 用 `roboflow` SDK 拉取（`ROBOFLOW_API_KEY` 在本地 .env） | 底图能；图标标签要重标 |
| `synth-real-bg/` | `uv run python -m vision_trainer.tools.composite`（M79-02）：27 枚**手册**图标合成到 815 张**真实**屏幕帧的左侧图标列上，位置与尺度按屏幕相对坐标（实测标定），四道融合（亮度对齐 / 模糊 / 噪点 / JPEG）。输出的是**屏幕裁剪**不是整帧——整帧里一枚图标只有 30 px，缩到 640 训练尺寸就没了。400 训练 / 100 验证，1111 + 293 个框，红色故障类权重 3× | **不能当真实召回**——正样本全是贴上去的。它能回答的是「换了真实底图与随机化之后，误接受率有没有降」，见 `内部文档` |
| 真实集（待建） | ≥30 张实拍 + ≥10 张负样本，CVAT 独立标框，见 M71-00 收口 §6 | 能 |

照片来源与许可登记在 [`../photos/README.md`](../photos/README.md)，真值在 [`../cases.jsonl`](../cases.jsonl)。
