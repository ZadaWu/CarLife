/**
 * 确认弹窗的体检区（施工单 M77-04，FL-58 F-58-11；
 * 设计依据 `内部文档` §3.2 / §3.4 / §3.5）。
 *
 * # 三类结论三种形态，不只靠颜色（设计系统 §7）
 *
 * 已验 = 对勾 + ok 底片；请你看 = 三角叹号 + warn；验不了 = 八角叹号 + danger 文字，**且必须写出缺什么**。
 * "验不了"与"已通过"若长得一样，等于告诉用户它过了——这一区存在的理由就是把它们分开。
 *
 * # 只消费 `AuditSummary`，不自己解析 details
 *
 * 拼与解都在 contracts（`formatAuditDetails / parseAuditDetails`），两端各引一次。
 * 这里没有任何按钮：未消解不阻塞，出口仍是弹窗自己的「拒绝 / 确认」（AC-58-5）。
 */
import type { AuditSummary } from "@carlife/shared";

export interface AuditSectionProps {
  summary: AuditSummary;
  /** 只画摘要条（车机横屏放在标题下）；明细两段由调用方决定放哪。 */
  compact?: boolean;
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
function IconTriangle() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5L21.5 20H2.5z" />
      <path d="M12 9.5v5M12 17.2v.3" />
    </svg>
  );
}
function IconOctagon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" />
      <path d="M12 8v5M12 16.2v.3" />
    </svg>
  );
}

const totalOf = (s: AuditSummary) => s.passed + s.attention.length + s.unverifiable.length;

/** 摘要条：三个胶囊 + 「自动修了 m 处」。全部通过时只剩一枚绿胶囊。 */
export function AuditSummaryBar({ summary }: { summary: AuditSummary }) {
  const total = totalOf(summary);
  const allPassed = summary.attention.length === 0 && summary.unverifiable.length === 0;
  return (
    <div className="audit-bar" role="status" aria-label="行程体检摘要">
      <span className="audit-pill audit-pill--ok">
        <IconCheck />
        {allPassed ? `已验 ${total} 项 · 全部通过` : `已验 ${summary.passed} 项`}
      </span>
      {summary.attention.length > 0 && (
        <span className="audit-pill audit-pill--warn">
          <IconTriangle />
          {summary.attention.length} 项请你看
        </span>
      )}
      {summary.unverifiable.length > 0 && (
        <span className="audit-pill audit-pill--danger">
          <IconOctagon />
          {summary.unverifiable.length} 项验不了
        </span>
      )}
      {summary.repaired.length > 0 && <span className="audit-bar__note">自动修了 {summary.repaired.length} 处</span>}
    </div>
  );
}

/** 「出发前请看」与「验不了」两段。都为空时什么都不渲染。 */
export function AuditLists({ summary }: { summary: AuditSummary }) {
  if (summary.attention.length === 0 && summary.unverifiable.length === 0) return null;
  return (
    <div className="audit-lists">
      {summary.attention.length > 0 && (
        <section className="audit-list audit-list--attention" aria-label="出发前请看">
          <h3 className="audit-list__title">
            <IconTriangle />
            出发前请看
          </h3>
          <ul>
            {summary.attention.map((a, i) => (
              <li key={i}>
                {a.day !== undefined && <span className="audit-list__day">第 {a.day} 天</span>}
                {a.text}
              </li>
            ))}
          </ul>
        </section>
      )}
      {summary.unverifiable.length > 0 && (
        <section className="audit-list audit-list--unverifiable" aria-label="验不了">
          <h3 className="audit-list__title">
            <IconOctagon />
            验不了
          </h3>
          <ul>
            {summary.unverifiable.map((u, i) => (
              <li key={i}>
                {u.day !== undefined && <span className="audit-list__day">第 {u.day} 天</span>}
                {u.text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function AuditSection({ summary, compact }: AuditSectionProps) {
  return (
    <>
      <AuditSummaryBar summary={summary} />
      {!compact && <AuditLists summary={summary} />}
    </>
  );
}
