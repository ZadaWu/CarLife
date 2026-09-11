# CarLife 帮助文档

本目录回答「怎么装、怎么跑、怎么接外部服务、怎么部署、出错了怎么办」。项目概览与技术栈在仓库根目录的 [README](../README.md)，数据合规说明在 [data/README.md](../data/README.md)。

| 文档 | 回答的问题 |
|---|---|
| [技术架构说明](architecture.md) | 模型选择、Agent 架构、工具调用方式、知识库与检索增强、多轮对话与上下文管理、工作流编排、数据处理流程与安全边界 |
| [逐步部署手册](step-by-step.md) | 不依赖 AI 助手，从零到看到运营控制台、车机端、手机端三个端，每一步带命令、预期输出与出错去处 |
| [安装](installation.md) | 需要哪些工具链、版本钉在哪里、缺失时的表现 |
| [快速体验](quickstart.md) | 不填任何付费密钥时如何跑通核心链路并验证 |
| [配置外部服务](external-services.md) | LLM、知识库、语音、地图、内容审核各自的作用、配置项与缺省降级 |
| [部署](deployment.md) | 容器化应用栈的启动、检查、停止与数据处理 |
| [排障](troubleshooting.md) | 常见错误的现象与处理办法 |
| [指示灯识别训练手册](warning-light-training.md) | 车厂开发人员怎么让系统认出自己品牌车型的指示灯：先建图标目录（不用训练），再决定要不要训专用检测器 |
| [商业服务与闭源模型披露](disclosure.md) | 每个商业 API 与闭源模型的调用环节、数据流向、权限范围、费用假设、可替代性与锁定风险；软件依赖的许可证在根目录 [THIRD-PARTY.md](../THIRD-PARTY.md) |

更细的运维说明在 `infra/` 目录：[infra/README.md](../infra/README.md)、[infra/external-dependencies.md](../infra/external-dependencies.md)、[infra/scripts/README.md](../infra/scripts/README.md)。

文档中出现的版本号、端口与路径以仓库内的配置文件为准：Node 版本在根 `.nvmrc`，Rust 版本在 `rust-toolchain.toml`，端口在 `.env.example`。
