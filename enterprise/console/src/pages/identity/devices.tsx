/**
 * 终端设备页 `/identity/devices`（施工单 M68-04）。
 *
 * 回答"这台设备是谁的、绑在哪辆车上、还活着吗"。三个下拉（类型 / 状态 / 归属），不搜文本：
 * 运营到这一页多半是从账号详情或车辆详情带着 `?userId=` / `?vin=` 过来的。
 *
 * 默认只看未撤销（运营默认看活着的），已撤销的能切过来看——否则"我上周撤过吗"答不了。
 * 车机行的按钮写「解绑」，私人行写「撤销」——同一端点，两个动作的名字。
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { api, ApiError } from "../../api";
import { useIdentity } from "../../app/identity";
import { ConfirmAction } from "../../components/ConfirmAction";
import { Hint } from "../../components/Hint";
import { Pager } from "./Pager";
import { FragmentRow } from "./vehicle-detail";
import {
  DEVICE_TYPE_LABEL,
  FIRST_PAGE,
  currentCursor,
  deviceQuery,
  deviceStatus,
  errorText,
  fmtTime,
  revokeConsequence,
  revokeResultText,
  shortId,
  type CursorStack,
  type DeviceListRow,
  type Page,
  type RevokeDeviceResult,
} from "./model";

const PAGE_SIZE = 50;

export function IdentityDevicesPage(): JSX.Element {
  const identity = useIdentity();
  const isAdmin = identity.role === "admin";
  // `?userId=` / `?vin=` 只做初值（账号详情 / 车辆详情带过来的）；之后改筛选不回写 URL。
  const [searchParams] = useSearchParams();
  const [type, setType] = useState("");
  const [status, setStatus] = useState("active");
  const [userId, setUserId] = useState(searchParams.get("userId") ?? "");
  const [vin, setVin] = useState(searchParams.get("vin") ?? "");
  const [rows, setRows] = useState<DeviceListRow[] | null>(null);
  const [stack, setStack] = useState<CursorStack>(FIRST_PAGE);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const cursor = currentCursor(stack);

  const load = useCallback(() => {
    const params = deviceQuery({ type, status, userId, vin }, { limit: String(PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    setRows(null);
    setLoading(true);
    api
      .get<Page<DeviceListRow>>(`/console/identity/devices?${params}`)
      .then((r) => {
        setRows(r.rows);
        setNext(r.hasMore ? r.nextCursor : null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? errorText(e.code) : String(e)))
      .finally(() => setLoading(false));
  }, [type, status, userId, vin, cursor]);

  useEffect(load, [load]);

  const resetPaging = (): void => {
    setStack(FIRST_PAGE);
    setNext(null);
  };

  const revoke = async (d: DeviceListRow, reason?: string): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.post<RevokeDeviceResult>(`/console/identity/devices/${encodeURIComponent(d.id)}/revoke`, reason ? { reason } : {});
      setNote({ kind: "ok", text: `${shortId(d.id)} ${revokeResultText(r)}` });
      setPending(null);
      load();
    } catch (e) {
      setNote({ kind: "err", text: e instanceof ApiError ? errorText(e.code) : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>
        终端设备
        <Hint label="本页说明">
          <p>
            "设备"的维度。私人终端（手机 / 平板）<strong>绑人</strong>，车机<strong>绑车</strong>；同一台 pad 充当车机时是另一条记录（R12）。
          </p>
          <p>
            默认只看未撤销的；切「已撤销」能看历史。撤销 = 该设备下一次刷新登录即失效（R11：库里的软删是唯一真相源）。
          </p>
        </Hint>
      </h1>
      <p className="muted">回答一个问题：<strong>这台设备是谁的、绑在哪、还活着吗</strong>。</p>

      <div className="filters">
        <label className="field">
          <span>类型</span>
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              resetPaging();
            }}
          >
            <option value="">全部</option>
            <option value="mobile">手机</option>
            <option value="pad">平板</option>
            <option value="cockpit">车机</option>
          </select>
        </label>
        <label className="field">
          <span>状态</span>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              resetPaging();
            }}
          >
            <option value="active">未撤销</option>
            <option value="revoked">已撤销 / 解绑</option>
            <option value="all">全部</option>
          </select>
        </label>
        <label className="field">
          <span>所属账号 id</span>
          <input
            value={userId}
            placeholder="userId（精确）"
            onChange={(e) => {
              setUserId(e.target.value);
              resetPaging();
            }}
          />
        </label>
        <label className="field">
          <span>绑定车辆 VIN</span>
          <input
            value={vin}
            placeholder="VIN（精确）"
            onChange={(e) => {
              setVin(e.target.value);
              resetPaging();
            }}
          />
        </label>
        <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
          查询
        </button>
      </div>
      {note ? <p className={note.kind === "ok" ? "id-ok" : "error"}>{note.text}</p> : null}

      {error ? <p className="error">{error}</p> : null}
      {!rows ? (
        <p className="muted">载入中…</p>
      ) : rows.length === 0 ? (
        <p className="muted">没有匹配的设备。{status === "active" ? "（已撤销的要把状态切到「已撤销 / 解绑」才看得到。）" : ""}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>设备</th>
              <th>类型</th>
              <th>型号</th>
              <th>所属账号</th>
              <th>绑定车辆</th>
              <th>注册</th>
              <th>最近活跃</th>
              <th>状态</th>
              {isAdmin ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const open = pending === d.id;
              const kind = d.vehicleVin ? "cockpit" : "personal";
              return (
                <FragmentRow
                  key={d.id}
                  open={open}
                  colSpan={isAdmin ? 9 : 8}
                  confirm={
                    open ? (
                      <ConfirmAction
                        title={`${kind === "cockpit" ? "解绑车机" : "撤销设备"} ${shortId(d.id)}（${d.modelName}）`}
                        consequence={revokeConsequence(kind)}
                        confirmLabel={kind === "cockpit" ? "确认解绑" : "确认撤销"}
                        busy={busy}
                        onConfirm={(reason) => void revoke(d, reason)}
                        onCancel={() => setPending(null)}
                      />
                    ) : null
                  }
                >
                  <tr className={d.revokedAt ? "id-row--revoked" : undefined}>
                    <td className="mono" title={d.id}>{shortId(d.id)}</td>
                    <td>{DEVICE_TYPE_LABEL[d.deviceType] ?? d.deviceType}</td>
                    <td>{d.modelName}</td>
                    <td className="mono">
                      <Link to={`/identity/users/${encodeURIComponent(d.userId)}`}>{d.user?.username ?? d.userId}</Link>
                      {kind === "cockpit" ? <span className="muted tiny">（绑定者）</span> : null}
                    </td>
                    <td className="mono">
                      {d.vehicleVin ? (
                        <Link to={`/identity/vehicles/${encodeURIComponent(d.vehicleVin)}`}>
                          {d.vehicleVin}
                          {d.vehicleModel ? <span className="muted"> · {d.vehicleModel}</span> : null}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="mono">{fmtTime(d.registeredAt)}</td>
                    <td className="mono">{fmtTime(d.lastActiveAt)}</td>
                    <td>{deviceStatus(d)}</td>
                    {isAdmin ? (
                      <td className="row-cta">
                        {!d.revokedAt ? (
                          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setPending(d.id)}>
                            {kind === "cockpit" ? "解绑" : "撤销"}
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
      {rows && (rows.length > 0 || stack.length > 1) ? (
        <Pager stack={stack} next={next} pageSize={PAGE_SIZE} loading={loading} onChange={setStack} />
      ) : null}
    </div>
  );
}
