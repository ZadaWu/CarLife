# CarLife 帮助文档

本目录回答「怎么装、怎么跑、怎么接外部服务、怎么部署、出错了怎么办」。项目概览与技术栈在仓库根目录的 [README](../README.md)，数据合规说明在 [data/README.md](../data/README.md)。

| 文档 | 回答的问题 |
|---|---|
| [安装](installation.md) | 需要哪些工具链、版本钉在哪里、缺失时的表现 |
| [快速体验](quickstart.md) | 不填任何付费密钥时如何跑通核心链路并验证 |
| [配置外部服务](external-services.md) | LLM、知识库、语音、地图、内容审核各自的作用、配置项与缺省降级 |
| [部署](deployment.md) | 容器化应用栈的启动、检查、停止与数据处理 |
| [排障](troubleshooting.md) | 常见错误的现象与处理办法 |

更细的运维说明在 `infra/` 目录：[infra/README.md](../infra/README.md)、[infra/external-dependencies.md](../infra/external-dependencies.md)、[infra/scripts/README.md](../infra/scripts/README.md)。

文档中出现的版本号、端口与路径以仓库内的配置文件为准：Node 版本在根 `.nvmrc`，Rust 版本在 `rust-toolchain.toml`，端口在 `.env.example`。
