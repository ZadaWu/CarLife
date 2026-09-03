/**
 * 部署后分层自检（施工单 M9-04，FL-43）。
 *
 * # 分层是为了让"哪一层坏了"一眼可见
 *
 * L0 进程起得来 → L1 存储可达 → L2 外部依赖 → L3 端到端链路 → L4 演示脚本。
 * **前一层不过就不跑后一层**：L1 挂了还去跑 L3，只会得到一堆派生失败，
 * 掩盖真正的原因。
 *
 * # 自检数据必须隔离
 *
 * 自检写入的会话/记忆要能被识别并清理，**不能混进真实数据**——
 * 否则演示时会看到一堆 `selfcheck-` 开头的会话（F-43-10）。
 *
 * 运行：`corepack pnpm selfcheck`
 */

export type Layer = "L0" | "L1" | "L2" | "L3" | "L4";

export interface CheckDef {
  layer: Layer;
  name: string;
  /** 失败时的**具体修复指引**——"检查配置"这种话等于没说。 */
  remedy: string;
  /**
   * 失败是否阻断后续层。默认 `true`。
   *
   * 分层跳过是为了不让派生失败掩盖真正的原因，但这条规则遇到**非必需依赖**会走反：
   * 对象存储没接线不该让端到端链路整段跳过，那样反而把真正该看的东西藏起来了。
   * 非必需项失败照样标 ✗ 并计入失败数（**不降级成警告**），只是不阻断。
   */
  required?: boolean;
  run(): Promise<{ ok: boolean; detail?: string }>;
}

export interface CheckOutcome {
  layer: Layer;
  name: string;
  status: "pass" | "fail" | "skipped";
  detail?: string;
  remedy?: string;
}

const LAYER_ORDER: Layer[] = ["L0", "L1", "L2", "L3", "L4"];

/** 自检产生的数据一律带此前缀，便于识别与清理（F-43-10）。 */
export const SELFCHECK_PREFIX = "selfcheck-";

export function isSelfcheckArtifact(id: string): boolean {
  return id.startsWith(SELFCHECK_PREFIX);
}

/**
 * 按层执行。**前一层有失败则后续层全部跳过**——
 * 派生失败会掩盖真正的原因。
 */
export async function runSelfcheck(checks: readonly CheckDef[]): Promise<CheckOutcome[]> {
  const results: CheckOutcome[] = [];
  let blocked = false;

  for (const layer of LAYER_ORDER) {
    const inLayer = checks.filter((c) => c.layer === layer);
    if (inLayer.length === 0) continue;

    if (blocked) {
      for (const c of inLayer) {
        results.push({ layer, name: c.name, status: "skipped", detail: "上一层未通过，跳过以免产生派生失败" });
      }
      continue;
    }

    let layerFailed = false;
    for (const c of inLayer) {
      try {
        const r = await c.run();
        results.push({
          layer,
          name: c.name,
          status: r.ok ? "pass" : "fail",
          detail: r.detail,
          remedy: r.ok ? undefined : c.remedy,
        });
        if (!r.ok && c.required !== false) layerFailed = true;
      } catch (err) {
        results.push({
          layer,
          name: c.name,
          status: "fail",
          detail: err instanceof Error ? err.message : String(err),
          remedy: c.remedy,
        });
        if (c.required !== false) layerFailed = true;
      }
    }
    if (layerFailed) blocked = true;
  }

  return results;
}

/** 人可读报告。失败项**带修复指引**，不是只报红。 */
export function formatReport(outcomes: readonly CheckOutcome[]): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    const icon = o.status === "pass" ? "✓" : o.status === "fail" ? "✗" : "–";
    lines.push(`${icon} [${o.layer}] ${o.name}${o.detail ? ` — ${o.detail}` : ""}`);
    if (o.remedy) lines.push(`    修复：${o.remedy}`);
  }
  const failed = outcomes.filter((o) => o.status === "fail").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  lines.push(
    `\n自检：${outcomes.length - failed - skipped} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ""}`,
  );
  return lines.join("\n");
}

// ── 入口 ────────────────────────────────────────────────────

/**
 * **零检查项必须报错。**
 *
 * 走查时 `pnpm selfcheck` 零输出、`exit=0`——框架在、检查项一条没有。
 * 它是"演示前 10 分钟跑一遍"要依赖的命令，而它当时会告诉你一切正常。
 * 一个什么都不查却报成功的自检比没有自检更糟：后者至少不会让人放心。
 */
/**
 * 载入仓库根 `.env`，语义与 `enterprise/backend/gateway/src/env.ts` 一致：**已存在的环境变量优先**。
 *
 * 不载入的后果不是"报错"，而是自检拿默认端口去连、连不上、报一堆红——
 * 然后人跑去重启本来好好的服务。**错误的诊断比没有诊断更费时间。**
 * 必须在 import 检查项之前调用（那边模块级会连库）。
 */
function loadRootEnv(): void {
  const root = new URL("../../../.env", import.meta.url);
  const before = new Map(Object.entries(process.env) as Array<[string, string]>);
  try {
    process.loadEnvFile(root);
  } catch {
    return; // 没有 .env 就用进程环境，容器部署本就如此
  }
  for (const [k, v] of before) process.env[k] = v;
}

/**
 * 清理自检留下的会话（F-43-10 的"可清理"那一半）。
 *
 * 只删 `selfcheck-` 前缀——**判据是命名本身，不靠"记得删"**。
 * 消息经 onDelete: Cascade 跟着走。
 *
 * 为什么不在自检结束时自动删：那会让"自检是否污染了数据"变成一句无法验证的话。
 * 留在库里、可被数出来、可一键清掉，比悄悄删干净更可信。
 */
async function clean(): Promise<void> {
  loadRootEnv();
  const { cleanSelfcheckArtifacts } = await import("./selfcheck-checks");
  const count = await cleanSelfcheckArtifacts();
  console.log(`已清理 ${count} 个自检会话（前缀 ${SELFCHECK_PREFIX}，消息级联删除）。`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--clean")) {
    await clean();
    process.exit(0);
  }

  loadRootEnv();
  const { CHECKS } = await import("./selfcheck-checks");

  if (CHECKS.length === 0) {
    console.error("自检没有任何检查项——这不是「全部通过」。");
    process.exit(2);
  }

  const only = process.argv.slice(2).filter((a) => /^L[0-4]$/.test(a));
  const selected = only.length ? CHECKS.filter((c) => only.includes(c.layer)) : CHECKS;

  const outcomes = await runSelfcheck(selected);
  console.log(formatReport(outcomes));

  const failed = outcomes.filter((o) => o.status === "fail").length;
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("自检自身出错（这不等于系统正常）：", err);
    process.exit(2);
  });
}
