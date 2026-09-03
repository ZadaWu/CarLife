/**
 * 账号页 `/identity/users`（施工单 M68-03）——「用户体系」组的入口。
 *
 * 顶部六个总览计数、一个搜索框的账号列表、admin 的建号表单。
 * 客服手里的线索永远是"用户名"，所以搜索只有一个框（username / 显示名模糊，id 精确）。
 *
 * # 角色在服务端
 *
 * 「新建账号」按 `identity.role === "admin"` **不渲染**（不是渲染后禁用）——与 F-55-07 同一条纪律；
 * 直接敲接口一样被 403 挡住。
 *
 * # 口令不回显
 *
 * 建号成功只显示"已创建 <username>"，提交即清空口令输入。服务端 `users.ts` 也不回明文口令：
 * 让口令留在页面状态里，等于把它留在了下一次截图里。
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, ApiError } from "../../api";
import { useIdentity } from "../../app/identity";
import { Hint } from "../../components/Hint";
import { Pager } from "./Pager";
import {
  FIRST_PAGE,
  currentCursor,
  errorText,
  fmtTime,
  identityQuery,
  validateNewAccount,
  type CursorStack,
  type IdentityOverview,
  type Page,
  type UserRow,
} from "./model";

const PAGE_SIZE = 50;

export function IdentityUsersPage(): JSX.Element {
  const identity = useIdentity();
  const isAdmin = identity.role === "admin";
  const navigate = useNavigate();

  const [overview, setOverview] = useState<IdentityOverview | null>(null);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [stack, setStack] = useState<CursorStack>(FIRST_PAGE);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** 建号成功的回执。**放在父组件**：表单成功即收起，消息留在表单里会跟着一起消失。 */
  const [createdNote, setCreatedNote] = useState<string | null>(null);
  /** 刷新计数：建号成功后总览与列表都要重取。 */
  const [tick, setTick] = useState(0);

  const cursor = currentCursor(stack);

  useEffect(() => {
    api
      .get<IdentityOverview>("/console/identity/overview")
      .then(setOverview)
      .catch((e: unknown) => setError(e instanceof ApiError ? errorText(e.code) : String(e)));
  }, [tick]);

  const load = useCallback(() => {
    const params = identityQuery({ q }, { limit: String(PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    setRows(null);
    setLoading(true);
    api
      .get<Page<UserRow>>(`/console/identity/users?${params}`)
      .then((r) => {
        setRows(r.rows);
        setNext(r.hasMore ? r.nextCursor : null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? errorText(e.code) : String(e)))
      .finally(() => setLoading(false));
  }, [q, cursor, tick]);

  useEffect(load, [load]);

  return (
    <div className="page">
      <h1>
        账号
        <Hint label="本页说明">
          <p>
            <strong>一车一主、驾驶人 / 乘客授权、设备绑定</strong>三层的运营入口。这里是"人"的维度：
            找到这个人 → 看他名下有什么（车、被授权的车、设备、最近会话）。
          </p>
          <p>
            账号由管理员预置（FL-07 负向验收：不做自助注册）。<strong>口令不回显</strong>：建号后只显示用户名。
          </p>
          <p>
            计数口径：「生效授权」是<strong>条数</strong>（一人两车算两条）；「设备」只数<strong>未撤销</strong>的。
          </p>
        </Hint>
      </h1>
      <p className="muted">
        回答一个问题：<strong>这个人是谁、名下有什么</strong>。搜索按用户名 / 显示名模糊、按 id 精确。
      </p>

      {overview && (
        <div className="audit-summary">
          <div className="audit-stat">
            <span className="audit-stat-num">{overview.users}</span>
            <span className="audit-stat-label">账号</span>
          </div>
          <div className="audit-stat">
            <span className="audit-stat-num">{overview.vehicles}</span>
            <span className="audit-stat-label">车辆</span>
          </div>
          <div className="audit-stat">
            <span className="audit-stat-num">{overview.activeGrants.driver + overview.activeGrants.passenger}</span>
            <span className="audit-stat-label">
              生效授权（条）
              <Hint label="授权口径">
                <p>
                  驾驶人 {overview.activeGrants.driver} · 乘客 {overview.activeGrants.passenger}。
                  是<strong>条数</strong>不是人数——同一个人被两辆车授权算两条。车主不在其中（所有权不是授权）。
                </p>
              </Hint>
            </span>
          </div>
          <div className="audit-stat">
            <span className="audit-stat-num">{overview.devices.mobile + overview.devices.pad}</span>
            <span className="audit-stat-label">私人终端（手机 {overview.devices.mobile} · 平板 {overview.devices.pad}）</span>
          </div>
          <div className="audit-stat">
            <span className="audit-stat-num">{overview.devices.cockpit}</span>
            <span className="audit-stat-label">车机（绑在 {overview.vehiclesWithCockpit} 辆车上）</span>
          </div>
          <div className={overview.revokedDevices > 0 ? "audit-stat audit-stat--warn" : "audit-stat"}>
            <span className="audit-stat-num">{overview.revokedDevices}</span>
            <span className="audit-stat-label">已撤销 / 解绑的设备</span>
          </div>
        </div>
      )}

      <div className="filters">
        <label className="field">
          <span>搜索</span>
          <input
            value={q}
            placeholder="用户名 / 显示名 / id"
            onChange={(e) => {
              setQ(e.target.value);
              setStack(FIRST_PAGE);
              setNext(null);
            }}
          />
        </label>
        <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
          查询
        </button>
        {isAdmin ? (
          <button type="button" className="btn" onClick={() => setCreating((v) => !v)}>
            {creating ? "收起" : "新建账号"}
          </button>
        ) : null}
      </div>

      {isAdmin && creating ? (
        <CreateAccountForm
          onCreated={(note) => {
            setCreating(false);
            setCreatedNote(note);
            setTick((t) => t + 1);
          }}
        />
      ) : null}
      {createdNote ? <p className="id-ok">{createdNote}</p> : null}

      {error ? <p className="error">{error}</p> : null}
      {!rows ? (
        <p className="muted">载入中…</p>
      ) : rows.length === 0 ? (
        <p className="muted">没有匹配的账号。</p>
      ) : (
        <table className="table table-clickable">
          <thead>
            <tr>
              <th>用户名</th>
              <th>显示名</th>
              <th>名下车辆</th>
              <th>被授权</th>
              <th>私人终端</th>
              <th>最近活跃</th>
              <th>创建时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const open = (): void => {
                void navigate(`/identity/users/${encodeURIComponent(u.id)}`);
              };
              return (
                <tr
                  key={u.id}
                  tabIndex={0}
                  role="link"
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open();
                    }
                  }}
                >
                  <td className="mono">{u.username}</td>
                  <td>{u.displayName ?? <span className="muted">—</span>}</td>
                  <td>{u.ownedVehicles}</td>
                  <td>{u.activeGrants}</td>
                  <td>{u.activeDevices}</td>
                  <td className="mono">{fmtTime(u.lastActiveAt)}</td>
                  <td className="mono">{fmtTime(u.createdAt)}</td>
                  <td className="row-cta">查看 →</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rows && (rows.length > 0 || stack.length > 1) ? (
        <Pager stack={stack} next={next} pageSize={PAGE_SIZE} loading={loading} onChange={setStack} />
      ) : null}
    </div>
  );
}

/** 建号表单（admin）。调 M48-02 的 `POST /console/users`。 */
function CreateAccountForm({ onCreated }: { onCreated: (note: string) => void }): JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const submit = async (): Promise<void> => {
    const local = validateNewAccount({ username, password });
    if (local) {
      setMsg({ kind: "err", text: local });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const created = await api.post<{ id: string; username: string }>("/console/users", {
        username: username.trim(),
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      // 口令不回显：成功即清空，页面状态里不留它（父组件随即收起本表单）
      setPassword("");
      setUsername("");
      setDisplayName("");
      onCreated(`已创建 ${created.username}（id ${created.id}）`);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof ApiError ? errorText(e.code) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="id-form">
      <div className="filters">
        <label className="field">
          <span>用户名（≥3）</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>初始口令（≥8，不回显）</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <label className="field">
          <span>显示名（可选）</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
          {busy ? "创建中…" : "创建"}
        </button>
      </div>
      {msg ? <p className={msg.kind === "ok" ? "id-ok" : "error"}>{msg.text}</p> : null}
    </div>
  );
}
