/**
 * 业务侧读取 guard DB 配置并注入 `enterprise/backend/shared/guardrails` 的 runtime-config
 * （施工单 TD-03；FL-25 F-25-10、
 * FL-30 F-30-03、
 * FL-35 F-35-04）。
 *
 * # 这个文件此前是空壳，而空壳的后果不是"少个功能"
 *
 * `enterprise/backend/shared/guardrails` 的 `GuardPolicy` / `applyPolicy` 一直齐备且有测试，
 * 但**生产侧零调用**：`guard/pipeline.ts` 调管线时不传策略，走的是编译期默认值。
 * 于是"运营可以关掉某个分类""出事能按止血开关"这两句话在代码里不成立，
 * 而它没有任何症状——系统照常回答，只是配置改了不起作用。
 *
 * # 短 TTL 缓存，不另起一套
 *
 * §10 目录树对本文件的注释原文：「业务侧读取 guard DB 配置并注入
 * `enterprise/backend/shared/guardrails` 的 runtime-config（**不另起一套缓存**）」。
 * 这里的"不另起一套"指的是**不引入第二种缓存机制**（Redis / LRU 库 / 订阅推送），
 * 而不是"不许有 TTL"——策略必须能热生效，每次 check 都打一次库也不现实。
 * 实现就是一个模块级的时间戳 + 值，与 `enterprise/backend/shared/db/src/config/store.ts` 同一形态。
 *
 * # 读失败回落到"更严"的一侧，不是回落到上次值
 *
 * 数据库读不到时用 `DEFAULT_POLICY`（六类全开）而不是沿用缓存里的旧值：
 * 旧值可能是运营刚放宽过的，而此刻我们连"它是不是还生效"都确认不了。
 * 宁可多拦，不可在失去配置可见性的同时继续按放宽的策略跑。
 */

import { DEFAULT_POLICY, validatePolicy, type GuardPolicy } from "@carlife/guardrails";
import type { FreshnessThresholds } from "@carlife/memory";
import { getPrisma, createGuardSettingRepository, type KillSwitch } from "@carlife/db";

import {
  DEFAULT_DISCLAIMER_POLICY,
  DEFAULT_DISCLAIMER_TEXT,
  validateDisclaimerPolicy,
  validateDisclaimerText,
  type DisclaimerPolicy,
  type DisclaimerText,
} from "./disclaimers";

/** 缓存有效期。§8.2 给的口径是"约 30s"。 */
export const POLICY_TTL_MS = 30_000;

export const EMPTY_KILL_SWITCH: KillSwitch = { agents: [], capabilities: [] };

interface CacheEntry<T> {
  value: T;
  at: number;
}

let policyCache: CacheEntry<GuardPolicy> | undefined;
let killSwitchCache: CacheEntry<KillSwitch> | undefined;
let disclaimerPolicyCache: CacheEntry<DisclaimerPolicy> | undefined;
let disclaimerTextCache: CacheEntry<DisclaimerText> | undefined;
let freshnessCache: CacheEntry<FreshnessSettings> | undefined;

/**
 * `guard_settings` 里 `freshness_thresholds` 这一行的形状。
 *
 * 冷却时长与三项阈值同住一行：它们是同一件事的策略面（"多久算旧"与"拒了多久不再问"），
 * 拆成两行只会让运营改一个忘一个。`resolveFreshnessThresholds` 只认那三项，
 * 多出来的 `cooldownDays` 它会忽略——所以同一份值可以直接喂给两边。
 */
export type FreshnessSettings = Partial<FreshnessThresholds> & { cooldownDays?: number };

/** 测试与运维用：强制下一次读穿透缓存。改完策略要立刻验证时用。 */
export function invalidateGuardSettings(): void {
  policyCache = undefined;
  killSwitchCache = undefined;
  disclaimerPolicyCache = undefined;
  disclaimerTextCache = undefined;
  freshnessCache = undefined;
}

function fresh<T>(entry: CacheEntry<T> | undefined, now: number): T | undefined {
  return entry && now - entry.at < POLICY_TTL_MS ? entry.value : undefined;
}

/**
 * 当前生效的策略值。
 *
 * 库里存的是运营写进去的 JSON，**不能信任它的形状**——它可能是上一版结构，
 * 也可能被人手工改过。因此读出来先过 `validatePolicy`：非法就回落到默认并出声，
 * 静默接受一份非法策略等于把"两侧同时 fail-open"这种情况放进生产。
 */
