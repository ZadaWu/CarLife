/**
 * 告警治理（施工单 M9-03，FL-44）。
 *
 * # 保护性告警先于观察性告警
 *
 * `storys/README.md` 的 Epic J 排期原则原文：**没有它会静默出事的功能优先**。
 * 因此这里只实现三条关键告警，成本视图与仪表盘留后：
 *
 * 1. **Guard fail 率**——审核层大面积 fail-open 意味着内容安全实际失效，
 *    而系统表现完全正常（F-44-05）。
 * 2. **静默故障**——某个本该周期性发生的事件长时间没发生。
 *    这类故障没有错误日志，只能靠"预期没兑现"发现（F-44-07）。
 * 3. **降级率**——双路检索退化成单路的比例；它决定"个性化"这个卖点是否还成立。
 *
 * # 去重与分级：告警疲劳会让真事件被淹没
 *
 * 同一条告警在冷却期内只发一次。**这不是省事，是有效性问题**——
 * 每分钟响一次的告警，第 N 次真响时也会被顺手划掉。
 */

export type AlertSeverity = "warning" | "critical";

export interface Alert {
  key: string;
  severity: AlertSeverity;
  message: string;
  at: number;
}

export interface AlertSink {
  fire(a: Alert): void;
}

export interface AlertRule {
  key: string;
  severity: AlertSeverity;
  /** 冷却期：同 key 在此期间内不重复发。 */
  cooldownMs: number;
  /** 返回 message 表示触发；undefined 表示正常。 */
  evaluate(snapshot: MetricsSnapshot): string | undefined;
}

export interface MetricsSnapshot {
  /** 审核层调用总数与 fail（异常走 fail 模式）次数。 */
  guardChecks: number;
  guardFailures: number;
  /** 双路检索总次数与降级次数。 */
  dualPathTotal: number;
  dualPathDegraded: number;
  /** 各周期性事件的最后发生时间。 */
  lastSeenAt: Record<string, number>;
  now: number;
}

export const GUARD_FAIL_RATE_THRESHOLD = 0.2;
export const DEGRADE_RATE_THRESHOLD = 0.5;

export function defaultRules(silentThresholds: Record<string, number>): AlertRule[] {
  return [
    {
      key: "guard_fail_rate",
      severity: "critical",
      cooldownMs: 10 * 60_000,
      evaluate: (s) => {
        if (s.guardChecks < 10) return undefined; // 样本太少不判，避免开机即报
        const rate = s.guardFailures / s.guardChecks;
        return rate > GUARD_FAIL_RATE_THRESHOLD
          ? `内容审核失败率 ${(rate * 100).toFixed(1)}%（阈值 ${GUARD_FAIL_RATE_THRESHOLD * 100}%）——` +
              `input 侧 fail-open 意味着**审核实际失效但系统表现正常**`
          : undefined;
      },
    },
    {
      key: "dual_path_degraded",
      severity: "warning",
      cooldownMs: 30 * 60_000,
      evaluate: (s) => {
        if (s.dualPathTotal < 10) return undefined;
        const rate = s.dualPathDegraded / s.dualPathTotal;
        return rate > DEGRADE_RATE_THRESHOLD
          ? `双路检索降级率 ${(rate * 100).toFixed(1)}%——个性化这个卖点在多数请求上已不成立`
          : undefined;
      },
    },
    ...Object.entries(silentThresholds).map(([event, maxSilentMs]): AlertRule => ({
      key: `silent_${event}`,
      severity: "critical",
      cooldownMs: 60 * 60_000,
      evaluate: (s) => {
        const last = s.lastSeenAt[event];
        // 从未发生过也算静默——**"从来没跑过"比"跑挂了"更容易被忽略**。
        const silentMs = last === undefined ? Number.POSITIVE_INFINITY : s.now - last;
        return silentMs > maxSilentMs
          ? `${event} 已 ${last === undefined ? "从未发生" : `${Math.round(silentMs / 60_000)} 分钟未发生`}` +
              `（阈值 ${Math.round(maxSilentMs / 60_000)} 分钟）——这类故障没有错误日志，只能靠预期没兑现发现`
          : undefined;
      },
    })),
  ];
}

/** 带冷却的告警器。 */
export class AlertManager {
  private lastFiredAt = new Map<string, number>();

  constructor(
    private rules: readonly AlertRule[],
    private sink: AlertSink,
  ) {}

  evaluate(snapshot: MetricsSnapshot): Alert[] {
    const fired: Alert[] = [];
    for (const rule of this.rules) {
      const message = rule.evaluate(snapshot);
      if (!message) continue;

      const last = this.lastFiredAt.get(rule.key);
      // 冷却期内不重复发——告警疲劳会让真事件被淹没。
      if (last !== undefined && snapshot.now - last < rule.cooldownMs) continue;

      const alert: Alert = { key: rule.key, severity: rule.severity, message, at: snapshot.now };
      this.lastFiredAt.set(rule.key, snapshot.now);
      try {
        this.sink.fire(alert);
      } catch {
        /* 告警发送失败不该让主链路失败 */
      }
      fired.push(alert);
    }
    return fired;
  }
}
