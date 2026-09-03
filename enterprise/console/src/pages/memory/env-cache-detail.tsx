/**
 * ⑤环境缓存条目的详情弹窗（M-mem-cache-detail）。
 *
 * # 每一类按它是什么来画，不是按它长什么样
 *
 * 列表那一行只有 200 字符的 JSON 预览——看得出"存了东西"，看不出存的对不对。
 * 详情要回答的是运营的问题：这份天气是哪儿的、导览简报给用户看到的是什么、
 * 推荐的店有没有出处。所以四类各一份渲染，**照车机端的栏目与措辞**
 * （`clients/shared/ui` 的 GuideScreen / HighlightsCard），让"缓存里的"与"屏上的"
 * 一眼能对上；表里没有的类型走通用的字段表——仍然是人话，不是原始 JSON。
 *
 * # 出处上屏
 *
 * 车机端的推荐卡刻意不显示出处（驾驶距离读不出 10px 的主机名）。控制台没有这个约束，
 * 而运营看这一页正是为了核对——所以这里**显示**。规则不变：只有通过全等校验的出处才有值，
 * 没有的就没有，这里不补、不猜。
 *
 * # 数据从哪儿来
 *
 * `GET /console/memory/cache/entry?key=`：全值另取，不放长列表的预览。
 * 只读、不续期——看一眼不该让这条多活一秒。
 */

import { useEffect, useState } from "react";

import type { GuideBrief, GuideComfortItem, GuideSource, GuideTimelineKind } from "@carlife/shared";
import { guideBriefToTimeline } from "@carlife/shared";

import { api } from "../../api";
import { ttlText, sizeText, type EnvCacheEntry } from "./env-cache";
import {
  BRANCH_LABEL,
  BRANCH_SOURCE_LABEL,
  chargingKeyToCenter,
  coordText,
  dateLabel,
  distanceText,
  durationText,
  hostOf,
  nsLabel,
  regeoKeyToPoint,
  routeKeyToEnds,
  tempRangeText,
  timeText,
  weatherText,
  windText,
} from "./env-cache-format";
import { CacheMap, type MapPoint } from "./env-cache-map";

// ── 接口形状 ─────────────────────────────────────────────────

interface Detail {
  key: string;
  namespace: string;
  ttlSeconds: number;
  sizeBytes: number;
  value: unknown;
}

interface RegeoPoint {
  lat: number;
  lon: number;
  district: string;
  formatted: string;
}

interface DetailResponse {
  wired: boolean;
  found?: boolean;
  entry?: Detail;
  regeoPoints?: RegeoPoint[];
}

type State =
  | { status: "loading" }
  | { status: "error"; code: string }
  | { status: "unwired" }
  | { status: "gone" }
  | { status: "ready"; detail: Detail; regeoPoints?: RegeoPoint[] };

export interface EnvCacheDetailModalProps {
  entry: EnvCacheEntry;
  onClose: () => void;
}

