# pi-research：用研面的 pi 项目目录

pi 按 ACP `session/new` 的 `cwd` 发现**项目级**配置与扩展。用研面把 `cwd` 指到本目录，
于是模型看到的是这里的 `.pi/settings.json` 与 `.pi/extensions/research-tools.ts`，
而不是车主面 `pi-agents/` 的那一份——隔离落在该落的那一层（ACR-038 步 3 / 施工单 M88-03）。

## 目录里只有七个文件

```
.pi/settings.json               用研面的 pi 项目设置
.pi/extensions/research-tools.ts 薄代理：取工具表 + 把 execute 转发回 research-runtime
prompts/analyst.md              分析员（Research Lead）的系统提示词
prompts/archivist.md            档案员（Data Steward）的系统提示词
prompts/challenger.md           Challenger 的系统提示词（直连与 ACP 两条路径共读这一份）
prompts/taxonomist.md           码表管理员（Taxonomy Owner）的系统提示词
README.md                       本文
```

四份提示词与 `RESEARCH_AGENTS` 一一对应：少一份，那个 Agent 的 `loadResearchPrompt`
当场抛错，外部症状只是"分支失败"。

**没有 `package.json`、没有 `node_modules/`、没有 `.pi/agent/`**，三样都借 `pi-agents/`：

| 借什么 | 实际位置 | 谁指过去 |
|---|---|---|
| pi / pi-acp 二进制与启动包装 `bin/pi-approved.sh` | `enterprise/backend/pi-agents/` | 底座的 `AcpApp.binDir`（缺省等于 `piDir`，用研面显式指向 pi-agents） |
| 模型覆盖 `.pi/agent/models.json`（`deepseek-flash` 的正式名） | 同上 | `pi-approved.sh` 的 `PI_CODING_AGENT_DIR` 按**脚本自身位置**推，借用时自然落到那里 |
| 凭据 `.pi/agent/auth.json`（gitignored） | 同上 | 同上 |

一份安装、一份 `models.json`、一份凭据：两份 devDependencies 人肉同步，漂一次就是
"一个底座面对两个协议版本"；`models.json` 复制一份，改一处忘一处时 pi **起不来**。

**不要给本目录加 `package.json`**：加了 pnpm 会把它当 workspace 成员，turbo 会去跑它的脚本，
而这里没有任何可构建、可测试的东西。

## `settings.json` 的两个值不是随手写的

- `defaultModel` 必须与 `pi-agents/.pi/settings.json` **相同**（`deepseek-flash`）：
  `models.json` 是借来的那份，只有它认识的 id 才起得来。
  `research-runtime/test/pi-research-dir.test.ts` 机械守这条。
- `defaultThinkingLevel: "off"` 只是兜底。真正生效的是 `CARLIFE_PI_MODEL` 拼出的
  `<provider>/<model>:<level>`，由应用描述符按会话给（M88-04）。

## 排障：会话 jsonl 落在哪

pi 的会话记录不在本目录，而在借来的 agent 目录下，按 **cwd** 分子目录：

```
enterprise/backend/pi-agents/.pi/agent/sessions/<把 cwd 绝对路径的分隔符换成 - 的目录名>/
```

用研面的那一份以 `-enterprise-backend-pi-research--` 结尾，车主面的以 `-pi-agents--` 结尾，
两者可分。（M88-05 联调实测：`…-CarLife_AI_Agent-enterprise-backend-pi-research--/`，与推断一致；该目录已 gitignore。）

扩展有没有被加载，**看 research-runtime 的 `/health.acp`**：`describeCalls ≥ 1` 且
`GET /internal/research/tools/describe?agent=<名>` 回该 Agent 的 ACL 条数——
analyst 4、challenger 4、taxonomist 3、archivist 3。扩展加载后做的第一件事就是拉工具表，
这两个数在本进程里数得到。扩展自己在 stderr 打的那行注册回执

```
[research-tools] agent=challenger 注册 4 个工具: findCounterEvidence,listSystemEvents,sliceBySegment,thresholdSensitivity
```

**到不了 research-runtime 的日志**——`pi-acp@0.0.33` 对 pi 子进程的 stderr 是 `child.stderr.on("data", () => {})`，
整条丢弃（`dist/index.js:173`；tech-debt TD-35）。grep 不到它不是扩展没加载。
`describeCalls = 0` 才是扩展没加载（pi 在项目未被信任时**静默忽略** `.pi/extensions/`），
症状是模型手里零工具却照样编出像样的答案——起进程的那条链路必须经 `bin/pi-approved.sh`（`pi --approve`）。

## P3 加一个研究 Agent：三步

1. `prompts/<agent>.md` 加一份提示词（`promptFor` 读它，读不到就抛）；
2. `@carlife/research-tools` 的 `ResearchAgentName` 加这个名字；
3. 它该拿到的每个工具，`agents` 数组里加上它（ACL 的唯一真相源是 `listForAgent`）。

别处不用改：扩展按 `CARLIFE_PI_AGENT` 取表，端点按同一份 ACL 裁剪。