export async function getGuardPolicy(now = Date.now()): Promise<GuardPolicy> {
  const cached = fresh(policyCache, now);
  if (cached) return cached;

  let value = DEFAULT_POLICY;
  try {
    const repo = createGuardSettingRepository(getPrisma());
    const row = await repo.get<GuardPolicy>("policy");
    if (row) {
      const problem = validatePolicy(row.value);
      if (problem) {
        console.error(`[guard] DB 里的策略值非法，已回落到默认：${problem}`);
      } else {
        value = row.value;
      }
    }
  } catch (err) {
    // 读不到就用默认（更严的一侧），并出声。**不沿用旧缓存**——见文件头。
    console.error(
      `[guard] 策略读取失败，本次按默认策略（六类全开）执行：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  policyCache = { value, at: now };
  return value;
}

/** 当前生效的止血开关。读失败回落到"没有关停任何东西"——止血开关的默认是不止血。 */
export async function getKillSwitch(now = Date.now()): Promise<KillSwitch> {
  const cached = fresh(killSwitchCache, now);
  if (cached) return cached;

  let value = EMPTY_KILL_SWITCH;
  try {
    const repo = createGuardSettingRepository(getPrisma());
    const row = await repo.get<KillSwitch>("kill_switch");
    if (row?.value) {
      value = {
        agents: Array.isArray(row.value.agents) ? row.value.agents : [],
        capabilities: Array.isArray(row.value.capabilities) ? row.value.capabilities : [],
      };
    }
  } catch (err) {
    console.error(
      `[guard] 止血开关读取失败，本次视为未关停任何 Agent/能力：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  killSwitchCache = { value, at: now };
  return value;
}

/** 某个 Agent 是否被止血开关关停（F-30-03）。 */
export async function isAgentDisabled(agent: string, now = Date.now()): Promise<boolean> {
  return (await getKillSwitch(now)).agents.includes(agent);
}

/** 某个能力（工具名）是否被止血开关关停。 */
export async function isCapabilityDisabled(tool: string, now = Date.now()): Promise<boolean> {
  return (await getKillSwitch(now)).capabilities.includes(tool);
}

/**
 * 读一项配置并校验，非法或读不到时回落到给定默认值并出声。
 *
 * 抽出来是因为四项的失败处理必须一致：**回落到编译期默认（更保守的一侧），
 * 不沿用旧缓存**。旧值可能是运营刚放宽过的，而此刻连"它还生不生效"都确认不了。
 */
async function readSetting<T>(
  key: "disclaimer_policy" | "disclaimer_text",
  fallback: T,
  validate: (v: T) => string | null,
  label: string,
  now: number,
): Promise<T> {
  try {
    const repo = createGuardSettingRepository(getPrisma());
    const row = await repo.get<T>(key);
    if (!row) return fallback;
    const problem = validate(row.value);
    if (problem) {
      console.error(`[guard] DB 里的${label}非法，已回落到默认：${problem}`);
      return fallback;
    }
    return row.value;
  } catch (err) {
    console.error(
      `[guard] ${label}读取失败，本次按默认执行：${err instanceof Error ? err.message : String(err)}`,
    );
    return fallback;
  }
}

/**
 * 话术开关（F-30-01 的第三档）。
 *
 * 注意**售后免责不可关**这条红线由 `validateDisclaimerPolicy` 守着：
 * 库里若被人塞进 `serviceEnabled: false`，这里判非法并回落到默认（两个都开），
 * 而不是照它执行。安全承诺不能靠配置关掉。
 */
export async function getDisclaimerPolicy(now = Date.now()): Promise<DisclaimerPolicy> {
  const cached = fresh(disclaimerPolicyCache, now);
  if (cached) return cached;
  const value = await readSetting(
    "disclaimer_policy",
    DEFAULT_DISCLAIMER_POLICY,
    validateDisclaimerPolicy,
    "话术开关",
    now,
  );
  disclaimerPolicyCache = { value, at: now };
  return value;
}

/** 话术文案（F-30-02）。校验见 `validateDisclaimerText`：空串与超长都判非法。 */
export async function getDisclaimerText(now = Date.now()): Promise<DisclaimerText> {
  const cached = fresh(disclaimerTextCache, now);
  if (cached) return cached;
  const value = await readSetting(
    "disclaimer_text",
    DEFAULT_DISCLAIMER_TEXT,
    validateDisclaimerText,
    "免责话术",
    now,
  );
  disclaimerTextCache = { value, at: now };
  return value;
}


/**
 * ④⑥ 数据新鲜度阈值（M26-02，F-53-02/03，AC-53-2）。
 *
 * 与上面几项同形：同一张 `guard_settings`（C 策略值）、同一段 TTL、同样的
 * "读不到就回落"。**回落方向与 policy 相反**：那边失去可见性时回落到更严，
 * 这边回落到 `undefined` —— 由 `resolveFreshnessThresholds` 取保守默认（宁可少问）。
 * 理由是这两处的"错"代价不同：Guard 少拦一次是安全事故，
 * 补录多问一次只是烦人，而多问会烧掉一份跨故事共享的打扰预算。
 *
 * 只做**部分覆盖**：库里写了哪几项就覆盖哪几项，没写的沿用代码里的保守默认。
 * 非有限值/非正数在 `resolveFreshnessThresholds` 那一层被忽略，这里不重复校验。
 */
export async function getFreshnessThresholds(
  now = Date.now(),
): Promise<FreshnessSettings | undefined> {
  const cached = fresh(freshnessCache, now);
  if (cached) return cached;

  let value: FreshnessSettings = {};
  try {
    const repo = createGuardSettingRepository(getPrisma());
    const row = await repo.get<FreshnessSettings>("freshness_thresholds");
    if (row?.value && typeof row.value === "object") value = row.value;
  } catch (err) {
    console.error(
      `[freshness] 阈值读取失败，本次按保守默认判定：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  freshnessCache = { value, at: now };
  return value;
}
