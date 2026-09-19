/**
 * [F-10-09] 高德 key 池的用量台账：纯函数部分（M100-01）。
 *
 * 台账要回答"这把 key 今天这一族用了多少"，三个维度各自有一处最容易错的地方：
 *  - 指纹：台账、日志、后台页都不能出现 key 本身；
 *  - 接口族：按路径分，未识别的归 other、不猜；
 *  - 北京日：本机可能在任何时区（`session-row-no-echo` 那三条红就是这么来的），日界只做 UTC+8 算术。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AMAP_API_FAMILIES,
  AMAP_POOL_KEY_PREFIX,
  amapFamilyOf,
  amapKeyFingerprint,
  beijingDay,
  buildAmapPoolSnapshot,
  createMemoryAmapLedger,
  createRedisAmapLedger,
  parseAmapDailyBudget,
  sumByFamily,
  type AmapRedisLike,
} from "../src/amap-ledger";

describe("[F-10-09] 接口族按路径分", () => {
  it("七族各归各的，未知路径归 other", () => {
    assert.equal(amapFamilyOf("/v5/place/text"), "place");
    assert.equal(amapFamilyOf("/v5/place/around"), "place");
    assert.equal(amapFamilyOf("/v3/geocode/geo"), "geocode");
    assert.equal(amapFamilyOf("/v3/geocode/regeo"), "regeo");
    assert.equal(amapFamilyOf("/v3/config/district"), "district");
    assert.equal(amapFamilyOf("/v5/direction/driving"), "direction");
    assert.equal(amapFamilyOf("/v3/direction/transit/integrated"), "transit");
    assert.equal(amapFamilyOf("/v3/weather/weatherInfo"), "weather");
    assert.equal(amapFamilyOf("/v4/whatever"), "other");
  });
});

describe("[F-10-09] 指纹与日界", () => {
  it("指纹是 sha1 前 8 位，稳定且不含 key 本身", () => {
    const fp = amapKeyFingerprint("secret-abc");
    assert.match(fp, /^[0-9a-f]{8}$/);
    assert.equal(fp, amapKeyFingerprint("secret-abc"));
    assert.notEqual(fp, amapKeyFingerprint("secret-abd"));
    assert.ok(!fp.includes("secret"));
  });

  it("北京日只做 UTC+8 算术：15:59:59Z 还是 16 日，16:00:00Z 起是 17 日，与本机 TZ 无关", () => {
    assert.equal(beijingDay(Date.UTC(2026, 8, 16, 15, 59, 59)), "2026-09-16");
    assert.equal(beijingDay(Date.UTC(2026, 8, 16, 16, 0, 0)), "2026-09-17");
    assert.equal(beijingDay(Date.UTC(2026, 8, 16, 17, 30)), "2026-09-17");
    const saved = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      assert.equal(beijingDay(Date.UTC(2026, 8, 16, 17, 30)), "2026-09-17");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe("[F-10-09] 内存台账", () => {
  const T = Date.UTC(2026, 8, 16, 4); // 北京 12:00

  it("record 返回该族今日累计（四种结局相加）；snapshot 分列存", async () => {
    const l = createMemoryAmapLedger();
    assert.equal(await l.record("fp1", "place", "ok", T), 1);
    assert.equal(await l.record("fp1", "place", "rate_limited", T + 1), 2);
    assert.equal(await l.record("fp1", "geocode", "ok", T + 2), 1, "另一族另算");
    assert.equal(await l.record("fp2", "place", "ok", T + 3), 1, "另一把 key 另算");
    const snap = await l.snapshot("2026-09-16");
    assert.deepEqual(snap, {
      fp1: { "place:ok": 1, "place:rate_limited": 1, "geocode:ok": 1 },
      fp2: { "place:ok": 1 },
    });
    assert.deepEqual(sumByFamily(snap.fp1), { place: 2, geocode: 1 });
    assert.deepEqual(sumByFamily(undefined), {});
  });

  it("跨北京日界的账分开记", async () => {
    const l = createMemoryAmapLedger();
    await l.record("fp1", "place", "ok", Date.UTC(2026, 8, 16, 15, 59));
    await l.record("fp1", "place", "ok", Date.UTC(2026, 8, 16, 16, 1));
    assert.deepEqual(await l.snapshot("2026-09-16"), { fp1: { "place:ok": 1 } });
    assert.deepEqual(await l.snapshot("2026-09-17"), { fp1: { "place:ok": 1 } });
  });

  it("退役 / 复活：复活时留一条「退役了几小时」的观测", async () => {
    const l = createMemoryAmapLedger();
    await l.retire("fp1", { at: T, family: "place", infocode: "10044" });
    assert.deepEqual(await l.retired(), { fp1: { at: T, family: "place", infocode: "10044" } });
    await l.revive("fp1", T + 5.5 * 3_600_000);
    assert.deepEqual(await l.retired(), {});
    const obs = l.resetObserved();
    assert.equal(obs.length, 1);
    assert.equal(obs[0]!.hours, 5.5);
  });
});

describe("[F-10-09] AMAP_DAILY_BUDGET 解析", () => {
  it("合法片段进表，0 与缺省是不设限，非法片段 warn 跳过", () => {
    const warns: string[] = [];
    const b = parseAmapDailyBudget("place=450, direction=0 ,bogus,geocode=x,weather=-1", (m) => warns.push(m));
    assert.deepEqual(b, { place: 450 });
    assert.equal(warns.length, 3, `bogus / geocode=x / weather=-1 各一条，实际 ${warns.join(" | ")}`);
    assert.deepEqual(parseAmapDailyBudget(undefined), {});
    assert.deepEqual(parseAmapDailyBudget("  "), {});
  });

  it("族名闭集与 AMAP_API_FAMILIES 一致", () => {
    for (const f of AMAP_API_FAMILIES) assert.deepEqual(parseAmapDailyBudget(`${f}=3`, () => {}), { [f]: 3 });
  });
});

/**
 * [F-10-09] Redis 台账（M100-02）：三进程同一份账。
 * 用一个内存替身当 Redis：命令语义照 redis@4 的返回形状写，两份台账实例共用同一个替身就是"两个进程"。
 */
