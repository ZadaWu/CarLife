/**
 * 客户座舱视图（施工单 M24-10，FL-51）。
 *
 * 客服接起电话时先看得见这辆车：绑定与实时状态（**离线如实显示离线**，不用
 * 缓存值冒充在线）、偏好与组合（只读——页面没有任何写控件，AC-51-1）、
 * 历史时间线（无记录如实"暂无"）。打开视图是提权动作，服务端已写审计。
 *
 * 展示层是一张**俯视座舱示意图**：温度/加热/通风/儿童锁落在对应座位上，
 * 氛围灯颜色与亮度来自真实状态。读不到的字段不画（缺什么就没有那一块），
 * 原始 JSON 折叠保留给排查。
 */

import { useCallback, useEffect, useState, type CSSProperties } from "react";

import { api, ApiError } from "../../api";
import "./cabin.css";

interface CabinPref {
  tempC?: number;
  tempMaxC?: number;
  seatHeating?: number;
  seatVentilation?: number;
  ambientBrightness?: number;
  mediaContentTag?: string;
  mediaVolumeLimit?: number;
}

interface ViewData {
  vehicle: { vin: string; ownerId: string; model: string };
  members: Array<{ id: string; displayName: string; relation: string | null; ageBand: string | null; cabinPreference: CabinPref | null }>;
  combinations: Array<{ id: string; label: string; memberIds: string[]; override: CabinPref; invalidReason: string | null }> | null;
}

interface StateData {
  state: "online" | "offline" | "unbound" | "unconfigured";
  reason?: string;
  cabinVehicleId?: string;
  deviceState?: Record<string, unknown>;
  fetchedAt?: string;
  provenance?: string;
}

interface HistoryData {
  windowDays: number;
  trips: Array<{ id: string; startedAt: number; endedAt: number; distanceKm: number }>;
  maintenance: Array<{ at: number; items: string; odometerKm: number }>;
  repairs: Array<{ at: number; symptom: string }>;
  cabinChanges: Array<{ seq: number; at: string; domain: string; zone: string; field: string; from: unknown; to: unknown }> | null;
  cabinChangesNote: string;
}

/* ── 车机状态的形状（与 mocks/cabin/src/state.ts 的 CabinState 对齐，
     全部可选：设备没报的域整块不渲染，不编） */
interface ClimateZoneState { tempC?: number; fanLevel?: number; mode?: string; recirculation?: boolean }
interface SeatZoneState { heating?: number; ventilation?: number; massage?: string }
interface AmbientZoneState { color?: string; brightness?: number; mode?: string }
interface MediaZoneState { source?: string; volume?: number; volumeLimit?: number | null; contentTag?: string | null }
interface ChildZoneState { screenLock?: boolean; childLock?: boolean }
interface DeviceState {
  climate?: Partial<Record<string, ClimateZoneState>>;
  climateSync?: boolean;
  seats?: Partial<Record<string, SeatZoneState>>;
  ambientLight?: Partial<Record<string, AmbientZoneState>>;
  media?: Partial<Record<string, MediaZoneState>>;
  fragrance?: { intensity?: string; scent?: string } | null;
  childMode?: Partial<Record<string, ChildZoneState>>;
}

const ZONE_LABEL: Record<string, string> = {
  driver: "主驾",
  passenger: "副驾",
  rearLeft: "左后",
  rearRight: "右后",
  rear: "后排",
  front: "前排",
  cabin: "全舱",
};

const CLIMATE_MODE: Record<string, string> = { auto: "自动", cool: "制冷", heat: "制热", fanOnly: "送风" };

