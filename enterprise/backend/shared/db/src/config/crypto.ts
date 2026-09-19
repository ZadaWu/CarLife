/**
 * 配置密钥的对称加密（施工单 M3-02，关闭 §13-12）。
 *
 * AES-256-GCM；密钥由 `CARLIFE_CONFIG_MASTER_KEY` 经 scrypt 派生。
 * 主密钥**由环境注入、不与密文同库**——缺失或过短时直接抛错，
 * 不提供"降级成明文存储"的路径（那等于这一层不存在）。
 *
 * 存储形态：`v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`，版本前缀留给未来换算法。
 *
 * # 算法在 `../crypto/field-cipher`，钥匙还在这里
 *
 * 本模块曾与 `pii/crypto.ts` 是两份逐行同构的实现；当第三份（日历凭证）要出现时，
 * 按 Rule of Three 把**算法**提炼了出去。提炼走的只有算法：盐与主密钥仍是本模块
 * 独占的，与 PII 侧互不通用（理由见 `pii/crypto.ts` 文件头的"两套钥匙"一节）。
 * `test/field-cipher-compat.test.ts` 用硬编码的历史密文守着这次提炼没有改变
 * 任何一个字节的密文格式。
 */

import { createFieldCipher } from "../crypto/field-cipher";

const SALT = "carlife-config-v1"; // 固定盐：主密钥本身已是高熵注入值

export class MasterKeyMissingError extends Error {
  constructor(reason: string) {
    super(
      `配置主密钥不可用：${reason}。请设置 CARLIFE_CONFIG_MASTER_KEY（至少 16 字符，由部署层注入，不入代码库）`,
    );
    this.name = "MasterKeyMissingError";
  }
}

const cipher = createFieldCipher({
  prefix: "v1",
  salt: SALT,
  envVar: "CARLIFE_CONFIG_MASTER_KEY",
  label: "配置",
  // 配置侧**没有**"无前缀原样返回"那条通路（PII 才有，那是迁移期兼容读）：
  // 配置密文全是我们自己写进去的，格式不对就是真的不对。
  makeError: (reason) => new MasterKeyMissingError(reason),
});

export const encryptSecret = cipher.encrypt;
export const decryptSecret = cipher.decrypt;

/** 启动期自检：主密钥可用且能完成一次加解密往返。 */
export const assertMasterKeyUsable = cipher.assertUsable;
