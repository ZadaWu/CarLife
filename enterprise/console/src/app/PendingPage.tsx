/**
 * 待建设页（施工单 M3-01）。
 *
 * 刻意**带上清单编号**而不是只写"暂无数据"——让"这一块还没做"
 * 与"这一块坏了"在界面上可区分（同 M3-05 的六类分区约定）。
 */
export function PendingPage({
  title,
  owner,
  what,
}: {
  title: string;
  owner: string;
  what: string;
}): JSX.Element {
  return (
    <div className="page">
      <h1>{title}</h1>
      <div className="pending-card">
        <span className="pending-tag">待建设</span>
        <p>{what}</p>
        <p className="muted">
          归属清单：<code>{owner}</code>。本 Sprint（M3）不包含该功能，页面可达是为了让路由与权限先就位。
        </p>
      </div>
    </div>
  );
}
