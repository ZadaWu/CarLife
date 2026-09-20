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
COPY clients/shared/ui/package.json clients/shared/ui/
COPY clients/mobile/package.json clients/mobile/
COPY clients/cockpit/package.json clients/cockpit/
# @carlife/ui 的清单里挂着 @carlife/rag（workspace:*），只要清单不要源码——
# 与 infra/images/Dockerfile.client 同一口径，前端构建用不到它的实现。
COPY enterprise/backend/shared/rag/package.json enterprise/backend/shared/rag/
# `...` 后缀 = 连同各自依赖的工作区包。其余成员的 package.json 不在上下文里，不参与。
RUN pnpm install --frozen-lockfile \
      --filter @carlife/demo-web... --filter @carlife/mobile... --filter @carlife/cockpit...

COPY contracts/ contracts/
COPY clients/shared/ui/ clients/shared/ui/
COPY clients/demo-web/ clients/demo-web/
COPY clients/mobile/ clients/mobile/
COPY clients/cockpit/ clients/cockpit/
RUN pnpm --filter @carlife/demo-web build

# ── 两端的真界面（ACR-049）：演示构建，带浏览器传输垫片，各挂一个子路径
#
# 高德 JS key **不进产物**：魔搭的 Docker 创空间不支持构建期变量，key 由 entrypoint 写进
# /config.js（运行时、no-store），两端的 main.tsx 先读它。
#
# 先前的做法是烘一个占位符、容器启动时 sed 换成真值——栽在缓存上：带哈希的产物是 immutable
# 永久缓存，sed 改了内容却不改文件名，开过页的浏览器一直拿着旧的那份。表现是「key 配好了、
# 线上产物里也确实有 key，地图就是不出来」，而换个没缓存的浏览器又是好的。
ENV VITE_WEB_SHIM=1
RUN VITE_BASE=/mobile/  pnpm --filter @carlife/mobile  exec vite build
RUN VITE_BASE=/cockpit/ pnpm --filter @carlife/cockpit exec vite build

FROM nginx:1.27-alpine
# envsubst 来自 gettext；alpine 的 nginx 镜像没带
RUN apk add --no-cache gettext

COPY --from=build /app/clients/demo-web/dist /usr/share/nginx/html
COPY --from=build /app/clients/mobile/dist-web  /usr/share/nginx/html/mobile
COPY --from=build /app/clients/cockpit/dist-web /usr/share/nginx/html/cockpit

# 构建指纹。用途很实际：平台的状态接口在滚动更新时**一直是 Running**，
# 判断不了"我推的这版到底生效了没"——两次排查都卡在这上面，各多花一轮。
# 这个时间戳会出现在界面角落与 /__whoami 里，一张截图就能认出是哪一版。
# 放在 COPY dist 之后：dist 每次构建都变，这一层不会被缓存复用。
RUN date -u +%Y%m%d-%H%M > /usr/share/nginx/html/build-id.txt
COPY infra/modelscope/nginx.conf.template /etc/nginx/templates/site.conf.template
COPY infra/modelscope/proxy-common.conf.template /etc/nginx/templates/proxy-common.conf.template
COPY infra/modelscope/http-context.conf.template /etc/nginx/templates/http-context.conf.template
COPY infra/modelscope/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 平台规定的对外端口，不可改
EXPOSE 7860
ENTRYPOINT ["/entrypoint.sh"]
