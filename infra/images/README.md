# infra/images

这里存放容器镜像定义，构建上下文统一为仓库根目录。

| 文件 | 产物 | 构建方式 |
|---|---|---|
| `Dockerfile` | `gateway`、`agent-runtime`、`worker`、`migrate` targets | workspace 分层安装 pnpm 依赖 |
| `Dockerfile.mock` | `mock-dealer` 或 `mock-cabin` | 只复制对应 Mock 服务，保持第三方隔离 |
| `Dockerfile.web` | nginx 静态 Web 服务 | 构建 Vite 产物，代理 `/console` 到 Gateway |
| `nginx.web.conf` | Web nginx 配置 | SPA 回退和 Gateway 代理 |
| `Dockerfile.llama-asr` | `local-asr` | 固定 llama.cpp v0.3.0 的多架构 ASR runtime（Qwen3-ASR GGUF，ACR-007） |

示例：

```bash
docker build -f infra/images/Dockerfile --target gateway .
docker build -f infra/images/Dockerfile.mock --build-arg SERVICE=cabin .
docker build -f infra/images/Dockerfile.web .
```

## 本地 ASR runtime

`local-asr` 是 `infra/docker-compose.yml` 中的可选 profile。镜像从固定的
llama.cpp v0.3.0 源码构建（ACR-007 前是 whisper.cpp，引擎与模型一起换掉了）；
模型是 Qwen3-ASR-0.6B GGUF 的**两个文件**（主模型 Q8_0 约 805MB + mmproj 音频编码器
约 214MB，缺 mmproj 则 llama-server 只是个纯文本模型，转写必失败），不打进镜像，
也不提交到 Git；默认模型目录为 `~/.cache/whisper-models`（目录名沿用，避免每个
开发者重新缓存）。启动编排先校验宿主缓存，再用 `whisper-model-volume.mjs` 经
Docker CLI 流式同步到 `carlife-whisper-models` 具名卷，最后以只读方式挂载到容器
`/models`；因此不依赖 Docker Desktop 的 File Sharing 设置。

```bash
corepack pnpm dev:asr:setup
corepack pnpm dev:start local-asr
docker compose -f infra/docker-compose.yml --profile local-asr \
  ps local-asr
```

setup 工具会逐文件校验模型大小与 Hugging Face LFS SHA-256（来源固定到 ggml-org
仓库的一个 commit）；重复执行已校验的文件会直接成功，已有但校验失败的文件必须
显式加 `--force`。
`dev:start`、`dev:bootstrap` 和 `infra/scripts/up.sh` 会在启动前完成具名卷同步；
若要单独排查卷内容，可运行：

```bash
node infra/scripts/whisper-model-volume.mjs --check
```

容器的健康状态只有在模型加载完成、`GET /health` 返回 ready 后才会变为 healthy。
宿主 Gateway 通过 `http://127.0.0.1:8795/v1/audio/transcriptions` 访问，完整
Compose 栈再改用 Compose 内部的 `local-asr` 服务名。

⚠️ llama-server 对 Qwen3-ASR 的转写输出带 `language …` + asr_text 尖括号标记前缀
（上游 llama.cpp #26749 未修）；剥前缀在 Gateway 的 provider 里做，别在这里的
镜像层打补丁。

`corepack pnpm dev:bootstrap` 在 `CARLIFE_ASR=local` 时会自动执行模型校验、启动
profile 并等待容器 health；未准备模型时会在启动阶段失败并给出上述 setup 命令，
不会调用宿主机任何本地 ASR 二进制。

完整容器栈的 `infra/scripts/up.sh` 会先独立构建所有选中镜像，再以
`compose up -d --no-build` 启动；构建或模型准备失败时不会继续使用旧镜像。

服务端镜像在构建阶段执行 Prisma Client 生成；宿主机开发仍需单独执行
`corepack pnpm --filter @carlife/db db:generate`。