const PREF_LABEL: Record<string, string> = {
  tempC: "温度",
  tempMaxC: "温度上限",
  seatHeating: "座椅加热",
  seatVentilation: "座椅通风",
  ambientBrightness: "氛围灯亮度",
  mediaContentTag: "上车放",
  mediaVolumeLimit: "音量上限",
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/* ── 小件 ─────────────────────────────────────────────── */

/** 档位刻度（0~3）。0 档整排熄灭但仍占位——"关着"也是信息。 */
function Pips({ kind, label, level }: { kind: "heat" | "vent"; label: string; level: number }): JSX.Element {
  return (
    <span className={`cv-pips cv-pips--${kind}`} title={`${label} ${level} 档`}>
      {label}
      <span className="cv-pips-track">
        {[1, 2, 3].map((n) => (
          <i key={n} className={level >= n ? "on" : undefined} />
        ))}
      </span>
    </span>
  );
}

/** 一个座位格：分区温度（有就显示）、座椅加热/通风档位、儿童锁徽标。 */
function Seat({
  zone,
  seat,
  climate,
  child,
}: {
  zone: "driver" | "passenger" | "rearLeft" | "rearRight";
  seat?: SeatZoneState;
  climate?: ClimateZoneState;
  child?: ChildZoneState;
}): JSX.Element {
  return (
    <div className={`cv-seat cv-seat--${zone}`}>
      <span className="cv-zone-label">{ZONE_LABEL[zone]}</span>
      {climate?.tempC != null && (
        <>
          <span className="cv-temp">
            {climate.tempC}
            <small>℃</small>
          </span>
          {(climate.mode || climate.fanLevel != null) && (
            <span className="cv-temp-mode">
              {[climate.mode && (CLIMATE_MODE[climate.mode] ?? climate.mode), climate.fanLevel != null && `风量 ${climate.fanLevel}`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </>
      )}
      {seat?.heating != null && <Pips kind="heat" label="加热" level={seat.heating} />}
      {seat?.ventilation != null && <Pips kind="vent" label="通风" level={seat.ventilation} />}
      {seat?.massage && seat.massage !== "off" && <span className="cv-tag">按摩 {seat.massage}</span>}
      {(child?.childLock || child?.screenLock) && (
        <span className="cv-lock">{[child.childLock && "儿童锁", child.screenLock && "屏幕锁"].filter(Boolean).join(" · ")}</span>
      )}
    </div>
  );
}

/** 氛围灯带：颜色与亮度注入 CSS 变量。没有该分区数据时由调用方决定不渲染。 */
function AmbientStrip({ pos, zone }: { pos: "front" | "rear"; zone: AmbientZoneState }): JSX.Element {
  const level = Math.max(0, Math.min(1, (zone.brightness ?? 30) / 100));
  return (
    <div
      className={`cv-ambient cv-ambient--${pos}`}
      style={{ "--cv-ambient-color": zone.color || "#4c8dff", "--cv-ambient-level": level } as CSSProperties}
      title={`${ZONE_LABEL[pos]}氛围灯 亮度${zone.brightness ?? "?"}`}
    >
      <i />
      <span className="cv-ambient-tag">
        {ZONE_LABEL[pos]}氛围灯 {zone.brightness != null ? `亮度${zone.brightness}` : ""}
      </span>
    </div>
  );
}

function MediaLine({ zone, media }: { zone: string; media: MediaZoneState }): JSX.Element {
  const what = media.contentTag || (media.source === "off" ? "未播放" : media.source ?? "未知");
  return (
    <div>
      <div className="cv-media-what">
        {ZONE_LABEL[zone] ?? zone}媒体 · {what}
      </div>
      {media.volume != null && (
        <div className="cv-media-vol">
          音量 {media.volume}
          {media.volumeLimit != null ? ` / 上限 ${media.volumeLimit}` : ""}
        </div>
      )}
    </div>
  );
}

/** 俯视座舱示意图。四座 + 中控 + 前后氛围灯带；离线时整图降灰。 */
function CabinSchematic({ device, dim }: { device: DeviceState; dim: boolean }): JSX.Element {
  const climate = device.climate ?? {};
  const seats = device.seats ?? {};
  const child = device.childMode ?? {};
  const ambient = device.ambientLight ?? {};
  const media = device.media ?? {};
  // cabin 域的空调作用于全车，落在中控格；rear 落在后排中格
  const cabinClimate = climate.cabin;
  const rearClimate = climate.rear;
  return (
    <div className={`cv-car${dim ? " cv-car--dim" : ""}`}>
      {ambient.front && <AmbientStrip pos="front" zone={ambient.front} />}
      <Seat zone="driver" seat={seats.driver} climate={climate.driver} child={child.driver} />
      <div className="cv-console">
        <span className="cv-zone-label">中控</span>
        {cabinClimate?.tempC != null && (
          <span className="cv-temp">
            {cabinClimate.tempC}
            <small>℃ · 全舱</small>
          </span>
        )}
        {media.cabin && <MediaLine zone="cabin" media={media.cabin} />}
        {device.fragrance ? (
          <span className="cv-note">香氛 {device.fragrance.scent ?? ""} {device.fragrance.intensity ?? ""}</span>
        ) : device.fragrance === null ? (
          <span className="cv-note">香氛：此车没有</span>
        ) : null}
        {device.climateSync === true && <span className="cv-note">空调各区同步</span>}
      </div>
      <Seat zone="passenger" seat={seats.passenger} climate={climate.passenger} child={child.passenger} />
      <Seat zone="rearLeft" seat={seats.rearLeft} child={child.rearLeft} />
      <div className="cv-rear-center">
        <span className="cv-zone-label">后排</span>
        {rearClimate?.tempC != null && (
          <span className="cv-temp">
            {rearClimate.tempC}
            <small>℃</small>
          </span>
        )}
        {media.rear && <MediaLine zone="rear" media={media.rear} />}
      </div>
      <Seat zone="rearRight" seat={seats.rearRight} child={child.rearRight} />
      {ambient.rear && <AmbientStrip pos="rear" zone={ambient.rear} />}
    </div>
  );
}

function PrefChips({ pref }: { pref: CabinPref | null }): JSX.Element {
  if (!pref || Object.keys(pref).length === 0) return <span className="cv-tag">偏好未登记</span>;
  return (
    <span className="cv-prefs">
      {Object.entries(pref).map(([k, v]) => (
        <span key={k} className="cv-pref">
          {PREF_LABEL[k] ?? k}
          <b>{String(v)}</b>
        </span>
      ))}
    </span>
  );
}

/* ── 页面 ─────────────────────────────────────────────── */

export function CabinViewPage(): JSX.Element {
  const [q, setQ] = useState("demo-user");
  const [view, setView] = useState<ViewData | null>(null);
  const [state, setState] = useState<StateData | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // view 是提权读取（服务端先写审计再放行）；state/history 随后并行
      const v = await api.get<ViewData>(`/console/cabin/view?q=${encodeURIComponent(q)}`);
      setView(v);
      const [s, h] = await Promise.all([
        api.get<StateData>(`/console/cabin/state?q=${encodeURIComponent(v.vehicle.vin)}`),
        api.get<HistoryData>(`/console/cabin/history?q=${encodeURIComponent(v.vehicle.vin)}`),
      ]);
      setState(s);
      setHistory(h);
    } catch (err) {
      setView(null);
      setState(null);
      setHistory(null);
      setError(err instanceof ApiError && err.status === 404 ? "没有找到这辆车（按用户 id 或 VIN 检索）" : String(err));
    } finally {
      setLoading(false);
    }
  }, [q]);

  // 打开页面即载入默认用户——客服第一眼要看到的是车，不是空检索框
  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshState = useCallback(async () => {
    if (!view) return;
    setState(await api.get<StateData>(`/console/cabin/state?q=${encodeURIComponent(view.vehicle.vin)}`));
  }, [view]);

  const nameOf = (id: string) => view?.members.find((m) => m.id === id)?.displayName ?? "（已删除）";
  const maxTripKm = Math.max(1, ...(history?.trips.map((t) => t.distanceKm) ?? [1]));
  // 保养与维修合并成一条时间线，按时间倒序——最近发生的最先被看到
  const events = [
    ...(history?.maintenance.map((m) => ({ at: m.at, kind: "保养" as const, detail: `${m.items}（${m.odometerKm} km）` })) ?? []),
    ...(history?.repairs.map((r) => ({ at: r.at, kind: "维修" as const, detail: r.symptom })) ?? []),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="cv-page">
      <h1>客户座舱视图</h1>
      <p className="cv-desc">
        只读。打开某位客户的视图会记入操作审计（谁、何时、看了哪辆车）。数据来自模拟车机与档案库，无缓存——车主侧的删除即时可见。
      </p>

      <div className="cv-toolbar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="用户 id 或 VIN" onKeyDown={(e) => e.key === "Enter" && void search()} />
        <button type="button" onClick={() => void search()} disabled={loading}>
          {loading ? "检索中…" : "检索"}
        </button>
      </div>

      {error && <p className="cv-error">{error}</p>}

      {view && (
        <>
          {/* ── 车辆识别横条 ── */}
          <div className="cv-hero">
            <span className="cv-hero-model">{view.vehicle.model}</span>
            <span className="cv-chip cv-chip--mono">VIN <b>{view.vehicle.vin}</b></span>
            <span className="cv-chip">车主 <b>{view.vehicle.ownerId}</b></span>
            <span className="cv-hero-right">
              {state?.state === "online" && (
                <>
                  <span className="cv-pill cv-pill--online"><i />车机在线 · {state.cabinVehicleId}（模拟系统）</span>
                  {state.fetchedAt && <span className="cv-fetched">拉取于 {state.fetchedAt.slice(11, 19)}</span>}
                  <button type="button" className="cv-ghost-btn" onClick={() => void refreshState()}>刷新</button>
                </>
              )}
              {state?.state === "offline" && (
                <>
                  <span className="cv-pill cv-pill--offline"><i />车机离线（绑定还在）</span>
                  {state.fetchedAt && <span className="cv-fetched">上次拉取 {state.fetchedAt.slice(11, 19)}</span>}
                  <button type="button" className="cv-ghost-btn" onClick={() => void refreshState()}>重试</button>
                </>
              )}
              {state?.state === "unbound" && <span className="cv-pill"><i />未绑定车机（车主可在档案页绑定）</span>}
              {state?.state === "unconfigured" && <span className="cv-pill"><i />{state.reason}</span>}
            </span>
          </div>

          <div className="cv-grid">
            {/* ── 座舱实时状态 ── */}
            <section className="cv-card">
              <h2>座舱实时状态</h2>
              {state?.state === "online" && state.deviceState ? (
                <>
                  <CabinSchematic device={state.deviceState as DeviceState} dim={false} />
                  <details className="cv-raw">
                    <summary>原始状态（排查用）</summary>
                    <pre className="mono">{JSON.stringify(state.deviceState, null, 2)}</pre>
                  </details>
                </>
              ) : (
                <p className="cv-car-note">
                  {state?.state === "offline" && "车机离线，读不到实时状态——离线如实显示，不用缓存值冒充在线。"}
                  {state?.state === "unbound" && "这辆车还没绑定车机，没有实时状态可看。"}
                  {state?.state === "unconfigured" && (state.reason ?? "车机通道未配置。")}
                  {!state && "实时状态加载中…"}
                </p>
              )}
            </section>

            {/* ── 偏好与组合（只读） ── */}
            <section className="cv-card">
              <h2>偏好与组合</h2>
              {view.members.length === 0 && <p className="cv-empty">暂无常用人员。车主在手机端登记后这里即时可见。</p>}
              {view.members.map((m) => (
                <div className="cv-member" key={m.id}>
                  <span className="cv-avatar">{m.displayName.slice(0, 1)}</span>
                  <div className="cv-member-body">
                    <span className="cv-member-head">
                      <b>{m.displayName}</b>
                      {m.relation && <span className="cv-tag">{m.relation}</span>}
                      {m.ageBand && <span className="cv-tag">{m.ageBand}</span>}
                    </span>
                    <PrefChips pref={m.cabinPreference} />
                  </div>
                </div>
              ))}
              <h3>组合</h3>
              {view.combinations === null && <p className="cv-empty">组合能力未接入。</p>}
              {view.combinations?.length === 0 && <p className="cv-empty">暂无组合。</p>}
              {view.combinations?.map((c) => (
                <div className={`cv-combo${c.invalidReason ? " cv-combo--invalid" : ""}`} key={c.id}>
                  <span className="cv-combo-head">
                    <b>{c.label}</b>
                    <span className="cv-combo-members">{c.memberIds.map(nameOf).join(" + ")}</span>
                  </span>
                  <PrefChips pref={c.override} />
                  {c.invalidReason && <span className="cv-invalid">已失效：{c.invalidReason}</span>}
                </div>
              ))}
            </section>

            {/* ── 历史时间线 ── */}
            <section className="cv-card cv-card--span">
              <h2>历史（近 {history?.windowDays ?? 30} 天）</h2>
              <div className="cv-history">
                <div className="cv-history-changes">
                  <h3>座舱设置变更</h3>
                  {history?.cabinChangesNote && <p className="cv-changes-note">{history.cabinChangesNote}</p>}
                  {history?.cabinChanges?.length === 0 && <p className="cv-empty">暂无变更。</p>}
                  {history?.cabinChanges && history.cabinChanges.length > 0 && (
                    <table className="cv-table">
                      <thead>
                        <tr>
                          <th>时间</th>
                          <th>域</th>
                          <th>分区</th>
                          <th>字段</th>
                          <th>变化</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.cabinChanges.slice(-30).map((c) => (
                          <tr key={c.seq}>
                            <td className="cv-td-time">{c.at.slice(11, 19)}</td>
                            <td><span className="cv-tag">{c.domain}</span></td>
                            <td>{ZONE_LABEL[c.zone] ?? c.zone}</td>
                            <td className="mono">{c.field}</td>
                            <td>
                              <span className="cv-td-from">{String(c.from)}</span>
                              <span className="cv-td-arrow">→</span>
                              <b>{String(c.to)}</b>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div>
                  <h3>行程</h3>
                  {history?.trips.length === 0 && <p className="cv-empty">暂无行程记录。</p>}
                  {history?.trips.slice(-8).map((t) => (
                    <div className="cv-trip" key={t.id}>
                      <span className="cv-trip-date">{day(t.endedAt)}</span>
                      <span className="cv-trip-track">
                        <span className="cv-trip-bar" style={{ width: `${Math.max(3, (t.distanceKm / maxTripKm) * 100)}%`, display: "block" }} />
                      </span>
                      <span className="cv-trip-km">{t.distanceKm} km</span>
                    </div>
                  ))}
                </div>

                <div>
                  <h3>保养 / 维修</h3>
                  {events.length === 0 && <p className="cv-empty">暂无保养维修记录。</p>}
                  <ul className="cv-events">
                    {events.map((e, i) => (
                      <li className={`cv-event${e.kind === "维修" ? " cv-event--repair" : ""}`} key={i}>
                        <span className="cv-event-date">{day(e.at)}</span>
                        <span className="cv-event-kind">{e.kind}</span>
                        <span className="cv-event-detail">{e.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export default CabinViewPage;
