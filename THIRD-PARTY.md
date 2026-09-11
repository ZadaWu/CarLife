# 第三方依赖清单（THIRD-PARTY）

> 生成日期 2026-09-11。表 1、表 2 由脚本从 `pnpm -r list --depth 0`、`pnpm licenses list` 与 `cargo metadata` 生成；表 3 来自 `vision-trainer` 的 uv 环境；表 4、表 5 手写。
> 只列**直接依赖**的名字、版本与许可证；传递依赖按许可证汇总在 §6。商业服务（模型、地图、审核、知识库）的调用环节、费用假设与锁定风险在 [docs/disclosure.md](docs/disclosure.md)。
> 本仓自身以 MIT 发布（根 `LICENSE`）。下面标注了三处许可证与 MIT 不同、需要单独说明的依赖。

## 0. 需要单独说明的三处

| 依赖 | 许可证 | 在哪 | 说明 |
|---|---|---|---|
| `ultralytics` | AGPL-3.0 | `enterprise/backend/vision-trainer`（Python 服务） | 警示灯检测器的训练与推理。它是独立进程、经 HTTP 被观察层调用，源码随本仓公开，满足 AGPL §13 的网络使用条款；该目录应视为 AGPL-3.0 派生物，**不按 MIT 再分发**。检测器缺省不启用（`CARLIFE_VISION_DETECT_PROVIDER` 缺省走通义千问），要商用可换 Apache-2.0 的实现或购买 Ultralytics 商业许可（ACR-026 §风险）。 |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | `gateway`（经 `sharp`） | 动态链接的预编译 libvips，图片格式识别与缩放；LGPL 对动态链接无传染，替换或升级该库不受限制。 |
| `webrtc-audio-processing(-sys)` 2.1.0 | BSD-3-Clause（crate 无 `license` 字段，许可证在 COPYING） | `clients/shared/rust/carlife-media`；`clients/shared/rust/vendor/` 带一份 iOS 交叉编译补丁 | Google WebRTC 的 AEC；补丁只改 build script，来由与删除条件见 `clients/shared/rust/vendor/README.md`。 |

## 1. JavaScript / TypeScript 直接依赖（45 个）

