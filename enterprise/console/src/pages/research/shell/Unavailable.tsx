/**
 * 研究面不可用时的两分型页（施工单 M82-08）。
 *
 * 「没配」与「没起」说成两句话——合成一句"服务不可用"，
 * 看的人不知道该去改配置还是去起进程（同 vision-trainer 的取舍）。
 */

import { unavailableView } from "./model";

export function Unavailable({ code }: { code: string }): JSX.Element {
  const v = unavailableView(code);
  if (!v) {
    return (
      <div className="page">
        <h1>研究面暂时读不到</h1>
        <p className="page-sub">上游返回 {code}。</p>
      </div>
    );
  }
  return (
    <div className="page">
      <h1>{v.title}</h1>
      <p className="page-sub">{v.detail}</p>
      <pre className="research-hint">{v.hint}</pre>
    </div>
  );
}
