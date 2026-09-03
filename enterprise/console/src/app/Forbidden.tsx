import type { ConsoleRole } from "../api";

/** 403 页：明确区分"没登录"与"没权限"，后者不该表现成空白或报错。 */
export function Forbidden({ need }: { need: ConsoleRole }): JSX.Element {
  return (
    <div className="page">
      <h1>没有访问权限</h1>
      <p className="muted">
        该功能仅限 <code>{need}</code> 角色。你的账号已登录，但角色不匹配——
        这不是故障，是角色矩阵的设计（见施工单 M3-01）。
      </p>
    </div>
  );
}
