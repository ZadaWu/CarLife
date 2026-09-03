# 外部依赖部署与验证

本页回答一个具体问题：RAGFlow、AMap、Ark、TTS、Guard 是否需要随 Compose 部署，
如何配置，未接通时系统会怎样。

配置分层、事务版本、变更通知、Provider 热切换和客户端密钥边界见
配置管理与热更新架构设计。本页只描述部署者
需要准备的外部依赖和验证顺序，不把“已写入配置库”视为“Provider 已激活”。

## 总体原则

这些服务都不是当前仓库 Compose 中的本地容器。它们通过环境变量或后台配置接入，
因此“服务端容器启动成功”不等于“所有能力已可用”。每个依赖都必须记录四件事：

1. 凭证（credential）从哪里来；
2. 容器或宿主机应该访问哪个 endpoint；
3. 用什么 probe 验证；
4. 失败时用户看到什么降级行为。

## 依赖矩阵

| 依赖 | 当前形态 | 主要配置 | 验证方式 | 未接通时的行为 |
|---|---|---|---|---|
| RAGFlow Cloud | 外部托管，不在 Compose 内自建 | `RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY`、三个 dataset id | `corepack pnpm probe:ragflow` | 检索明确标记未接入；不伪造说明书出处 |
| AMap | 外部地图服务 | `AMAP_SERVER_KEY`；客户端还需 `AMAP_JS_KEY`、`AMAP_JS_SECURITY_CODE` | `corepack pnpm probe:amap` | 天气可退回 Open-Meteo；路径规划标记未接入；客户端地图回退程序化底图 |
| Ark ASR | 外部语音识别服务 | `ARK_API_KEY`、`ARK_BASE_URL`、`ARK_ASR_MODEL` | `corepack pnpm smoke:voice` | 使用 Fake ASR 或向端上明确提示语音识别不可用，不能无限等待 |
| 字节 TTS | 外部语音合成服务；播放在座舱端 | `BYTEDANCE_TTS_API_KEY`、资源 ID、音色 | 与语音链路 smoke 一起验证；当前没有独立 TTS probe | 云端失败时座舱端降级系统 TTS；移动端当前没有本地 TTS |
| Guard / 阿里云内容安全 | 外部审核服务 | `GUARD_PROVIDER=aliyun`、`Aliyun_AccessKey_ID`、`Aliyun_AccessKey_Secret` 等 | `corepack pnpm probe:aliyun-guard` | 输入默认 fail-open 但要留痕；输出默认 fail-closed；规则筛与脱敏仍运行 |
| Guard / OpenAI-compatible | 自建或第三方兼容端点 | `GUARD_PROVIDER=openai-compat`、`GUARD_BASE_URL`、`GUARD_API_KEY`、`GUARD_MODEL` | 当前依赖 Guard 运行时探活；应纳入统一 preflight | 按 Guard 超时策略降级并标记，不能静默当作审核成功 |
| Guard / Ollama | 设计中的本地可选形态 | 本地模型地址与资源限制 | 当前没有 Compose 服务；FL-37 仅记录了编排方向 | 默认不应宣称已接入 |

## 当前仓库已经写了什么

### RAGFlow

已有说明：

- [`.env.example`](../.env.example) 给出端点、key 和三个数据集变量；
- FL-24 知识库管理与同步 说明解析、切分、
  向量化、检索和出处要求；
- FL-39 外部服务接入与 Mock 开关 说明
  三数据集隔离与探活；
- `infra/scripts/ragflow-*.mts` 提供 probe、上传、等待和 QA 脚本。

缺口：这些内容没有形成“首次部署 RAGFlow 后按什么顺序填配置、如何确认三个数据集都
可检索”的单页 runbook。

### AMap

已有说明：

- [`.env.example`](../.env.example) 区分服务端 key、Web/JS key 和安全密钥；
- `scripts/dev/probe/amap-probe.mts` 与 `package.json` 的 `probe:amap` 可做连通性自检；
- 地图/天气的降级行为写在工具实现和 feature-list 中。

缺口：没有将“服务端 key 与客户端 key 不能互换、客户端构建期变量如何注入、缺 key
时回退到什么”集中写成部署步骤。

### Ark ASR 与 TTS

已有说明：

- [`.env.example`](../.env.example) 给出 Ark 和字节 TTS 参数；
- FL-38 语音链 说明 ASR、TTS、降级、
  探活和端侧边界；
- `smoke:voice` 覆盖网关语音链路。

缺口：`infra/README.md` 只要求填写 key，没有告诉开发者 TTS 实际由座舱端播放、
手机端当前没有本地 TTS，也没有给出“只验证文本链路”和“验证真实语音链路”的区别。

### Guard

已有说明：

- FL-37 内容安全模型部署与 Guard 参数
  说明云端、自建兼容端点和 Ollama 方向；
- [`.env.example`](../.env.example) 给出阿里云与 OpenAI-compatible 两套配置；
- `scripts/dev/probe/aliyun-guard-probe.mts` 提供阿里云实际判定探活。

缺口：当前没有本地 Guard Compose service，也没有一条启动前命令说明“选择哪种 provider、
哪些 key 是必填、输入/输出的 fail 策略分别是什么”。

## 推荐的首次接入顺序

1. 先用 `CARLIFE_LLM=fake`、Mock 工具和无外部 RAG 的路径确认 Gateway、Runtime、SSE、
   数据库迁移和端侧连接。
2. 再接 RAGFlow，按 `vehicle-manuals`、`repair-kb`、`car-catalog` 顺序逐一 probe，
   确认返回内容带出处。
3. 再接 AMap 服务端 key；客户端地图 key 只在 Web/Tauri 构建时注入，不放进服务端容器。
4. 最后接 Ark、TTS 和 Guard，并分别执行语音/审核 probe。任何一项失败，都应在健康视图
   中显示“未接入/降级”，而不是把整套系统标成绿色。

## 后续文档与代码门禁

未来新增外部依赖时，必须同时更新：

- `.env.example`；
- 本页依赖矩阵；
- `infra/scripts/` 中的 probe 或明确说明为什么不需要 probe；
- `FL-39` 的降级行为；
- `FL-43` 的 L2 依赖探活清单。
