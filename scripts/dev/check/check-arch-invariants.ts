/**
 * 架构不变量的自动化守护（施工单 M4-05）。
 *
 * 这里守的规则有一个共同点：**违反不会报错、不会变慢、不会有任何症状**，
 * 只会在半年后的某次重构里被人发现"原来这个能力早就没了"。
 * 因此取舍与 `check-secrets.ts` 相反——这里**零假阴性优先于零假阳性**：
 * 宁可偶尔误报让人来看一眼，也不能漏掉真的违规（漏报等于没做）。
 *
 * 运行：
 *   corepack pnpm check:arch          # 全部
 *   corepack pnpm check:arch -- boundary   # 只跑一条（调试用）
 *
 * 每条失败信息都要写清**违反的是哪条架构规则与出处章节**，
 * 否则下一个人会以为是误报，直接加豁免。
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

interface Violation {
  file: string;
  line?: number;
  detail: string;
}
interface Check {
  id: string;
  title: string;
  /** 违反了架构文档的哪一条——失败信息里必须出现。 */
  rule: string;
  run(): Violation[];
}

// ── 文件遍历 ───────────────────────────────────────────────

const SKIP_DIR = new Set(["node_modules", "dist", "target", ".git", ".turbo", "bindings", "generated"]);

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

const ts = (dir: string) => walk(join(ROOT, dir), /\.tsx?$/);
const read = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => relative(ROOT, p);

