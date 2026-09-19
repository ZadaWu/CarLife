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

# ── 构建期可换 npm 源（缺省不换）
#
# 2026-09-19 那次部署整套镜像**零缓存命中**（`node:24-alpine` 是会移动的 tag，一动
# 下游全失效），于是每个镜像都要从头装依赖——而从国内 ECS 直连 registry.npmjs.org
# 实测 13.7 KB/s、40 秒连一份包元数据都传不完，构建就停在那里，`up` 一步都没走到。
# 留这个口子与 apply 第①步给 Docker Hub 写 registry-mirrors 是同一个思路。
#
# **缺省为空 = 官方源**：本机开发与 CI 的行为一个字都不变，只有部署脚本显式传值才换。
# 换源不放松完整性：这里走 `pnpm install --frozen-lockfile`，pnpm-lock.yaml 里逐包的
# integrity 哈希照样校验，换个镜像站换不了包的内容。
ARG NPM_REGISTRY=""
# 两处都要设，少一个就还有一半流量走官方源：COREPACK_NPM_REGISTRY 管 corepack 自己
# 下载 pnpm 那一步，npm config 写出的 ~/.npmrc 管 pnpm 解析依赖那一步。
# 用 `:-` 兜默认值而不是直接赋空——COREPACK_NPM_REGISTRY 被设成空串会让 corepack 出错。
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org}
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

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
# acp 与 research 曾漏在这份清单外，而 `src` 阶段的 `COPY enterprise/` 会把它们的
# **源码**带进来——于是缺失不在构建期暴露：pnpm install 时它们不是 workspace 成员，
# node_modules 里没有链接，而服务走 tsx 不编译，要等运行到那条代码路径才 Cannot find module。
# 这份清单必须覆盖 gateway / agent-runtime / worker / db 的 workspace 依赖传递闭包。
COPY enterprise/backend/shared/acp/package.json          enterprise/backend/shared/acp/
COPY enterprise/backend/shared/research/package.json     enterprise/backend/shared/research/
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
