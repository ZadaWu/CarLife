/**
 * 启动期配置校验（施工单 M3-02，AC-35-11；M49-01 加开发默认值）。
 *
 * 必填缺失或格式非法 → **进程立即退出并指明具体项**，而不是跑起来在
 * 第一次真实调用时才炸。这是沈立平那句"新人照着 .env.example 填是起不来的"
 * 的对策：起不来至少要说清楚差哪一行。
 *
 * # 开发默认值（`devDefault`）与生产守卫
 *
 * M48-02 删掉 demo-token 万能钥匙后，`CARLIFE_JWT_SECRET` 是"必填无默认"，
 * 于是**任何没配过它的机器一律起不来**——对着刚 clone 完仓库的人，这是道障碍不是道防线。
 * 所以有了 `devDefault`：非生产时把它写回 env 并打一行醒目告警。
 *
 * **生产不吃 `devDefault`。** 这一条不是保守，是因为反过来的代价不可见：
 * 一个写在公开仓库里的签名密钥，如果生产只打一行 warn，它与完全没有鉴权等价
 * ——任何拿到仓库的人都能签出通过校验的 token 冒充任意 userId，
 * 而这件事不会以任何现象暴露（token 照常签发、照常通过、日志上一切正常）。
 * 一行会被滚屏冲掉的 warn 挡不住这个后果，所以生产维持"缺失即退出"。
 */

import { assertMasterKeyUsable, MasterKeyMissingError } from "./crypto";
import { CONFIG_REGISTRY } from "./registry";

export interface StartupIssue {
  key: string;
  reason: string;
}

/** 用了开发默认值的项。不影响退出码，但必须被看见。 */
export interface StartupWarning {
  key: string;
  reason: string;
}

export interface StartupReport {
  issues: StartupIssue[];
  warnings: StartupWarning[];
}

/**
 * 生产判定。取 `NODE_ENV` 是因为它是**仓库里唯一已存在的生产信号**
 * （`infra/images/Dockerfile` 的四处 `ENV NODE_ENV=production`）。
 * 不新造 `CARLIFE_ENV`——多一个环境变量就多一处"两边不一致时听谁的"。
 */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

/**
 * 校验并（在非生产下）把 `devDefault` 写回 env。
 *
 * **有副作用**：写回是故意的——后续所有读 `process.env` 的代码
 * （`jwt.ts` 之外还有脚本与子进程）由此拿到同一个值，而不是各自再兜一次底。
 */
export function collectStartupReport(env: NodeJS.ProcessEnv = process.env): StartupReport {
  const issues: StartupIssue[] = [];
  const warnings: StartupWarning[] = [];
  const production = isProductionEnv(env);

  for (const def of CONFIG_REGISTRY) {
    // 只校验 env-only 的必填项：db 存储的项在库里，启动时不一定连得上库。
    if (def.storage !== "env-only") continue;
    const value = env[def.envFallback];
    if (def.required && (value === undefined || value === "")) {
      if (!production && def.devDefault !== undefined) {
        env[def.envFallback] = def.devDefault;
        warnings.push({
          key: def.key,
          reason:
            "未配置，正在使用**开发默认值**。生产环境（NODE_ENV=production）不提供默认值，" +
            "缺失即启动失败；部署前请生成一个：openssl rand -hex 32",
        });
        continue;
      }
      issues.push({ key: def.key, reason: `必填项缺失（${def.description}）` });
      continue;
    }
    if (value !== undefined && value !== "") {
      // 配了但不合法 → 照旧是 issue。**不拿 devDefault 去顶**：
      // 配错了比没配更需要被指出来，悄悄顶替会让人以为自己那行生效了。
      const invalid = def.validate?.(value);
      if (invalid) issues.push({ key: def.key, reason: invalid });
    }
  }

  if (!issues.some((i) => i.key === "CARLIFE_CONFIG_MASTER_KEY")) {
    try {
      assertMasterKeyUsable(env.CARLIFE_CONFIG_MASTER_KEY);
    } catch (err) {
      issues.push({
        key: "CARLIFE_CONFIG_MASTER_KEY",
        reason: err instanceof MasterKeyMissingError ? err.message : String(err),
      });
    }
  }

  return { issues, warnings };
}

/** 旧签名保留：调用方（含测试）只关心"有没有拦下来的问题"。 */
export function collectStartupIssues(env: NodeJS.ProcessEnv = process.env): StartupIssue[] {
  return collectStartupReport(env).issues;
}

/** 有问题就打印清单并 `process.exit(1)`；服务入口在加载 env 之后立刻调用。 */
export function assertStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const { issues, warnings } = collectStartupReport(env);
  for (const w of warnings) {
    console.warn(`⚠ [config] ${w.key}: ${w.reason}`);
  }
  if (issues.length === 0) return;
  console.error("[config] 启动配置校验失败：");
  for (const i of issues) console.error(`  - ${i.key}: ${i.reason}`);
  console.error("  参见仓库根 .env.example（施工单 M3-02）");
  process.exit(1);
}