describe("[F-10-09] Redis 台账（M100-02）", () => {
  const T = Date.UTC(2026, 8, 16, 4); // 北京 12:00
  const H = 3_600_000;

  class FakeRedis implements AmapRedisLike {
    hashes = new Map<string, Map<string, number>>();
    strings = new Map<string, string>();
    lists = new Map<string, string[]>();
    ttl = new Map<string, number>();
    failHIncrBy = false;
    allKeys(): string[] {
      return [...this.hashes.keys(), ...this.strings.keys(), ...this.lists.keys()];
    }
    async hIncrBy(key: string, field: string, by: number): Promise<number> {
      if (this.failHIncrBy) throw new Error("ECONNRESET");
      const h = this.hashes.get(key) ?? new Map<string, number>();
      this.hashes.set(key, h);
      const v = (h.get(field) ?? 0) + by;
      h.set(field, v);
      return v;
    }
    async hmGet(key: string, fields: string[]): Promise<Array<string | null>> {
      const h = this.hashes.get(key);
      return fields.map((f) => (h?.has(f) ? String(h.get(f)) : null));
    }
    async hGetAll(key: string): Promise<Record<string, string>> {
      return Object.fromEntries([...(this.hashes.get(key) ?? [])].map(([f, v]) => [f, String(v)]));
    }
    async expire(key: string, seconds: number): Promise<void> {
      this.ttl.set(key, seconds);
    }
    async scan(_cursor: number, options: { MATCH: string }): Promise<{ cursor: number; keys: string[] }> {
      const prefix = options.MATCH.endsWith("*") ? options.MATCH.slice(0, -1) : options.MATCH;
      return { cursor: 0, keys: this.allKeys().filter((k) => k.startsWith(prefix)) };
    }
    async set(key: string, value: string, options: { EX: number }): Promise<void> {
      this.strings.set(key, value);
      this.ttl.set(key, options.EX);
    }
    async get(key: string): Promise<string | null> {
      return this.strings.get(key) ?? null;
    }
    async del(key: string): Promise<void> {
      this.strings.delete(key);
    }
    async lPush(key: string, element: string): Promise<void> {
      const l = this.lists.get(key) ?? [];
      l.unshift(element);
      this.lists.set(key, l);
    }
    async lTrim(key: string, start: number, stop: number): Promise<void> {
      this.lists.set(key, (this.lists.get(key) ?? []).slice(start, stop + 1));
    }
    async lRange(key: string, start: number, stop: number): Promise<string[]> {
      return (this.lists.get(key) ?? []).slice(start, stop + 1);
    }
  }
  const ledgerOn = (fake: FakeRedis, warn: (m: string) => void = () => {}, now = () => T) =>
    createRedisAmapLedger("redis://fake", { clientFactory: async () => fake, warn, now });

  it("两个实例各记 5 次，读到 10；键都在 amap:pool: 下并带 3 天 TTL", async () => {
    const fake = new FakeRedis();
    const l1 = ledgerOn(fake);
    const l2 = ledgerOn(fake);
    assert.equal(await l1.ready(), "redis");
    let last = 0;
    for (let i = 0; i < 5; i += 1) last = await l1.record("fp1", "place", "ok", T + i);
    assert.equal(last, 5);
    for (let i = 0; i < 5; i += 1) last = await l2.record("fp1", "place", i % 2 ? "rate_limited" : "ok", T + 10 + i);
    assert.equal(last, 10, "record 返回该族四种结局之和");
    const snap = await l1.snapshot("2026-09-16");
    assert.deepEqual(snap, { fp1: { "place:ok": 8, "place:rate_limited": 2 } });
    assert.deepEqual(sumByFamily(snap.fp1), { place: 10 });
    assert.ok(fake.allKeys().every((k) => k.startsWith(AMAP_POOL_KEY_PREFIX)), `键前缀：${fake.allKeys().join(",")}`);
    assert.equal(fake.ttl.get(`${AMAP_POOL_KEY_PREFIX}usage:2026-09-16:fp1`), 3 * 24 * 3600);
    assert.deepEqual(await l2.snapshot("2026-09-17"), {}, "别的日子是空表");
  });

  it("退役跨实例可见、带 36 小时兜底 TTL；复活删键并留一条观测", async () => {
    const fake = new FakeRedis();
    const l1 = ledgerOn(fake);
    const l2 = ledgerOn(fake);
    await l1.retire("fp1", { at: T, family: "place", infocode: "10044" });
    assert.deepEqual(await l2.retired(), { fp1: { at: T, family: "place", infocode: "10044" } });
    assert.equal(fake.ttl.get(`${AMAP_POOL_KEY_PREFIX}retired:fp1`), 36 * 3600);
    await l2.revive("fp1", T + 2.5 * H);
    assert.deepEqual(await l1.retired(), {});
    const obs = await l1.observations();
    assert.equal(obs.length, 1);
    assert.equal(obs[0]!.fp, "fp1");
    assert.equal(obs[0]!.hours, 2.5);
    assert.ok(!fake.strings.has(`${AMAP_POOL_KEY_PREFIX}retired:fp1`));
  });

  it("hIncrBy 抛错：record 不抛、返回本进程计数、warn 每分钟至多一条；snapshot 退回内存", async () => {
    const fake = new FakeRedis();
    fake.failHIncrBy = true;
    const warns: string[] = [];
    let t = T;
    const l = ledgerOn(fake, (m) => warns.push(m), () => t);
    assert.equal(await l.record("fp1", "place", "ok", T), 1);
    t += 1000;
    assert.equal(await l.record("fp1", "place", "ok", T), 2);
    assert.equal(warns.length, 1, `一分钟内只提示一次，实际 ${warns.join(" | ")}`);
    t += 60_000;
    await l.record("fp1", "place", "ok", T);
    assert.equal(warns.length, 2);
    // 全表以 Redis 为准：它连着、只是这几笔没写进去，全表就是空的——丢的几笔只体现在 record 的返回值里。
    assert.deepEqual(await l.snapshot("2026-09-16"), {});
  });

  it("连不上：ready 是 memory、warn 一条，其后全部走进程内", async () => {
    const warns: string[] = [];
    const l = createRedisAmapLedger("redis://nowhere", {
      clientFactory: async () => {
        throw new Error("ECONNREFUSED");
      },
      warn: (m) => warns.push(m),
    });
    assert.equal(await l.ready(), "memory");
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /连不上/);
    assert.equal(await l.record("fp1", "geocode", "ok", T), 1);
    await l.retire("fp1", { at: T, family: "geocode", infocode: "10003" });
    assert.deepEqual(Object.keys(await l.retired()), ["fp1"]);
    await l.revive("fp1", T + H);
    assert.equal((await l.observations())[0]!.hours, 1);
  });
});

