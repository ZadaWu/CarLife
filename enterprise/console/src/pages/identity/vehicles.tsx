/**
 * 车辆与授权列表 `/identity/vehicles`（施工单 M68-04）。
 *
 * 回答"这辆车是谁的、授权给了几个人、绑了几台车机"。搜索一个框：VIN 前缀 / 车型模糊 / 车主 username 模糊
 * ——运营手里的线索是"VIN 末几位"或"车主的用户名"。整行可点进详情。
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, ApiError } from "../../api";
import { Hint } from "../../components/Hint";
import { Pager } from "./Pager";
import {
  ENERGY_LABEL,
  FIRST_PAGE,
  currentCursor,
  errorText,
  fmtTime,
  vehicleQuery,
  type CursorStack,
  type Page,
  type VehicleRow,
} from "./model";

const PAGE_SIZE = 50;

export function IdentityVehiclesPage(): JSX.Element {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<VehicleRow[] | null>(null);
  const [stack, setStack] = useState<CursorStack>(FIRST_PAGE);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = currentCursor(stack);

  const load = useCallback(() => {
    const params = vehicleQuery({ q }, { limit: String(PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    setRows(null);
    setLoading(true);
    api
      .get<Page<VehicleRow>>(`/console/identity/vehicles?${params}`)
      .then((r) => {
        setRows(r.rows);
        setNext(r.hasMore ? r.nextCursor : null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? errorText(e.code) : String(e)))
      .finally(() => setLoading(false));
  }, [q, cursor]);

  useEffect(load, [load]);

  return (
    <div className="page">
      <h1>
        车辆与授权
        <Hint label="本页说明">
          <p>
            "车"的维度：一辆车<strong>只有一个车主</strong>（所有权只在车辆档案的 ownerId，设计裁决 R1），
            可以授权给若干驾驶人 / 乘客，可以绑若干台车机。
          </p>
          <p>
            「生效授权」不含车主；「车机」只数未撤销的。影子成员（车主登记的家人档案）的称呼<strong>不在本组页面</strong>出现，
            要看去「客户座舱」。
          </p>
        </Hint>
      </h1>
      <p className="muted">搜索按 VIN 前缀、车型模糊、车主用户名模糊。</p>

      <div className="filters">
        <label className="field">
          <span>搜索</span>
          <input
            value={q}
            placeholder="VIN / 车型 / 车主用户名"
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
      </div>

      {error ? <p className="error">{error}</p> : null}
      {!rows ? (
        <p className="muted">载入中…</p>
      ) : rows.length === 0 ? (
        <p className="muted">没有匹配的车辆。</p>
      ) : (
        <table className="table table-clickable">
          <thead>
            <tr>
              <th>VIN</th>
              <th>车型 · 年款</th>
              <th>能源</th>
              <th>车主</th>
              <th>生效授权</th>
              <th>车机</th>
              <th>默认车</th>
              <th>建档时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => {
              const open = (): void => {
                void navigate(`/identity/vehicles/${encodeURIComponent(v.vin)}`);
              };
              return (
                <tr
                  key={v.vin}
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
                  <td className="mono">{v.vin}</td>
                  <td>
                    {v.model} · {v.modelYear}
                  </td>
                  <td>{v.energyType ? (ENERGY_LABEL[v.energyType] ?? v.energyType) : <span className="muted">未知</span>}</td>
                  <td>
                    {v.owner ? (
                      <>
                        <span className="mono">{v.owner.username}</span>
                        {v.owner.displayName ? <span className="muted"> · {v.owner.displayName}</span> : null}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{v.activeGrants}</td>
                  <td>{v.cockpits}</td>
                  <td>{v.isDefault ? "✓" : ""}</td>
                  <td className="mono">{fmtTime(v.createdAt)}</td>
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