export function EnvCacheDetailModal({ entry, onClose }: EnvCacheDetailModalProps): JSX.Element {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api
      .get<DetailResponse>(`/console/memory/cache/entry?key=${encodeURIComponent(entry.key)}`)
      .then((r) => {
        if (cancelled) return;
        if (!r.wired) setState({ status: "unwired" });
        else if (!r.found || !r.entry) setState({ status: "gone" });
        else setState({ status: "ready", detail: r.entry, regeoPoints: r.regeoPoints });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const code = (err as { code?: string; status?: number })?.code ?? "unknown";
        // 404 是"过期了"，不是读不到——TTL 到点是这一类的正常结局
        if ((err as { status?: number })?.status === 404) setState({ status: "gone" });
        else setState({ status: "error", code });
      });
    return () => {
      cancelled = true;
    };
  }, [entry.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ttl = state.status === "ready" ? state.detail.ttlSeconds : entry.ttlSeconds;
  const size = state.status === "ready" ? state.detail.sizeBytes : entry.sizeBytes;

  return (
    <div className="cache-modal-overlay" onClick={onClose}>
      <div
        className="cache-modal"
        role="dialog"
        aria-label={`${nsLabel(entry.namespace)} 详情`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cache-modal__head">
          <div>
            <div className="cache-modal__ns">{nsLabel(entry.namespace)}</div>
            <div className="cache-modal__key mono">{entry.key}</div>
            <div className="cache-modal__meta">
              <span className={ttl === -1 ? "cache-ttl-bad" : ""}>{ttlText(ttl)}</span>
              <span>· {sizeText(size)}</span>
            </div>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="cache-modal__body">
          {state.status === "loading" && <p className="muted tiny">正在读取完整内容…</p>}
          {state.status === "unwired" && (
            <p className="muted tiny">⑤未接入 Redis——列表能显示是因为上一次读到过，此刻读不到全值。</p>
          )}
          {state.status === "gone" && (
            <p className="muted tiny">
              这条已经过期或被清掉了。⑤靠 TTL 自己过期，<b>列表是打开那一刻的快照</b>——刷新列表即可。
            </p>
          )}
          {state.status === "error" && (
            <p className="error tiny">读不到（{state.code}）。Redis 的连接握在 agent-runtime 手上，它不在时读不到。</p>
          )}
          {state.status === "ready" && <DetailBody detail={state.detail} regeoPoints={state.regeoPoints} />}
        </div>
      </div>
    </div>
  );
}

function DetailBody({ detail, regeoPoints }: { detail: Detail; regeoPoints?: RegeoPoint[] }): JSX.Element {
  const v = detail.value;
  if (v === null || typeof v !== "object") {
    // 非 JSON 的键是别处直接写的——与 TTL=-1 同一类要点名的异常
    return (
      <p className="error tiny">
        这条的值不是 JSON（{String(v)}）。⑤的每一条都经 `withEnvCache` 写入 JSON，出现这种键说明有人绕过它直接写了 Redis。
      </p>
    );
  }
  switch (detail.namespace) {
    case "regeo":
      return <RegeoDetail keyName={detail.key} value={v as RegeoValue} />;
    case "amap-forecast":
      return <ForecastDetail value={v as ForecastValue} points={regeoPoints ?? []} />;
    case "cma-view":
      return <CmaDetail value={v as CmaValue} />;
    case "guide-brief":
      return <GuideBriefDetail brief={v as GuideBrief} />;
    case "dest-highlights":
      return <HighlightsDetail value={v as HighlightsValue} />;
    case "route":
      return <RouteDetail keyName={detail.key} value={v as RouteValue} />;
    case "charging":
      return <ChargingDetail keyName={detail.key} value={v as ChargingPoi[]} />;
    default:
      return <GenericDetail value={v} />;
  }
}

// ── 逆地理编码 ───────────────────────────────────────────────

interface RegeoValue {
  adcode?: string;
  city?: string;
  district?: string;
  formatted?: string;
}

function RegeoDetail({ keyName, value }: { keyName: string; value: RegeoValue }): JSX.Element {
  const pt = regeoKeyToPoint(keyName);
  const points: MapPoint[] = pt ? [{ ...pt, badge: "📍", label: value.district ?? value.formatted ?? "", kind: "pin" }] : [];
  return (
    <div className="cd">
      <h3 className="cd__title">{value.formatted || "（没有地址）"}</h3>
      <dl className="cd__facts">
        <dt>行政区</dt>
        <dd>
          {[value.city, value.district].filter(Boolean).join(" · ") || "—"}
          {value.adcode && <span className="muted"> · adcode {value.adcode}</span>}
        </dd>
        <dt>查询坐标</dt>
        <dd>
          {pt ? <span className="mono">{coordText(pt)}</span> : "键上没有坐标"}
          <span className="muted tiny"> · 已取整到 0.01°（约 1.1 km），同一格内的点共用这一条</span>
        </dd>
      </dl>
      <CacheMap points={points} />
    </div>
  );
}

// ── 天气预报（高德） ─────────────────────────────────────────

interface ForecastCast {
  date: string;
  dayWeather: string;
  nightWeather: string;
  dayTempC: number | null;
  nightTempC: number | null;
  dayWind: string;
  dayPower: string;
}

interface ForecastValue {
  city?: string;
  adcode?: string;
  reportTime?: string;
  casts?: ForecastCast[];
}

function ForecastDetail({ value, points }: { value: ForecastValue; points: RegeoPoint[] }): JSX.Element {
  const today = new Date();
  const mapPoints: MapPoint[] = points.map((p, i) => ({
    lat: p.lat,
    lon: p.lon,
    badge: String(i + 1),
    label: p.district || p.formatted,
    kind: "pin",
  }));
  return (
    <div className="cd">
      <h3 className="cd__title">
        {value.city || "（未知地区）"}
        {value.adcode && <span className="muted tiny"> · adcode {value.adcode}</span>}
      </h3>
      <p className="muted tiny">发布时间 {value.reportTime || "—"}（高德按 adcode 给一份，不是按坐标）</p>
      <table className="cd__table">
        <thead>
          <tr>
            <th>日期</th>
            <th>天气</th>
            <th>气温</th>
            <th>风</th>
          </tr>
        </thead>
        <tbody>
          {(value.casts ?? []).map((c) => (
            <tr key={c.date}>
              <td>{dateLabel(c.date, today)}</td>
              <td>{weatherText(c.dayWeather, c.nightWeather)}</td>
              <td>{tempRangeText(c.dayTempC, c.nightTempC)}</td>
              <td>{windText(c.dayWind, c.dayPower)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4 className="cd__sub">这份预报是为哪些地方查的</h4>
      {points.length === 0 ? (
        <p className="muted tiny">
          没有找到解析到这个 adcode 的逆地理条目——预报按行政区存、值里没有坐标，所以画不出位置。
          逆地理条目过期得比预报慢，通常能反查到；反查不到就只给文字，不拿城市中心点冒充。
        </p>
      ) : (
        <p className="muted tiny">
          下面 {points.length} 个点是缓存里解析到同一 adcode 的逆地理查询坐标（取整到 0.01°）。
        </p>
      )}
      <CacheMap points={mapPoints} />
    </div>
  );
}

// ── 实况与预警（气象局） ──────────────────────────────────────

interface CmaValue {
  station?: { id?: string; name?: string; lat?: number; lon?: number };
  observation?: {
    temperatureC?: number | null;
    feelsLikeC?: number | null;
    humidityPct?: number | null;
    precipitationMm?: number | null;
    pressureHpa?: number | null;
    windDirection?: string | null;
    windScale?: string | null;
    windSpeedMs?: number | null;
  };
  daily?: Array<{
    date: string;
    highC: number | null;
    lowC: number | null;
    dayText: string;
    nightText: string;
    dayWindDirection: string;
    dayWindScale: string;
  }>;
  alarms?: Array<{ title: string; type: string; level: string; effective: string }>;
  lastUpdate?: string;
}

function CmaDetail({ value }: { value: CmaValue }): JSX.Element {
  const st = value.station;
  const o = value.observation ?? {};
  const points: MapPoint[] =
    st && typeof st.lat === "number" && typeof st.lon === "number"
      ? [{ lat: st.lat, lon: st.lon, badge: "站", label: st.name ?? "", kind: "pin" }]
      : [];
  const today = new Date();
  return (
    <div className="cd">
      <h3 className="cd__title">
        {st?.name || "（未知站点）"}
        <span className="muted tiny"> 气象站 · 观测时间 {value.lastUpdate || "—"}</span>
      </h3>
      {(value.alarms ?? []).length > 0 && (
        <ul className="cd__alarms">
          {value.alarms!.map((a, i) => (
            <li key={i}>
              ⚠ {a.type}{a.level}预警 · {a.title}
              {a.effective && <span className="muted tiny"> · {a.effective}</span>}
            </li>
          ))}
        </ul>
      )}
      <dl className="cd__facts cd__facts--grid">
        <dt>气温</dt>
        <dd>{o.temperatureC ?? "—"}℃{o.feelsLikeC != null && <span className="muted">（体感 {o.feelsLikeC}℃）</span>}</dd>
        <dt>湿度</dt>
        <dd>{o.humidityPct ?? "—"}%</dd>
        <dt>降水</dt>
        <dd>{o.precipitationMm ?? "—"} mm（当前）</dd>
        <dt>气压</dt>
        <dd>{o.pressureHpa ?? "—"} hPa</dd>
        <dt>风</dt>
        <dd>
          {windText(o.windDirection, o.windScale)}
          {o.windSpeedMs != null && <span className="muted"> · {o.windSpeedMs} m/s</span>}
        </dd>
      </dl>
      {(value.daily ?? []).length > 0 && (
        <table className="cd__table">
          <thead>
            <tr>
              <th>日期</th>
              <th>天气</th>
              <th>气温</th>
              <th>风</th>
            </tr>
          </thead>
          <tbody>
            {value.daily!.map((d) => (
              <tr key={d.date}>
                <td>{dateLabel(d.date, today)}</td>
                <td>{weatherText(d.dayText, d.nightText)}</td>
                <td>{tempRangeText(d.highC, d.lowC)}</td>
                <td>{windText(d.dayWindDirection, d.dayWindScale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CacheMap points={points} />
    </div>
  );
}

// ── 景区导览简报（照车机端 GuideScreen 的栏目） ──────────────

const KIND_LABEL: Record<GuideTimelineKind, string> = {
  parking: "停车场",
  spot: "游玩点",
  photo: "打卡点",
  food: "餐饮",
  rest: "休息",
  toilet: "厕所",
  charging: "充电",
  refuel: "加油",
};

const COMFORT_LABEL: Record<GuideComfortItem["kind"], string> = {
  rest: "休息",
  food: "吃饭",
  toilet: "厕所",
  pitfall: "避雷",
};

function SourceLink({ source }: { source?: GuideSource }): JSX.Element | null {
  if (!source?.url) return null;
  return (
    <a className="cd__source" href={source.url} target="_blank" rel="noreferrer" title={source.title ?? source.url}>
      据 {hostOf(source.url)} ↗
    </a>
  );
}

function GuideBriefDetail({ brief }: { brief: GuideBrief }): JSX.Element {
  const timeline = guideBriefToTimeline(brief);
  const access = brief.access;
  const firstParking = access?.parking[0];
  const pitfalls = brief.comfort.filter((c) => c.kind === "pitfall");
  const comfortRest = brief.comfort.filter((c) => c.kind !== "pitfall");

  // 地图：停车场当起点（车机端同款「停」），必玩点按 spots 顺序编号——徽标写它在 spots 里的位置
  const mapPoints: MapPoint[] = [];
  if (firstParking && firstParking.lat !== undefined && firstParking.lon !== undefined) {
    mapPoints.push({ lat: firstParking.lat, lon: firstParking.lon, badge: "停", label: firstParking.name, kind: "origin" });
  }
  brief.spots.forEach((s, i) => {
    if (s.lat !== undefined && s.lon !== undefined) {
      mapPoints.push({ lat: s.lat, lon: s.lon, badge: String(i + 1), label: s.name, kind: s.kind === "photo" ? "photo" : "spot" });
    }
  });
  const unlocated = brief.spots.filter((s) => s.lat === undefined || s.lon === undefined).length;

  return (
    <div className="cd">
      <h3 className="cd__title">
        {brief.spot} · 景区导览
        <span className="muted tiny">
          {brief.city && ` · ${brief.city}`}
          {brief.date && ` · ${brief.date}`}
          {brief.selfDrive && " · 自驾"}
          {" · 采集于 "}
          {timeText(brief.generatedAt)}
        </span>
      </h3>

      {access?.arrivalAdvice && (
        <section className="cd__section">
          <h4 className="cd__sub">自驾到达（停哪儿、怎么进景区）</h4>
          <p>{access.arrivalAdvice}</p>
        </section>
      )}

      {access && (access.parking.length > 0 || access.charging.length > 0 || access.refuel.length > 0) && (
        <section className="cd__section cd__cols">
          {access.parking.length > 0 && (
            <div>
              <h4 className="cd__sub">停车场</h4>
              <ul className="cd__list">
                {access.parking.map((p, i) => (
                  <li key={i}>
                    <b>{p.name}</b>
                    {p.distanceToGateMeters !== undefined && (
                      <span className="muted"> · 距入口约 {distanceText(p.distanceToGateMeters)}（估算）</span>
                    )}
                    {p.address && <div className="tiny muted">{p.address}</div>}
                    {p.toGate && <div className="tiny">{p.toGate}</div>}
                    {p.note && <div className="tiny muted">{p.note}</div>}
                    <SourceLink source={p.source} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {access.charging.length > 0 && (
            <div>
              <h4 className="cd__sub">充电</h4>
              <ul className="cd__list">
                {access.charging.map((c, i) => (
                  <li key={i}>
                    <b>{c.name}</b>
                    {c.address && <div className="tiny muted">{c.address}</div>}
                    {c.note && <div className="tiny muted">{c.note}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {access.refuel.length > 0 && (
            <div>
              <h4 className="cd__sub">加油</h4>
              <ul className="cd__list">
                {access.refuel.map((c, i) => (
                  <li key={i}>
                    <b>{c.name}</b>
                    {c.address && <div className="tiny muted">{c.address}</div>}
                    {c.note && <div className="tiny muted">{c.note}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="cd__section cd__cols cd__cols--guide">
        <div>
          <h4 className="cd__sub">游玩时间轴</h4>
          {timeline.length === 0 ? (
            <p className="muted tiny">本次没有查到可排入时间轴的点位。</p>
          ) : (
            <ol className="cd-timeline">
              {timeline.map((e) => (
                <li key={e.index} className={`cd-timeline__row is-${e.kind}`}>
                  <span className="cd-timeline__seq" aria-hidden="true">
                    {e.index}
                  </span>
                  <span className={`cd-timeline__kind is-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                  <span className="cd-timeline__name">{e.name}</span>
                  {e.note && <span className="cd-timeline__note">{e.note}</span>}
                </li>
              ))}
            </ol>
          )}
          {brief.spots.some((s) => s.source) && (
            <ul className="cd__list cd__list--sources">
              {brief.spots.map((s, i) =>
                s.source ? (
                  <li key={i} className="tiny">
                    {i + 1}. {s.name}
                    {s.platform && <span className="muted"> · {s.platform}</span>}
                    {s.sourceDate && <span className="muted"> · {s.sourceDate}</span>} <SourceLink source={s.source} />
                  </li>
                ) : null,
              )}
            </ul>
          )}
        </div>
        <div>
          <h4 className="cd__sub">单向游玩路线</h4>
          {brief.spots.length === 0 && (
            <p className="muted tiny">本次没有查到必玩点位，路线画不出来。</p>
          )}
          <CacheMap points={mapPoints} path />
          {unlocated > 0 && (
            <p className="muted tiny">{unlocated} 个点位没有坐标，只在时间轴里、不在图上。</p>
          )}
          {brief.routeOrderSource === "editorial" && (
            <p className="muted tiny">顺序来自攻略整理（未经坐标校验）</p>
          )}
          {brief.routeOrderSource === "geo" && <p className="muted tiny">顺序由坐标最近邻 + 去交叉求解</p>}
          {brief.transportAdvice && <p className="tiny">园内代步：{brief.transportAdvice}</p>}
          {brief.routeAdvice && <p className="tiny">{brief.routeAdvice}</p>}
        </div>
      </section>

      {(comfortRest.length > 0 || pitfalls.length > 0) && (
        <section className="cd__section cd__cols">
          {comfortRest.length > 0 && (
            <div>
              <h4 className="cd__sub">休息 · 吃饭 · 厕所</h4>
              <ul className="cd__list">
                {comfortRest.map((c, i) => (
                  <li key={i}>
                    <span className={`cd-comfort__kind is-${c.kind}`}>{COMFORT_LABEL[c.kind]}</span>
                    {c.name && <b>{c.name}</b>} {c.note} <SourceLink source={c.source} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pitfalls.length > 0 && (
            <div>
              <h4 className="cd__sub">避雷提醒</h4>
              <ul className="cd__list">
                {pitfalls.map((c, i) => (
                  <li key={i}>
                    <span className="cd-comfort__kind is-pitfall">{COMFORT_LABEL.pitfall}</span>
                    {c.name && <b>{c.name}</b>} {c.note} <SourceLink source={c.source} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {brief.caveats.length > 0 && (
        <section className="cd__section cd__caveats">
          {brief.caveats.map((c, i) => (
            <div key={i}>⚠ {c}</div>
          ))}
        </section>
      )}

      {/* 车机端不显示的采集读数：控制台正是看这个的地方 */}
      <section className="cd__section cd__audit">
        <h4 className="cd__sub">采集读数（仅控制台）</h4>
        <dl className="cd__facts cd__facts--grid">
          {(Object.keys(BRANCH_LABEL) as Array<keyof typeof brief.branchSources>).map((b) => (
            <FactRow key={b} label={BRANCH_LABEL[b]!} value={BRANCH_SOURCE_LABEL[brief.branchSources?.[b] ?? ""] ?? String(brief.branchSources?.[b] ?? "—")} />
          ))}
          <dt>出处核验</dt>
          <dd>
            模型声称 {brief.sourcesVerified?.claimed ?? 0} 条，与真实搜索结果对上 {brief.sourcesVerified?.matched ?? 0} 条
          </dd>
        </dl>
        {brief.findings.length > 0 && (
          <ul className="cd__list tiny muted">
            {brief.findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

// ── 目的地推荐（照车机端 HighlightsCard 的三节） ─────────────

interface HighlightEntry {
  name: string;
  note?: string;
  source?: { url: string; title?: string };
}

interface HighlightsValue {
  destination?: string;
  foods?: HighlightEntry[];
  spots?: HighlightEntry[];
  photoTips?: Array<{ spot?: string; tip: string }>;
  searchCount?: number;
  sourcesVerified?: { matched: number; claimed: number };
}

function RankList({ title, entries }: { title: string; entries: HighlightEntry[] }): JSX.Element | null {
  // 整段为空就连小标题一起不渲染——孤零零的「吃什么」下面什么都没有，读起来像加载失败
  if (entries.length === 0) return null;
  return (
    <div>
      <h4 className="cd__sub">{title}</h4>
      <ol className="cd-rank">
        {entries.map((e, i) => (
          <li key={`${e.name}-${i}`}>
            <span className="cd-rank__n" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <b>{e.name}</b>
              {e.note && <span className="cd-rank__note">{e.note}</span>}
              <SourceLink source={e.source} />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function HighlightsDetail({ value }: { value: HighlightsValue }): JSX.Element {
  const foods = value.foods ?? [];
  const spots = value.spots ?? [];
  const tips = value.photoTips ?? [];
  return (
    <div className="cd">
      <h3 className="cd__title">目的地推荐 · {value.destination || "（未知目的地）"}</h3>
      <section className="cd__section cd__cols cd__cols--3">
        <RankList title="吃什么" entries={foods} />
        <RankList title="打卡点" entries={spots} />
        {tips.length > 0 && (
          <div>
            <h4 className="cd__sub">怎么拍</h4>
            <ul className="cd__list">
              {tips.map((t, i) => (
                <li key={`${t.spot ?? ""}-${i}`}>
                  {t.spot && <b>{t.spot}</b>}
                  <div className="tiny">{t.tip}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      {foods.length + spots.length + tips.length === 0 && (
        <p className="muted tiny">三节都是空的——这份推荐没有内容。</p>
      )}
      <section className="cd__section cd__audit">
        <h4 className="cd__sub">采集读数（仅控制台）</h4>
        <dl className="cd__facts cd__facts--grid">
          <dt>联网搜索</dt>
          <dd>{value.searchCount ?? 0} 次{(value.searchCount ?? 0) === 0 && <span className="error">（0 次 = 凭记忆答的，不该被缓存）</span>}</dd>
          <dt>出处核验</dt>
          <dd>
            模型声称 {value.sourcesVerified?.claimed ?? 0} 条，与真实搜索结果对上 {value.sourcesVerified?.matched ?? 0} 条
            <span className="muted tiny">（只有对上的才显示出处链接）</span>
          </dd>
        </dl>
      </section>
    </div>
  );
}

// ── 路线规划 ─────────────────────────────────────────────────

interface RouteValue {
  distanceM?: number;
  durationS?: number;
  tollYuan?: number;
  trafficLights?: number;
  steps?: Array<{ instruction: string; distanceM: number; durationS: number; points?: Array<{ lat: number; lon: number }> }>;
}

function RouteDetail({ keyName, value }: { keyName: string; value: RouteValue }): JSX.Element {
  const ends = routeKeyToEnds(keyName);
  const steps = value.steps ?? [];
  const polyline: Array<[number, number]> = [];
  for (const s of steps) for (const p of s.points ?? []) polyline.push([p.lon, p.lat]);
  const points: MapPoint[] = [];
  if (ends) {
    points.push({ ...ends.origin, badge: "起", label: "", kind: "origin" });
    ends.waypoints.forEach((w, i) => points.push({ ...w, badge: String(i + 1), label: "途经", kind: "aux" }));
    points.push({ ...ends.destination, badge: "终", label: "", kind: "origin" });
  }
  return (
    <div className="cd">
      <h3 className="cd__title">
        路线规划
        {ends && <span className="muted tiny"> · 策略 {ends.strategy}</span>}
      </h3>
      <dl className="cd__facts cd__facts--grid">
        <dt>里程</dt>
        <dd>{distanceText(value.distanceM)}</dd>
        <dt>耗时</dt>
        <dd>{durationText(value.durationS)}（含缓存时的路况）</dd>
        <dt>过路费</dt>
        <dd>{value.tollYuan ?? "—"} 元</dd>
        <dt>红绿灯</dt>
        <dd>{value.trafficLights ?? "—"} 个</dd>
        {ends && (
          <>
            <dt>起点</dt>
            <dd className="mono">{coordText(ends.origin)}</dd>
            <dt>终点</dt>
            <dd className="mono">{coordText(ends.destination)}</dd>
          </>
        )}
      </dl>
      <CacheMap points={points} polyline={polyline} />
      {steps.length > 0 && (
        <>
          <h4 className="cd__sub">导航分段（{steps.length} 段）</h4>
          <ol className="cd__list cd__list--steps">
            {steps.map((s, i) => (
              <li key={i}>
                {s.instruction} <span className="muted tiny">{distanceText(s.distanceM)} · {durationText(s.durationS)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

// ── 充电站搜索 ───────────────────────────────────────────────

interface ChargingPoi {
  name: string;
  address?: string;
  cityName?: string;
  type?: string;
  distanceM?: number | null;
  lat?: number;
  lon?: number;
}

function ChargingDetail({ keyName, value }: { keyName: string; value: ChargingPoi[] }): JSX.Element {
  const c = chargingKeyToCenter(keyName);
  const list = Array.isArray(value) ? value : [];
  const points: MapPoint[] = [];
  if (c) points.push({ ...c.center, badge: "中", label: "搜索中心", kind: "origin" });
  list.forEach((p, i) => {
    if (typeof p.lat === "number" && typeof p.lon === "number") points.push({ lat: p.lat, lon: p.lon, badge: String(i + 1), label: p.name, kind: "spot" });
  });
  return (
    <div className="cd">
      <h3 className="cd__title">
        充电站搜索
        {c && (
          <span className="muted tiny">
            {" "}· 以 {coordText(c.center)} 为中心、半径 {distanceText(c.radiusM)}
          </span>
        )}
      </h3>
      <p className="muted tiny">存的全是静态属性（位置、名称、类型）——不含价格与空闲桩数，那两样本仓没有数据源。</p>
      {list.length === 0 ? (
        <p className="muted tiny">这次搜索范围内没有充电站。</p>
      ) : (
        <ol className="cd__list cd__list--steps">
          {list.map((p, i) => (
            <li key={i}>
              <b>{p.name}</b>
              {p.distanceM != null && <span className="muted"> · 距中心 {distanceText(p.distanceM)}</span>}
              {p.address && <div className="tiny muted">{[p.cityName, p.address].filter(Boolean).join(" ")}</div>}
              {p.type && <div className="tiny muted">{p.type}</div>}
            </li>
          ))}
        </ol>
      )}
      <CacheMap points={points} />
    </div>
  );
}

// ── 通用：字段表（不认识的命名空间） ─────────────────────────

function GenericDetail({ value }: { value: unknown }): JSX.Element {
  return (
    <div className="cd">
      <p className="muted tiny">这一类还没有专门的展示，按字段列出（新接的缓存类型请补一份渲染）。</p>
      <ValueTree value={value} />
    </div>
  );
}

function ValueTree({ value }: { value: unknown }): JSX.Element {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">（空列表）</span>;
    return (
      <ol className="cd__list cd__list--steps">
        {value.map((v, i) => (
          <li key={i}>
            <ValueTree value={v} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="cd__facts">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <FactPair key={k} k={k} v={v} />
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

function FactPair({ k, v }: { k: string; v: unknown }): JSX.Element {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        <ValueTree value={v} />
      </dd>
    </>
  );
}
