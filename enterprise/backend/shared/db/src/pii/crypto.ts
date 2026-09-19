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
 * **算法已提炼进 `../crypto/field-cipher`，这段话依然成立**：
 * 提炼走的只有算法，钥匙（盐 + 主密钥）仍是各模块独占的。
 *
 * # 没有"降级成明文"的路径
 *
 * 主密钥缺失/过短一律抛错（与 config 同一条纪律）——静默回退明文等于
 * 这一层不存在。`decryptPii` 对**无前缀**的值原样返回，这不是降级，
 * 是迁移期兼容读：存量明文行在跑迁移脚本前也要能被读出来。
 */

import { createFieldCipher } from "../crypto/field-cipher";

const SALT = "carlife-pii-v1"; // 固定盐：主密钥本身已是高熵注入值（同 config 的理由）

export class PiiMasterKeyMissingError extends Error {
  constructor(reason: string) {
    super(
      `PII 主密钥不可用：${reason}。请设置 CARLIFE_PII_MASTER_KEY（至少 16 字符，` +
        `生成：openssl rand -hex 32；由部署层注入，不入代码库、不与密文同库）`,
    );
    this.name = "PiiMasterKeyMissingError";
  }
}

const cipher = createFieldCipher({
  prefix: "pii:v1",
  salt: SALT,
  envVar: "CARLIFE_PII_MASTER_KEY",
  label: "PII",
  // 迁移期兼容读（文件头）：存量明文行在跑迁移脚本前也要能被读出来。
  passthroughUnprefixed: true,
  makeError: (reason) => new PiiMasterKeyMissingError(reason),
});

export const isPiiCiphertext = cipher.isCiphertext;
export const encryptPii = cipher.encrypt;

/**
 * 解密。无 `pii:v1:` 前缀的值**原样返回**（迁移期兼容读，见文件头）；
 * 有前缀但解不开（错钥/密文损坏）**抛错**——返回密文串会让下游把
 * `pii:v1:...` 当成手机号用出去，那比报错糟糕得多。
 */
export const decryptPii = cipher.decrypt;

/** 启动期自检：主密钥可用且能完成一次加解密往返（config 的 assertMasterKeyUsable 同款）。 */
export const assertPiiMasterKeyUsable = cipher.assertUsable;