| 包 | 版本 | 许可证 | 运行 / 开发 | 使用方（workspace 成员） |
|---|---|---|---|---|
| `@agentclientprotocol/sdk` | 0.26.0 | Apache-2.0 | 运行 | agent-runtime |
| `@ai-sdk/deepseek` | 0.1.17 | Apache-2.0 | 运行 | agent-runtime |
| `@ai-sdk/openai-compatible` | 0.1.17 | Apache-2.0 | 运行 | agent-runtime |
| `@aws-sdk/client-s3` | 3.1106.0 | Apache-2.0 | 运行 | gateway |
| `@earendil-works/pi-coding-agent` | 0.84.1 | MIT | 开发 | pi-agents |
| `@langchain/core` | 1.2.5 | MIT | 运行 | agent-runtime |
| `@langchain/langgraph` | 1.4.9 | MIT | 运行 | agent-runtime |
| `@langchain/langgraph-checkpoint` | 1.1.3 | MIT | 运行 | agent-runtime |
| `@langchain/langgraph-checkpoint-postgres` | 1.0.4 | MIT | 运行 | agent-runtime |
| `@number-flow/react` | 0.6.2 | MIT | 运行 | web |
| `@paper-design/shaders-react` | 0.0.80 | Apache-2.0 | 运行 | web |
| `@prisma/client` | 6.19.3 | Apache-2.0 | 运行 | db |
| `@tauri-apps/api` | 2.11.1 | Apache-2.0 OR MIT | 运行 | cockpit, mobile |
| `@tauri-apps/cli` | 2.11.4 | Apache-2.0 OR MIT | 开发 | cockpit, mobile |
| `@tauri-apps/plugin-geolocation` | 2.3.2 | MIT OR Apache-2.0 | 运行 | mobile |
| `@types/express` | 5.0.6 | MIT | 开发 | gateway |
| `@types/node` | 22.20.1 | MIT | 开发 | agent-runtime, db, gateway, memory, mock-cabin, mock-dealer, mock-insurance, mock-repair, mock-tts, rag, shared, web, worker |
| `@types/node-cron` | 3.0.11 | MIT | 开发 | worker |
| `@types/react` | 18.3.31 | MIT | 开发 | cockpit, mobile, ui, web |
| `@types/react-dom` | 18.3.7 | MIT | 开发 | cockpit, mobile, ui, web |
| `@vitejs/plugin-react` | 4.7.0 | MIT | 开发 | cockpit, mobile, web |
| `ai` | 4.3.19 | Apache-2.0 | 运行 | agent-runtime |
| `c8` | 12.0.0 | ISC | 开发 | carlife-ai-agent |
| `express` | 4.22.2 | MIT | 运行 | gateway |
| `http-proxy-middleware` | 4.2.0 | MIT | 运行 | gateway |
| `husky` | 9.1.7 | MIT | 开发 | carlife-ai-agent |
| `mem0ai` | 3.1.5 | Apache-2.0 | 运行 | memory |
| `node-cron` | 3.0.3 | ISC | 运行 | worker |
| `pg-boss` | 12.28.1 | MIT | 运行 | agent-runtime |
| `pi-acp` | 0.0.33 | MIT | 开发 | pi-agents |
| `prettier` | 3.9.6 | MIT | 开发 | carlife-ai-agent |
| `prisma` | 6.19.3 | Apache-2.0 | 开发 | db |
| `react` | 18.3.1 | MIT | 运行 | cockpit, mobile, ui, web |
| `react-dom` | 18.3.1 | MIT | 运行 | cockpit, mobile, ui, web |
| `react-router-dom` | 7.18.2 | MIT | 运行 | web |
| `reactflow` | 11.11.4 | MIT | 运行 | web |
| `redis` | 4.7.1 | MIT | 运行 | agent-runtime, gateway, tools |
| `sharp` | 0.35.4 | Apache-2.0 | 运行 | tools |
| `tsx` | 4.23.9 | MIT | 开发 | agent-runtime, carlife-ai-agent, db, gateway, guardrails, memory, mobile, mock-cabin, mock-dealer, mock-insurance, mock-repair, mock-tts, rag, shared, tools, ui, web, worker |
| `turbo` | 2.10.8 | MIT | 开发 | carlife-ai-agent |
| `typescript` | 5.9.3 | Apache-2.0 | 开发 | agent-runtime, carlife-ai-agent, cockpit, db, gateway, guardrails, memory, mobile, mock-cabin, mock-dealer, mock-insurance, mock-repair, mock-tts, rag, shared, tools, ui, web, worker |
| `vite` | 6.4.3 | MIT | 开发 | cockpit, mobile, web |
| `yaml` | 2.9.0 | ISC | 开发 | carlife-ai-agent |
| `zod` | 3.25.76 | MIT | 运行 | agent-runtime, guardrails, memory, tools |
| `zod-to-json-schema` | 3.25.2 | ISC | 运行 | tools |

## 2. Rust 直接依赖（26 个）

