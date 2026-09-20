#!/usr/bin/env bash
# deploy-script: docker/M109-01-vision-infer-service
# title: ECS 上拉起只推理的 YOLO 服务 vision-infer，runtime 改指向它
# title-en: Bring up vision-infer on ECS and point runtime at it
# sprint: M109
# infra: docker
# services: vision-infer, agent-runtime
# envs: test
# destructive: no
# status: applied
# workorder: -
#
# 这份脚本做什么（两三句，说清这个 Sprint 对部署做了什么改动、为什么）：
#   ACR-050：线上配了 CARLIFE_VISION_DETECT_PROVIDER=yolo 却没有 YOLO 服务——runtime 容器里的
#   VISION_TRAINER_URL=http://localhost:8799 指向容器自己，每张不带端上框的照片 ECONNREFUSED、
#   观察层整图降级，全程零报错。本脚本在 ECS 上构建并拉起只推理的 `vision-infer`
#   （onnxruntime + 与端上同一份 ONNX），再**重建 agent-runtime 的容器**（不重建镜像）让它吃到
#   compose 里新的 VISION_TRAINER_URL=http://vision-infer:8799。
#
#   **只同步这一件事需要的文件，不整仓 rsync**：M56-01 同步的是整个工作树，多会话并发时会把别人的
#   半成品一起带上线。这里只送 vision-infer 自己、它的 Dockerfile、栈定义与端上那份模型。
#   代码侧的"检测抛错也走兜底"（observe.ts）不在这份脚本里——它随下一次 M56-01 的整栈重建上线。
#
# 用法：bash infra/docker/sprints/M109-01-vision-infer-service.sh <plan|apply|verify|rollback> test [--confirm]
#   plan     只预检 + 打印计划，什么都不改
#   apply    预检 → （prod 要确认）→ apply → verify → 记运行台账
#   verify   只跑验证
#   rollback 预检 → 确认 → rollback → 记运行台账
# 头部 `# key: value` 是唯一真相源：services 决定预检核对哪些服务；envs 决定允许跑哪些环境；destructive 是否含删除动作。
# 删除 / 不可逆动作一律写成 `destructive "<说明>" -- <命令…>`，没有人点头它不会执行。环境差异放 envs/<env>/，正文不写死环境。

# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")/../../lib" && pwd)/common.sh"

require_remote_vars() {
  [[ -n "${DEPLOY_SSH:-}" && -n "${DEPLOY_APP_DIR:-}" ]] ||
    die "envs/$DEPLOY_ENV/.env 缺 DEPLOY_SSH / DEPLOY_APP_DIR"
  declare -F remote >/dev/null || die "envs/$DEPLOY_ENV/hooks.sh 未定义 remote()——这个环境不是远端 SSH 形态？"
}

# 国内 ECS 直连 PyPI 与直连 GitHub 一样慢；换源不丢完整性——requirements.lock.txt 带内容哈希。
# 要换别的源，在 envs/<env>/.env 里设 DEPLOY_PIP_INDEX_URL。
PIP_INDEX="${DEPLOY_PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"

# 只送这几样（相对仓库根）。目录以 / 结尾。
SYNC_PATHS=(
  enterprise/backend/vision-infer/
  clients/shared/rust/carlife-vision/models/
  clients/shared/rust/carlife-vision/tests/fixtures/
  infra/images/Dockerfile.vision-infer
  infra/docker-compose.stack.yml
)
FIXTURE=clients/shared/rust/carlife-vision/tests/fixtures/store-03-parked.jpg

# ---------- plan ----------

