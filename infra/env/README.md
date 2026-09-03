# infra/env

这里存放可复制的环境模板，不存放真实密钥。

| 文件 | 用途 |
|---|---|
| `.env.demo.example` | Fake LLM/ASR、Mock 工具、本地 Compose 基础设施 |
| `.env.external.example` | DeepSeek、Ark、TTS、RAGFlow、AMap、Guard 接入 |

模板复制到仓库根目录后使用：

```bash
cp infra/env/.env.demo.example .env
```

`infra/docker-compose.stack.yml` 的 `env_file` 读取仓库根 `.env`。因此不要只在
`infra/env/` 目录编辑模板后直接启动；模板是样例，`.env` 才是当前运行配置。

启动前必须修改 `CARLIFE_CONFIG_MASTER_KEY`。真实 key 不应出现在 Git、镜像层、日志或
文档截图中。
