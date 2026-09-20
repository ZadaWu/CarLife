#!/usr/bin/env bash
# deploy-script: docker/M109-02-mount-icon-images
# title: ECS 上补齐手册图标：图片挂进 runtime、向量索引建进库
# title-en: Mount manual icon images into runtime and build the icon index on ECS
# sprint: M109
# infra: docker
# services: agent-runtime
# envs: test
# destructive: no
# status: applied
# workorder: -
#
# 这份脚本做什么（两三句，说清这个 Sprint 对部署做了什么改动、为什么）：
#   线上拍照问诊的每一条匹配都带着「未能与手册完全对上」（2026-09-20 实测）。缺的是**两样**，
#   缺任何一样现象都一模一样、且全程零报错：
#     ① 图标图片：镜像的 src 阶段只 COPY contracts/ 与 enterprise/，data/ 从来不在里面
#        （`icon-images.ts` 文件头写着这件事），取不到图就跳过成对核验、结果标 verified:false；
#     ② 向量索引：ECS 的 icon_embeddings 是 0 行（本机 54 行），召回那一步根本没有候选。
#   本脚本把 1.8 MB 的 data/kb-src/icons 同步上去（compose 已加只读挂载），再经 SSH 隧道
#   把索引建进 ECS 的库——索引用的是 kb:icons 本身，不是从本机搬行，所以 schema 对不上会当场暴露。
#
#   **为什么不整仓 rsync**：data/ 整个目录在本机 120 MB（备份 86M + 手册图 32M），
#   M56-01 刻意排除了它；这里只送 icons 这一个子目录。
#
# 用法：bash infra/docker/sprints/M109-02-mount-icon-images.sh <plan|apply|verify|rollback> test [--confirm]
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
  declare -F remote >/dev/null || die "envs/$DEPLOY_ENV/hooks.sh 未定义 remote()"
}

ICONS_REL=data/kb-src/icons
CATALOG_MD="$ICONS_REL/tesla-model3-indicators.md"
# ECS 的 Postgres 只映射在宿主 55433（安全组挡着公网，实测 TCP 半开但握不了手）。
# 建索引的脚本跑在本机（它要 DASHSCOPE_API_KEY 与 node_modules，服务器上都没有），
# 所以开一条 SSH 隧道把库借过来。端口用 15433，避开本机开发库的 55433。
TUNNEL_PORT="${DEPLOY_DB_TUNNEL_PORT:-15433}"
ECS_DB_PORT="${DEPLOY_DB_HOST_PORT:-55433}"
ECS_DB_URL="postgresql://carlife:carlife@127.0.0.1:${TUNNEL_PORT}/carlife"

icon_rows_remote() {
  remote "docker exec carlife-postgres psql -U carlife -d carlife -t -A -c 'select count(*) from icon_embeddings'" 2>/dev/null | tr -d '[:space:]'
}

tunnel_up()   { pkill -f "${TUNNEL_PORT}:127.0.0.1:${ECS_DB_PORT}" 2>/dev/null || true
                ssh -o BatchMode=yes -f -N -L "${TUNNEL_PORT}:127.0.0.1:${ECS_DB_PORT}" "$DEPLOY_SSH" || die "SSH 隧道起不来"
                sleep 2; }
tunnel_down() { pkill -f "${TUNNEL_PORT}:127.0.0.1:${ECS_DB_PORT}" 2>/dev/null || true; }

# ---------- plan ----------

plan() {
  require_remote_vars
  info "目标：$DEPLOY_SSH:${DEPLOY_APP_DIR}（env=${DEPLOY_ENV}）"
  remote 'echo ok' >/dev/null 2>&1 || die "SSH 不可达"
  local n; n="$(find "$REPO_ROOT/$ICONS_REL" -type f | wc -l | tr -d ' ')"
  info "本机图标：$n 个文件 / $(du -sh "$REPO_ROOT/$ICONS_REL" | cut -f1)（含 $(find "$REPO_ROOT/$ICONS_REL" -name '*.png' | wc -l | tr -d ' ') 张 png）"
  if remote "test -d '$DEPLOY_APP_DIR/$ICONS_REL'"; then
    info "远端图标目录：已存在 → 覆盖同步"
  else
    info "远端图标目录：不存在 → 创建"
  fi
  svc_exists agent-runtime || die "agent-runtime 不存在——先跑 docker/M56-01"
  info "agent-runtime：**只重建容器**（--no-build，镜像不动），为的是吃到 compose 新加的只读挂载"
  info "  当前 CARLIFE_ICON_IMAGES_ROOT：$(remote_compose exec -T agent-runtime printenv CARLIFE_ICON_IMAGES_ROOT 2>/dev/null || echo '(未设置，走代码反推)')"
  info "  当前启动日志那一行：$(remote "docker logs carlife-agent-runtime-1 2>&1 | grep -o '图标图片 [^；]*' | tail -1" 2>/dev/null || echo '(读不到)')"
  warn "  重建期间（约 20~40 s）正在进行的对话轮会断；网关与其它服务不动"
  info "远端索引现有 $(icon_rows_remote) 行；本机 $(find "$REPO_ROOT/$ICONS_REL" -name '*.png' | wc -l | tr -d ' ') 张图，建完应当是同一量级（文本向量 + 图像向量各一条）"
  [[ -n "${DASHSCOPE_API_KEY:-}" ]] || warn "DASHSCOPE_API_KEY 为空——建索引这一步会失败（先 set -a; source .env; set +a）"
  info "步骤：①rsync 图标 ②重建 agent-runtime 容器 ③SSH 隧道 + kb:icons 建索引 ④verify"
}

