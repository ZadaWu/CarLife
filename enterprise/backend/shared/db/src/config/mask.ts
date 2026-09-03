/**
 * 密钥掩码（施工单 M3-02）——**唯一实现，全链路复用**。
 *
 * 规则：保留前 3 后 4，中间固定 `***`；长度不足 8 时全掩。
 * 掩码后的值可以直接贴进工单、日志、审计与前端而不泄密（AC-35-3）。
 */

export function maskSecret(value: string): string {
  if (value.length === 0) return "";
  if (value.length < 8) return "***";
  return `${value.slice(0, 3)}***${value.slice(-4)}`;
}

/** 递归掩掉对象里疑似密钥的字段，用于日志与错误上报的兜底。 */
const SECRET_HINT = /(key|token|secret|password|authorization)/i;

export function maskDeep(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_HINT.test(k) && typeof v === "string" ? maskSecret(v) : maskDeep(v),
      ]),
    );
  }
  return value;
}
