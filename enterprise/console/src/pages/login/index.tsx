/**
 * 登录页（施工单 M3-01，POC 简化形态）。
 *
 * 用后台角色 token 换身份。**没有用户名密码、没有注册**——
 * 退出条件见 `gateway/src/auth/console.ts`（FL-07 F-07-01）。
 */

import { useState, type FormEvent } from "react";

import { api, setToken, clearToken, type ConsoleIdentity } from "../../api";

export function LoginPage({
  onSignedIn,
}: {
  onSignedIn: (identity: ConsoleIdentity) => void;
}): JSX.Element {
  const [token, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setToken(token.trim());
    try {
      onSignedIn(await api.whoami());
    } catch {
      clearToken();
      // 不区分"token 不存在/错误"，不泄露账号存在性（沿用 FL-07 约束）
      setError("登录失败：token 无效");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>CarLife Console</h1>
        <p className="muted">输入后台访问 token（角色由 token 决定）</p>
        <input
          type="password"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="console token"
          autoFocus
        />
        <button type="submit" disabled={busy || token.trim() === ""}>
          {busy ? "验证中…" : "登录"}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </div>
  );
}
