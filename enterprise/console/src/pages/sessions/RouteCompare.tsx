/**
 * 行程路径优化前后对比（`route_audit` 的后台消费面）。
 *
 * 三列对照：**优化前**（模型第一次交给算法体检的顺序——`trip_route_audits`
 * 的第一条）→ **算法建议** → **最终行程**（该会话最后一份落库快照）。
 * 回答的问题是"算法有没有把路调顺、模型采纳了没有、省了多少"。
 *
 * # 里程口径
 *
 * 全部是**直线估算**（与 route_audit 工具同口径），只用于顺序比较，
 * 页面上如实标注。最终行程的里程在前端按坐标现算——它落库时没有里程字段，
 * 算法与工具侧同为 haversine（这里是展示层的独立小实现，输入不同：
 * 工具算的是体检入参，这里算的是落库快照）。
 *
 * # 没有审计记录时不装作有
 *
 * 旧会话（功能上线前）只有行程快照没有体检记录——如实显示"无体检记录"，
 * 不去拿快照现算一个"假装是优化前"的数字。
 */

import { useEffect, useState } from "react";

import { api, ApiError } from "../../api";

interface GeoPoint {
  name: string;
  lat: number;
  lon: number;
}

interface AuditDay {
  day?: number;
  points: GeoPoint[];
  givenKm: number;
  suggestedOrder?: string[];
  suggestedKm?: number;
  crossings: string[];
  unresolved: string[];
}

interface JourneyInfo {
  totalGivenKm: number;
  regroup?: {
    moves: string[];
    totalKm: number;
    savedKm: number;
    savedPct: number;
    days: Array<{ day?: number; order: string[]; km: number }>;
  };
  dayOrder?: {
    order: number[];
    chainKmBefore: number;
    chainKmAfter: number;
    savedPct: number;
    note: string;
  };
}

interface AuditRow {
  id: string;
  agent?: string;
  turnId?: string;
  createdAt: string;
  payload: { city?: string; days: AuditDay[]; journey?: JourneyInfo };
}

interface PlanSpot {
  name: string;
  lat?: number;
  lon?: number;
  indoor?: boolean;
  note?: string;
  /** 预计时段（`HH:MM`，模型给的**预计口径**，展示恒带"预计"） */
  estStart?: string;
  estEnd?: string;
}

interface PlanHotel extends PlanSpot {
  address?: string;
  area?: string;
  estPrice?: string;
}

interface PlanDay {
  day: number;
  date?: string;
  theme?: string;
  area?: string;
  spots: PlanSpot[];
  hotel?: PlanHotel;
  lodging?: { strategy: "checkin-midday" | "checkin-evening"; note?: string };
  notes?: string[];
}

interface PlanRow {
  planId: string;
  status: "confirmed" | "cancelled";
  destination: string;
  days: number;
  committedAt: string;
  plan: {
    skeleton?: PlanDay[];
    origin?: string;
    startDate?: string;
    party?: string;
    transit?: { recommended?: "drive" | "train" | "flight"; summary: string };
    energyStops?: string[];
    caveats?: string[];
    nav?: { day: number; startedAt: string };
  };
}

interface TripRoutePayload {
  sessionId: string;
  audits: AuditRow[];
  plans: PlanRow[];
}

const EARTH_R_KM = 6371.0088;
const rad = (d: number): number => (d * Math.PI) / 180;

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(s));
}

function pathKm(points: readonly GeoPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1], points[i]);
  return total;
}

const fmtKm = (v: number | undefined): string => (v === undefined ? "—" : `${v.toFixed(1)} km`);

/**
 * 小地图：等距圆柱投影（lon→x、lat→y 反转），按传入的公共包围盒缩放——
 * 同一天的三列共用包围盒，点位在三张图里位置一致，肉眼才能对比"线怎么变了"。
 */
