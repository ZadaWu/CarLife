/**
 * PII 字段的落盘加密（施工单 M42-01）。
 *
 * # 与 config/crypto.ts 是两套钥匙，刻意不复用
 *
 * 算法与参数同源（AES-256-GCM + scrypt），但主密钥独立
 * （`CARLIFE_PII_MASTER_KEY`）：配置密钥与个人数据密钥的轮换周期、泄露影响面
 * 完全不同，共钥意味着换任何一把都得重加密两类数据。
 * 密文前缀 `pii:v1:` 与配置密文（`v1:`）可区分，迁移脚本靠它做幂等判据。
 *
 * # 没有"降级成明文"的路径
 *
 * 主密钥缺失/过短一律抛错（与 config 同一条纪律）——静默回退明文等于
 * 这一层不存在。`decryptPii` 对**无前缀**的值原样返回，这不是降级，
 * 是迁移期兼容读：存量明文行在跑迁移脚本前也要能被读出来。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const PREFIX = "pii:v1";
const SALT = "carlife-pii-v1"; // 固定盐：主密钥本身已是高熵注入值（同 config 的理由）
const KEY_LEN = 32;
const IV_LEN = 12;

let cachedKey: Buffer | undefined;
let cachedMaster: string | undefined;

export class PiiMasterKeyMissingError extends Error {
  constructor(reason: string) {
    super(
      `PII 主密钥不可用：${reason}。请设置 CARLIFE_PII_MASTER_KEY（至少 16 字符，` +
        `生成：openssl rand -hex 32；由部署层注入，不入代码库、不与密文同库）`,
    );
    this.name = "PiiMasterKeyMissingError";
  }
}

function derive(master: string | undefined): Buffer {
  if (!master) throw new PiiMasterKeyMissingError("未设置");
  if (master.length < 16) throw new PiiMasterKeyMissingError("长度不足 16 字符");
  if (cachedKey && cachedMaster === master) return cachedKey;
  cachedKey = scryptSync(master, SALT, KEY_LEN);
  cachedMaster = master;
  return cachedKey;
}

export function isPiiCiphertext(v: string): boolean {
  return v.startsWith(`${PREFIX}:`);
}

export function encryptPii(plain: string, master = process.env.CARLIFE_PII_MASTER_KEY): string {
  const key = derive(master);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(
    ":",
  );
}

/**
 * 解密。无 `pii:v1:` 前缀的值**原样返回**（迁移期兼容读，见文件头）；
 * 有前缀但解不开（错钥/密文损坏）**抛错**——返回密文串会让下游把
 * `pii:v1:...` 当成手机号用出去，那比报错糟糕得多。
 */
export function decryptPii(stored: string, master = process.env.CARLIFE_PII_MASTER_KEY): string {
  if (!isPiiCiphertext(stored)) return stored;
  const parts = stored.split(":");
  // pii:v1:<iv>:<tag>:<data> → 5 段
  if (parts.length !== 5) throw new Error("PII 密文格式非法（期望 pii:v1:iv:tag:data）");
  const [, , ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", derive(master), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

/** 启动期自检：主密钥可用且能完成一次加解密往返（config 的 assertMasterKeyUsable 同款）。 */
export function assertPiiMasterKeyUsable(master = process.env.CARLIFE_PII_MASTER_KEY): void {
  const probe = "carlife-pii-key-probe";
  if (decryptPii(encryptPii(probe, master), master) !== probe) {
    throw new PiiMasterKeyMissingError("加解密自检失败");
  }
}
