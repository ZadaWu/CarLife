#!/usr/bin/env bash
# infra/docker/envs/prod/hooks.sh —— prod 环境专属的钩子与覆盖（可选；common.sh 在加载 .env 之后 source 它）。
# 能定义：pre_apply / post_apply / pre_rollback / post_rollback；也可以重定义适配器里的任何函数（比如 prod 的 svc_up 先拉镜像再 up）。
# 这是"环境有独立脚本"的落点——与其把 prod 专属逻辑 if-else 进每份 sprint 脚本，不如放这里。

# pre_apply()  { info "prod：apply 之前…"; }
# post_apply() { info "prod：apply 之后…"; }
