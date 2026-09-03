# infra/compose

这里存放默认核心栈之外的 Compose 片段。片段依赖
`../docker-compose.yml`，不要单独执行。

| 文件 | profile | 内容 |
|---|---|---|
| `worker.yml` | `worker` | 定时任务进程 |
| `web.yml` | `web` | Web 静态站点与 Gateway `/console` 代理 |
| `ollama.yml` | `ollama` | 本地 embedding 模型和可达地址 |

推荐使用脚本启动：

```bash
infra/scripts/up.sh --worker --web
infra/scripts/up.sh --ollama
```

手动执行时，必须同时指定核心文件、片段文件和对应 profile：

```bash
docker compose \
  -f infra/docker-compose.stack.yml \
  -f infra/compose/worker.yml \
  --profile worker up -d --build
```

核心服务不放入 profile；profile 只控制额外资源或额外运行职责。
