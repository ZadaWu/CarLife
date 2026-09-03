# 配置外部服务

本文说明每一项外部服务的作用、配置项、验证方式与未配置时的行为。所有服务都可以不配置；配置项的完整清单与注释在 `.env.example`，部署侧的说明在 [infra/external-dependencies.md](../infra/external-dependencies.md)。

改动 `.env` 后重启对应服务：

```bash
corepack pnpm dev:restart gateway runtime
```

## 服务矩阵

| 服务 | 作用 | 主要配置项 | 验证 | 未配置时 |
|---|---|---|---|---|
| DeepSeek / Qwen | LLM 推理，唯一计费的必选项 | `DEEPSEEK_API_KEY`；Qwen 走 `DASHSCOPE_*` | `corepack pnpm smoke:llm` | 确定性 Fake 模型 |
| RAGFlow | 知识库检索，带出处 | `RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY`、三个数据集 id | `corepack pnpm probe:ragflow` | 检索标记未接入，不伪造出处 |
| 高德 | 地图、路径规划、天气 | `AMAP_SERVER_KEY`；客户端另需 `AMAP_JS_KEY`、`AMAP_JS_SECURITY_CODE` | `corepack pnpm probe:amap` | 天气退回 Open-Meteo，路径规划标记未接入，客户端使用程序化底图 |
| Ark ASR | 语音识别 | `ARK_API_KEY`、`ARK_BASE_URL`、`ARK_ASR_MODEL` | `corepack pnpm smoke:voice` | Fake ASR，或向终端提示语音识别不可用 |
| 字节 TTS | 语音合成，播放在车机端 | `BYTEDANCE_TTS_API_KEY`、资源 id、音色 | 随语音链路 smoke | 车机端降级到系统 TTS |
| 阿里云内容安全 | 内容审核 | `GUARD_PROVIDER=aliyun`、`Aliyun_AccessKey_ID`、`Aliyun_AccessKey_Secret` | `corepack pnpm probe:aliyun-guard` | 规则筛与脱敏仍运行；审核层按 fail 策略降级并留痕 |
| OpenAI 兼容审核端点 | 自建或本地审核模型 | `GUARD_PROVIDER=openai-compat`、`GUARD_BASE_URL`、`GUARD_API_KEY`、`GUARD_MODEL` | 运行时探活 | 同上 |
| MinerU | PDF 转 markdown，仅知识库导入时用 | `MINERU_*` | `corepack pnpm kb:convert` | 无法转换 PDF，可直接上传已有 markdown |

## 推荐的接入顺序

1. LLM。填 `DEEPSEEK_API_KEY`，运行 `smoke:llm`，再运行 `corepack pnpm smoke:acp` 验证编排链路。
2. 知识库。在 RAGFlow 建三个数据集，把 id 填入 `.env`，运行 `probe:ragflow` 确认连通与隔离，再按 [data/README.md](../data/README.md) 导入语料。
3. 地图。填 `AMAP_SERVER_KEY`，运行 `probe:amap`。
4. 内容审核。填阿里云密钥，运行 `probe:aliyun-guard`，输出会列出该账号实际开启的检测维度。
5. 语音。填 Ark 与 TTS 配置，运行 `smoke:voice`。

## 知识库的三个数据集

| 数据集 | 配置项 | 消费方 | 放什么 |
|---|---|---|---|
| `vehicle-manuals` | `RAGFLOW_DATASET_VEHICLE_MANUALS` | 用车助手 | 用户手册、导航娱乐系统手册 |
| `repair-kb` | `RAGFLOW_DATASET_REPAIR_KB` | 售后服务 | 保修及保养手册、故障码表、维修工艺 |
| `car-catalog` | `RAGFLOW_DATASET_CAR_CATALOG` | 购车顾问 | 车型手册、配置参数、选装表、价格表 |

隔离由代码在调用层强制。放错数据集的后果是该看到它的 Agent 看不到，不该看到的反而能看到。

RAGFlow 侧有两项设置不在本仓代码里，但会让解析全部失败：数据集的切分方法（PDF 不能用 `table`，要用 `manual`），以及 embedding 模型所在账号的余额（与 RAGFlow 订阅是两笔钱，欠费表现为文档 0 篇、检索零命中）。

语料一律先转 markdown 再上传，不直接上传 PDF：

```bash
corepack pnpm kb:convert <PDF...>
corepack pnpm kb:upload <数据集> <文件...>
```

重传同名文档用 `kb:replace`，它先删后传并校验文件名。直接重传时 RAGFlow 会把新文件改名成 `xxx(1).md`，旧文件继续占用正名。

## 内容审核的维度开关

运营策略里的维度开关只能关、不能开：某维度是否参与检测由阿里云控制台决定，本仓的开关只能抑制已经返回的拦截。个人信息脱敏不依赖阿里云的 `sensitiveData` 维度，由本地输出脱敏层负责。

## 密钥管理

- `.env` 不入库，`.gitignore` 已排除。
- `corepack pnpm check:secrets` 扫描仓库里的明文密钥，pre-commit 会运行它。
- `corepack pnpm check:env-example` 检查配置注册表与 `.env.example` 的一致性，新增配置项时两处都要改。
