/**
 * 行程核查的回补（M75-03 追加）。
 *
 * M75-03 之前，没有出发日的行程在夜间核查里被整份跳过：`tripDayDate` 给不出日期，
 * 逐日一律记 `unavailable`，一次天气接口都没打。改完之后这些行程该按"默认明天出发"逐日取预报，
 * 但库里那批旧核查不会自己变——而 `reviewOne` 见到"今天已经有一份核查"就跳过，
 * 所以**当天的 cron 补不了它自己**，得等第二天 06:10。这个脚本就是把那一天补上。
 *
 * # 补写，不删
 *
 * 核查表的每条读路径都是「按 `reviewedAt` 取最新一份」（`latestForPlan` / `latestForPlans`），
 * 没有任何地方枚举"某一天的那一行"。所以回补是**插一份更新的**，旧行留着当历史：
 * 删掉才是不可逆的，而它换不来任何东西。代价是这一天有两行，与 cron 的"同一天只写一行"不同——
 * 那条纪律约束的是任务不要重复插，不是禁止人工补一份修正。
 *
 * # 判据与幂等
 *
 * 只补**该补的**：最新一份核查逐日全 `unavailable`、或它的第 1 天日期不等于今天算出来的生效出发日。
 * 已经有真实天气且日期对得上的，跳过——所以跑两遍第二遍零写入。
 *
 * 天气、算路、仓储全部复用 worker 的 `createReviewDeps()`：装配与 cron 同源，
 * 不在这里另接一次高德，否则"手工补的"与"每天跑的"迟早给出两种结果。
 *
 * 默认 dry-run 只打印计划；`--apply` 才落库。
 *
 *   corepack pnpm trips:review-backfill            # 看要补哪些、补成什么样
 *   corepack pnpm trips:review-backfill --apply    # 落库
 */

import { diffReviews, effectiveStartDate, reviewSignature, severityOf } from "@carlife/shared";

import {
  createReviewDeps,
  reviewDays,
  reviewRoute,
} from "../../enterprise/backend/worker/src/trip-plan-review";

/** 与 backfill-session-titles.ts 同一份语义：已存在的环境变量优先。 */
function loadRootEnv(): void {
  const root = new URL("../../.env", import.meta.url);
  const before = new Map(Object.entries(process.env) as Array<[string, string]>);
  try {
    process.loadEnvFile(root);
  } catch {
    return;
  }
  for (const [k, v] of before) process.env[k] = v;
}

/** 一行摘要：`1) 09-09 多云 20~28℃`；查不到的写「查不到」，不写「晴」。 */
function describeDay(d: { day: number; date?: string; kind?: string; label?: string; tempMinC?: number; tempMaxC?: number; alarms?: string[] }): string {
  const md = d.date ? d.date.slice(5) : "无日期";
  if (!d.kind) return `${d.day}) ${md} 查不到`;
  const temp = d.tempMinC !== undefined && d.tempMaxC !== undefined ? ` ${Math.round(d.tempMinC)}~${Math.round(d.tempMaxC)}℃` : "";
  const alarms = d.alarms?.length ? ` ⚠${d.alarms.join("/")}` : "";
  return `${d.day}) ${md} ${d.label ?? d.kind}${temp}${alarms}`;
}

async function main(): Promise<void> {
  loadRootEnv();
  const apply = process.argv.includes("--apply");
  const deps = createReviewDeps();
  const today = deps.today();
  const plans = await deps.plans(today);

  console.log(`[回补] 今天 ${today}，活动行程 ${plans.length} 份${apply ? "" : "（dry-run，加 --apply 才落库）"}`);

  let planned = 0;
  let skipped = 0;
  let written = 0;
  const failures: string[] = [];

  for (const plan of plans) {
    const label = `${plan.plan.destination}(${plan.planId.slice(-6)}, ${plan.plan.days} 天)`;
    const latest = await deps.latest(plan.planId);
    const wantStart = effectiveStartDate(plan.plan, today);

    /*
     * 跳过的两种情况，都是"它已经是对的"：
     *  - 最新一份逐日有天气，且第 1 天的日期就是今天算出来的生效出发日；
     *  - 定了出发日、逐日有天气的行程（`wantStart` 就是它自己的 startDate）。
     * 逐日全查不到的一律补——那正是旧规则留下的行。
     */
    const hasWeather = Boolean(latest && latest.days.some((d) => !d.unavailable));
    const startMatches = latest?.days.find((d) => d.day === 1)?.date === wantStart;
    if (hasWeather && startMatches) {
      skipped += 1;
      console.log(`  跳过 ${label}：已有 ${wantStart} 起的逐日天气`);
      continue;
    }

    planned += 1;
    try {
      const days = await reviewDays(plan.plan, today, deps.weather);
      const route = await reviewRoute(plan, today, deps);
      const changes = diffReviews(latest ?? undefined, { days, route });
      const severity = severityOf(changes);

      console.log(`  ${apply ? "回补" : "将补"} ${label} 生效出发日 ${wantStart}`);
      console.log(`      ${days.map(describeDay).join("  ")}`);
      if (route) console.log(`      出发路线 第 ${route.day} 天 ${route.from} → ${route.to} ${route.distanceKm}km / ${route.durationMin}min`);
      else console.log(`      出发路线 无（缺常住地 / 坐标 / key）`);
      if (changes.length > 0) console.log(`      变化 ${changes.length} 条（${severity}）：${changes.map((c) => c.text).join("；")}`);

      if (apply) {
        await deps.insert({
          planId: plan.planId,
          userId: plan.userId,
          signature: reviewSignature(days, route),
          days,
          route,
          changes,
          severity,
        });
        written += 1;
      }
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[回补] 计划 ${planned} 份，跳过 ${skipped} 份，落库 ${written} 份，失败 ${failures.length} 份`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (!apply && planned > 0) console.log("[回补] dry-run 结束，确认无误后加 --apply");
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[回补] 失败", err);
  process.exit(1);
});
