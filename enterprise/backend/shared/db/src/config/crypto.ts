/**
 * 配置密钥的对称加密（施工单 M3-02，关闭 §13-12）。
 *
 * AES-256-GCM；密钥由 `CARLIFE_CONFIG_MASTER_KEY` 经 scrypt 派生。
 * 主密钥**由环境注入、不与密文同库**——缺失或过短时直接抛错，
 * 不提供"降级成明文存储"的路径（那等于这一层不存在）。
 *
 * 存储形态：`v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`，版本前缀留给未来换算法。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const PREFIX = "v1";
const SALT = "carlife-config-v1"; // 固定盐：主密钥本身已是高熵注入值
const KEY_LEN = 32;
const IV_LEN = 12;

let cachedKey: Buffer | undefined;
let cachedMaster: string | undefined;

export class MasterKeyMissingError extends Error {
  constructor(reason: string) {
    super(
      `配置主密钥不可用：${reason}。请设置 CARLIFE_CONFIG_MASTER_KEY（至少 16 字符，由部署层注入，不入代码库）`,
    );
    this.name = "MasterKeyMissingError";
  }
}

function derive(master: string | undefined): Buffer {
  if (!master) throw new MasterKeyMissingError("未设置");
  if (master.length < 16) throw new MasterKeyMissingError("长度不足 16 字符");
  if (cachedKey && cachedMaster === master) return cachedKey;
  cachedKey = scryptSync(master, SALT, KEY_LEN);
  cachedMaster = master;
  return cachedKey;
}

export function encryptSecret(plain: string, master = process.env.CARLIFE_CONFIG_MASTER_KEY): string {
  const key = derive(master);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(
    ":",
  );
}

export function decryptSecret(
  stored: string,
  master = process.env.CARLIFE_CONFIG_MASTER_KEY,
): string {
  const [prefix, ivB64, tagB64, dataB64] = stored.split(":");
  if (prefix !== PREFIX || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("配置密文格式非法（期望 v1:iv:tag:data）");
  }
  const decipher = createDecipheriv("aes-256-gcm", derive(master), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** 启动期自检：主密钥可用且能完成一次加解密往返。 */
export function assertMasterKeyUsable(master = process.env.CARLIFE_CONFIG_MASTER_KEY): void {
  const probe = "carlife-master-key-probe";
  if (decryptSecret(encryptSecret(probe, master), master) !== probe) {
    throw new MasterKeyMissingError("加解密自检失败");
  }
}