| crate | 版本 | 许可证 | 使用方（workspace 成员） |
|---|---|---|---|
| `apple-native-keyring-store` | 1.0.2 | MIT OR Apache-2.0 | carlife-core |
| `base64` | 0.22.1 | MIT OR Apache-2.0 | carlife-net, cockpit, mobile |
| `block2` | 0.6.2 | MIT | carlife-media |
| `cpal` | 0.16.0 | Apache-2.0 | carlife-media |
| `futures-util` | 0.3.33 | MIT OR Apache-2.0 | carlife-net |
| `image` | 0.25.10 | MIT OR Apache-2.0 | carlife-media |
| `keyring` | 4.2.0 | MIT OR Apache-2.0 | carlife-core |
| `keyring-core` | 1.0.0 | MIT OR Apache-2.0 | carlife-core |
| `libc` | 0.2.189 | MIT OR Apache-2.0 | mobile |
| `objc2` | 0.6.4 | MIT | carlife-media, mobile |
| `objc2-foundation` | 0.3.2 | MIT | carlife-media |
| `pinyin` | 0.11.0 | MIT | carlife-voice, cockpit |
| `reqwest` | 0.12.28 | MIT OR Apache-2.0 | carlife-net |
| `rodio` | 0.22.2 | MIT OR Apache-2.0 | carlife-tts, cockpit |
| `rusqlite` | 0.32.1 | MIT | carlife-core |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | carlife-core, carlife-net, cockpit, mobile |
| `serde_json` | 1.0.151 | MIT OR Apache-2.0 | carlife-core, carlife-net, cockpit, mobile |
| `tauri` | 2.11.5 | Apache-2.0 OR MIT | cockpit, mobile |
| `tauri-build` | 2.6.3 | Apache-2.0 OR MIT | cockpit, mobile |
| `tauri-plugin-geolocation` | 2.3.2 | Apache-2.0 OR MIT | mobile |
| `tauri-plugin-opener` | 2.5.4 | Apache-2.0 OR MIT | cockpit, mobile |
| `thiserror` | 2.0.19 | MIT OR Apache-2.0 | carlife-core, carlife-media, carlife-net |
| `tokio` | 1.53.1 | MIT | carlife-net, carlife-tts, cockpit |
| `ts-rs` | 12.0.1 | MIT | carlife-core |
| `webrtc-audio-processing` | 2.1.0 | BSD-3-Clause（COPYING，Google WebRTC） | carlife-media |
| `webrtc-vad` | 0.4.0 | MIT | carlife-media |

## 3. Python 依赖（`enterprise/backend/vision-trainer`，uv 环境实测版本）

| 包 | 版本 | 许可证 |
|---|---|---|
| `ultralytics` | 8.4.143 | AGPL-3.0（见 §0） |
| `torch` | 2.14.0 | BSD-3-Clause（含 Apache-2.0 等组件） |
| `torchvision` | 0.29.0 | BSD-3-Clause |
| `opencv-python` | 5.0.0.93 | Apache-2.0 |
| `onnx` | 1.22.0 | Apache-2.0 |
| `onnxruntime` | 1.29.0 | MIT |
| `numpy` | 2.5.3 | BSD-3-Clause |
| `pillow` | 12.3.0 | MIT-CMU |
| `fastapi` | 0.141.1 | MIT |
| `uvicorn` | 0.52.4 | BSD-3-Clause |
| `python-multipart` | 0.0.32 | Apache-2.0 |
| `pyyaml` | 6.0.3 | MIT |

## 4. 模型权重、数据集与非代码素材

| 项 | 许可证 / 授权 | 用途 | 在仓库里吗 |
|---|---|---|---|
| `yolo11n.pt`（Ultralytics 预训练权重） | AGPL-3.0 | 警示灯检测器的微调起点 | 是（`vision-trainer/`） |
| 自训警示灯检测器权重 | 随 ultralytics 派生（AGPL-3.0） | 观察层第一遍（可选） | 否（训练产物） |
| `nomic-embed-text`（经本机 Ollama） | Apache-2.0 | Mem0 记忆向量化，不出网 | 否（Ollama 拉取） |
| Roboflow「Tesla New HMI」底图集（815 张 Model 3/Y 屏幕实拍） | CC BY 4.0，须署名 | 合成训练集的真实屏幕底图 | 否 |
| 厂商车主手册 / 保养手册（Tesla、雪佛兰） | 厂商版权，公开可下载；仅用于竞赛演示的知识库，不随仓库分发 | RAG 三个数据集与图标目录 | 否（`data/kb-md/` 被忽略） |
| Open-Meteo 天气 | CC-BY 4.0（非商用免费） | 高德天气未配置时的回退 | — |
| 界面素材（暖暖形象、HUD 图标） | 项目自制（AI 生成 + 人工修图） | 车机端与手机端 | 是 |