function RouteMap({
  points,
  bbox,
  stroke,
}: {
  points: GeoPoint[];
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  stroke: string;
}): JSX.Element {
  const W = 240;
  const H = 170;
  const PAD = 16;
  const spanLon = Math.max(bbox.maxLon - bbox.minLon, 1e-6);
  const spanLat = Math.max(bbox.maxLat - bbox.minLat, 1e-6);
  // 纬度方向按 cos(纬度) 修正横向比例，城市尺度足够（不修正的话东西向会被拉扁）。
  const aspect = Math.cos(rad((bbox.minLat + bbox.maxLat) / 2));
  const scale = Math.min((W - PAD * 2) / (spanLon * aspect), (H - PAD * 2) / spanLat);
  const x = (p: GeoPoint): number => PAD + (p.lon - bbox.minLon) * aspect * scale;
  const y = (p: GeoPoint): number => H - PAD - (p.lat - bbox.minLat) * scale;
  return (
    <svg className="rc-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="路线示意">
      <polyline
        points={points.map((p) => `${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth={1.6}
      />
      {points.map((p, i) => (
        <g key={`${p.name}-${i}`}>
          <circle cx={x(p)} cy={y(p)} r={i === 0 ? 5 : 4} fill={stroke} opacity={i === 0 ? 1 : 0.75} />
          <text x={x(p) + 6} y={y(p) - 4} className="rc-map-label">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * 最终行程某天的点序：**只取景点，不含酒店段**。
 * 三列的口径要尽量可比：体检列从"当天锚点"出发，最终列若把回酒店那一段
 * 计进去，数字会比前两列凭空多一截，读起来像"越优化越长"（实测踩到）。
 */
function finalDayPoints(d: PlanDay): { points: GeoPoint[]; missing: string[] } {
  const points: GeoPoint[] = [];
  const missing: string[] = [];
  for (const s of d.spots ?? []) {
    if (s.lat !== undefined && s.lon !== undefined) points.push({ name: s.name, lat: s.lat, lon: s.lon });
    else missing.push(s.name);
  }
  return { points, missing };
}

/**
 * 最终顺序是否与算法建议一致：只比双方共有的点（锚点/酒店不参与）。
 * 回答后台最关心的问题——"模型看了体检结果之后，采纳了没有"。
 */
function adoptionOf(audit: AuditDay, finalNames: string[]): "adopted" | "kept" | "partial" | undefined {
  if (!audit.suggestedOrder) return undefined;
  const common = (order: string[]): string[] => order.filter((n) => finalNames.includes(n));
  const finalCommon = finalNames.filter(
    (n) => audit.suggestedOrder!.includes(n) || audit.points.some((p) => p.name === n),
  );
  if (finalCommon.length < 2) return undefined;
  const eq = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
  if (eq(common(audit.suggestedOrder), finalCommon)) return "adopted";
  if (eq(common(audit.points.map((p) => p.name)), finalCommon)) return "kept";
  return "partial";
}

function DayCompare({ audit, final }: { audit: AuditDay; final?: PlanDay }): JSX.Element {
  const finalSeq = final ? finalDayPoints(final) : undefined;
  const suggestedPoints = audit.suggestedOrder
    ?.map((n) => audit.points.find((p) => p.name === n))
    .filter((p): p is GeoPoint => !!p);

  const everyPoint = [
    ...audit.points,
    ...(suggestedPoints ?? []),
    ...(finalSeq?.points ?? []),
  ];
  const bbox = {
    minLat: Math.min(...everyPoint.map((p) => p.lat)),
    maxLat: Math.max(...everyPoint.map((p) => p.lat)),
    minLon: Math.min(...everyPoint.map((p) => p.lon)),
    maxLon: Math.max(...everyPoint.map((p) => p.lon)),
  };
  const finalKm = finalSeq && finalSeq.points.length >= 2 ? pathKm(finalSeq.points) : undefined;

  const columns: Array<{
    key: string;
    title: string;
    points: GeoPoint[];
    km: number | undefined;
    stroke: string;
    note?: string;
  }> = [
    {
      key: "before",
      title: "优化前（LLM 第一版）",
      points: audit.points,
      km: audit.givenKm,
      stroke: "#d4622a",
      note: audit.crossings.length ? `⚠️ 交叉 ${audit.crossings.length} 处` : undefined,
    },
    {
      key: "suggested",
      title: "算法建议",
      points: suggestedPoints ?? [],
      km: audit.suggestedKm,
      stroke: "#3572b0",
      note: audit.suggestedOrder ? undefined : "已判定为最优，无需调整",
    },
    {
      key: "final",
      title: "最终行程（落库）",
      points: finalSeq?.points ?? [],
      km: finalKm,
      stroke: "#2c8a5b",
      note: [
        final?.hotel ? `住 ${final.hotel.name}（酒店段不计入里程）` : undefined,
        finalSeq?.missing.length ? `缺坐标 ${finalSeq.missing.length} 点未画` : undefined,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
    },
  ];

  const adoption = finalSeq ? adoptionOf(audit, finalSeq.points.map((p) => p.name)) : undefined;

  return (
    <div className="rc-day">
      <div className="rc-day-head">
        <strong>第 {audit.day ?? "?"} 天</strong>
        {final?.theme ? <span className="muted">{final.theme}</span> : null}
        {audit.suggestedKm !== undefined ? (
          <span className="rc-saved">
            建议省 {(audit.givenKm - audit.suggestedKm).toFixed(1)} km（
            {Math.round(((audit.givenKm - audit.suggestedKm) / audit.givenKm) * 100)}%）
          </span>
        ) : (
          <span className="muted tiny">第一版已最优</span>
        )}
        {adoption === "adopted" ? <span className="rc-adopted">✓ 模型已采纳</span> : null}
        {adoption === "kept" ? <span className="rc-kept">✗ 保持原顺序</span> : null}
        {adoption === "partial" ? <span className="rc-kept">◐ 部分采纳</span> : null}
      </div>
      <div className="rc-cols">
        {columns.map((c) => (
          <div className="rc-col" key={c.key}>
            <div className="rc-col-title">
              {c.title}
              <span className="rc-km">{fmtKm(c.km)}</span>
            </div>
            {c.points.length >= 2 ? (
              <>
                <RouteMap points={c.points} bbox={bbox} stroke={c.stroke} />
                <ol className="rc-order">
                  {c.points.map((p, i) => (
                    <li key={`${p.name}-${i}`}>{p.name}</li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="muted tiny">{c.note ?? "无可画的点序"}</p>
            )}
            {c.points.length >= 2 && c.note ? <p className="muted tiny">{c.note}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function RouteCompare({
  sessionId,
  refreshKey = 0,
}: {
  sessionId: string;
  /** 变了就重取——见 SessionDetail 处的说明。 */
  refreshKey?: number | string;
}): JSX.Element | null {
  const [data, setData] = useState<TripRoutePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .get<TripRoutePayload>(`/console/trip-route/${encodeURIComponent(sessionId)}`)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.code : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey, tick]);

  /*
   * 切回这个标签页时重取。行程是在对话里被确认的：页面开着、用户在车上说一句
   * "就这么定了"，回来看到的还是确认前的样子（「最终行程：无可画的点序」）——
   * 那不是没落库，是这块没刷新。焦点回来那一刻重取一次，代价是一次小请求。
   */
  useEffect(() => {
    const onFocus = (): void => setTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // 静默失败会把"接口坏了"伪装成"这个会话没行程"——错误如实说。
  if (error) return <p className="muted tiny">路径优化数据加载失败：{error}</p>;
  if (!data || (data.audits.length === 0 && data.plans.length === 0)) return null;

  const firstAudit = data.audits[0];
  const confirmed = [...data.plans].reverse().find((p) => p.status === "confirmed");
  const finalPlan = confirmed ?? data.plans[data.plans.length - 1];

  return (
    <section className="rc-section">
      {/* 先是"定了什么"，再是"怎么调顺的"——前者是用户拿到的结果，后者是过程 */}
      {finalPlan && <PlanCard plan={finalPlan} />}
      <h2 className="rc-title">
        行程路径优化对比
        <span className="muted tiny">
          {" "}
          里程均为直线估算，仅供顺序比较；体检 {data.audits.length} 次
          {firstAudit ? ` · 首次 ${new Date(firstAudit.createdAt).toLocaleString()}` : ""}
        </span>
        <button type="button" className="ss-btn ss-btn--ghost rc-refresh" onClick={() => setTick((t) => t + 1)}>
          刷新
        </button>
      </h2>
      {firstAudit?.payload.journey ? (
        <div className="rc-journey">
          <strong>跨天体检</strong>
          {firstAudit.payload.journey.regroup ? (
            <p>
              换点建议（每天点数不变）省{" "}
              <strong>
                {firstAudit.payload.journey.regroup.savedKm.toFixed(1)} km（
                {firstAudit.payload.journey.regroup.savedPct}%）
              </strong>
              ：{firstAudit.payload.journey.regroup.moves.join("；")}
            </p>
          ) : null}
          {firstAudit.payload.journey.dayOrder ? (
            <p>
              天序建议：按{" "}
              <strong>{firstAudit.payload.journey.dayOrder.order.map((d) => `D${d}`).join(" → ")}</strong>{" "}
              游玩，片区推进链 {firstAudit.payload.journey.dayOrder.chainKmBefore.toFixed(1)} →{" "}
              {firstAudit.payload.journey.dayOrder.chainKmAfter.toFixed(1)} km（顺路感 +
              {firstAudit.payload.journey.dayOrder.savedPct}%）。
              <span className="muted tiny">{firstAudit.payload.journey.dayOrder.note}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {!firstAudit ? (
        <p className="muted tiny">
          该会话没有 route_audit 体检记录（功能上线前的会话，或模型未按纪律体检）——
          只有落库行程，无"优化前"可对比。
        </p>
      ) : (
        firstAudit.payload.days
          .filter((d) => d.points.length >= 2)
          .map((d) => (
            <DayCompare
              key={`${firstAudit.id}-${d.day ?? "x"}`}
              audit={d}
              final={finalPlan?.plan.skeleton?.find((pd) => pd.day === d.day)}
            />
          ))
      )}
    </section>
  );
}

/** 天序里的一句时间：`预计 09:30–12:00`；模型没给就不编。 */
function timeText(sp: PlanSpot): string | undefined {
  if (!sp.estStart && !sp.estEnd) return undefined;
  return `预计 ${sp.estStart ?? "?"}–${sp.estEnd ?? "?"}`;
}

const TRANSIT_LABEL: Record<string, string> = { drive: "自驾", train: "高铁/火车", flight: "飞机" };

/**
 * 已确定的行程（这条会话最新一份落库快照）：按天列站点、住宿与提醒。
 *
 * 这是用户在车机上看到的那份行程的**后台镜像**——运营点开一条对话，先要知道
 * "这条对话最后定了什么"，再看"算法有没有把它调顺"。已取消的也画，标成已取消：
 * 定过又取消是这条对话的真实经历，藏掉等于改写历史。
 */
function PlanCard({ plan }: { plan: PlanRow }): JSX.Element {
  const snap = plan.plan;
  const days = snap.skeleton ?? [];
  return (
    <div className="rc-plan" aria-label="已确定的行程">
      <div className="rc-plan-head">
        <h3>
          {plan.status === "cancelled" ? "已取消的行程" : "已确定的行程"} · {plan.destination}
        </h3>
        <span className={`rc-plan-status is-${plan.status}`}>
          {plan.status === "cancelled" ? "已取消" : "已确定"} · {new Date(plan.committedAt).toLocaleString()}
        </span>
        <span className="muted tiny">
          {plan.days} 天{snap.startDate ? ` · ${snap.startDate} 出发` : " · 未定日期"}
          {snap.origin ? ` · 从${snap.origin}出发` : ""}
          {snap.party ? ` · ${snap.party}` : ""}
          {snap.nav ? ` · 正在导航第 ${snap.nav.day} 天` : ""}
        </span>
      </div>
      {days.length === 0 ? (
        <p className="muted tiny">这份快照没有按天的安排。</p>
      ) : (
        <div className="rc-plan-days">
          {days.map((d) => (
            <div className="rc-plan-day" key={d.day}>
              <div className="rc-plan-day-head">
                <b>第 {d.day} 天</b>
                {d.date && <span className="rc-plan-time">{d.date}</span>}
                {d.theme && <span className="muted tiny">{d.theme}</span>}
              </div>
              {d.area && <p className="rc-plan-note">片区：{d.area}</p>}
              {d.spots.length === 0 ? (
                <p className="muted tiny">这天没有站点。</p>
              ) : (
                <ol className="rc-plan-spots">
                  {d.spots.map((sp, i) => (
                    <li key={`${sp.name}-${i}`}>
                      <span className="rc-plan-seq" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span>
                        {sp.name}
                        {sp.indoor && <span className="muted tiny"> · 室内</span>}
                        {timeText(sp) && <span className="rc-plan-time"> {timeText(sp)}</span>}
                        {sp.lat === undefined && <span className="muted tiny"> · 无坐标</span>}
                        {sp.note && <div className="muted tiny">{sp.note}</div>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {d.hotel && (
                <p className="rc-plan-hotel">
                  住 <b>{d.hotel.name}</b>
                  {d.hotel.address && ` · ${d.hotel.address}`}
                  {d.hotel.estPrice && ` · ${d.hotel.estPrice}`}
                  {d.lodging?.note && <div>{d.lodging.note}</div>}
                </p>
              )}
              {(d.notes ?? []).map((n, i) => (
                <p className="rc-plan-note" key={i}>
                  {n}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
      {(snap.transit || (snap.energyStops ?? []).length > 0 || (snap.caveats ?? []).length > 0) && (
        <div className="rc-plan-foot">
          {snap.transit && (
            <div>
              交通：{snap.transit.recommended ? `${TRANSIT_LABEL[snap.transit.recommended] ?? snap.transit.recommended} · ` : ""}
              {snap.transit.summary}
            </div>
          )}
          {(snap.energyStops ?? []).length > 0 && <div>补能点：{snap.energyStops!.join("、")}</div>}
          {(snap.caveats ?? []).map((c, i) => (
            <div className="rc-plan-caveat" key={i}>
              ⚠ {c}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
