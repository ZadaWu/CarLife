/**
 * 账号详情 `/identity/users/:id`（施工单 M68-03）——一眼看全"这个人有什么"。
 *
 * 四块：名下车辆（他是车主）/ 被授权的车（他是驾驶人或乘客）/ 设备（含他绑定的车机、含已撤销）/ 最近会话。
 * 已撤销的行压灰**不隐藏**：运营要答"我上周撤过吗"。
 *
 * admin 多一个「重置口令」：输入新口令 → 再点一次确认。口令不回显（提交即清空）。
 *
 * 「看他的全部会话」跳 `/sessions?userId=`——会话页只把它当**初值**，之后改筛选不回写 URL。
 * **不放记忆页入口**：`console/memory.ts` 仍以 demo-user 为默认主体（M48-02 §7 #5 的债），链过去看的可能是别人的。
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, ApiError } from "../../api";
import { useIdentity } from "../../app/identity";
import { Hint } from "../../components/Hint";
import {
  DEVICE_TYPE_LABEL,
  ENERGY_LABEL,
  ROLE_LABEL,
  deviceStatus,
  errorText,
  fmtTime,
  grantStatus,
  shortId,
  type UserDetail,
} from "./model";

export function IdentityUserDetailPage(): JSX.Element {
  const { id = "" } = useParams();
  const identity = useIdentity();
  const isAdmin = identity.role === "admin";
  const navigate = useNavigate();
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .get<UserDetail>(`/console/identity/users/${encodeURIComponent(id)}`)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof ApiError ? errorText(e.code) : String(e)));
  }, [id]);

  useEffect(load, [load]);

  if (error) {
    return (
      <div className="page">
        <h1>账号详情</h1>
        <p className="error">{error}</p>
        <Link to="/identity/users">← 回账号列表</Link>
      </div>
    );
  }
  if (!detail) return <div className="page"><p className="muted">载入中…</p></div>;

  const { user } = detail;

  return (
    <div className="page">
      <p className="muted">
        <Link to="/identity/users">← 账号</Link>
      </p>
      <h1>
        {user.displayName ?? user.username}
        <span className="id-sub mono">{user.username}</span>
      </h1>
      <div className="id-kv">
        <span className="muted">id</span>
        <span className="mono">{user.id}</span>
        <span className="muted">创建时间</span>
        <span className="mono">{fmtTime(user.createdAt)}</span>
      </div>
      <div className="detail-actions">
        <Link className="btn btn-secondary btn-sm" to={`/sessions?userId=${encodeURIComponent(user.id)}`}>
          看他的全部会话 →
        </Link>
        {isAdmin ? <ResetPassword userId={user.id} /> : null}
      </div>

      <section className="id-section">
        <h2>
          名下车辆（{detail.ownedVehicles.length}）
          <Hint label="名下车辆说明">
            <p>他是<strong>车主</strong>的车——所有权只由车辆档案的 ownerId 表达（一车一主，设计裁决 R1）。</p>
          </Hint>
        </h2>
        {detail.ownedVehicles.length === 0 ? (
          <p className="muted">没有。</p>
        ) : (
          <table className="table table-clickable">
            <thead>
              <tr>
                <th>VIN</th>
                <th>车型</th>
                <th>能源</th>
                <th>默认车</th>
                <th>生效授权</th>
                <th>车机</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.ownedVehicles.map((v) => (
                <tr key={v.vin} tabIndex={0} role="link" onClick={() => void navigate(`/identity/vehicles/${v.vin}`)}>
                  <td className="mono">{v.vin}</td>
                  <td>
                    {v.model} · {v.modelYear}
                  </td>
                  <td>{v.energyType ? (ENERGY_LABEL[v.energyType] ?? v.energyType) : <span className="muted">未知</span>}</td>
                  <td>{v.isDefault ? "✓" : ""}</td>
                  <td>{v.activeGrants}</td>
                  <td>{v.cockpits}</td>
                  <td className="row-cta">查看 →</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="id-section">
        <h2>被授权的车（{detail.grants.length}）</h2>
        {detail.grants.length === 0 ? (
          <p className="muted">没有。</p>
        ) : (
          <table className="table table-clickable">
            <thead>
              <tr>
                <th>VIN</th>
                <th>车型</th>
                <th>车主</th>
                <th>角色</th>
                <th>授予时间</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.grants.map((g) => (
                <tr
                  key={g.id}
                  className={g.revokedAt ? "id-row--revoked" : undefined}
                  tabIndex={0}
                  role="link"
                  onClick={() => void navigate(`/identity/vehicles/${g.vin}`)}
                >
                  <td className="mono">{g.vin}</td>
                  <td>{g.vehicleModel ?? "—"}</td>
                  <td>{g.owner ? (g.owner.displayName ?? g.owner.username) : <span className="muted">—</span>}</td>
                  <td>{ROLE_LABEL[g.role]}</td>
                  <td className="mono">{fmtTime(g.grantedAt)}</td>
                  <td>{g.revokedAt ? `已于 ${fmtTime(g.revokedAt)} 撤销` : grantStatus(g)}</td>
                  <td className="row-cta">查看 →</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="id-section">
        <h2>
          设备（{detail.devices.length}）
          <Hint label="设备说明">
            <p>
              含他绑定的车机（记在绑定者名下，供审计）与<strong>已撤销</strong>的设备。
              私人终端撤销叫"已撤销"，车机撤销叫"已解绑"——同一个字段，两个动作的名字。
            </p>
          </Hint>
        </h2>
        {detail.devices.length === 0 ? (
          <p className="muted">没有。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>设备</th>
                <th>类型</th>
                <th>型号</th>
                <th>绑定车辆</th>
                <th>注册</th>
                <th>最近活跃</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {detail.devices.map((d) => (
                <tr key={d.id} className={d.revokedAt ? "id-row--revoked" : undefined}>
                  <td className="mono" title={d.id}>{shortId(d.id)}</td>
                  <td>{DEVICE_TYPE_LABEL[d.deviceType] ?? d.deviceType}</td>
                  <td>{d.modelName}</td>
                  <td className="mono">{d.vehicleVin ? <Link to={`/identity/vehicles/${d.vehicleVin}`}>{d.vehicleVin}</Link> : "—"}</td>
                  <td className="mono">{fmtTime(d.registeredAt)}</td>
                  <td className="mono">{fmtTime(d.lastActiveAt)}</td>
                  <td>{deviceStatus(d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted tiny">
          <Link to={`/identity/devices?userId=${encodeURIComponent(user.id)}`}>在终端设备页按此账号筛选 →</Link>
        </p>
      </section>

      <section className="id-section">
        <h2>最近会话（{detail.recentSessions.length}）</h2>
        {detail.recentSessions.length === 0 ? (
          <p className="muted">没有。访客会话不属于任何账号，不会出现在这里。</p>
        ) : (
          <table className="table table-clickable">
            <thead>
              <tr>
                <th>标题</th>
                <th>会话 id</th>
                <th>轮次</th>
                <th>最近活动</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.recentSessions.map((s) => (
                <tr key={s.sessionId} tabIndex={0} role="link" onClick={() => void navigate(`/sessions/${s.sessionId}`)}>
                  <td>{s.title ?? <span className="muted">（还没起名）</span>}</td>
                  <td className="mono">{s.sessionId}</td>
                  <td>{s.turnCount}</td>
                  <td className="mono">{fmtTime(s.updatedAt)}</td>
                  <td className="row-cta">查看 →</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/** 重置口令（admin）：输入 → 再点一次确认。调 M48-02 的 `POST /console/users/:id/password`。 */
