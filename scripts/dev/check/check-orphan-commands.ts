/**
 * Tauri 命令的「注册了但端上没人调」检查（施工单 M53-02）。
 *
 * 运行：`corepack pnpm check:orphan-commands`（已进 `check:all`）
 *
 * # 为什么值得一条独立检查
 *
 * 同一形状的缺陷在三个月里发生了**三次**，每次都是人真的去点才发现：
 *
 *  | 命令 | 注册于 | 端上零调用方期间的现象 | 补上的工单 |
 *  |---|---|---|---|
 *  | `switch_device_role` | M48-04 | pad 双角色切换**等于不存在** | M49-04 |
 *  | `request_pairing_code` | M48-04 | 车主拿不到配对码，整条绑定流程走不通 | M51-01 |
 *  | `auth_logout` | M48-02 | 登录进去**出不来**，换账号只能重装 | M52-01 |
 *
 * 三次都是：编得过、跑得起来、测试全绿、**不报任何错**。Rust 侧命令有，
 * TS 侧没有任何地方 `invoke` 它——两边各自成立，中间那根线断了没人知道。
 * 这正是机器能查而人查不动的那类：它不是逻辑错误，是**缺一处连接**。
 *
 * # 形态照 `check-env-example.ts`
 *
 * 那条做的是「配置注册表 ↔ `.env.example`」的双向一致性，与本条同构：
 * 一侧声明、另一侧使用，缺了就报。同样只报不修。
 *
 * # 为什么豁免必须写理由
 *
 * 不写理由的豁免等于把检查关掉——半年后没人知道那一行是"确实不需要"
 * 还是"当时赶时间加进来的"。所以 `EXEMPT` 的值是理由字符串，不是布尔。
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** 端：Rust 侧入口（找注册表）与 TS 侧根目录（找调用方）。 */
const SURFACES = [
  { name: "cockpit", tauri: "clients/cockpit/src-tauri/src", web: "clients/cockpit/src" },
  { name: "mobile", tauri: "clients/mobile/src-tauri/src", web: "clients/mobile/src" },
] as const;

/**
 * 显式豁免：命令名 → **为什么**它没有本端调用方。
 *
 * 加一行之前先问一遍："这真的是不需要，还是又一次漏接线？"
 * 前三次的教训都是后者。
 */
const EXEMPT: Record<string, string> = {
  // ── 排障 / 调参口：**刻意**不进产品界面 ──
  interrupt_stats:
    "打断计数快照（M33-02），验收与排障用的读数口——它的价值就在于不占界面",
  sentinel_set_windows:
    "哨兵聆听/追问时长的热改口（M25-03），立即生效不落盘；持久化与界面归后续偏好面",
  set_music_enabled:
    "车内音乐的现场逃生阀（M63-03），从 devtools invoke。刻意不进界面：音乐开不开由服务端的媒体源（cabin_control 的 source）决定，端上再摆一个开关就是第二处真相源——而两处早晚分叉，分叉的表现是「界面显示在放、喇叭没声」",

  // ── 下面三条是**存疑**，不是「确定不需要」 ──
  // 写成豁免只为让这条检查先立起来（它今天已经查出 register_device 那个真缺口）。
  // 逐条的判断与去向在 M53-02 验收 §7；**别把它们当成已经想清楚了**。
  sentinel_stop:
    "存疑：哨兵关闭走 sentinel_set_switch，stop 只在真要释放麦克风时需要，而端上没有那个时机——是不是该在退出对话层时调它没人验过。去向见 M53-02 验收 §7 债 1",
  clear_message_cache:
    "存疑：端上消息缓存的清理口，目前没有任何界面入口（清缓存这件事用户要不要能做，没定过）。去向见 M53-02 验收 §7 债 1",
  flush_trips:
    "存疑：行程队列的手动冲刷口，注释说网络失败时留队列等下次——那个「下次」由谁触发没查清。去向见 M53-02 验收 §7 债 1",
};

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * 从 `tauri::generate_handler![...]` 里取命令名。
 *
 * 只认 `path::to::name` 的最后一段。宏体里可能有注释与换行，所以先剥注释再切。
 */
