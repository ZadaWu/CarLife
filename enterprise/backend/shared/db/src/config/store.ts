/**
 * 配置存储与读取层（施工单 M3-02）。
 *
 * 两条互不相通的出口，**从类型上杜绝把明文送到接口层**：
 *   `runtimeValues()`   → 解密后的真实值，仅服务端内部消费（provider 构造）
 *   `displayItems()`    → 掩码 + 来源 + 验证状态，给 HTTP 层
 *
 * 优先级固定：**DB > 环境变量 > 代码默认值**，且每一项都带 `source` 标注
 * 让"当前生效值到底来自哪一层"可见（AC-35-5）。
 *
 * 缓存：TTL 默认 30s（与 §8.2 同量级）。**DB 不可用时返回上次缓存值**并打错误日志——
 * 配置层的故障不应放大成业务故障（AC-35-4 的非功能面）。
 * 两个进程各自缓存，因此写入后最长 TTL 内可能不一致，这是已知取舍（M3-02 风险栏）。
 */

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { resolveDeepSeekModel } from "@carlife/shared";

import { decryptSecret, encryptSecret } from "./crypto";
import { maskSecret } from "./mask";
import {
  CONFIG_REGISTRY,
  findConfigDef,
  isWritable,
  type ConfigDef,
  type ConfigScope,
} from "./registry";

export type ConfigSource = "db" | "env" | "default" | "unset";

export interface ConfigDisplayItem {
  key: string;
  scope: ConfigScope;
  isSecret: boolean;
  writable: boolean;
  required: boolean;
  /** 掩码后的展示值；`null` 表示未配置 */
  value: string | null;
  source: ConfigSource;
  description: string;
  howToObtain?: string;
  /** 闭集取值（见 registry 的 `options`）。有它的项界面渲染成下拉。 */
  options?: readonly string[];
  updatedBy: string | null;
  updatedAt: string | null;
  verifiedAt: string | null;
}

export interface ConfigWrite {
  key: string;
  value: string;
}

