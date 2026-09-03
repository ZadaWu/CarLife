/**
 * 四道防线的裁决审计汇聚（施工单 M6-05，§8.5）。
 *
 * # 含放行，这是硬要求
 *
 * "只记拦截的系统永远不知道自己漏了什么"（§8.5）。运营调阈值时要看的是**放行样本**
 * ——被误拦的用户通常不投诉，直接不用了，靠投诉量看不出误伤率。
 *
 * # 写入放在裁决函数的唯一出口
 *
 * 让"漏记"在结构上不可能（FL-28 F-28-05 的实现建议）。
 * 审计完备性无法自证，只能靠结构保证——散在各分支里迟早漏一条。
 */

export type GuardLayer = "input_prefilter" | "input_moderation" | "output_moderation" | "output_pii" | "action_gate";

export interface GuardAuditRecord {
  sessionId: string;
  turnId?: string;
  layer: GuardLayer;
  /** **放行也记**——这是本模块存在的理由。 */
  decision: "allow" | "deny" | "needs_confirmation";
  /** 命中的规则 id 或类别，供归因。 */
  rule?: string;
  /** action_gate 时的工具名（M37-04）——按工具聚合拦截情况要用。 */
  tool?: string;
  reason?: string;
  durationMs: number;
  at: number;
}

export interface GuardAuditSink {
  write(r: GuardAuditRecord): void;
}

/**
 * 内存实现。M37-04 之前它是唯一实现（"落库归 M9-01"的那句注释停在了轨迹——
 * 轨迹落了库，审计没跟上）；现在是 `PersistentGuardAuditSink` 的**降级去处**：
 * 落库失败时记录至少还在进程里活到重启，误伤样本审查（F-30-04）也还有数据源。
 */
export class MemoryGuardAuditSink implements GuardAuditSink {
  private records: GuardAuditRecord[] = [];
  constructor(private cap = 10_000) {}

  write(r: GuardAuditRecord): void {
    this.records.push(r);
    if (this.records.length > this.cap) this.records.splice(0, this.records.length - this.cap);
  }

  all(): readonly GuardAuditRecord[] {
    return this.records;
  }

  /** 误伤样本审查的数据源（FL-30 F-30-04）：按层看拒绝率。 */
  denialRateByLayer(): Record<string, { total: number; denied: number; rate: number }> {
    const acc: Record<string, { total: number; denied: number; rate: number }> = {};
    for (const r of this.records) {
      const a = (acc[r.layer] ??= { total: 0, denied: 0, rate: 0 });
      a.total += 1;
      if (r.decision === "deny") a.denied += 1;
    }
    for (const a of Object.values(acc)) a.rate = a.total === 0 ? 0 : a.denied / a.total;
    return acc;
  }
}

/**
 * 落库实现（施工单 M37-04，F-10-13 / F-10-12）。
 *
 * # 三条纪律
 *
 * 1. **不阻塞裁决路径**：`write` 同步返回，落库 fire-and-forget——权限门的
 *    check 是挂起等 resume 的同步 HTTP，审计延迟加进去就是对话延迟。
 * 2. **失败降级不刷屏**：落库失败退回内存 sink + 同因只告警一次；恢复后
 *    自动回到落库（不做补写——内存里丢了就丢了，如实）。
 * 3. **高风险全量落，allow 可采样**：deny / needs_confirmation 永远落；
 *    allow 按 `sampleAllow`（默认 1 = 全量，F-27-11"含放行"）。采样掉的 allow
 *    仍进内存 sink——误伤样本审查（F-30-04）看的就是放行样本，不能采丢。
 */
export class PersistentGuardAuditSink implements GuardAuditSink {
  private warned = false;

  constructor(
    private persist: (r: GuardAuditRecord) => Promise<void>,
    private fallback: GuardAuditSink,
    private opts: { sampleAllow?: number; random?: () => number } = {},
  ) {}

  write(r: GuardAuditRecord): void {
    const sampleAllow = this.opts.sampleAllow ?? 1;
    const sampled =
      r.decision !== "allow" || sampleAllow >= 1 || (this.opts.random ?? Math.random)() < sampleAllow;
    if (!sampled) {
      this.fallback.write(r);
      return;
    }
    void this.persist(r).catch((err) => {
      if (!this.warned) {
        this.warned = true;
        console.error(
          `[guard-audit] ⚠️ 审计落库失败，退回内存 sink（同因不再重复告警）：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.fallback.write(r);
    });
  }
}

/**
 * 审计器。**写入永不抛错**——审计是旁路，它坏了不该让对话坏
 * （与 FL-10 F-10-12 同源）。
 */
export class GuardAuditor {
  constructor(
    private sink: GuardAuditSink,
    private now: () => number = Date.now,
  ) {}

  record(r: Omit<GuardAuditRecord, "at">): void {
    try {
      this.sink.write({ ...r, at: this.now() });
    } catch {
      /* 吞掉 */
    }
  }
}

/**
 * 误伤样本审查（施工单 M6-04，FL-30 F-30-04）。
 *
 * # 为什么需要主动抽样，而不是等投诉
 *
 * **被误拦的用户通常不投诉，直接不用了**（FL-25 F-25-13 的原话）。
 * 只看投诉量会得出"误伤率为零"的结论，而真实误伤率可能很高。
 * 因此这里给的是**放行与拦截的完整样本**，让运营主动看。
 */
export interface DenialSample {
  at: number;
  layer: GuardLayer;
  rule?: string;
  reason?: string;
  sessionId: string;
}

export interface SampleQuery {
  layer?: GuardLayer;
  /** 只看拒绝的（默认）还是也看放行的。**看放行样本才能发现漏放**。 */
  include?: "denied" | "all";
  since?: number;
  limit?: number;
}

export function querySamples(
  records: readonly GuardAuditRecord[],
  q: SampleQuery = {},
): DenialSample[] {
  const include = q.include ?? "denied";
  return records
    .filter((r) => (q.layer ? r.layer === q.layer : true))
    .filter((r) => (q.since ? r.at >= q.since : true))
    .filter((r) => (include === "denied" ? r.decision === "deny" : true))
    // 最近的在前——排查看的总是刚发生的事
    .sort((a, b) => b.at - a.at)
    .slice(0, q.limit ?? 100)
    .map((r) => ({ at: r.at, layer: r.layer, rule: r.rule, reason: r.reason, sessionId: r.sessionId }));
}

/**
 * 按规则统计命中次数——**找出"某条规则贡献了绝大多数拒绝"的情况**。
 *
 * 那通常意味着这条规则过宽（误伤源），而不是攻击变多了。
 * 没有这个视图，运营只能看到总拒绝率上升，无从下手。
 */
export function denialsByRule(records: readonly GuardAuditRecord[]): Array<{ rule: string; count: number }> {
  const acc = new Map<string, number>();
  for (const r of records) {
    if (r.decision !== "deny" || !r.rule) continue;
    acc.set(r.rule, (acc.get(r.rule) ?? 0) + 1);
  }
  return [...acc.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count);
}