/** 抓 import / export-from / 动态 import 的模块说明符。 */
function imports(src: string): Array<{ spec: string; line: number }> {
  const out: Array<{ spec: string; line: number }> = [];
  src.split("\n").forEach((text, i) => {
    const re = /(?:from\s+|import\s*\(\s*|require\(\s*)["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ spec: m[1], line: i + 1 });
  });
  return out;
}

// ── 各条检查 ───────────────────────────────────────────────

/** pi / ACP SDK 的模块前缀——`graph/` 下一个都不许出现。 */
const PI_ACP_SPECS = [/^@agentclientprotocol\//, /^pi-acp/, /^@earendil-works\//, /^@zed-industries\/agent-client-protocol/];

const checks: Check[] = [
  {
    id: "boundary",
    title: "编排层不 import pi/ACP SDK；SDK 类型不泄漏出 acp-client/",
    rule: "§0 已澄清 2：LangGraph 只说 ACP，不在进程内 import pi 的 SDK（F-12-10 / AC-12-2）",
    run() {
      const v: Violation[] = [];
      // ① graph/ 下不得出现 pi/ACP SDK
      for (const f of ts("enterprise/backend/agent-runtime/src/graph")) {
        for (const { spec, line } of imports(read(f))) {
          if (PI_ACP_SPECS.some((re) => re.test(spec)))
            v.push({ file: rel(f), line, detail: `编排层 import 了 ${spec}` });
        }
      }
      // ② acp-client/ 之外不得出现 pi/ACP SDK
      for (const f of ts("enterprise/backend/agent-runtime/src")) {
        if (rel(f).includes("/acp-client/")) continue;
        for (const { spec, line } of imports(read(f))) {
          if (PI_ACP_SPECS.some((re) => re.test(spec)))
            v.push({ file: rel(f), line, detail: `acp-client/ 之外 import 了 ${spec}` });
        }
      }
      // ③ enterprise/backend/shared/tools 不得 import enterprise/backend/ 下的服务（否则无法脱离 Agent 单测，AC-34-4）
      for (const f of ts("enterprise/backend/shared/tools/src")) {
        for (const { spec, line } of imports(read(f))) {
          if (/(^|\/)services\//.test(spec) || /^@carlife\/(gateway|agent-runtime)/.test(spec))
            v.push({ file: rel(f), line, detail: `工具层 import 了服务层 ${spec}（AC-34-4：工具必须可脱离 Agent 单测）` });
        }
      }
      return v;
    },
  },

  {
    id: "crosstalk",
    title: "子 Agent 之间不互相调用",
    rule: "§11 关键原则：子 Agent 之间不会互相调用，协作路径永远经过 LangGraph（F-13-06 / AC-11-8）",
    run() {
      const v: Violation[] = [];
      const dir = join(ROOT, "enterprise/backend/agent-runtime/src/graph/subgraphs");
      // ① 子图之间不得互相 import
      for (const f of walk(dir, /\.tsx?$/)) {
        for (const { spec, line } of imports(read(f))) {
          const isSibling = /^\.\/[a-z-]+$|^\.\/[a-z-]+\.js$/.test(spec);
          if (isSibling) v.push({ file: rel(f), line, detail: `子图之间直接 import：${spec}` });
        }
      }
      // ② 工具表里不得出现"以调用另一个 Agent 为实现"的工具
      const registry = join(ROOT, "enterprise/backend/shared/tools/src/registry.ts");
      if (existsSync(registry)) {
        read(registry)
          .split("\n")
          .forEach((text, i) => {
            if (/(ask|call|invoke|delegate)[_-]?(agent|supervisor|ownership|trip|cabin|service|buying)/i.test(text))
              v.push({ file: rel(registry), line: i + 1, detail: `工具表疑似注册了跨 Agent 调用型工具：${text.trim()}` });
          });
      }
      return v;
    },
  },

  {
    id: "sidecar-isolation",
    title: "旁路观察者只读、同步、够不着业务能力",
    rule: "§4.1 旁路四条硬约束：不是第六个子 Agent / 能力边界是工具表不是 prompt / 对主链路零同步成本 / 不绕过 §8.3（US-45 AC-45-8、AC-45-10）",
    run() {
      const v: Violation[] = [];
      const dir = join(ROOT, "enterprise/backend/agent-runtime/src/sidecar");
      if (!existsSync(dir)) return v;

      /*
       * ① 够不着业务能力。
       *
       * 这条是 F-45-09"单工具旁路"在 L0 形态下的落地：L0 全程零 LLM，没有 pi 的
       * 工具表可言，能力边界只能靠**模块依赖**来守。写在 prompt 里的"别回答用户的
       * 问题"迟早被绕过；import 不进来则是物理约束。
       */
      const FORBIDDEN = [
        /^@carlife\/(tools|rag|memory|db|guardrails)/,
        /(^|\/)\.\.\/(llm|graph)(\/|$)/,
      ];
      for (const f of walk(dir, /\.tsx?$/)) {
        for (const { spec, line } of imports(read(f))) {
          if (FORBIDDEN.some((re) => re.test(spec)))
            v.push({ file: rel(f), line, detail: `旁路 import 了业务能力 ${spec}——能力边界靠依赖守，不靠提示词` });
        }
      }

      /*
       * ② 扇出入口必须同步。
       *
       * 观察挂在主链路的同步回调上（`setSpanSink` / `TurnRunner` 的 trace sink）。
       * 一旦某个导出函数返回 Promise，接线处迟早会 `await` 它，扇出就变成了串联，
       * 而那正是本 Sprint 唯一不能破的不变量（主链路分位数不变）。
       *
       * 只查**导出**函数：内部实现将来接 L1 时可以有异步（fire-and-forget）。
       */
      for (const f of walk(dir, /\.tsx?$/)) {
        read(f)
          .split("\n")
          .forEach((text, i) => {
            if (/^\s*export\s+(async\s+function|function\s+\w+[^)]*\)\s*:\s*Promise)/.test(text))
              v.push({
                file: rel(f),
                line: i + 1,
                detail: `旁路导出了异步入口：${text.trim().slice(0, 70)}——扇出入口必须同步返回`,
              });
          });
      }

      /*
       * ③ 模板表里不得有兜底键（M18-04，F-45-04）。
       *
       * 单测已经断言过一次，这里再加一道**结构性**的：单测可以被改，
       * 而这条不变量会在 `check:all` 里拦住任何一次"顺手加个 default 兜一下"。
       * 那句兜底话（"正在为您查询"）在什么都没发生时说出口就是假话，
       * 而且是用户完全无法证伪的假话——它值一道额外的闸。
       */
      const templates = join(dir, "templates.ts");
      if (existsSync(templates)) {
        read(templates)
          .split("\n")
          .forEach((text, i) => {
            if (/^\s*(default|fallback|unknown)\s*:/.test(text) || /"\*"\s*:/.test(text))
              v.push({
                file: rel(templates),
                line: i + 1,
                detail: `模板表出现兜底键：${text.trim().slice(0, 60)}——没有事件支撑的进度描述是假话`,
              });
          });
      }

      /*
       * ④ 垫场话必须过输出管线（M18-04，F-45-10）。
       *
       * 旁路不是安全边界的旁路。判据取"下发入口只有 speak.ts 一处"：
       * `turn-runner` 里除 `emitFiller` 外不得直接构造 `events.filler(...)`，
       * 否则就存在一条绕过 `checkOutput` 的下发路径。
       */
      const runner = join(ROOT, "enterprise/backend/agent-runtime/src/turn-runner.ts");
      if (existsSync(runner)) {
        const src = read(runner);
        const direct = [...src.matchAll(/events\.filler\s*\(/g)].length;
        const viaSpeak = /emitFiller\s*\(/.test(src);
        if (direct > 1 || (direct === 1 && !viaSpeak))
          v.push({
            file: rel(runner),
            line: 1,
            detail: `发现 ${direct} 处直接构造 events.filler——垫场话的下发入口只能是 sidecar/speak.ts 的 emitFiller（它负责过 checkOutput）`,
          });
      }
      return v;
    },
  },

  {
    id: "guardrails-purity",
    title: "enterprise/backend/shared/guardrails 无业务耦合",
    rule: "§10 要点 3：通用管线放共享包（无业务耦合、可单测、可复用），业务规则在 agent-runtime/src/guard（AC-25-10）",
    run() {
      const v: Violation[] = [];
      // CarLife 特有的业务概念——出现在通用包里即为耦合。
      const BUSINESS = /(硬禁|免责|车辆控制|自动驾驶|维修|保养|试驾|车主|CarLife|carlife)/;
      for (const f of ts("enterprise/backend/shared/guardrails/src")) {
        const src = read(f);
        for (const { spec, line } of imports(src)) {
          if (/(^|\/)services\//.test(spec) || /^@carlife\/(gateway|agent-runtime|tools|memory|rag)/.test(spec))
            v.push({ file: rel(f), line, detail: `通用管线 import 了业务模块 ${spec}` });
        }
        src.split("\n").forEach((text, i) => {
          if (BUSINESS.test(text) && !text.trimStart().startsWith("//") && !text.trimStart().startsWith("*"))
            v.push({ file: rel(f), line: i + 1, detail: `通用管线出现业务词表：${text.trim().slice(0, 60)}` });
        });
      }
      return v;
    },
  },

  {
    id: "capabilities",
    title: "端侧能力白名单不含车辆控制；Rust command 面同样审查",
    rule: "§8.5：Tauri capability 白名单不暴露任何车辆控制能力，物理上无法下发控制指令（F-28-01/02）",
    run() {
      const v: Violation[] = [];
      // 车辆控制类能力的词表——只读的 vehicle_signal 明确放行。
      const FORBIDDEN = /(vehicle[_-]?control|drive[_-]?control|set[_-]?speed|steer|throttle|brake|accelerat|autopilot|self[_-]?driv|自动驾驶|车辆控制)/i;
      const READONLY_OK = /vehicle[_-]?signal|read[_-]?only/i;

      for (const app of ["clients/mobile", "clients/cockpit"]) {
        for (const f of walk(join(ROOT, app, "src-tauri/capabilities"), /\.(json|toml)$/)) {
          // 只扫**真正的权限项**（permissions 数组），不扫 description/identifier 等元信息——
          // 后者按约定恰恰会写"不暴露任何车辆控制能力"，扫它必然误报。
          let perms: unknown[] = [];
          try {
            const parsed = JSON.parse(read(f)) as { permissions?: unknown[] };
            perms = Array.isArray(parsed.permissions) ? parsed.permissions : [];
          } catch {
            v.push({ file: rel(f), detail: "capability 文件不是合法 JSON，无法审查——视为不通过" });
            continue;
          }
          for (const p of perms) {
            const s = typeof p === "string" ? p : JSON.stringify(p);
            if (FORBIDDEN.test(s) && !READONLY_OK.test(s))
              v.push({ file: rel(f), detail: `capability 疑似车辆控制能力：${s}` });
          }
        }
        // 白名单管的是 WebView→Rust 的调用面；Rust 侧自己实现了控制 command 的话，白名单形同虚设。
        for (const f of walk(join(ROOT, app, "src-tauri/src"), /\.rs$/)) {
          read(f)
            .split("\n")
            .forEach((text, i) => {
              if (/#\[tauri::command\]/.test(text)) return;
              if (FORBIDDEN.test(text) && !READONLY_OK.test(text) && /fn\s+\w+/.test(text))
                v.push({ file: rel(f), line: i + 1, detail: `Rust command 面疑似车辆控制：${text.trim()}` });
            });
        }
      }
      return v;
    },
  },

  {
    id: "env-timing",
    title: "服务的非入口模块不在模块级读 process.env",
    rule: "§9 配置由入口 loadRootEnv() 注入：ESM import 提升让模块级读跑在它之前，读到的是默认值而非 .env（F-02 走查实证）",
    run() {
      const v: Violation[] = [];
      // 入口自己可以：`loadRootEnv()` 是它的第一条语句，其后的模块级读是安全的。
      // env.ts 是加载器本身。
      const ENTRY = /\/src\/(index|env)\.tsx?$/;
      for (const dir of ["enterprise/backend/gateway/src", "enterprise/backend/agent-runtime/src", "enterprise/backend/worker/src"]) {
        for (const f of ts(dir)) {
          if (ENTRY.test(f)) continue;
          read(f)
            .split("\n")
            .forEach((text, i) => {
              // 只看零缩进的声明——模块级作用域的可靠信号。
              // 函数体内、对象字面量内的读取都是惰性的，不在此列。
              if (!/^(export\s+)?(const|let|var)\s/.test(text)) return;
              if (!/process\.env/.test(text)) return;
              // `const f = () => process.env.X` / `= function () {` 是惰性的，放行。
              // 立即执行（`)()` 结尾）不放行——那与模块级读等价。
              const lazyFn = /=\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(text) || /=\s*(async\s+)?function\b/.test(text);
              if (lazyFn && !/\)\s*\(\s*\)\s*;?\s*$/.test(text)) return;
              v.push({
                file: rel(f),
                line: i + 1,
                detail: `模块级读 process.env：${text.trim()}\n  → 改成函数内惰性读（例：\`function runtimeUrl() { return process.env.X ?? "…" }\`）`,
              });
            });
        }
      }
      return v;
    },
  },

  {
    id: "contract",
    title: "Rust 协议结构体是生成物，不是手写",
    rule: "§10 要点 6：contracts 是端云契约唯一真相源，Rust 侧经 ts-rs/specta 生成（F-34-04 / AC-34-3）",
    run() {
      const v: Violation[] = [];
      const gen = join(ROOT, "contracts/src/generated");
      if (!existsSync(gen)) return [{ file: "contracts/src/generated", detail: "生成物目录不存在——契约链路未接通" }];
      // 生成物与当前 TS 契约是否一致：交给 test:contract 做（它跑 Rust roundtrip）。
      // 这里只守"生成物没有被手工改过"——git 里有未提交的改动即可疑。
      try {
        const dirty = execSync(`git status --porcelain -- ${gen}`, { cwd: ROOT, encoding: "utf8" }).trim();
        if (dirty)
          v.push({
            file: "contracts/src/generated",
            detail: `生成物有未提交改动，可能是手工编辑：\n${dirty}\n  → 应改 contracts 的契约后重跑 generate:contract`,
          });
      } catch {
        /* 非 git 环境跳过 */
      }
      return v;
    },
  },

  {
    id: "no-websocket",
    title: "实时通道只用 SSE，不引入 WebSocket",
    rule: "§3：用户动作走 POST，token 流与步骤事件走 SSE（text/event-stream）。**新增实时通道时不要引入 WS**",
    run() {
      const v: Violation[] = [];
      /*
       * 只扫**应用与服务源码**。刻意不扫：
       *  - `infra/`（本文件自己就含这些字面量）；
       *  - vite / tauri 配置（dev server 的 HMR 通道是 WS，那是工具链不是我们的协议）；
       *  - `docs/`（架构文档里正要谈论这件事）。
       */
      const dirs = [
        "enterprise/backend/gateway/src",
        "enterprise/backend/agent-runtime/src",
        "contracts/src",
        "enterprise/backend/shared/tools/src",
        "clients/mobile/src",
        "clients/cockpit/src",
        "enterprise/console/src",
      ];
      // 行注释、块注释行、以及 markdown 引用里的说明不算违规 ——
      // 「本文件不用 WebSocket」这种注释恰恰是我们希望多写的，扫到它会让规则自伤。
      const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
      const HIT = /\bnew WebSocket\b|\bWebSocketServer\b|['"\`]wss?:\/\//;

      for (const dir of dirs) {
        for (const f of ts(dir)) {
          const lines = read(f).split("\n");
          lines.forEach((line, i) => {
            if (isComment(line)) return;
            if (HIT.test(line))
              v.push({ file: rel(f), line: i + 1, detail: `出现 WebSocket 用法：${line.trim().slice(0, 80)}` });
          });
        }
      }
      return v;
    },
  },

  {
    id: "mock-dealer-isolation",
    title: "模拟系统（经销商/车机舒适域/语音合成）不依赖本仓业务包",
    rule: "M19-01 D1：它们是**假装成第三方**的独立进程，唯一价值是能被当场 kill 掉演示降级；引了业务包就不再是外部系统",
    run() {
      const v: Violation[] = [];
      // 注释里提到 `@carlife/tools` 说明它与谁配合，是我们希望多写的，不算违规。
      const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
      // 新增一个 mock 记得往这里加一行——这份清单静默过期的话，
      // 检查照样打 ✓，而那正是"CI 绿但其实没测"的那种绿。
      for (const dir of ["mocks/dealer/src", "mocks/cabin/src", "mocks/tts/src"]) {
        if (!existsSync(join(ROOT, dir))) continue;
        for (const f of ts(dir)) {
          read(f)
            .split("\n")
            .forEach((line, i) => {
              if (isComment(line)) return;
              if (/\bfrom\s+['"\`]@carlife\//.test(line) || /\brequire\(['"\`]@carlife\//.test(line)) {
                v.push({ file: rel(f), line: i + 1, detail: `引了业务包：${line.trim().slice(0, 80)}` });
              }
            });
        }
      }
      return v;
    },
  },
  {
    id: "client-isolation",
    title: "端侧只认识网关：不直连第三方、不读服务端配置、不带硬编码凭证",
    rule:
      "§0 端云边界（ACR-018）：车机与手机是面向车主的消费端，唯一后端是网关；" +
      "vendor 密钥与服务端配置一律不下端（§8.2 A 类只写不读）",
    run() {
      const v: Violation[] = [];

      /*
       * 扫描面 = 会被打进客户端产物的东西：两个端的前端与 Rust 层、
       * 两端共用的 crates、以及被两端 import 的 clients/shared/ui。
       * 服务端与 enterprise/console（面向企业内部的控制台）不在此列——
       * 它们本来就该知道更多。
       */
      /*
       * ACR-020 之后清单只剩两条——目录开始自己说话了。`clients/` 整棵扫（含两端的
       * src 与 src-tauri/src、shared/ui、shared/rust），`contracts/` 是端上也会 import 的契约。
       * 刻意跳过：vendor/（上游源码树，它自己的 URL 与 env 读取不归我们管）、
       * src-tauri/gen/（Xcode 工程生成物）、examples/（cargo 的开发冒烟工具，不进产物，
       * 它们读 CARLIFE_SMOKE_TOKEN 这类走查变量是正常的）、build.rs（构建脚本读
       * CARGO_CFG_* 是 cargo 的约定，不是服务端配置）。
       */
      const CLIENT_DIRS = ["clients", "contracts"];
      const SKIP_IN_CLIENT = /(^|\/)(vendor|gen|target|node_modules|dist|examples)\/|(^|\/)build\.rs$/;

      /**
       * 端上允许出现的主机。判据是"这一跳有没有带凭证、能不能被网关代理"：
       *   - 本机与局域网地址：网关自己的地址就长这样（设置页示例、默认值）
       *   - uri.amap.com / iosamap：**唤起外部 App 的深链**，不带凭证、不取数据，
       *     且已被两个端的 Tauri capability 白名单限死（各自 src-tauri 下的 capabilities）
       */
      const ALLOWED_HOSTS = [
        /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/,
        /^192\.168\./,
        /^uri\.amap\.com/,
        /*
         * 下面两类**根本不是网络调用**，放行不是豁免：
         *   - example.com / example.org：RFC 2606 保留域名，演示数据里的占位
         *     sourceUrl 用它。它不可能被真的请求到，也正因如此才该用它。
         *   - www.w3.org：SVG/XML 的命名空间 URI。它是**标识符不是地址**，
         *     浏览器从不去取它；`xmlns="http://www.w3.org/2000/svg"` 是标准写法。
         */
        /^example\.(com|org)/,
        /^www\.w3\.org/,
      ];

      /**
       * 已知例外，**逐个写清删除条件**。这份清单只能变短——ACR-019 已经把它
       * 从三条砍到一条（安全密钥收进了网关的 `/_AMapService/*` 代理，
       * 两个端的 `main.tsx` 与 `vite-env.d.ts` 因此不再需要豁免）。
       *
       * 剩下这一条**大概率永远留着**，它不是待办：加载高德 SDK 的那个 script
       * 标签必须带 JS key，那是 SDK 的固有形态，不是我们的实现选择。
       * 要消灭它只有一条路——不用高德 JS SDK 渲染地图，那是换渲染方案，
       * 不是收紧边界。JS key 的安全性靠高德控制台的域名白名单，不靠这条检查。
       */
      const KNOWN_EXCEPTIONS: Array<{ file: RegExp; why: string }> = [
        {
          file: /^clients\/shared\/ui\/src\/map\/amap-loader\.ts$/,
          why: "加载高德 JS SDK 的 script 标签，必须带 JS key（SDK 固有形态，非待办）",
        },
      ];

      /** 端上自己的配置项。与两个端 src-tauri 下 dev_env.rs 的白名单同一份语义。 */
      const CLIENT_ENV_KEYS = new Set([
        "CARLIFE_GATEWAY_URL",
        "CARLIFE_TTS_SAY_VOICE",
        "CARLIFE_AEC_ENABLED",
        "CARLIFE_AEC_DELAY_MS",
        "CARLIFE_SENTINEL_DEBUG",
        "CARLIFE_TTS",
      ]);

      const isComment = (line: string) => /^\s*(\/\/|\*|\/\*|#|!)/.test(line.trim());

      for (const dir of CLIENT_DIRS) {
        const abs = join(ROOT, dir);
        if (!existsSync(abs)) continue;
        for (const f of walk(abs, /\.(tsx?|rs)$/)) {
          const relPath = rel(f);
          if (SKIP_IN_CLIENT.test(relPath)) continue;
          // 测试与走查用例不进产物：它们打 mock 服务、用假密钥，是正常的。
          if (/(^|\/)test(s)?\//.test(relPath) || /\.test\.tsx?$/.test(relPath)) continue;
          const exempt = KNOWN_EXCEPTIONS.find((e) => e.file.test(relPath));

          const lines = read(f).split("\n");
          /*
           * Rust 的 `#[cfg(test)]` 之后全是测试代码。按约定它在文件末尾，
           * 于是"从第一个 cfg(test) 起停止扫描"是个足够好的近似——
           * 它可能漏掉写在中间的测试模块（少见），但不会误报生产代码。
           */
          const stopAt = relPath.endsWith(".rs")
            ? lines.findIndex((l) => l.includes("#[cfg(test)]"))
            : -1;
          const limit = stopAt >= 0 ? stopAt : lines.length;

          for (let i = 0; i < limit; i += 1) {
            const line = lines[i];
            if (isComment(line)) continue;

            // ① 直连第三方：抓字面量里的 http(s):// 主机
            for (const m of line.matchAll(/https?:\/\/([A-Za-z0-9.\-_:[\]]+)/g)) {
              const host = m[1];
              if (ALLOWED_HOSTS.some((re) => re.test(host))) continue;
              if (exempt) continue;
              v.push({
                file: relPath,
                line: i + 1,
                detail: `端上出现非网关地址 ${host}——所有网络调用必须经网关转发`,
              });
            }

            // ② 服务端配置：端上只该读自己那几项
            const envReads = [
              ...line.matchAll(/env::var(?:_os)?\(\s*"([A-Z0-9_]+)"/g),
              ...line.matchAll(/import\.meta\.env\.([A-Za-z0-9_]+)/g),
              ...line.matchAll(/process\.env\.([A-Z0-9_]+)/g),
            ];
            for (const m of envReads) {
              const key = m[1];
              // vite 内置与 VITE_ 前缀是构建期注入，不是服务端配置。
              if (/^(MODE|DEV|PROD|SSR|BASE_URL)$/.test(key) || key.startsWith("VITE_")) continue;
              if (CLIENT_ENV_KEYS.has(key)) continue;
              if (exempt) continue;
              v.push({
                file: relPath,
                line: i + 1,
                detail: `端上读了 ${key}——它不在客户端配置白名单里（见 dev_env.rs 的 CLIENT_KEYS）`,
              });
            }

            // ③ 硬编码凭证：那把万能钥匙已随 M48-02 删除，产物里不该再有它
            if (line.includes("demo-token")) {
              v.push({
                file: relPath,
                line: i + 1,
                detail: "硬编码 demo-token——网关早已不认它，且它会随产物分发",
              });
            }
          }
        }
      }
      return v;
    },
  },
];

// ── 执行 ───────────────────────────────────────────────────

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = only.length ? checks.filter((c) => only.includes(c.id)) : checks;

let failed = 0;
for (const c of selected) {
  const violations = c.run();
  if (violations.length === 0) {
    console.log(`✓ ${c.id.padEnd(18)} ${c.title}`);
    continue;
  }
  failed += 1;
  console.error(`\n✗ ${c.id} —— ${c.title}`);
  console.error(`  规则：${c.rule}`);
  for (const x of violations) console.error(`    ${x.file}${x.line ? `:${x.line}` : ""}  ${x.detail}`);
}

if (failed) {
  console.error(`\n架构不变量检查：${selected.length - failed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\n架构不变量检查：${selected.length} passed`);
