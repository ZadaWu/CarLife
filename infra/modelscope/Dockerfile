# 魔搭 Docker 创空间的镜像（ACR-048）。
#
# 它只做一件事：把演示页的静态产物交给 nginx，并把 /v1/* 反代到真正的网关。
# 容器里只有 nginx 一个进程——服务端全在阿里云 ECS 上，这里不跑任何业务进程。
#
# ⚠️ 这个文件在公开树里位于**仓库根**（导出契约的 mirror_files 把它从
# infra/modelscope/Dockerfile 映射到 Dockerfile），因为平台要求 Dockerfile 在根目录。
# 本地构建时要显式指路径：docker build -f infra/modelscope/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

# ── 构建期换源：这里的缺省与 infra/images/* 相反，是刻意的
#
# 那几个镜像把 NPM_REGISTRY 缺省留空（官方源），靠部署脚本显式传值换源。
# 这个镜像不能这么做：**魔搭的 Docker 创空间在 Beta 阶段不支持构建期变量**
# （官方文档原话），设置页里配的变量只在运行时注入，传不进 build。
# 而它的构建机在国内——实测从国内直连 registry.npmjs.org 13.7 KB/s，
# 构建会直接卡死在装依赖上。所以这里把国内镜像站写成缺省值。
#
# 换源不放松完整性：下面走 --frozen-lockfile，pnpm-lock.yaml 里逐包的 integrity
# 哈希照样校验，换个镜像站换不了包的内容。
ARG NPM_REGISTRY="https://registry.npmmirror.com"
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org}
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts/package.json contracts/
COPY clients/demo-web/package.json clients/demo-web/
# 只装演示页这一条依赖链（`...` 后缀 = 连同它依赖的工作区包）。
# 整个 workspace 的其它成员不参与——它们的 package.json 都不在上下文里。
RUN pnpm install --frozen-lockfile --filter @carlife/demo-web...

COPY contracts/ contracts/
COPY clients/demo-web/ clients/demo-web/
RUN pnpm --filter @carlife/demo-web build

FROM nginx:1.27-alpine
# envsubst 来自 gettext；alpine 的 nginx 镜像没带
RUN apk add --no-cache gettext

COPY --from=build /app/clients/demo-web/dist /usr/share/nginx/html

# 构建指纹。用途很实际：平台的状态接口在滚动更新时**一直是 Running**，
# 判断不了"我推的这版到底生效了没"——两次排查都卡在这上面，各多花一轮。
# 这个时间戳会出现在界面角落与 /__whoami 里，一张截图就能认出是哪一版。
# 放在 COPY dist 之后：dist 每次构建都变，这一层不会被缓存复用。
RUN date -u +%Y%m%d-%H%M > /usr/share/nginx/html/build-id.txt
COPY infra/modelscope/nginx.conf.template /etc/nginx/templates/site.conf.template
COPY infra/modelscope/proxy-common.conf.template /etc/nginx/templates/proxy-common.conf.template
COPY infra/modelscope/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 平台规定的对外端口，不可改
EXPOSE 7860
ENTRYPOINT ["/entrypoint.sh"]
