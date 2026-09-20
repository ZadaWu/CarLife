# vision-infer

指示灯检测的**线上只推理服务**（ACR-050）。给一张照片，回一组框。

本文说明它与 `vision-trainer` 的分工、如何在本机运行和测试、接口约定，以及更换模型时要改哪几处。

## 与 vision-trainer 的分工

两个服务对 runtime 是同一个角色：`VISION_TRAINER_URL` 指向谁，`yolo.ts` 就向谁发 `POST /predict`，请求与响应同形。

| | vision-trainer | vision-infer |
|---|---|---|
| 用途 | 训练、验证、导出、推理 | 只推理 |
| 运行位置 | 开发机 | 线上（compose 栈里的 `vision-infer` 服务） |
| 运行时 | ultralytics + PyTorch（AGPL-3.0） | onnxruntime（MIT） |
| 模型 | 任意训练任务的 `best.pt` | 与端上同一份 `indicator-yolo11n.onnx` |
| 写操作 | 有（建任务、删任务） | 无，不落盘 |

`vision-trainer` 不能放到对外服务背后：ACR-026 给它划的边界是"内部工具，不对外提供服务"。

本机开发不需要起 `vision-infer`，继续用 `corepack pnpm dev:restart vision-trainer` 即可。

## 模型只有一份

模型文件的唯一存放处是 `clients/shared/rust/carlife-vision/models/`，端上把它编进二进制。
本服务在本机直接读该目录，镜像构建时从同一路径复制，服务目录下不放第二份。

服务的模型号从该目录的 `MODEL.md` 读取（形如 `train-20260917-120344-e7b9`）。
请求里的 `model` 参数与它不一致时回 `404 model_not_found`，以免两侧配置不一致时静默跑错模型。

## 在本机运行

需要 [uv](https://docs.astral.sh/uv/)。

```bash
cd enterprise/backend/vision-infer
uv sync
VISION_INFER_PORT=18799 uv run serve.py
```

缺省端口是 8799，与 `vision-trainer` 相同。两者同时运行时用 `VISION_INFER_PORT` 换一个。

验证服务可用：

```bash
corepack pnpm probe:vision-infer http://localhost:18799
```

## 测试

```bash
cd enterprise/backend/vision-infer
uv run pytest -q
```

测试分三组：

- `test_parity.py`：读端上的夹具 `carlife-vision/tests/fixtures/*.expected.json`，容差与 Rust 侧的平行测试相同。
- `test_api.py`：接口形状与各错误码。
- `test_lock_in_sync.py`：`requirements.lock.txt` 与 `uv.lock` 是否同步。

## 接口

### `GET /health`

```json
{"ok": true, "service": "vision-infer", "version": "0.1.0", "model": "train-20260917-120344-e7b9", "imgsz": 960, "classes": 27}
```

### `POST /predict?model=<模型号>&conf=0.3&imgsz=960`

请求体是图片原始字节，`content-type` 为 `image/jpeg`、`image/png` 或 `image/webp`，上限 20 MB。

```json
{
  "ok": true,
  "detections": [{"cls": 9, "name": "parking_lights", "conf": 0.9652, "xyxy": [225.1, 389.6, 305.4, 434.9]}],
  "imageW": 2856,
  "imageH": 2142,
  "ms": 51.2,
  "model": "train-20260917-120344-e7b9",
  "conf": 0.3
}
```

`xyxy` 是按 EXIF 转正后的**像素**坐标。归一化到 0–1000 由调用方 `yolo.ts` 完成。

| 状态码 | `error` | 含义 |
|---|---|---|
| 400 | `imgsz_unsupported` | 模型按 960 静态导出，不支持其他尺寸 |
| 400 | `empty_body` / `undecodable_image` | 请求体为空，或不是可解码的图片 |
| 404 | `model_not_found` | `model` 与服务加载的模型号不一致 |
| 413 | `image_too_large` | 超过 20 MB |
| 415 | `unsupported_image_type` | `content-type` 不在白名单内 |
| 500 | `predict_failed` | 推理异常 |

## 环境变量

| 变量 | 缺省 | 说明 |
|---|---|---|
| `VISION_INFER_HOST` | `127.0.0.1` | 监听地址，镜像里为 `0.0.0.0` |
| `VISION_INFER_PORT` | `8799` | 监听端口 |
| `VISION_INFER_MODEL_DIR` | 端上 crate 的 `models/` | 模型目录，镜像里为 `/app/models` |
| `VISION_INFER_MODEL_ID` | 从 `MODEL.md` 读 | 覆盖服务自报的模型号 |
| `VISION_INFER_THREADS` | onnxruntime 自定 | 推理线程数，compose 里为 2 |

## 更换模型

1. 在 `vision-trainer` 导出新的 ONNX 与类别表，覆盖 `carlife-vision/models/` 下的两个文件，并更新 `MODEL.md` 里的训练任务号。
2. 更新端上的夹具 `carlife-vision/tests/fixtures/*.expected.json`。
3. 运行 `corepack pnpm test:rust` 与本目录的 `uv run pytest -q`。
4. 重新构建并部署 `vision-infer` 镜像，同时把线上的 `CARLIFE_VISION_YOLO_MODEL` 改为新的任务号。

第 4 步的两件事必须一起做：只改其中一处时，服务回 `404 model_not_found`。

## 更新依赖

改 `pyproject.toml` 后重新导出镜像用的依赖清单：

```bash
cd enterprise/backend/vision-infer
uv lock
uv export --frozen --no-dev --no-emit-project -o requirements.lock.txt
```

镜像按 `requirements.lock.txt` 安装并校验哈希，理由见 `infra/images/Dockerfile.vision-infer` 的文件头。