## 5. 运行时接入的商业服务（详见 docs/disclosure.md）

DeepSeek（LLM 与视觉表述）、阿里云百炼 / 通义千问（视觉观察、ASR、TTS、图标向量）、火山方舟 / 豆包（ASR、TTS）、阿里云 AI 安全护栏（内容审核）、RAGFlow Cloud（知识库检索）、高德开放平台（路径规划、天气、地图底图）、MinerU（PDF 转 markdown，离线工具）、Google Calendar / CalDAV（真实日历后端，可选）。每一项都可不配置，缺省档不出网。

## 6. 传递依赖按许可证汇总

JavaScript 全量 649 个包（含传递）：

| 许可证 | 数量 |
|---|---|
| MIT | 483 |
| Apache-2.0 | 82 |
| ISC | 39 |
| BSD-3-Clause | 25 |
| BlueOak-1.0.0 | 5 |
| Apache-2.0 OR MIT | 3 |
| MIT OR Apache-2.0 | 2 |
| BSD-2-Clause | 2 |
| LGPL-3.0-or-later | 1 |
| CC-BY-4.0 | 1 |
| (MIT OR WTFPL) | 1 |
| (AFL-2.1 OR BSD-3-Clause) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| Unknown | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |

Rust 全量 594 个 crate（含传递）：

| 许可证 | 数量 |
|---|---|
| MIT OR Apache-2.0 | 270 |
| MIT | 126 |
| Apache-2.0 OR MIT | 51 |
| MIT/Apache-2.0 | 25 |
| Zlib OR Apache-2.0 OR MIT | 21 |
| Unicode-3.0 | 18 |
| MPL-2.0 | 17 |
| Unlicense OR MIT | 6 |
| Apache-2.0/MIT | 6 |
| Apache-2.0 | 5 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 5 |
| MIT OR Apache-2.0 OR Zlib | 5 |
| BSD-3-Clause | 4 |
| ISC | 4 |
| BSD-3-Clause（COPYING） | 3 |
| Apache-2.0 OR ISC OR MIT | 2 |
| BSD-2-Clause OR MIT OR Apache-2.0 | 2 |
| BSD-3-Clause OR Apache-2.0 | 2 |
| BSD-3-Clause OR MIT OR Apache-2.0 | 2 |
| MIT OR Apache-2.0 OR LGPL-2.1-or-later | 2 |
| Unlicense/MIT | 2 |
| BSD-2-Clause OR Apache-2.0 OR MIT | 2 |
| 0BSD OR MIT OR Apache-2.0 | 1 |
| BSD-3-Clause AND MIT | 1 |
| BSD-3-Clause/MIT | 1 |
| Apache-2.0 AND MIT | 1 |
| CC0-1.0 OR MIT-0 OR Apache-2.0 | 1 |
| (Apache-2.0 OR MIT) AND BSD-3-Clause | 1 |
| Apache-2.0 / MIT | 1 |
| Zlib | 1 |
| MIT OR Zlib OR Apache-2.0 | 1 |
| Apache-2.0 AND ISC | 1 |
| Apache-2.0 OR BSL-1.0 | 1 |
| Apache-2.0 WITH LLVM-exception | 1 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 |
| CDLA-Permissive-2.0 | 1 |

复制方法：

```bash
corepack pnpm -r list --depth 0 --json > /tmp/pnpm-direct.json
corepack pnpm licenses list --json -r > /tmp/pnpm-licenses.json
cargo metadata --format-version 1 > /tmp/cargo-metadata.json
```
