# 排障

本文按现象列出常见问题的原因与处理办法。每一条先说现象，再说原因，最后给命令。

## 安装与构建

**`corepack pnpm build` 整条链一个包都没编，报 `Unable to find package manager binary`。**
turbo 要按名字在 PATH 上找 pnpm，而本仓的 pnpm 只经 corepack 提供。根 `package.json` 的 `turbo` 脚本会把 `scripts/dev/bin/pnpm` 垫片前置进 PATH。始终通过根脚本调用 turbo，不要直接运行 `turbo run ...`。

**cargo 构建在某个依赖的 build script 里报 `Failed to execute meson. Do you have it installed?`。**
`carlife-media` 依赖的 `webrtc-audio-processing` 从 C++ 源码编译。安装 meson 与 ninja：

```bash
brew install meson ninja
```

**`check:node` 拒绝启动。**
Node 版本与根 `.nvmrc` 不一致。按输出里给出的命令切换版本，然后：

```bash
corepack enable
corepack pnpm check:node
```

**改了前端，`vite build` 也跑了，release 客户端里还是上一版界面。**
Tauri 的构建脚本不把前端产物声明为重编触发条件。两个 `src-tauri/build.rs` 已各补一行 `cargo:rerun-if-changed=../dist`；新建端时照抄。

## 启动

**端口有人应答，状态表显示正常，屏幕上什么都没有。**
只启动了 `cockpit`（Vite dev server），没启动 `cockpit-app`（客户端窗口）。两者都要在，且 Vite 先就绪：

```bash
corepack pnpm dev:restart cockpit cockpit-app
```

**改了代码不生效，端口照常应答。**
`dev:status` 里标为「监护层已死」的进程：终端关闭后中间的 watch 层被回收，最里层的进程被系统收养继续服务。重启该目标：

```bash
corepack pnpm dev:restart runtime
```

**助手回复「门店系统没连上」。**
`mock-dealer` 未启动，或 `.env` 里 `MOCK_DEALER_URL` 缺失。两者现象一样。查看状态并重启：

```bash
corepack pnpm dev:status
corepack pnpm dev:restart mock-dealer runtime
```

**`mock-cabin` 在容器里放不出声。**
预期行为。车内音乐的出声位在车机端，服务端只保留状态机，容器里的 `/health` 报 `backend:"none"` 是正常的。

**macOS 上 `dev:upgrade` 报 Docker 未就绪。**
命令会尝试自动启动 Docker Desktop 并等待约 60 秒。仍未就绪时手动启动 Docker Desktop 后重试。

## 测试

**测试拒绝运行，提示库名不合法。**
测试库名必须以 `_test` 结尾。首次运行前建库：

```bash
corepack pnpm db:test:setup
```

**`prisma migrate dev` 要求 reset 或 `--accept-data-loss`。**
LangGraph 的 `checkpoint*` 表与 Mem0 的 `carlife_memories`、`memory_migrations` 不在本仓 schema 里，prisma 把它们判成漂移。改 schema 一律用：

```bash
corepack pnpm --filter @carlife/db db:migrate:safe <name>
```

**模型手里零工具，却编出像样的答案。**
pi 在项目未被信任时静默忽略 `.pi/extensions/`。运行时启动自检会输出 `ACP 自检通过：扩展已加载`；没有这一行时，用 `enterprise/backend/pi-agents/bin/pi-approved.sh` 重新授权。

## 知识库

**文档 0 篇、检索零命中，上传没有报错。**
两种原因：数据集的切分方法设成了 `table`（PDF 要用 `manual`），或 embedding 模型所在账号欠费。二者都在 RAGFlow 侧设置。检查：

```bash
corepack pnpm probe:ragflow
```

**同一份文档检索命中两次，出处几乎一样。**
重传同名文档时 RAGFlow 把新文件改名为 `xxx(1).md`，旧文件继续占用正名。用 `kb:replace` 重传，它先删后传。

**三栏手册检索命中，拼起来讲的不是一件事。**
直接上传的 PDF 被逐行横向串读。先用 `kb:convert` 转成 markdown 再上传。

## 内容审核

**某个维度的开关打开了，检测仍然不生效。**
运营策略的开关只能关、不能开。维度是否参与检测由阿里云控制台决定。查看该账号实际开启的维度：

```bash
corepack pnpm probe:aliyun-guard
```

## 部署

**镜像层全部推完，最后一步报 `denied: unknown manifest class`。**
buildx 默认附加的 provenance 清单使用 OCI 媒体类型，部分个人版镜像仓库不认。推送时加 `--provenance=false --sbom=false --output oci-mediatypes=false`。

**`down -v` 之后数据全没了。**
`down -v` 删除命名卷。日常停止用 `infra/scripts/down.sh`，它保留数据卷。
