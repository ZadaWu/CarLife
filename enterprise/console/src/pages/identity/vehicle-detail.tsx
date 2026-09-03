/**
 * 车辆详情 `/identity/vehicles/:vin`（施工单 M68-04）。
 *
 * 四块：车辆 / 车主 / 授权（含已撤销，admin 可撤销生效的）/ 车机（含已解绑，admin 可解绑）。
 * 车主**单独一块**不是授权表的一行——他不是授权，撤不掉（服务端 409 也这么说）。
 * 影子档案只一句"N 条，内容见「客户座舱」"（F-46-13：称呼是车主给家人起的叫法）。
 *
 * 动作按钮只在 admin 渲染；一次只展开一个确认条（`pending`）。
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api, ApiError } from "../../api";
import { useIdentity } from "../../app/identity";
import { ConfirmAction } from "../../components/ConfirmAction";
import { Hint } from "../../components/Hint";
import {
  DEVICE_TYPE_LABEL,
  ENERGY_LABEL,
  ROLE_LABEL,
  deviceStatus,
  errorText,
  fmtTime,
  revokeConsequence,
  revokeResultText,
  shortId,
  type RevokeDeviceResult,
  type RevokeGrantResult,
  type VehicleDetail,
} from "./model";

type Pending = { kind: "grant"; userId: string } | { kind: "cockpit"; deviceId: string } | null;

export function IdentityVehicleDetailPage(): JSX.Element {
  const { vin = "" } = useParams();
  const identity = useIdentity();
  const isAdmin = identity.role === "admin";
  const [detail, setDetail] = useState<VehicleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(() => {
    api
      .get<VehicleDetail>(`/console/identity/vehicles/${encodeURIComponent(vin)}`)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof ApiError ? errorText(e.code) : String(e)));
  }, [vin]);

  useEffect(load, [load]);

  const revokeGrant = async (userId: string, reason?: string): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.post<RevokeGrantResult>(
        `/console/identity/vehicles/${encodeURIComponent(vin)}/grants/${encodeURIComponent(userId)}/revoke`,
        reason ? { reason } : {},
      );
      setNote({ kind: "ok", text: `授权${revokeResultText({ alreadyRevoked: r.alreadyRevoked })}` });
      setPending(null);
      load();
    } catch (e) {
      setNote({ kind: "err", text: e instanceof ApiError ? errorText(e.code) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (deviceId: string, reason?: string): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.post<RevokeDeviceResult>(`/console/identity/devices/${encodeURIComponent(deviceId)}/revoke`, reason ? { reason } : {});
      setNote({ kind: "ok", text: `车机${revokeResultText(r)}` });
      setPending(null);
      load();
    } catch (e) {
      setNote({ kind: "err", text: e instanceof ApiError ? errorText(e.code) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="page">
        <h1>车辆详情</h1>
        <p className="error">{error}</p>
        <Link to="/identity/vehicles">← 回车辆列表</Link>
      </div>
    );
  }
  if (!detail) return <div className="page"><p className="muted">载入中…</p></div>;

  const { vehicle, owner } = detail;

  return (
    <div className="page">
      <p className="muted">
        <Link to="/identity/vehicles">← 车辆与授权</Link>
      </p>
      <h1>
        {vehicle.model} · {vehicle.modelYear}
        <span className="id-sub mono">{vehicle.vin}</span>
      </h1>
      <div className="id-kv">
        <span className="muted">能源</span>
        <span>{vehicle.energyType ? (ENERGY_LABEL[vehicle.energyType] ?? vehicle.energyType) : "未知"}</span>
        <span className="muted">里程</span>
        <span className="mono">{vehicle.odometerKm} km</span>
        <span className="muted">购入</span>
        <span className="mono">{fmtTime(vehicle.purchasedAt)}</span>
        <span className="muted">默认车</span>
        <span>{vehicle.isDefault ? "是（该车主的默认车）" : "否"}</span>
        <span className="muted">车主</span>
        <span>
          {owner ? (
            <Link to={`/identity/users/${encodeURIComponent(owner.id)}`}>
              {owner.displayName ?? owner.username} <span className="mono muted">({owner.username})</span>
            </Link>
          ) : (
            <span className="muted">—</span>
          )}
          <Hint label="车主说明">
            <p>
              车主<strong>不是授权</strong>，撤不掉——所有权只在车辆档案的 ownerId（一车一主，R1）。
              过户 / 转让不在本系统范围内。
            </p>
          </Hint>
        </span>
      </div>
      {note ? <p className={note.kind === "ok" ? "id-ok" : "error"}>{note.text}</p> : null}

      <section className="id-section">
        <h2>
          授权（{detail.grants.length}）
          <Hint label="授权说明">
            <p>含已撤销的（压灰）。「已关联档案」是这条授权对应车上哪个影子成员——只显示是否关联，不显示称呼（F-46-13）。</p>
            <p>后台只<strong>收回</strong>不代授：添加成员由车主在手机端做。</p>
          </Hint>
        </h2>
        {detail.grants.length === 0 ? (
          <p className="muted">没有授权过任何人。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>显示名</th>
                <th>角色</th>
                <th>授予时间</th>
                <th>状态</th>
                <th>已关联档案</th>
                {isAdmin ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {detail.grants.map((g) => (
                <GrantRowView
                  key={g.id}
                  g={g}
                  isAdmin={isAdmin}
                  pending={pending?.kind === "grant" && pending.userId === g.userId}
                  busy={busy}
                  onAsk={() => setPending({ kind: "grant", userId: g.userId })}
                  onCancel={() => setPending(null)}
                  onConfirm={(reason) => void revokeGrant(g.userId, reason)}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="id-section">
        <h2>
          车机（{detail.cockpits.length}）
          <Hint label="车机说明">
            <p>绑到这辆车的车机终端，含已解绑的（压灰）。「绑定者」只是当时扫码的人（必是车主），<strong>不代表谁在用</strong>——那由上车声明回答。</p>
          </Hint>
        </h2>
        {detail.cockpits.length === 0 ? (
          <p className="muted">没有绑过车机。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>设备</th>
                <th>型号</th>
                <th>绑定者</th>
                <th>注册</th>
                <th>最近活跃</th>
                <th>状态</th>
                {isAdmin ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {detail.cockpits.map((d) => {
                const open = pending?.kind === "cockpit" && pending.deviceId === d.id;
                return (
                  <FragmentRow key={d.id} open={open} colSpan={isAdmin ? 7 : 6} confirm={
                    open ? (
                      <ConfirmAction
                        title={`解绑车机 ${shortId(d.id)}`}
                        consequence={revokeConsequence("cockpit")}
                        confirmLabel="确认解绑"
                        busy={busy}
                        onConfirm={(reason) => void revokeDevice(d.id, reason)}
                        onCancel={() => setPending(null)}
                      />
                    ) : null
                  }>
                    <tr className={d.revokedAt ? "id-row--revoked" : undefined}>
                      <td className="mono" title={d.id}>{shortId(d.id)}</td>
                      <td>{d.modelName}</td>
                      <td className="mono">
                        <Link to={`/identity/users/${encodeURIComponent(d.userId)}`}>{d.userId}</Link>
                      </td>
                      <td className="mono">{fmtTime(d.registeredAt)}</td>
                      <td className="mono">{fmtTime(d.lastActiveAt)}</td>
                      <td>{deviceStatus(d)}</td>
                      {isAdmin ? (
                        <td className="row-cta">
                          {!d.revokedAt ? (
                            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setPending({ kind: "cockpit", deviceId: d.id })}>
                              解绑
                            </button>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted tiny">
          {DEVICE_TYPE_LABEL.cockpit}只是绑到车上的终端；私人设备（手机 / 平板）在账号详情与
          <Link to={`/identity/devices?vin=${encodeURIComponent(vehicle.vin)}`}>终端设备页</Link>。
        </p>
      </section>

      <section className="id-section">
        <h2>影子成员档案</h2>
        <p className="muted">
          {detail.shadowMemberCount} 条。称呼 / 关系 / 手机号是车主给家人登记的内容（他人 PII），不在本页展开——
          要看去<Link to="/cabin">「客户座舱」</Link>（那一页有自己的查看审计）。
        </p>
      </section>
    </div>
  );
}

function GrantRowView({
  g,
  isAdmin,
  pending,
  busy,
  onAsk,
  onCancel,
  onConfirm,
}: {
  g: VehicleDetail["grants"][number];
  isAdmin: boolean;
  pending: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: (reason?: string) => void;
}): JSX.Element {
  return (
    <FragmentRow
      open={pending}
      colSpan={isAdmin ? 7 : 6}
      confirm={
        pending ? (
          <ConfirmAction
            title={`撤销 ${g.user?.username ?? g.userId} 的${ROLE_LABEL[g.role]}授权`}
            consequence={revokeConsequence("grant")}
            confirmLabel="确认撤销"
            busy={busy}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        ) : null
      }
    >
      <tr className={g.revokedAt ? "id-row--revoked" : undefined}>
        <td className="mono">
          <Link to={`/identity/users/${encodeURIComponent(g.userId)}`}>{g.user?.username ?? g.userId}</Link>
        </td>
        <td>{g.user?.displayName ?? <span className="muted">—</span>}</td>
        <td>{ROLE_LABEL[g.role]}</td>
        <td className="mono">{fmtTime(g.grantedAt)}</td>
        <td>{g.revokedAt ? `已于 ${fmtTime(g.revokedAt)} 撤销` : "生效"}</td>
        <td>{g.linkedMember ? "✓" : ""}</td>
        {isAdmin ? (
          <td className="row-cta">
            {!g.revokedAt ? (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onAsk}>
                撤销
              </button>
            ) : null}
          </td>
        ) : null}
      </tr>
    </FragmentRow>
  );
}

/** 一行 + 它下面（展开时）的确认条。表格里塞不了 div，所以确认条占一整行。 */
export function FragmentRow({
  open,
  colSpan,
  confirm,
  children,
}: {
  open: boolean;
  colSpan: number;
  confirm: JSX.Element | null;
  children: JSX.Element;
}): JSX.Element {
  return (
    <>
      {children}
      {open ? (
        <tr className="confirm-row">
          <td colSpan={colSpan}>{confirm}</td>
        </tr>
      ) : null}
    </>
  );
}
