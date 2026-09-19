/**
 * 字段级对称加密的共用实现（AES-256-GCM + scrypt 派生 + 版本前缀）。
 *
 * # 为什么提炼，以及提炼的**不是**钥匙
 *
 * 配置密钥（`config/crypto.ts`）与 PII（`pii/crypto.ts`）本来是两份逐行同构的
 * 代码，各自文件头都写明**刻意不共钥**：轮换周期与泄露影响面不同，共钥意味着
 * 换任何一把都得重加密两类数据。提炼时是日历凭证要成为第三份（Rule of Three），
 * 把**算法**收进这里，**钥匙仍是各的**（每个实例一把 `envVar`、一撮盐、
 * 一个前缀）。这一层不知道也不关心有几把钥匙。
 *
 * **日历那份后来随 FL-31 一起下线了，于是现在只有两个实例。** 保留这层提炼是
 * 因为它已经写完且被兼容测试锁死格式，回退只是把重复加回去；但也别据此以为
 * "两份就该提炼" —— 当初的判据是第三份。
 *
 * # 密文格式由参数完全决定，所以迁移是零风险的
 *
 * `<prefix>:<iv-b64>:<tag-b64>:<data-b64>`。既有两处改成取实例后，
 * 只要 prefix/salt/envVar 照原样传，产出与解读的字节与之前一模一样 ——
 * `test/field-cipher-compat.test.ts` 用**硬编码的历史密文**守着这条，
 * 它是这次提炼的安全绳，改这个文件前先看它还绿不绿。
 *
 * # 两处刻意保留的差异，都参数化了
 *
 *  - `passthroughUnprefixed`：PII 对**无前缀**的值原样返回。那不是"降级成明文"，
 *    是迁移期兼容读 —— 存量明文行在跑迁移脚本前也要能被读出来。配置侧没有这个
 *    需要，格式不对就是不对。
 *  - `makeError`：两边的错误类被 `instanceof` 消费（`config/startup.ts` 按它
 *    区分"缺钥"与"其它异常"），所以类必须留在各自文件里，由调用方传构造器进来。
 *
 * # 没有"降级成明文"的路径
 *
 * 主密钥缺失/过短一律抛错。静默回退明文等于这一层不存在。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const KEY_LEN = 32;
const IV_LEN = 12;
/** 主密钥最短长度。低于它的值熵不足以撑住固定盐的 scrypt。 */
const MIN_MASTER_LEN = 16;

export interface FieldCipherSpec {
  /** 版本前缀，可含冒号（`v1` / `pii:v1` / `cal:v1`）。换算法时换它。 */
  prefix: string;
  /** 固定盐。主密钥本身已是高熵注入值，故不随行变化。 */
  salt: string;
  /** 主密钥的环境变量名。**每次调用时读**，不在构造时定死（测试要能改）。 */
  envVar: string;
  /** 无前缀的值原样返回（迁移期兼容读）。缺省 false：格式不对即抛。 */
  passthroughUnprefixed?: boolean;
  /** 缺钥/自检失败时抛什么。各家的错误类被 `instanceof` 消费，故由外部给。 */
  makeError: (reason: string) => Error;
  /** 格式错话术里的主语（"配置" / "PII"）。 */
  label: string;
}

export interface FieldCipher {
  encrypt(plain: string, master?: string): string;
  decrypt(stored: string, master?: string): string;
  isCiphertext(value: string): boolean;
  /** 启动期自检：主密钥可用且能完成一次加解密往返。 */
  assertUsable(master?: string): void;
}

export function createFieldCipher(spec: FieldCipherSpec): FieldCipher {
  const marker = `${spec.prefix}:`;
  // 前缀自带的段数：`v1` 占 1 段、`pii:v1` 占 2 段。密文总段数 = 它 + iv/tag/data。
  const prefixSegments = spec.prefix.split(":").length;
  const totalSegments = prefixSegments + 3;

  // 派生一次 scrypt 要几十毫秒，而主密钥在进程生命周期内不变 ——
  // 缓存是必需的而不是优化。每个实例一份（钥匙不共享，缓存自然也不共享）。
  let cachedKey: Buffer | undefined;
  let cachedMaster: string | undefined;

  /** `??` 而不是默认参数：显式传 `""` 要走"缺钥"而不是回落到环境变量。 */
  const resolveMaster = (master: string | undefined): string | undefined =>
    master ?? process.env[spec.envVar];

  function derive(master: string | undefined): Buffer {
    if (!master) throw spec.makeError("未设置");
    if (master.length < MIN_MASTER_LEN) {
      throw spec.makeError(`长度不足 ${MIN_MASTER_LEN} 字符`);
    }
    if (cachedKey && cachedMaster === master) return cachedKey;
    cachedKey = scryptSync(master, spec.salt, KEY_LEN);
    cachedMaster = master;
    return cachedKey;
  }

  function isCiphertext(value: string): boolean {
    return value.startsWith(marker);
  }

  function malformed(): Error {
    return new Error(`${spec.label}密文格式非法（期望 ${spec.prefix}:iv:tag:data）`);
  }

  function encrypt(plain: string, master?: string): string {
    const key = derive(resolveMaster(master));
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [
      spec.prefix,
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      enc.toString("base64"),
    ].join(":");
  }

  /**
   * 解密。有前缀但解不开（错钥/密文损坏）**抛错** —— 返回密文串会让下游把
   * `pii:v1:...` 当成手机号用出去，那比报错糟糕得多。
   */
  function decrypt(stored: string, master?: string): string {
    if (!isCiphertext(stored)) {
      if (spec.passthroughUnprefixed) return stored;
      throw malformed();
    }
    const parts = stored.split(":");
    if (parts.length !== totalSegments) throw malformed();
    const [ivB64, tagB64, dataB64] = parts.slice(prefixSegments);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derive(resolveMaster(master)),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  // 具名函数而不是 `this.decrypt`：这四个会被各家 crypto 模块**解构后再导出**
  // （`export const encryptPii = cipher.encrypt` 那种写法），带 this 的实现
  // 一解构就断。
  function assertUsable(master?: string): void {
    const probe = `carlife-${spec.prefix}-key-probe`;
    if (decrypt(encrypt(probe, master), master) !== probe) {
      throw spec.makeError("加解密自检失败");
    }
  }

  return { encrypt, decrypt, isCiphertext, assertUsable };
}
