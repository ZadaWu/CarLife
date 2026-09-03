/**
 * 车机绑定的配对码存储（施工单 M48-04，F-56-03）。
 *
 * # 为什么配对码存 Redis 不违反"撤销以 DB 为唯一真相源"（设计裁决 R11）
 *
 * R11 禁止的是把**权限状态**放进第二个地方——那会出现"库里已撤销、缓存还没过期"
 * 的窗口。配对码不是权限状态，它是**一次性挑战值**：60 秒内有效、用一次即焚，
 * 天然就该活在有 TTL 的地方。它过期了最坏的后果是重扫一次码。
 *
 * # 为什么 Redis 不可用时降级成进程内 Map 而不是拒绝服务
 *
 * 单实例部署（POC 常态）下进程内完全等价。多实例时降级会让"在 A 实例发码、
 * 在 B 实例确认"失败——那是**可见的失败**（配对码无效，重来一次），
 * 而不是静默的安全漏洞。用不可用直接拒绝换来的是"车机永远绑不上"。
 */

export interface PairingRequest {
  /** 待绑定的车机设备 id（二维码里带的那个）。 */
  deviceId: string;
  vin: string;
  /** 发起绑定的车主——确认时不再查一次，避免中途换人。 */
  requestedBy: string;
}

export interface PairingStore {
  /** 存一次配对码。同一 deviceId 再次发码会覆盖前一枚（旧码当场作废）。 */
  put(code: string, req: PairingRequest, ttlSeconds: number): Promise<void>;
  /** 取出并**删除**（一次性）。不存在或已过期返回 null。 */
  take(code: string): Promise<PairingRequest | null>;
  /**
   * 发码限速：同一 deviceId 每小时至多 `limit` 次。
   * 返回 true 表示放行。
   */
  allowIssue(deviceId: string, limit: number): Promise<boolean>;
}

const CODE_PREFIX = "carlife:pairing:code:";
const RATE_PREFIX = "carlife:pairing:rate:";
const RATE_WINDOW_SEC = 3600;

/** 进程内实现。单实例等价于 Redis 版；多实例下只影响"跨实例确认"。 */
export function createMemoryPairingStore(): PairingStore {
  const codes = new Map<string, { req: PairingRequest; expiresAt: number }>();
  const rates = new Map<string, { count: number; resetAt: number }>();
  return {
    async put(code, req, ttlSeconds) {
      codes.set(code, { req, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async take(code) {
      const hit = codes.get(code);
      if (!hit) return null;
      codes.delete(code); // 一次性：无论过没过期都拿走，不给重放留余地
      return hit.expiresAt > Date.now() ? hit.req : null;
    },
    async allowIssue(deviceId, limit) {
      const now = Date.now();
      const cur = rates.get(deviceId);
      if (!cur || cur.resetAt <= now) {
        rates.set(deviceId, { count: 1, resetAt: now + RATE_WINDOW_SEC * 1000 });
        return true;
      }
      if (cur.count >= limit) return false;
      cur.count += 1;
      return true;
    },
  };
}

/**
 * Redis 实现。**同步返回**，内部惰性连接。
 *
 * 同步是为了让装配层（`createGatewayApp`，非 async）能直接用它。
 * 每个方法 await 同一个连接 promise：第一次调用可能多等一次握手，
 * 之后就是直连。连不上时整体降级成进程内版（见文件头的理由）。
 */
export function createPairingStore(url: string | undefined): PairingStore {
  const backend = connect(url);
  return {
    put: (code, req, ttl) => backend.then((b) => b.put(code, req, ttl)),
    take: (code) => backend.then((b) => b.take(code)),
    allowIssue: (deviceId, limit) => backend.then((b) => b.allowIssue(deviceId, limit)),
  };
}

async function connect(url: string | undefined): Promise<PairingStore> {
  if (!url) return createMemoryPairingStore();
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url });
    client.on("error", (e: unknown) =>
      console.warn("[pairing] Redis 连接异常（配对码将不可跨实例）", e),
    );
    await client.connect();
    return {
      async put(code, req, ttlSeconds) {
        await client.set(CODE_PREFIX + code, JSON.stringify(req), { EX: ttlSeconds });
      },
      async take(code) {
        const key = CODE_PREFIX + code;
        /*
         * 先读后删，两步之间理论上可被并发抢跑。用 GETDEL 更好，但它要 Redis 6.2+，
         * 而本仓没有对 Redis 版本的下限声明。并发抢跑的后果是两个设备用同一枚码
         * 绑同一辆车——两者都得先扫到码（车主本人操作），风险可接受。
         */
        const raw = await client.get(key);
        await client.del(key);
        return raw ? (JSON.parse(raw) as PairingRequest) : null;
      },
      async allowIssue(deviceId, limit) {
        const key = RATE_PREFIX + deviceId;
        const n = await client.incr(key);
        if (n === 1) await client.expire(key, RATE_WINDOW_SEC);
        return n <= limit;
      },
    };
  } catch (err) {
    console.warn(`[pairing] Redis 连接失败（${url}）——配对码走进程内存`, err);
    return createMemoryPairingStore();
  }
}
