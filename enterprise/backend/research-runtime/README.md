# research-runtime

用户研究面的分析进程（ARCH-001 /
ACR-034，施工单 M82-04）。
端口 **8800**，只绑 `127.0.0.1`，无鉴权。

## 它为什么是单独一个进程

研究面本质上是**跨用户聚合**：「这一百台车里有多少台在低温下抱怨过续航」这个问题没有用户键可带。

`agent-runtime` 里每个仓储都刻意带 `userId` / `vin`（M7-01 纪律：少一个条件读到的是别人家的数据）。
把无键读混进那个进程，等于给端上路径顺手留一条无键入口——而漏用的那一次不会有任何现象。

所以研究面另起一个进程，并由 `check:arch` 的 `research-isolation` 守住：
本目录不得 import `@carlife/agent-runtime` / `@carlife/tools` / `@carlife/memory`。

## 它为什么不经 pi / ACP

四个 Agent（Coder / Namer / Synthesizer / Challenger）产出的是**给代码解析的结构化结果**，
不是给人读的流式回答。ACP 那一整套（会话、流式 token、权限请求）在这里没有消费者，
而 `generateObject` 的 zod schema 约束恰恰是 pi 给不了的。

## 起停

```bash
corepack pnpm dev:restart research-runtime
corepack pnpm dev:logs research-runtime
curl -s 127.0.0.1:8800/health | python3 -m json.tool
```

**不在默认集合里**：研究面由两个开关兜底，缺省关着。

| 开关 | 缺省 | 管什么 |
|---|---|---|
| `RESEARCH_ENABLED` | `off` | worker 挂不挂 `research-acquire` 取数任务 |
| `RESEARCH_RUNTIME_URL` | 空 | 网关代不代理 `/console/research/*` |

本进程自己起不起来与这两个开关无关（它起来了也只是空转），
但**缺 `DEEPSEEK_API_KEY` 时编码队列不注册**，只读端点照常——`/health` 的 `queue.code` 会如实报 `false`。

## 目录

| 路径 | 干什么 |
|---|---|
| `codebooks/*.yaml` | **口径本身**。版本 = 文件 sha256；锁版后文件被改 → 启动拒绝 |
| `prompts/coder.md` | 编码员的系统提示词。业务提示词，不经 pi |
| `src/llm/` | 唯一的模型入口。**思考恒关**，`test/thinking.test.ts` 扫源码守它 |
| `src/codebook/` | 载入、结构校验、锁版对账 |
| `src/coding/` | codebook → zod schema；Coder |
| `src/queue/` | `research.code` 消费者；`research.embed` / `research.snapshot` 先空注册（M82-05 填） |
| `src/internal-api/` | 只读 HTTP 面。**永不返回原文** |

## 三条不能忘的纪律

1. **思考必须显式关。** DeepSeek v4 全系默认 thinking on，SDK 关不掉，
   要在 provider 的 `fetch` 层合进 `thinking: {type:"disabled"}`。
   不关的表现不是报错，是「49 秒 18253 字、一个字段没填」（M24 实测）。
   验收查 `SELECT sum(reasoning_tokens) FROM llm_usage WHERE agent LIKE 'research-%'` 应为 0。
2. **codebook 锁版后只增不改。** 改一个码的定义没有任何自然现象——图照出、
   一致率照样高（两批各自内部仍一致），只有跨版本比较时数字悄悄换了含义。
   能拦住它的只有启动期那一次 hash 比对。
3. **端点永不返回原文。** 证据出口用**白名单挑字段**而不是删字段，
   这样库里新增一列时默认不出现。`test/api.test.ts` 有一条断言钉住响应体里没有 `content` 键。

## 队列

三条队列与 `agent-runtime` 的 `guide.*` 共用 `pgboss` schema，两个进程各起一个实例、
各 `work()` 自己的队列。本进程**只消费 `research.*`**，不碰 `guide.*`。

| 队列 | 谁入队 | 谁消费 |
|---|---|---|
| `research.code` | worker 的 `research-acquire`（M82-02） | 本进程（M82-04） |
| `research.embed` | M82-05 | M82-05（现在是空 handler，只记日志） |
| `research.snapshot` | M82-05 | M82-05（同上） |