function ResetPassword({ userId }: { userId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const submit = async (): Promise<void> => {
    if (password.length < 8) {
      setMsg({ kind: "err", text: "口令至少 8 位" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`/console/users/${encodeURIComponent(userId)}/password`, { password });
      setPassword("");
      setArmed(false);
      setOpen(false);
      setMsg({ kind: "ok", text: "口令已重置（不回显）" });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? errorText(e.code) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="id-inline">
      {!open ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
          重置口令
        </button>
      ) : (
        <>
          <input
            type="password"
            placeholder="新口令（≥8）"
            value={password}
            autoComplete="new-password"
            onChange={(e) => {
              setPassword(e.target.value);
              setArmed(false);
            }}
          />
          {!armed ? (
            <button type="button" className="btn btn-sm" disabled={busy || password.length < 8} onClick={() => setArmed(true)}>
              重置
            </button>
          ) : (
            <button type="button" className="btn btn-sm id-danger" disabled={busy} onClick={() => void submit()}>
              {busy ? "提交中…" : "确认重置——该账号现有登录态照旧，只换口令"}
            </button>
          )}
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              setOpen(false);
              setArmed(false);
              setPassword("");
            }}
          >
            取消
          </button>
        </>
      )}
      {msg ? <span className={msg.kind === "ok" ? "id-ok" : "error"}> {msg.text}</span> : null}
    </span>
  );
}
