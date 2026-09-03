/**
 * 内联的二次确认条（施工单 M68-04）。
 *
 * # 为什么不是 `window.confirm`
 *
 * 它要能填 `reason`（进审计 detail，回答"为什么"），要写清后果（"该设备下一次刷新登录即失效"）。
 * 原生 confirm 两样都做不到。也不做弹层：后台既有风格没有 modal，加一个会显得像另一套系统——
 * 做成就地展开的一条，与 `.id-form` 同一形状。
 *
 * # 一次只开一个
 *
 * 父组件持 `pendingId`，点另一行的按钮就切过去；本组件只负责展开态本身。
 */

import { useState } from "react";

/** 与网关 `console/identity.ts` 的 `MAX_REASON_LEN` 一致；超过的不是理由，是别的东西。 */
export const MAX_REASON_LEN = 200;

export function reasonTooLong(reason: string): boolean {
  return reason.trim().length > MAX_REASON_LEN;
}

export function ConfirmAction({
  title,
  consequence,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  /** 后果一句：做了会发生什么。不是"确定吗？"。 */
  consequence: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [reason, setReason] = useState("");
  const tooLong = reasonTooLong(reason);
  return (
    <div className="confirm-action" role="alertdialog" aria-label={title}>
      <div className="confirm-action-title">{title}</div>
      <p className="confirm-action-consequence">{consequence}</p>
      <div className="confirm-action-row">
        <input
          value={reason}
          placeholder="理由（可选，≤200 字，进审计）"
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        />
        <button type="button" className="btn btn-sm id-danger" disabled={busy || tooLong} onClick={() => onConfirm(reason.trim() || undefined)}>
          {busy ? "处理中…" : confirmLabel}
        </button>
        <button type="button" className="btn-link" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
      {tooLong ? <p className="error tiny">理由不能超过 {MAX_REASON_LEN} 字（现在 {reason.trim().length}）</p> : null}
    </div>
  );
}