/**
 * [F-43-05][F-39-10] 池子快照：probe 与财务页共用的那一段组装（M100-03）。
 * 它只接受名字与指纹——**结构上就拿不到 key 本身**，这是"后台页不泄 key"最硬的一道。
 */
describe("[F-43-05] buildAmapPoolSnapshot（M100-03）", () => {
  const T = Date.UTC(2026, 8, 16, 4); // 北京 12:00
  const REFS = [
    { name: "AMAP_SERVER_KEY", fp: "aaaa1111" },
    { name: "AMAP_SERVER_KEY_2", fp: "bbbb2222" },
  ];

  it("有预算的族算出 ratio，没预算的族只有次数；退役的带 retiredAt 与 infocode", async () => {
    const l = createMemoryAmapLedger();
    for (let i = 0; i < 45; i += 1) await l.record("aaaa1111", "place", "ok", T);
    await l.record("aaaa1111", "geocode", "ok", T);
    await l.record("bbbb2222", "place", "quota_exhausted", T);
    await l.retire("bbbb2222", { at: T - 3_600_000, family: "place", infocode: "10044" });

    const snap = await buildAmapPoolSnapshot(REFS, l, { place: 450 }, T);
    assert.equal(snap.day, "2026-09-16");
    assert.equal(snap.source, "memory");
    const [a, b] = snap.keys;
    assert.deepEqual(a!.usage, { place: 45, geocode: 1 });
    assert.deepEqual(a!.budget, { place: 450 });
    assert.equal(a!.ratio!.place, 0.1);
    assert.equal(a!.ratio!.geocode, undefined, "没有预算的族不编占比");
    assert.equal(a!.retiredAt, undefined);
    assert.equal(b!.retiredAt, T - 3_600_000);
    assert.equal(b!.retiredInfocode, "10044");
    assert.ok(!JSON.stringify(snap).includes("AMAP_SERVER_KEY="), "快照里只有名字与指纹");
  });

  it("没有预算时 budget / ratio 两项都不出现；没有台账时 source 是 none 且各把 usage 为空", async () => {
    const l = createMemoryAmapLedger();
    await l.record("aaaa1111", "place", "ok", T);
    const noBudget = await buildAmapPoolSnapshot(REFS, l, {}, T);
    assert.equal(noBudget.keys[0]!.budget, undefined);
    assert.equal(noBudget.keys[0]!.ratio, undefined);
    assert.deepEqual(noBudget.keys[0]!.usage, { place: 1 });

    const none = await buildAmapPoolSnapshot(REFS, undefined, { place: 450 }, T);
    assert.equal(none.source, "none");
    assert.deepEqual(none.keys.map((k) => k.usage), [{}, {}]);
    assert.deepEqual(none.observations, []);
  });

  it("复活观测随快照带出来（最新在前）", async () => {
    const l = createMemoryAmapLedger();
    await l.retire("aaaa1111", { at: T, family: "place", infocode: "10044" });
    await l.revive("aaaa1111", T + 4 * 3_600_000);
    const snap = await buildAmapPoolSnapshot(REFS, l, {}, T);
    assert.equal(snap.observations.length, 1);
    assert.equal(snap.observations[0]!.hours, 4);
  });
});
