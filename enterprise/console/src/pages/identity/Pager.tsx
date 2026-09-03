/**
 * 游标式翻页条（施工单 M68-03）。三张列表共用；形态照 `sessions/index.tsx`。
 *
 * 只说"第 N 页"，**不说"共 M 页"**：游标式接口拿不到总数，编一个总页数出来就是假的。
 * 同理不做页码跳转——那需要 offset。
 */

import { type CursorStack, popCursor, pushCursor } from "./model";

export function Pager({
  stack,
  next,
  pageSize,
  loading,
  onChange,
}: {
  stack: CursorStack;
  next: string | null;
  pageSize: number;
  loading: boolean;
  onChange: (stack: CursorStack) => void;
}): JSX.Element {
  return (
    <div className="ss-pager">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={stack.length === 1 || loading}
        onClick={() => onChange(popCursor(stack))}
      >
        ← 上一页
      </button>
      <span className="ss-pager-at">
        第 {stack.length} 页 · 每页 {pageSize} 条
      </span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!next || loading}
        onClick={() => onChange(pushCursor(stack, next))}
      >
        下一页 →
      </button>
    </div>
  );
}