plan() {
  require_remote_vars
  info "目标：$DEPLOY_SSH:${DEPLOY_APP_DIR}（env=${DEPLOY_ENV}）"
  remote 'echo ok' >/dev/null 2>&1 || die "SSH 不可达"
  info "远端内存：$(remote "free -m | awk 'NR==2{print \$7\" MB 可用 / \"\$2\" MB\"}'")（vision-infer 常驻约 200 MB，上限 1g）"
  info "远端磁盘：$(remote 'df -h / | tail -1 | awk "{print \$4\" 可用\"}"')（镜像约 300~400 MB）"
  if svc_exists vision-infer; then info "vision-infer：已存在 → 重新构建镜像并按新镜像更新"; else info "vision-infer：不存在 → 构建镜像并创建"; fi
  if svc_exists agent-runtime; then
    info "agent-runtime：已存在 → **只重建容器**（--no-build，镜像不动），为的是吃到 VISION_TRAINER_URL=http://vision-infer:8799"
    info "  当前值：$(remote_compose exec -T agent-runtime printenv VISION_TRAINER_URL 2>/dev/null || echo '(读不到)')"
    warn "  重建期间（约 20~40 s）正在进行的对话轮会断；网关与其它服务不动"
  else
    die "agent-runtime 不存在——这份脚本不负责首次拉栈，先跑 docker/M56-01"
  fi
  info "同步的文件（rsync，不带 --delete）：${SYNC_PATHS[*]}"
  info "步骤：①rsync ②远端 build vision-infer（pip 源 $PIP_INDEX；失败即止，ADR-005）③up vision-infer 并等 healthy ④重建 agent-runtime 容器 ⑤verify"
}

# ---------- apply ----------

apply() {
  require_remote_vars

  info "① rsync（只送 vision-infer 需要的文件）"
  local p
  for p in "${SYNC_PATHS[@]}"; do [[ -e "$REPO_ROOT/$p" ]] || die "本机缺 $p"; done
  # -R：按相对路径在远端重建目录层级。**必须 cd 到仓库根、传相对路径**——不要用 rsync 的 "/./" 锚点：
  # macOS 自带的是 openrsync（protocol 29），不认那个锚点，会把文件按本机绝对路径建到
  # $DEPLOY_APP_DIR/Users/<我>/…（2026-09-20 首次 apply 就这么落空的：rsync 报成功，
  # 下一步 compose 才说 no such service）。所以同步完当场核对落点，不等下一步来报。
  ( cd "$REPO_ROOT" && rsync -azR -e "ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-%r@%h:%p -o ControlPersist=120s" \
    --exclude '.venv' --exclude '__pycache__' --exclude '.pytest_cache' \
    "${SYNC_PATHS[@]}" "$DEPLOY_SSH:$DEPLOY_APP_DIR/" )
  remote "grep -q '^  vision-infer:' '$DEPLOY_APP_DIR/infra/docker-compose.stack.yml' && test -f '$DEPLOY_APP_DIR/enterprise/backend/vision-infer/serve.py' && test -f '$DEPLOY_APP_DIR/infra/images/Dockerfile.vision-infer'" ||
    die "rsync 报成功但文件不在预期位置（$DEPLOY_APP_DIR 下）——未构建、未启动，线上保持原状"
  ok "已同步，落点已核对"

  # ADR-005：构建与启动分成有序的门。构建失败在这里就退出，后面的 up 一律 --no-build——
  # 绝不让 compose 拿一份旧缓存镜像"成功"启动。
  info "② 远端构建 vision-infer 镜像"
  # 不经 remote_compose：要给这一次构建注入 PIP_INDEX_URL（shell 环境优先于 --env-file），而那个函数只拼 compose 参数。
  # 只带栈定义这一份文件就够——vision-infer 定义在它里面，项目名也由它的 `name: carlife` 决定。
  remote "cd '$DEPLOY_APP_DIR' && PIP_INDEX_URL='$PIP_INDEX' docker compose --env-file .env -f infra/docker-compose.stack.yml build vision-infer" ||
    die "镜像构建失败——未启动任何东西，线上保持原状"
  ok "镜像已构建"

  info "③ 启动 vision-infer（--no-build），等 healthy"
  remote_compose "up -d --no-build --no-deps vision-infer"
  local i=0
  until [[ "$(remote "docker inspect -f '{{.State.Health.Status}}' carlife-vision-infer 2>/dev/null")" == "healthy" ]]; do
    i=$((i+1)); [[ $i -lt 24 ]] || die "vision-infer 120 s 内没有 healthy（docker logs carlife-vision-infer）——agent-runtime 未动，线上保持原状"
    sleep 5
  done
  ok "vision-infer healthy"

  info "④ 重建 agent-runtime 的容器（--no-build --no-deps：镜像不动、不牵连 mock 与 postgres）"
  remote_compose "up -d --no-build --no-deps agent-runtime"
}

# ---------- verify ----------

verify() {
  require_remote_vars
  declare -F svc_cache_reset >/dev/null && svc_cache_reset
  local s
  for s in "${SERVICES[@]}"; do svc_running "$s" || die "$s 没在跑"; done
  ok "vision-infer 与 agent-runtime 都在跑"

  # "起来了"不等于"能用"。要证的是 runtime **自己的环境变量**指向的那个地址上，
  # 是 vision-infer、跑的是配置里写的那个模型、并且一张真图出得了框——
  # 所以请求从 agent-runtime 容器里发，地址与模型号都读它的 env，不在这里另写一份。
  info "从 agent-runtime 容器内，按它自己的 VISION_TRAINER_URL / CARLIFE_VISION_YOLO_MODEL 打一张真图"
  local i=0
  until remote_compose "exec -T agent-runtime node -e \"fetch(process.env.VISION_TRAINER_URL+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" 2>/dev/null; do
    i=$((i+1)); [[ $i -lt 12 ]] || die "60 s 内从 agent-runtime 打不通 \$VISION_TRAINER_URL/health"
    sleep 5
  done
  remote "APP='$DEPLOY_APP_DIR' FIXTURE='$FIXTURE' bash -s" <<'EOF'
set -euo pipefail
cd "$APP"
cid="$(docker compose --env-file .env -f infra/docker-compose.stack.yml ps -q agent-runtime)"
[[ -n "$cid" ]] || { echo "  ✗ 找不到 agent-runtime 容器"; exit 1; }
docker cp "$APP/$FIXTURE" "$cid:/tmp/vision-infer-verify.jpg"
docker exec -i "$cid" node --input-type=module - <<'JS'
import { readFileSync } from "node:fs";
const base = (process.env.VISION_TRAINER_URL ?? "").replace(/\/$/, "");
const model = (process.env.CARLIFE_VISION_YOLO_MODEL ?? "").trim();
const fail = (m) => { console.error("  ✗ " + m); process.exit(1); };
if (!/vision-infer/.test(base)) fail(`VISION_TRAINER_URL=${base || "(空)"}——容器没吃到新配置`);
if (!model) fail("CARLIFE_VISION_YOLO_MODEL 为空——检测那一遍不会选 yolo");
const health = await (await fetch(base + "/health")).json();
if (health.service !== "vision-infer") fail("应答的不是 vision-infer：" + JSON.stringify(health));
if (health.model !== model) fail(`模型号不一致：runtime 配的是 ${model}，服务跑的是 ${health.model}——每次检测都会 404`);
const t0 = Date.now();
const res = await fetch(`${base}/predict?model=${encodeURIComponent(model)}&conf=0.3&imgsz=960`, {
  method: "POST", headers: { "content-type": "image/jpeg" }, body: readFileSync("/tmp/vision-infer-verify.jpg"),
});
const body = await res.json();
if (!res.ok) fail(`/predict HTTP ${res.status}: ${JSON.stringify(body)}`);
const names = body.detections.map((d) => `${d.name} ${Math.round(d.conf * 100)}%`);
// 这张夹具上端上与 ultralytics 都稳出这两盏；少了就是前后处理或模型不对
for (const want of ["parking_lights", "parking_brake_on"]) if (!body.detections.some((d) => d.name === want)) fail(`没框到 ${want}：${names.join("、") || "零框"}`);
console.log(`  ✓ ${health.service} / ${health.model}：${names.join("、")}（往返 ${Date.now() - t0} ms，推理 ${body.ms} ms）`);
JS
EOF
  info "常驻内存：$(remote "docker stats --no-stream --format '{{.MemUsage}}' carlife-vision-infer")"
}

# ---------- rollback ----------

# 退回"云端定位"（ACR-045 留的显式选项，DASHSCOPE_API_KEY 已配），再停掉 vision-infer。
# 不删容器、不删镜像：stop 可逆，再 apply 一次就回来。
rollback() {
  require_remote_vars
  info "① 远端 .env：CARLIFE_VISION_DETECT_PROVIDER → dashscope（原值留备份）"
  remote "APP='$DEPLOY_APP_DIR' bash -s" <<'EOF'
set -euo pipefail
cd "$APP"
cp .env ".env.bak.vision-infer.$(date +%s)"
if grep -q '^CARLIFE_VISION_DETECT_PROVIDER=' .env; then
  sed -i 's/^CARLIFE_VISION_DETECT_PROVIDER=.*/CARLIFE_VISION_DETECT_PROVIDER=dashscope/' .env
else
  echo 'CARLIFE_VISION_DETECT_PROVIDER=dashscope' >> .env
fi
EOF
  info "② 重建 agent-runtime 的容器让它读到新值"
  remote_compose "up -d --no-build --no-deps agent-runtime"
  info "③ 停 vision-infer"
  remote_compose "stop vision-infer"
  warn "再次 apply 之前，把远端 .env 的 CARLIFE_VISION_DETECT_PROVIDER 改回 yolo（本机 .env 里它就是 yolo，M56-01 整栈部署会覆盖回去）"
}

main "$@"
