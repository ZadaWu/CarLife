# infra/docker/ —— Docker Compose 部署

> 这个目录是 **部署目标上** `docker` 这套设施的全部维护入口：每一次对部署的改动都是 `sprints/` 下一份脚本，
> 不手敲命令。由 [`/deploy-ops`](../../内部技能模板) 技能产出与维护；四条铁律与判准在它的
> [`references/deploy-rubric.md`](../../内部技能模板)，
> 命名 / 目录规范在 [`references/naming.md`](../../内部技能模板) /
> [`references/directory-layout.md`](../../内部技能模板)。

## 结构

```
infra/docker/
├── README.md            ← 本文：定位 + 索引（索引段由 deploy.mjs index 重写）
├── lib/adapter.sh       ← 设施适配器：svc_exists / svc_running / svc_up / svc_remove…（技能模板生成，deploy.mjs sync 更新）
├── envs/                ← 每个环境一份配置，**正文脚本不写死环境**
│   ├── dev/   .env.example  .env（不进 git）  <设施专属覆盖>  hooks.sh（可选）
│   ├── test/  …
│   └── prod/  …
└── sprints/             ← 一次部署改动一份脚本：M<n>-<NN>-<slug>.sh
```

## 怎么跑

```bash
D=内部技能模板
node $D plan docker/M<n>-<NN> --env dev       # 预检：服务存不存在、在不在跑 + 计划；不改任何东西
node $D run  docker/M<n>-<NN> --env dev       # apply → verify → 记 infra/deploy.runs.jsonl
node $D run  docker/M<n>-<NN> --env prod --confirm   # --confirm 只能在人明确说 yes 之后加
node $D runs docker                           # 最近的运行记录
```

或者直接 `bash infra/docker/sprints/<脚本>.sh <plan|apply|verify|rollback> <env>`——两条路都经过同一份 `infra/lib/common.sh`。

## 索引

<!-- deploy-index:start -->
| 脚本 | 标题 | Sprint | 状态 | 服务 | 环境 | 删除动作 | dev | test | prod |
|---|---|---|---|---|---|---|---|---|---|
| [docker/M56-01](M56-01-aliyun-ecs-stack-bringup.sh) | 阿里云 ECS 首次拉起完整服务栈（不含 ASR/TTS 大模型） | M56 | applied | postgres, redis, minio, migrate, mock-dealer, mock-cabin, mock-repair, mock-insurance, agent-runtime, gateway, worker, web | test | 是 | — | ✓ 2026-09-01 | — |
<!-- deploy-index:end -->
