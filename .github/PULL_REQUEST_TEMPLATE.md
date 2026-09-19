<!--
  先读 CONTRIBUTING.md 的「这是一份镜像」：本仓库的内容由上游按导出契约整棵替换，
  合并后维护者会把同一处改动应用到上游，再由下一次同步带回来。
-->

## 改了什么

<!-- 一两句说清「改了什么、为什么」。关联 Issue 写 Closes #<编号>。 -->

## 类型

- [ ] `fix` 修缺陷
- [ ] `feat` 新功能
- [ ] `perf` 性能
- [ ] `docs` 文档
- [ ] `chore` 构建 / 依赖 / 工具链

## 验证

<!--
  贴你实际跑过的命令与结果，不要写「应该没问题」。
  真连库的测试要先起容器：corepack pnpm dev:infra-up && corepack pnpm db:test:setup
-->

```
corepack pnpm typecheck
corepack pnpm check:all
```

结果：

- [ ] 影响到界面时附了截图或录屏

## 契约与迁移

改到下面这些地方时勾上对应项；它们是「一侧声明、另一侧使用」的连接点，改一侧不改
另一侧通常不报错（详见 CONTRIBUTING.md 的「哪些目录是契约」）。

- [ ] 改了 `contracts/`：`corepack pnpm test:contract` 通过，绑定已重新生成
- [ ] 改了配置项：`.env.example` 与配置注册表同步，`corepack pnpm check:env-example` 通过
- [ ] 改了数据库 schema：迁移由 `db:migrate:safe` 生成并一起提交
- [ ] 加了端侧 Tauri 命令：端上有真实调用方，`corepack pnpm check:orphan-commands` 通过
- [ ] 加了第三方依赖：说明了用途与许可证，`THIRD-PARTY.md` 已更新
- [ ] 以上都不涉及

## 提交前确认

- [ ] 没有提交 `.env`、密钥或真实个人信息（测试夹具一律用假值）
- [ ] 提交信息用了 `<type>(<范围>): <描述>` 的形式
- [ ] 贡献以 MIT 许可发布
