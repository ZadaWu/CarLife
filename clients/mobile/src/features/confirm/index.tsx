/**
 * HITL 跨层确认弹窗（施工单 A3，FL-04 F-04-01/F-04-02，均 P0；
 * M65-02 接上真实 resume：F-04-08）。
 *
 * # 为什么是"跨层"
 *
 * 权限门挂起发生在用户可能已经切走的时候（§8.4：`interrupt()` 挂起那条内部 HTTP
 * 请求，等 resume）。确认弹窗必须**层级高于 HUD 与对话层**、不依赖当前在哪一层，
 * 因此用 overlay 而不是某一层内部的组件——挂在路由层级里的弹窗，
 * 用户切到 HUD 就看不见了，而那笔动作还挂着。
 *
 * # F-04-02：动作明细渲染，**不只显示动作名**
 *
 * "确认预约吗"这种弹窗等于没问。要显示的是门店、时间、以及
 * **将提供给门店的信息**（F-26-09）——后者由 `enterprise/backend/shared/tools` 的
 * `describeDisclosure()` 生成，前端只渲染，不自己拼：两处各拼一份时，
 * 用户看到的和实际发出去的会对不上，那正是这条验收要防的。
 *
 * # 吃契约类型，不再自定义 `ConfirmRequest`（M65-02）
 *
 * A3 时代这里有一份手写的 `ConfirmRequest`，比契约 `PermissionRequest` 少 `action` 与 `scope`，
 * `disclosure` 的键还叫 `field`。SSE `permission` 事件的载荷就是 `PermissionRequest`，
 * 中间再转一道只会让两份形状慢慢漂开。
 *
 * # 决策只有一个出口 `onDecide(approved)`，弹层自己不碰网络
 *
 * 与车机 `ConfirmSheet` 同一形态：幂等在网关 HitlRelay；resume 没被接住时由外层传 `notice`，
 * **有 `notice` 就不显示两个出口**——这一屏已经不是"要不要做"，而是"刚才那次没生效"。
 * 静默收起是最糟的形态：车主以为定了。
 */
import type { PermissionRequest } from "@carlife/shared";

export interface ConfirmDialogProps {
  request: PermissionRequest | null;
  /** resume 发送中：双键禁用，防连点（连点本身也幂等，这只是手感）。 */
  busy?: boolean;
  /** 确认没被接住时的告知（见文件头）。 */
  notice?: string;
  onDismissNotice?: () => void;
  onDecide: (approved: boolean) => void;
}

export function ConfirmDialog({ request, busy, notice, onDismissNotice, onDecide }: ConfirmDialogProps) {
  if (!request) return null;

  return (
    <div className="hitl-overlay" role="dialog" aria-modal="true" aria-label={request.title}>
      <div className="hitl-panel">
        <h2 className="hitl-title">{request.title}</h2>

        <dl className="hitl-details">
          {request.details.map((d, i) => (
            <div key={`${d.label}-${i}`} className="hitl-row">
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
          {/* 影响范围（如写入哪个日历账号）。契约里可为 null——那时不摆一行空的。 */}
          {request.scope && (
            <div className="hitl-row hitl-row--scope">
              <dt>影响范围</dt>
              <dd>{request.scope}</dd>
            </div>
          )}
        </dl>

        {/* 外发信息单独成块并加标题：混在动作明细里，用户不会意识到
            这几行的性质和"门店地址"完全不同（F-26-09）。 */}
        {request.disclosure.length > 0 && (
          <section className="hitl-disclosure">
            <h3>将提供给门店的信息</h3>
            <dl className="hitl-details">
              {request.disclosure.map((d, i) => (
                <div key={`${d.label}-${i}`} className="hitl-row">
                  <dt>{d.label}</dt>
                  <dd>{d.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {notice && (
          <p className="hitl-notice" role="alert">
            {notice}
          </p>
        )}

        <div className="hitl-actions">
          {notice ? (
            <button type="button" className="is-primary hitl-actions__single" onClick={onDismissNotice}>
              知道了
            </button>
          ) : (
            <>
              {/* 拒绝在左、确认在右，且拒绝**不是**次要样式：
                  这是一个有后果的动作，两个选项应当平权呈现。 */}
              <button type="button" disabled={busy} onClick={() => onDecide(false)}>
                不了
              </button>
              <button type="button" className="is-primary" disabled={busy} onClick={() => onDecide(true)}>
                {busy ? "发送中…" : "确认"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
