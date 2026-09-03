/**
 * 档案页的「成员与授权」区（施工单 M48-03，F-55-07）。
 *
 * 与「常用人员」区**并列但独立**：那边登记"车上常有谁"（可以没有账号），
 * 这边管"谁能登录用这辆车"。两块 UI 分开摆是因为它们的生命周期独立
 * （删档案不撤授权、撤授权不删档案，AC-55-6）——合成一块，用户删掉一个
 * 就会以为两边都没了。
 *
 * 三条纪律：
 *  - **只有车主渲染管理入口**（AC-55-5）。driver 看得到名单（上车声明要用），
 *    但连"添加"按钮都不出现——不是点开了再弹"你没权限"。
 *  - **offline ≠ empty**：读不到名单绝不显示"还没有分享给任何人"。
 *  - 移除的确认文案说清后果：**下次用车立刻失效**。只写"确定移除吗"等于没说。
 *
 * # 二次确认为什么不用 `window.confirm`（M52-01）
 *
 * 因为它在 Tauri 窗口里**根本不会弹**：wry 0.55.1 没有实现 WKWebView 的
 * `runJavaScriptConfirmPanel`（全仓 grep 零命中），而 WKWebView 在 UI delegate
 * 不实现该方法时**不弹面板、直接返回 false**。于是 `if (!window.confirm(...)) return;`
 * 每次都从这里返回——现象是**点「移除」毫无反应**，不报错、控制台也没东西。
 * 2026-08-31 走查 W3 撞的就是它，而这曾是全仓唯一一处 `window.confirm`，所以没人踩过。
 *
 * 换成行内两段式：点「移除」→ 那一行就地展开后果说明与「确认移除 / 取消」。
 * 它不依赖任何 WebView 能力，在浏览器走查与 Tauri 里表现一致，
 * 且在触屏上比系统弹窗更好按。
 */
import { useCallback, useEffect, useState } from "react";

import { addGrant, loadGrants, removeGrant } from "./api";
import { GRANT_ROLE_LABEL, type GrantListState } from "./types";

export interface GrantsSectionProps {
  vin: string;
  /** 本人对这辆车的角色。非 owner 时只读。 */
  myRole: "owner" | "driver" | "passenger";
}

export function GrantsSection({ vin, myRole }: GrantsSectionProps) {
  const [state, setState] = useState<GrantListState>({ kind: "loading" });
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"driver" | "passenger">("driver");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在等二次确认的那一行（`userId`）。见文件头「二次确认为什么不用 window.confirm」。 */
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setState(await loadGrants(vin));
  }, [vin]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isOwner = myRole === "owner";

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy || !username.trim()) return;
      setBusy(true);
      setError(null);
      try {
        await addGrant(vin, { username: username.trim(), role });
        setUsername("");
        await reload();
      } catch (err) {
        /*
         * 服务端对"账号不存在"与"已是成员"回同一句（grant_failed）——刻意的，
         * 区分它们等于给车主一个账号探测接口。所以这里的话术也只能是合并的那一句，
         * 不要替它猜是哪一种。
         */
        setError(
          String(err).includes("grant_failed")
            ? "添加失败：账号不存在，或此人已经是这辆车的成员"
            : `添加失败：${String(err)}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, username, role, vin, reload],
  );

  const remove = useCallback(
    async (userId: string) => {
      setBusy(true);
      setError(null);
      try {
        await removeGrant(vin, userId);
        setPendingRemove(null);
        await reload();
      } catch (err) {
        setError(`移除失败：${String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [vin, reload],
  );

  return (
    <section className="own-section own-grants">
      <header className="own-section-head">
        <h3>成员与授权</h3>
        <small>{isOwner ? "谁能登录使用这辆车" : "这辆车的成员"}</small>
      </header>

      {state.kind === "loading" ? <p className="own-muted">读取中…</p> : null}

      {/* offline 与 empty 是两件事：读不到 ≠ 没分享给任何人 */}
      {state.kind === "offline" ? <p className="own-muted">读不到成员名单：{state.reason}</p> : null}

      {state.kind === "empty" ? <p className="own-muted">读到的名单是空的</p> : null}

      {state.kind === "ready" ? (
        <ul className="own-grant-list">
          {state.grants.map((g) => (
            <li key={g.userId} className="own-grant-row">
              <span className="own-grant-name">{g.displayName ?? g.userId}</span>
              <span className="own-grant-role">{GRANT_ROLE_LABEL[g.role]}</span>
              {isOwner && g.role !== "owner" ? (
                <button
                  type="button"
                  className="own-grant-remove"
                  disabled={busy}
                  onClick={() => setPendingRemove(g.userId)}
                >
                  移除
                </button>
              ) : null}
              {pendingRemove === g.userId ? (
                <div className="own-grant-confirm">
                  {/* 后果写全：只问"确定吗"等于没问 */}
                  <p>
                    移除「{g.displayName ?? g.userId}」对这辆车的使用授权？
                    <br />
                    他从下一次操作起就用不了这辆车（不必等任何超时）。常用人员档案不受影响。
                  </p>
                  <div className="own-grant-confirm-acts">
                    <button
                      type="button"
                      className="own-grant-remove"
                      disabled={busy}
                      onClick={() => void remove(g.userId)}
                    >
                      {busy ? "移除中…" : "确认移除"}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setPendingRemove(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {/* 非车主连表单都不渲染（AC-55-5）：入口本身就不该出现 */}
      {isOwner ? (
        <form className="own-grant-form" onSubmit={submit}>
          <input
            placeholder="对方的账号"
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <select value={role} onChange={(e) => setRole(e.target.value as "driver" | "passenger")}>
            <option value="driver">驾驶</option>
            <option value="passenger">乘坐</option>
          </select>
          <button type="submit" disabled={busy || !username.trim()}>
            添加
          </button>
        </form>
      ) : null}

      {error ? <p className="own-error">{error}</p> : null}
    </section>
  );
}