interface Snapshot {
  /** 解密后的 DB 值 */
  db: Map<string, string>;
  meta: Map<string, { updatedBy: string | null; updatedAt: Date; verifiedAt: Date | null }>;
  /** 版本号：DB 侧最近一次写入时间戳，provider 工厂据此失效缓存 */
  version: number;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 30_000;

export type ConfigStore = ReturnType<typeof createConfigStore>;

export function createConfigStore(
  prisma: PrismaClient,
  opts: { ttlMs?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const ttlMs = opts.ttlMs ?? Number(process.env.CARLIFE_CONFIG_TTL_MS ?? DEFAULT_TTL_MS);
  const env = opts.env ?? process.env;

  let cache: Snapshot | undefined;
  let inflight: Promise<Snapshot> | undefined;

  async function load(): Promise<Snapshot> {
    const rows = await prisma.configItem.findMany();
    const db = new Map<string, string>();
    const meta = new Snapshot_MetaMap();
    let version = 0;

    for (const row of rows) {
      const def = findConfigDef(row.key);
      if (!def) continue; // 注册表里没有的历史项：忽略而不是暴露
      try {
        db.set(row.key, row.isSecret ? decryptSecret(row.value) : row.value);
      } catch (err) {
        // 解密失败（换过主密钥）：跳过该项，回落 env/default，并大声报错
        console.error(`[config] 解密失败 key=${row.key}（主密钥是否变更？）`, err);
        continue;
      }
      meta.set(row.key, {
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
        verifiedAt: row.verifiedAt,
      });
      version = Math.max(version, row.updatedAt.getTime());
    }
    return { db, meta, version, fetchedAt: Date.now() };
  }

  async function snapshot(): Promise<Snapshot> {
    if (cache && Date.now() - cache.fetchedAt < ttlMs) return cache;
    inflight ??= load()
      .then((s) => {
        cache = s;
        return s;
      })
      .catch((err) => {
        console.error("[config] 读取失败，沿用上次缓存值", err);
        if (cache) return cache;
        throw err;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  function canonicalValue(def: ConfigDef, value: string): string {
    if (def.key !== "DEEPSEEK_MODEL" || value.trim() === "") return value;
    return resolveDeepSeekModel(value);
  }

  /** env-override 项当前是否被部署层钉死（env 在场且非空）。 */
  function pinnedByEnv(def: ConfigDef): boolean {
    if (def.storage !== "env-override") return false;
    const v = env[def.envFallback];
    return v !== undefined && v !== "";
  }

  function resolve(def: ConfigDef, snap: Snapshot): { value: string | null; source: ConfigSource } {
    // env-override（ACR-017）：env 优先于 db——部署层钉档的语义。
    // 不在场时落回下面的 db → env → default 常规顺序（env 一定也不在场，等价于 db → default）。
    if (pinnedByEnv(def)) {
      return { value: canonicalValue(def, env[def.envFallback] as string), source: "env" };
    }
    if (def.storage === "db" || def.storage === "env-override") {
      const fromDb = snap.db.get(def.key);
      if (fromDb !== undefined && fromDb !== "") {
        return { value: canonicalValue(def, fromDb), source: "db" };
      }
    }
    const fromEnv = env[def.envFallback];
    if (fromEnv !== undefined && fromEnv !== "") {
      return { value: canonicalValue(def, fromEnv), source: "env" };
    }
    if (def.default !== undefined) return { value: def.default, source: "default" };
    return { value: null, source: "unset" };
  }

  const api = {
    /** 当前配置版本（DB 侧最近写入时间戳）；provider 工厂用它判断要不要重建。 */
    async version(): Promise<number> {
      return (await snapshot()).version;
    },

    /** 内部消费：解密后的真实值。**不要把它的返回值送进任何 HTTP 响应**。 */
    async runtimeValues(): Promise<Map<string, string>> {
      const snap = await snapshot();
      const out = new Map<string, string>();
      for (const def of CONFIG_REGISTRY) {
        const { value } = resolve(def, snap);
        if (value !== null) out.set(def.key, value);
      }
      return out;
    },

    async get(key: string): Promise<string | undefined> {
      const def = findConfigDef(key);
      if (!def) return undefined;
      const { value } = resolve(def, await snapshot());
      return value ?? undefined;
    },

    /** HTTP 层消费：掩码 + 来源 + 验证状态。 */
    async displayItems(): Promise<ConfigDisplayItem[]> {
      const snap = await snapshot();
      return CONFIG_REGISTRY.map((def) => {
        const { value, source } = resolve(def, snap);
        const m = snap.meta.get(def.key);
        return {
          key: def.key,
          scope: def.scope,
          isSecret: def.class === "secret",
          // env-override 被钉死时界面按只读渲染——否则用户会填完点保存才被拒。
          writable: isWritable(def) && !pinnedByEnv(def),
          required: def.required === true,
          value: value === null ? null : def.class === "secret" ? maskSecret(value) : value,
          source,
          description: def.description,
          howToObtain: def.howToObtain,
          options: def.options,
          updatedBy: m?.updatedBy ?? null,
          updatedAt: m?.updatedAt.toISOString() ?? null,
          verifiedAt: m?.verifiedAt?.toISOString() ?? null,
        };
      });
    },
  };

  /**
   * 写入。返回被拒绝的项及原因（不抛错，便于界面逐项展示）。
   * `verified` 为 false 时清空 `verifiedAt` —— 强制保存的项要在视图里显示"未验证"。
   *
   * 提成独立函数（而不是对象方法）是为了让 rollback 能直接复用，
   * 不依赖调用点的 `this` 绑定。
   */
  async function write(
    writes: readonly ConfigWrite[],
    actor: string,
    opts: { verified: boolean },
  ): Promise<{ accepted: string[]; rejected: Array<{ key: string; reason: string }> }> {
      const accepted: string[] = [];
      const rejected: Array<{ key: string; reason: string }> = [];

      for (const w of writes) {
        const def = findConfigDef(w.key);
        if (!def) {
          rejected.push({ key: w.key, reason: "未在配置注册表中" });
          continue;
        }
        if (!isWritable(def)) {
          rejected.push({
            key: w.key,
            reason:
              def.storage === "env-only"
                ? "引导层配置只能由部署环境注入"
                : "该项当前为只读",
          });
          continue;
        }
        // env-override 被部署层钉死时拒绝写入（ACR-017）——不做"落库但不生效"：
        // 那会在某天删掉 env 后冒出一个早已忘记的旧值。
        if (pinnedByEnv(def)) {
          rejected.push({
            key: w.key,
            reason: `该项当前被环境变量钉死（.env 的 ${def.envFallback}），后台修改不生效；要热切请先从 .env 移除该行并重启网关`,
          });
          continue;
        }
        // 旧模型名只允许作为兼容输入；写入时立即存成当前基线，
        // 避免数据库继续积累废弃值。
        const value = canonicalValue(def, w.value);
        const invalid = value === "" ? null : def.validate?.(value);
        if (invalid) {
          rejected.push({ key: w.key, reason: invalid });
          continue;
        }

        const isSecret = def.class === "secret";
        const stored = isSecret && value !== "" ? encryptSecret(value) : value;

        // 变更历史（M3-06 F-35-07）：**密钥类只记"变更过"，不留旧值**。
        // 为了能回滚而保留一份旧密文，等于给泄露多开一个面。
        const previous = await prisma.configItem.findUnique({ where: { key: def.key } });
        if (previous) {
          await prisma.configItemRevision.create({
            data: {
              id: `rev-${randomUUID()}`,
              key: def.key,
              changedBy: actor,
              isSecret,
              prevValue: isSecret ? null : canonicalValue(def, previous.value),
              prevVerifiedAt: previous.verifiedAt,
            },
          });
        }

        await prisma.configItem.upsert({
          where: { key: def.key },
          create: {
            key: def.key,
            value: stored,
            isSecret,
            updatedBy: actor,
            verifiedAt: opts.verified ? new Date() : null,
          },
          update: {
            value: stored,
            isSecret,
            updatedBy: actor,
            verifiedAt: opts.verified ? new Date() : null,
          },
        });
        accepted.push(def.key);
      }

    if (accepted.length > 0) cache = undefined; // 本进程立即失效；其它进程等 TTL
    return { accepted, rejected };
  }

  return {
    ...api,
    write,

    /** 变更历史（M3-06 F-35-07）：最近 N 条，密钥类的 prevValue 恒为 null。 */
    async revisions(key: string, limit = 10) {
      const rows = await prisma.configItemRevision.findMany({
        where: { key },
        orderBy: { changedAt: "desc" },
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        changedAt: r.changedAt.toISOString(),
        changedBy: r.changedBy,
        isSecret: r.isSecret,
        /** 密钥类永远拿不到旧值——这是设计不是缺陷 */
        restorable: !r.isSecret && r.prevValue !== null,
      }));
    },

    /**
     * 回滚到上一版本（M3-06 F-35-07）。
     *
     * B 类可完整回滚；**A 类不行**——旧值从未被保存，只能重新填。
     * 界面必须把这一点说清楚，不能让人以为点一下就能恢复密钥。
     */
    async rollback(
      key: string,
      actor: string,
    ): Promise<{ ok: boolean; reason?: string; restoredValue?: string }> {
      const def = findConfigDef(key);
      if (!def) return { ok: false, reason: "未在配置注册表中" };
      if (!isWritable(def)) return { ok: false, reason: "该项不可写" };
      if (def.class === "secret") {
        return {
          ok: false,
          reason: "密钥类不保存旧值（不为回滚而留一份旧密文）——请重新填写新值",
        };
      }

      const last = await prisma.configItemRevision.findFirst({
        where: { key },
        orderBy: { changedAt: "desc" },
      });
      if (!last || last.prevValue === null) return { ok: false, reason: "没有可回滚的历史版本" };

      const restoredValue = canonicalValue(def, last.prevValue);
      await write([{ key, value: restoredValue }], actor, {
        verified: last.prevVerifiedAt !== null,
      });
      return { ok: true, restoredValue };
    },

    /** 探活通过后单独打标（M3-03 消费）。 */
    async markVerified(keys: readonly string[]): Promise<void> {
      if (keys.length === 0) return;
      await prisma.configItem.updateMany({
        where: { key: { in: [...keys] } },
        data: { verifiedAt: new Date() },
      });
      cache = undefined;
    },

    /** 仅测试/脚本用：丢弃缓存。 */
    invalidate(): void {
      cache = undefined;
    },
  };
}

/** 小工具类：让 Snapshot.meta 的类型写起来短一点。 */
class Snapshot_MetaMap extends Map<
  string,
  { updatedBy: string | null; updatedAt: Date; verifiedAt: Date | null }
> {}