# ---------- apply ----------

apply() {
  require_remote_vars
  [[ -f "$REPO_ROOT/$CATALOG_MD" ]] || die "本机缺 $CATALOG_MD"
  [[ -n "${DASHSCOPE_API_KEY:-}" ]] || die "DASHSCOPE_API_KEY 为空——建索引要它（set -a; source .env; set +a）"

  info "① rsync 图标目录 + 栈定义（挂载写在 compose 里，不送它的话远端重建出来的还是旧定义）"
  remote "mkdir -p '$DEPLOY_APP_DIR/data/kb-src'"
  # cd 到仓库根传相对路径：macOS 自带 openrsync 不认 "/./" 锚点（M109-01 的教训）
  ( cd "$REPO_ROOT" && rsync -azR --delete -e "ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-%r@%h:%p -o ControlPersist=120s" \
    "$ICONS_REL/" "$DEPLOY_SSH:$DEPLOY_APP_DIR/" )
  ( cd "$REPO_ROOT" && rsync -azR -e "ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-%r@%h:%p -o ControlPersist=120s" \
    infra/docker-compose.stack.yml "$DEPLOY_SSH:$DEPLOY_APP_DIR/" )
  # 同步完当场核对落点与内容，不等下一步来报
  remote "test -f '$DEPLOY_APP_DIR/$CATALOG_MD' && test -d '$DEPLOY_APP_DIR/$ICONS_REL/tesla-model3'" ||
    die "rsync 报成功但文件不在预期位置——未重建容器，线上保持原状"
  remote "grep -q 'kb-src/icons:/app/data/kb-src/icons:ro' '$DEPLOY_APP_DIR/infra/docker-compose.stack.yml'" ||
    die "远端 compose 里没有图标挂载——重建容器也不会生效，先看同步是不是被别的改动盖了"
  ok "图标已同步（$(remote "ls '$DEPLOY_APP_DIR/$ICONS_REL/tesla-model3' | wc -l" | tr -d '[:space:]') 个文件），栈定义含挂载"

  info "② 重建 agent-runtime 的容器（挂载变更必须重建，--no-build --no-deps）"
  remote_compose "up -d --no-build --no-deps agent-runtime"

  info "③ 建图标向量索引（SSH 隧道借 ECS 的库，脚本与 DASHSCOPE_API_KEY 在本机）"
  tunnel_up
  # --rebuild：幂等，先删该车型旧行再写。重跑这份脚本不会堆出重复行。
  ( cd "$REPO_ROOT" && DATABASE_URL="$ECS_DB_URL" corepack pnpm kb:icons "$CATALOG_MD" --rebuild ) || { tunnel_down; die "建索引失败——图片已同步、容器已重建，但匹配仍只会说「疑似」"; }
  tunnel_down
}

# ---------- verify ----------

verify() {
  require_remote_vars
  declare -F svc_cache_reset >/dev/null && svc_cache_reset
  svc_running agent-runtime || die "agent-runtime 没在跑"

  # 三条判据缺一不可，因为缺任何一样，现象都是同一句「疑似」：
  # 容器里看得见图 → 索引有行 → runtime 自己报"图标图片 N 个车型"（它是 createIconImageResolver 真扫出来的结果）
  # 数图片用 find 不用 `ls *.png`，且**只经一层 ssh、不套 sh -c**：
  # 先前写成 `remote_compose exec -T … sh -c "ls …/*.png | wc -l"`，引号穿过 ssh → docker compose → sh
  # 三层之后 glob 就散了，数出个 8（实际 27），把一次成功的 apply 判成失败（2026-09-20 实测）。
  local n
  n="$(remote "docker exec carlife-agent-runtime-1 find /app/data/kb-src/icons/tesla-model3 -name '*.png' | wc -l" | tr -d '[:space:]')"
  [[ "${n:-0}" -ge 20 ]] || die "容器里看不到图标图片（数到 ${n:-0} 张）——挂载没生效"
  ok "容器内可见 $n 张图标"

  n="$(icon_rows_remote)"
  [[ "${n:-0}" -ge 40 ]] || die "远端索引只有 ${n:-0} 行——召回没有候选，匹配仍会说「疑似」"
  ok "索引 $n 行"

  local line
  line="$(remote "docker logs carlife-agent-runtime-1 2>&1 | grep -o '图标图片 [^；]*' | tail -1" | tr -d '\r')"
  [[ -n "$line" ]] || die "runtime 启动日志里没有观察层那一行"
  case "$line" in
    *无*) die "runtime 仍报「$line」——它扫不到图，检查 CARLIFE_ICON_IMAGES_ROOT 与挂载点是否同一个路径" ;;
    *)    ok "runtime 自报：$line" ;;
  esac
  info "成对核验从此可能发生；是否真的「已对上手册」还要看具体照片，跑一轮真图确认"
}

# ---------- rollback ----------

# 退回"只能说疑似"的状态：撤掉挂载要改 compose（代码侧 revert），这里只清索引行。
# 不删远端图片目录——1.8 MB，留着无害，下次 apply 还要用。
rollback() {
  require_remote_vars
  destructive "清空 ECS 上 icon_embeddings 表里 Tesla Model 3/Y 的 $(icon_rows_remote) 行索引（图片目录保留）" -- \
    remote "docker exec carlife-postgres psql -U carlife -d carlife -c \"delete from icon_embeddings where vehicle_model = 'Tesla Model 3/Y'\""
  warn "挂载本身要靠 revert compose 的改动 + 重建容器才能撤掉；只清索引的话，匹配会退回「疑似」"
}

main "$@"
