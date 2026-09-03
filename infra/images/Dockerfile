# CarLife 服务端镜像（gateway / agent-runtime 共用）
#
# pnpm workspace 分层构建：先只拷贝清单装依赖（依赖不变时命中缓存），再拷源码。
#
# 【为什么用 tsx 运行而非 tsc 产物】`@carlife/shared` 的 package.json
# `main` 指向 `src/index.ts`（TS 源码，见 §10 要点 6 的契约共享方式），
# 消费方直接引用源码；`node dist/index.js` 会在运行时解析不到。
# 保持 tsx 运行可避免为容器另建一套 tsc project references。
# 若后续要瘦身产物，需先把 shared 改为发布 dist + exports 映射。

FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable

# ── 依赖层：只拷 workspace 清单
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contracts/package.json      contracts/
COPY enterprise/backend/shared/db/package.json          enterprise/backend/shared/db/
COPY clients/shared/ui/package.json          clients/shared/ui/
COPY enterprise/backend/shared/tools/package.json       enterprise/backend/shared/tools/
COPY enterprise/backend/shared/memory/package.json      enterprise/backend/shared/memory/
COPY enterprise/backend/shared/guardrails/package.json  enterprise/backend/shared/guardrails/
COPY enterprise/backend/shared/rag/package.json         enterprise/backend/shared/rag/
COPY enterprise/backend/gateway/package.json     enterprise/backend/gateway/
COPY enterprise/backend/agent-runtime/package.json enterprise/backend/agent-runtime/
COPY enterprise/backend/worker/package.json      enterprise/backend/worker/
COPY enterprise/backend/pi-agents/package.json   enterprise/backend/pi-agents/
# 两个 mock 不在本镜像运行（各自有 infra/images/Dockerfile.mock），但 frozen-lockfile
# 要求 lockfile 里的每个 workspace 成员都有 manifest 在场——少一个就装不动
COPY mocks/dealer/package.json mocks/dealer/
COPY mocks/cabin/package.json  mocks/cabin/
COPY enterprise/console/package.json             enterprise/console/
COPY clients/mobile/package.json          clients/mobile/
COPY clients/cockpit/package.json         clients/cockpit/
# 端应用（Tauri/Vite）不在服务端镜像运行，但 pnpm 需要完整 workspace 图
RUN pnpm install --frozen-lockfile

# ── 源码层
FROM deps AS src
COPY contracts/ contracts/
COPY enterprise/ enterprise/
# Prisma Client 必须在镜像内生成（产物与平台相关，不能从宿主拷）
RUN pnpm --filter @carlife/db exec prisma generate

# ── 目标：网关（唯一对外入口，§3）
FROM src AS gateway
ENV NODE_ENV=production
WORKDIR /app/enterprise/backend/gateway
EXPOSE 8790
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

# ── 目标：Agent 运行时（内部服务，不对外暴露）
FROM src AS agent-runtime
ENV NODE_ENV=production
WORKDIR /app/enterprise/backend/agent-runtime
EXPOSE 8791
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

# ── 目标：离线 Worker（通过 Compose 可选启用）
FROM src AS worker
ENV NODE_ENV=production
WORKDIR /app/enterprise/backend/worker
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

# ── 目标：一次性任务（数据库迁移）
FROM src AS migrate
WORKDIR /app/enterprise/backend/shared/db
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