function registeredCommands(tauriDir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walk(tauriDir).filter((f) => f.endsWith(".rs"))) {
    const src = readFileSync(file, "utf8");
    const start = src.indexOf("generate_handler![");
    if (start < 0) continue;
    // 配对方括号，别用正则——宏体里有注释、泛型和嵌套
    let depth = 0;
    let end = -1;
    for (let i = src.indexOf("[", start); i < src.length; i += 1) {
      if (src[i] === "[") depth += 1;
      else if (src[i] === "]") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    const body = src
      .slice(src.indexOf("[", start) + 1, end)
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const raw of body.split(",")) {
      const name = raw.trim().split("::").pop()?.trim();
      if (name && /^[a-z_][a-z0-9_]*$/.test(name)) found.set(name, file.replace(ROOT, ""));
    }
  }
  return found;
}

/** 端上 TS/TSX 里 `invoke("name")` / `invoke<T>("name")` 的命令名。 */
function invokedCommands(webDir: string): Set<string> {
  const names = new Set<string>();
  const re = /invoke\s*(?:<[^>]*>)?\s*\(\s*["'`]([a-z_][a-z0-9_]*)["'`]/g;
  for (const file of walk(webDir).filter((f) => /\.(ts|tsx)$/.test(f))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(re)) names.add(m[1]!);
  }
  return names;
}

let failed = false;
const lines: string[] = [];

const registry = SURFACES.map((s) => ({
  surface: s,
  registered: registeredCommands(join(ROOT, s.tauri)),
  invoked: invokedCommands(join(ROOT, s.web)),
}));

/** 全部端加起来调过的命令。跨端共用的命令靠它免于误报。 */
const invokedAnywhere = new Set(registry.flatMap((r) => [...r.invoked]));

/*
 * 两档，因为两种情况的严重程度差着量级：
 *
 *  - **硬失败**：注册了、**所有端都没人调**。这就是发生过三次的那一类——
 *    功能不存在，且不报任何错。
 *  - **只提示**：本端注册、只有另一个端在调。两个端共用一套 `commands::stream::*`
 *    是本仓的既有形态（`read_cached_messages` 手机在调、`start_mock_stream` 车机在调），
 *    把它算失败会让这条检查一上来就是红的，然后被人加一堆豁免绕过去——
 *    那时它就等于不存在了。
 */
const deadEverywhere: Array<[string, string]> = [];
const crossSurfaceOnly: string[] = [];

for (const { surface, registered, invoked } of registry) {
  for (const [name, where] of registered) {
    if (invoked.has(name) || name in EXEMPT) continue;
    if (invokedAnywhere.has(name)) crossSurfaceOnly.push(`${name}（${surface.name} 注册，另一个端在调）`);
    else deadEverywhere.push([name, where]);
  }
}

for (const { surface, registered } of registry) {
  lines.push(`· ${surface.name}：注册 ${registered.size} 个命令`);
}

if (crossSurfaceOnly.length > 0) {
  lines.push(`ℹ 跨端共用（不算问题）：${crossSurfaceOnly.length} 个`);
  for (const n of crossSurfaceOnly) lines.push(`    ${n}`);
}

if (deadEverywhere.length === 0) {
  lines.push(`✓ 没有「注册了但全端都没人调」的命令`);
} else {
  failed = true;
  lines.push(`✗ 以下命令注册了，但**所有端**的 src 里都没有任何地方调用它——`);
  for (const [n, where] of deadEverywhere) lines.push(`    ${n}    （注册于 ${where}）`);
}

/** 豁免清单本身也要体检：写了名字没写理由，等于把这条检查悄悄关掉。 */
for (const [name, reason] of Object.entries(EXEMPT)) {
  if (!reason || reason.trim().length < 8) {
    failed = true;
    lines.push(`✗ 豁免 ${name} 没写理由——不写理由的豁免等于把检查关掉`);
  }
}

console.log(lines.join("\n"));

if (failed) {
  console.error(
    "\n命令注册了却没人调 = 那个功能**不存在**，而且编得过、跑得起来、测试全绿、不报错。\n" +
      "同一形状已经发生三次（switch_device_role / request_pairing_code / auth_logout），\n" +
      "三次都是人真的去点才发现。\n\n" +
      "两条路二选一：\n" +
      "  1. 补上端上的调用方（多半是这条——命令写好了说明当初就打算用它）；\n" +
      "  2. 确实不需要：加进 scripts/dev/check/check-orphan-commands.ts 的 EXEMPT，**并写清理由**。",
  );
  process.exit(1);
}
