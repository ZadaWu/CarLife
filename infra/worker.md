# Worker：定时任务与数据维护

Worker 是离线任务进程，不参与用户请求的 REST/SSE 接入，也不调用 LLM 做业务判断。
它按固定时间扫描 PostgreSQL、Mem0 和 RAGFlow 的状态，把需要延迟处理的工作补齐。

## 当前代码位置

```text
enterprise/backend/worker/
├── src/index.ts               # cron 调度与 --once 入口
├── src/job-runner.ts           # 幂等、租约、补偿、执行留痕
├── src/memory-decay.ts         # episodic 记忆衰减与删除
├── src/usage-aggregation.ts    # 用车流水聚合为 usage_pattern
├── src/kb-sync.ts              # RAGFlow 解析状态同步
├── src/vehicle-reminder.ts     # 保养/年检提醒
└── src/alerts.ts               # 失败告警
```

## 四类任务

| 任务 | 默认时间 | 读取 | 写入或副作用 | 目的 |
|---|---:|---|---|---|
| `usage-aggregation` | 每小时第 5 分钟 | PostgreSQL 用车流水、车辆成员 | Mem0 `usage_pattern`、任务留痕 | 让用车助手能够基于真实用车习惯回答 |
| `kb-sync` | 每小时第 20 分钟 | RAGFlow 文档解析状态 | 任务留痕、失败告警 | 发现“上传成功但异步解析失败/卡住”的文档 |
| `memory-decay` | 每天 03:30 | Mem0 `episodic` | 软删、延迟物理删除、告警 | Mem0 没有内置 TTL 时执行衰减策略 |
| `vehicle-reminder` | 每天 08:00 | PostgreSQL 车辆档案与画像 | 生成保养/年检提醒、去重留痕 | 将维护周期转成车主可见提醒 |

任务表达式以 `enterprise/backend/worker/src/index.ts` 为准；部署文档不能另写一份 cron 表。

## 三条运行契约

1. **幂等**：同一时间窗口重复执行，不产生重复画像、重复提醒或重复删除。
2. **可补偿**：漏跑后按有限窗口补跑，不能一次追溯到无限久以前。
3. **失败要出声**：失败写入任务留痕并告警；下游看到 stale 数据时必须降级，不能把旧画像
   当成最新事实。

## 它为什么不能并入 Gateway 或 Agent Runtime

- Worker 的扫描和聚合可能持续较久，不能阻塞在线 SSE。
- 记忆衰减、硬删和提醒是有副作用的离线操作，需要独立的资源和审计边界。
- Agent Runtime 负责请求级编排；Worker 负责时间驱动的维护，两者触发条件不同。
- Worker 当前默认单实例；多实例需要确认租约、资源上限和任务互斥后再开放。

## 当前如何运行

合并代码后，推荐用完整升级入口一次完成依赖、构建、启动和验收；它会把 Worker 纳入默认
宿主开发集合：

```bash
corepack pnpm dev:upgrade
```

只做宿主机调试时也可以单独运行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @carlife/db db:generate
set -a
. ./.env
set +a
corepack pnpm --filter @carlife/worker dev
```

`corepack pnpm dev:restart` 的默认集合同样包含 Worker；若只重启在线服务，显式列出目标
（例如 `corepack pnpm dev:restart gateway runtime`）。不要在同一台机器同时启动宿主 Worker
和 Compose Worker，以免两个实例争抢同一批任务租约。

手动跑一次任务（运维演练或调试）：

```bash
corepack pnpm --filter @carlife/worker exec tsx src/index.ts --once usage-aggregation
corepack pnpm --filter @carlife/worker exec tsx src/index.ts --once kb-sync
corepack pnpm --filter @carlife/worker exec tsx src/index.ts --once memory-decay
corepack pnpm --filter @carlife/worker exec tsx src/index.ts --once vehicle-reminder
```

手动执行前确认：

- 目标 PostgreSQL、Redis 和 Mem0 已连通；
- `kb-sync` 需要 RAGFlow endpoint、key 和三个数据集 id；
- `memory-decay` 可能删除数据，先确认软删窗口和删除比例保护；
- 不要同时启动第二个 Worker 实例。

## 目标部署方式

Worker 应作为 Compose 的可选 profile，而不是默认和在线服务混在一起：

```bash
docker compose --profile worker up -d worker
```

纳入 Compose 前必须补齐：

- Worker 镜像 target 或独立 Dockerfile；
- `worker` 健康/心跳检查；
- 日志与任务留痕查看方式；
- PostgreSQL、Redis、Mem0、RAGFlow 的容器内地址覆盖；
- 单实例约束或经过验证的分布式租约；
- `up → health → smoke → down` 的验收脚本。

## 相关设计文档

- FL-32 定时任务：业务与运行契约
- FL-40 数据与中间件部署运维：存储、资源和恢复
- FL-42 运行时进程与定时任务运维：进程、告警和单实例假设
