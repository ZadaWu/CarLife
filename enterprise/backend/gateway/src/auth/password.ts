/**
 * 口令散列（施工单 M48-02，FL-07 F-07-01）。
 *
 * # 为什么是 node 内置 scrypt，不是 bcrypt
 *
 * 设计文档写的是"bcrypt cost 12"。落地时改成 `node:crypto` 的 scrypt，理由是
 * **依赖纪律**：本仓引入新依赖要立一份 ACR 变更单并经人工确认（`内部文档`
 * 的交付链表），而 bcrypt 还是个需要编译的 native 包。为了一个 30 行就能正确实现的
 * 能力去开变更单，成本与收益不匹配。
 *
 * scrypt 不是"退而求其次"：它与 bcrypt 同属 OWASP 推荐的口令 KDF，
 * 且是**内存硬**的（bcrypt 只是计算硬），对 GPU 爆破更不友好。
 * 真要换 argon2id 属于加依赖，那时再走 ACR。
 *
 * # 落盘格式
 *
 * `scrypt$N$r$p$<salt-b64>$<hash-b64>`：参数写进串里，
 * 这样以后调高参数不会让老口令全部失效——校验按**串里记的**参数重算。
 * 不把参数写进串是这类实现最常见的坑：调一次参数，所有人都登不进来。
 *
 * # 锁定账号
 *
 * 迁移种下的 `demo-user` 口令散列是 `!`。它不是合法格式，`verifyPassword`
 * 对任何输入都返回 false ——这是"账号存在但不能登录"的标准表达，
 * 比在表里加一个 `disabled` 布尔更难被误用（忘了查布尔 = 谁都能登）。
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/** 与 OWASP 对 scrypt 的最低建议同档（N=2^15, r=8, p=1）。 */
const PARAMS = { N: 32_768, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;
/** 默认 maxmem 是 32MB，N=32768/r=8 需要约 128 * N * r ≈ 32MB，卡在边界上——给足。 */
const MAX_MEM = 96 * 1024 * 1024;

/** 永不匹配的散列：账号存在但被锁定（迁移的种子账号用它）。 */
export const LOCKED_PASSWORD_HASH = "!";

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scrypt(plain, salt, KEY_LEN, { ...PARAMS, maxmem: MAX_MEM });
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/**
 * 校验。**任何异常都返回 false，不抛**——调用方是登录路径，
 * 抛出去会变成 500，而 500 与 401 的区别本身就是一条信息泄露通道
 * （"这个用户名的散列是坏的"）。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const salt = Buffer.from(parts[4]!, "base64");
    const expected = Buffer.from(parts[5]!, "base64");
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await scrypt(plain, salt, expected.length, { N, r, p, maxmem: MAX_MEM });
    // 长度不等时 timingSafeEqual 会抛，先挡掉。
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
