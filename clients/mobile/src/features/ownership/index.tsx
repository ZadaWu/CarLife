/**
 * 手机端「车辆档案」页（施工单 M14-11，定稿 `内部文档`）。
 *
 * # 这一版做的两件事，都是 Brief §1 点名的问题
 *
 * 1. **车与人分开**。此前 `MembersSection` 内联在这条滚动流里，
 *    车辆档案回答"这辆车是什么、被怎样使用"，人员档案回答"谁会用它、有什么需要"，
 *    两者的编辑、隐私与删除语义都不同。现在这一页**零人员信息**——
 *    连"常用人员 2 人"这样的计数都不放（Brief §2 原则 2 原文）。
 * 2. **用车画像接上⑥**。此前是一句占位文案（M14-05 台账 §6 #4）。
 *
 * # 定稿上的数字一个都不许写死
 *
 * `18,620 km`、`1,380 km`、`日均 46 km`、`32 条行程` 都是示意值。
 * 拿不到时只给理由与行动说明，不显示任何数字（Brief §5）。
 */
import { CabinSection } from "./cabin-section";
import { useCallback, useEffect, useState } from "react";
import { characterInitial, vehicleCharacter } from "@carlife/ui";

import { loadVehicleUsage, loadVehicles, setDefaultVehicle } from "./api";
import {
  chargeHoursLabel,
  ENERGY_LABEL,
  isPendingVin,
  knowledgeLine,
  maskVin,
  roadTypeLabel,
  type UsageState,
  type VehicleListState,
  type VehicleView,
} from "./types";
import { PeopleProfilePage } from "./people";
import { VehicleWizard, WizardDonePage } from "./wizard";
import "./ownership.css";

function fmtMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

function fmtDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface MobileOwnershipProps {
  /** 建档入口的外部覆盖；缺省用内置向导（M14-05）。 */
  onCreate?: () => void;
  /** 主题跟随外壳；素材分 light/dark 两套。 */
  theme?: "light" | "dark";
}

type PageMode =
  | { kind: "list" }
  | { kind: "wizard" }
  | { kind: "done"; created: VehicleView }
  | { kind: "people"; vehicle: VehicleView };

export function MobileOwnership({ onCreate, theme = "light" }: MobileOwnershipProps) {
  const [state, setState] = useState<VehicleListState>({ kind: "loading" });
  const [mode, setMode] = useState<PageMode>({ kind: "list" });
  const [usage, setUsage] = useState<UsageState>({ kind: "loading" });

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    void loadVehicles().then(setState);
  }, []);

  useEffect(reload, [reload]);

  // 只给默认车拉画像：同屏一辆车的信息密度已经够了（也少打一次网关）。
  const primary = state.kind === "ready" ? state.vehicles[0] : undefined;
  useEffect(() => {
    if (!primary) return;
    setUsage({ kind: "loading" });
    void loadVehicleUsage(primary.vin).then(setUsage);
  }, [primary?.vin]);

  const openWizard = onCreate ?? (() => setMode({ kind: "wizard" }));

  if (mode.kind === "wizard") {
    return (
      <VehicleWizard
        onDone={(created) => {
          setMode({ kind: "done", created });
          reload();
        }}
        onCancel={() => setMode({ kind: "list" })}
      />
    );
  }

  if (mode.kind === "done") {
    return <WizardDonePage created={mode.created} onBack={() => setMode({ kind: "list" })} />;
  }

  if (mode.kind === "people") {
    return (
      <PeopleProfilePage
        vehicle={mode.vehicle}
        theme={theme}
        onBack={() => setMode({ kind: "list" })}
      />
    );
  }

  return (
    <div className={`own-page own-page--${theme}`} aria-label="车辆档案">
      <header className="own-head">
        <span className="own-head-icon" aria-hidden>
          <CarBadgeIcon />
        </span>
        <h2 className="own-title">车辆档案</h2>
        {state.kind === "ready" && state.vehicles.length > 1 && (
          <VehiclePicker vehicles={state.vehicles} onPick={(vin) => void switchTo(vin)} />
        )}
      </header>

      {state.kind === "loading" && <p className="own-offline">正在读取…</p>}

      {/* offline ≠ empty：读不到绝不显示"还没有车辆"（Brief §5 最后一行） */}
      {state.kind === "offline" && (
        <div className="own-card own-offline">
          <p>暂时读不到你的车辆档案。</p>
          <p className="own-meta">{state.reason}</p>
          <button type="button" className="own-secondary" onClick={reload}>
            重试
          </button>
        </div>
      )}

      {state.kind === "empty" && (
        <div className="own-card own-empty">
          <p>还没有车辆档案。</p>
          <p className="own-meta">建档后可以获得针对这辆车的保养推算、说明书检索与问诊留档。</p>
          <button type="button" className="own-cta" onClick={openWizard}>
            创建车辆档案
          </button>
        </div>
      )}

      {primary && (
        <>
          <VehicleCard v={primary} theme={theme} />
          <ForecastCard v={primary} />
          <UsageCard state={usage} />
          <CabinSection vin={primary.vin} />
          <CollectCard />
          <button type="button" className="own-navrow" onClick={() => setMode({ kind: "people", vehicle: primary })}>
            <span className="own-navrow-icon" aria-hidden>
              <PersonIcon />
            </span>
            <span className="own-navrow-main">
              <b>人员档案</b>
              {/* Brief §2 原则 2：**不显示人数、姓名或约束标签** */}
              <small>管理常用人员与个人偏好</small>
            </span>
            <span className="own-navrow-arrow" aria-hidden>
              ›
            </span>
          </button>
          <RecordsCard v={primary} />
          <div className="own-empty">
            <button type="button" className="own-secondary" onClick={openWizard}>
              添加另一辆车
            </button>
          </div>
        </>
      )}
    </div>
  );

  async function switchTo(vin: string) {
    try {
      await setDefaultVehicle(vin);
    } finally {
      reload();
    }
  }
}

/** 多车切换：切的是**默认车**——默认车同时决定检索侧的车型限定，所以不是纯视图状态。 */
function VehiclePicker({ vehicles, onPick }: { vehicles: VehicleView[]; onPick: (vin: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="own-picker">
      <button type="button" className="own-pick" onClick={() => setOpen(!open)}>
        {vehicles[0]!.model}
        <span className={`own-caret${open ? " is-open" : ""}`} aria-hidden>
          ⌄
        </span>
      </button>
      {open && (
        <ul className="own-pick-menu">
          {vehicles.map((v, i) => (
            <li key={v.vin}>
              <button
                type="button"
                className={i === 0 ? "is-active" : undefined}
                onClick={() => {
                  setOpen(false);
                  if (i !== 0) onPick(v.vin);
                }}
              >
                {v.model} · {v.modelYear} 款
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function VehicleCard({ v, theme }: { v: VehicleView; theme: "light" | "dark" }) {
  // 匹配不到就不给图（M14-09 同一条）：拿别款顶替，用户会以为系统认得这辆车。
  const art = vehicleCharacter(v.model, theme);
  return (
    <section className="own-card own-hero">
      <h3 className="own-hero-title">
        {v.model} · {v.modelYear} 款 · {v.energyType ? ENERGY_LABEL[v.energyType] : "动力形式未记录"}
      </h3>
      <div className="own-hero-body">
        <div className="own-art">
          {art ? <img src={art} alt="" /> : <span className="own-art-fallback">{characterInitial(v.model)}</span>}
        </div>
        <dl className="own-facts">
          <div>
            <dt>表显里程</dt>
            <dd className="own-num">
              {Math.round(v.odometerKm).toLocaleString()} <span>km</span>
            </dd>
          </div>
          <div>
            <dt>购入</dt>
            <dd>{fmtMonth(v.purchasedAt)}</dd>
          </div>
          <div>
            <dt>VIN</dt>
            {/* 占位 VIN 不渲染值（M14-05 纪律）：它不是 VIN，只是主键 */}
            <dd>{isPendingVin(v.vin) ? <span className="own-meta">待补</span> : maskVin(v.vin)}</dd>
          </div>
          <div className="own-facts-foot">
            <span className="own-star">☆ 当前默认车</span>
          </div>
        </dl>
      </div>
      {/*
        知识库关联放卡底而不是 facts 里：定稿的 facts 是**三行**
        （里程 / 购入 / VIN）+ 默认车行，插第四行会把这张卡撑高。
        它是一句话，不是一个数值。
      */}
      <p className="own-cardfoot">{knowledgeLine(v.knowledge)}</p>
    </section>
  );
}

/** 保养推算（Brief §3.A 首屏待办）：数值与依据同一视区，通用估算标注。 */
function ForecastCard({ v }: { v: VehicleView }) {
  const f = v.forecast;
  const last = v.maintenance[v.maintenance.length - 1];
  return (
    <section className="own-card own-forecast">
      <span className="own-badge-round" aria-hidden>
        <WrenchIcon />
      </span>
      <div className="own-forecast-main">
        <div className="own-forecast-head">
          <b>{f && f.remainingKm < 0 ? "保养已超期约" : "距下次保养约"}</b>
          {f && (
            <span className="own-chip own-chip--quiet">
              {f.degraded ? "通用周期" : "厂商手册"}
              {last ? ` · 上次保养 ${fmtDay(last.at)}` : " · 无保养记录"}
            </span>
          )}
        </div>
        {f ? (
          <p className="own-forecast-value">
            {Math.abs(Math.round(f.remainingKm)).toLocaleString()} <span>km</span>
          </p>
        ) : (
          <p className="own-meta">还算不出保养推算——补一次保养记录后就能给出。</p>
        )}
        {/* 端上拿不到⑥日均里程 → 不显示到期时间，用行动说明替代（不猜） */}
        {f?.etaDays === undefined && f && (
          <p className="own-meta">积累行车数据后，会按你的用车强度给出大致到期时间。</p>
        )}
        {f && (
          // 定稿这里是一行小字，不是一段。三条 basis 拼起来会顶掉半张卡。
          <details className="own-basis">
            <summary>{(f.basis[0] ?? "推算依据").replace(/\*\*/g, "")}</summary>
            <ul>
              {f.basis.slice(1).map((b) => (
                <li key={b}>{b.replace(/\*\*/g, "")}</li>
              ))}
            </ul>
          </details>
        )}
        <div className="own-actions">
          <button type="button" className="own-secondary" disabled>
            查看保养记录
          </button>
          <button type="button" className="own-warnbtn" disabled>
            记一笔
          </button>
        </div>
        <p className="own-meta own-tiny">记录的录入走对话：说一句"刚做完保养"即可。</p>
      </div>
    </section>
  );
}

function UsageCard({ state }: { state: UsageState }) {
  return (
    <section className="own-card">
      <div className="own-card-head">
        <span className="own-head-icon own-head-icon--sm" aria-hidden>
          <PieIcon />
        </span>
        <b>这辆车的用车画像</b>
      </div>

      {state.kind === "loading" && <p className="own-meta">正在读取…</p>}
      {/* 三种"没有数字"的原因措辞各不相同——合并会把系统故障说成用户开得少 */}
      {state.kind === "offline" && <p className="own-meta">暂时读不到用车数据（{state.reason}）。</p>}
      {state.kind === "unconfigured" && (
        <p className="own-meta">用车数据还没有接入（{state.reason}），所以这里没有画像——不是你开得少。</p>
      )}
      {state.kind === "unusable" && (
        <p className="own-meta">
          {state.reason}
          {state.sampleSize > 0 ? `（目前 ${state.sampleSize} 条行程）` : ""}。
          连接车辆或完成几次行程后再生成画像。
        </p>
      )}

      {state.kind === "ready" && <UsageFacts profile={state.profile} />}
    </section>
  );
}

function UsageFacts({ profile }: { profile: Extract<UsageState, { kind: "ready" }>["profile"] }) {
  const s = profile.summary;
  const road = roadTypeLabel(s.dominantRoadType);
  const charge = chargeHoursLabel(s.commonChargeHours);
  const stale =
    s.staleDays === null
      ? undefined
      : s.staleDays < 1
        ? "今日同步"
        : s.staleDays < 2
          ? "昨日同步"
          : `${Math.round(s.staleDays)} 天前同步`;
  return (
    <>
      <p className="own-meta own-tiny">
        近 {s.windowDays} 天 · {s.sampleSize} 条行程{stale ? ` · ${stale}` : ""}
      </p>
      <div className="own-stats">
        <div className="own-stat">
          <span className="own-stat-icon own-stat-icon--blue" aria-hidden>
            <RoadIcon />
          </span>
          <div>
            <small>日均</small>
            <b>
              {s.avgDailyKm.toFixed(s.avgDailyKm < 10 ? 1 : 0)} <span>km</span>
            </b>
          </div>
        </div>
        {/* 路况与充电时段没有就整块不出现，不留一个写着"未知"的格子 */}
        {road && (
          <div className="own-stat">
            <span className="own-stat-icon own-stat-icon--blue" aria-hidden>
              <PinIcon />
            </span>
            <div>
              <b className="own-stat-text">{road}</b>
            </div>
          </div>
        )}
        {charge && (
          <div className="own-stat">
            <span className="own-stat-icon own-stat-icon--green" aria-hidden>
              <PlugIcon />
            </span>
            <div>
              <small>常在</small>
              <b className="own-stat-text">{charge} 充电</b>
            </div>
          </div>
        )}
      </div>
      {s.derivation.length > 0 && (
        // 可解释性的落点（F-22-06）
        <details className="own-derivation">
          <summary>这些数字怎么来的</summary>
          <ul>
            {s.derivation.map((d) => (
              <li key={d}>{d.replace(/\*\*/g, "")}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * 采集说明。**手机端不放开关**——手机不产生行程流水（`commands::trips` 只在车机），
 * 给一个开关等于让用户以为关掉它就停止采集了，而真正在采的是车上那台。
 */
function CollectCard() {
  return (
    <section className="own-card own-row">
      <span className="own-navrow-icon" aria-hidden>
        <ShieldIcon />
      </span>
      <div className="own-navrow-main">
        <b>用车数据采集</b>
        <small>采集行程、路况、充电时段，不采集车内音视频。开关在车机端——采集发生在车上。</small>
      </div>
    </section>
  );
}

function RecordsCard({ v }: { v: VehicleView }) {
  const [hint, setHint] = useState<string | null>(null);
  const lastM = v.maintenance[v.maintenance.length - 1];
  return (
    <section className="own-card own-timeline">
      {/*
        三行都带箭头（定稿如此），详情页都还没有。
        摘要那一行仍是真数据，没做的只是"点进去还能看到更多"，点击如实说。
      */}
      <button type="button" className="own-row" onClick={() => setHint("保养与维修")}>
        <span className="own-dot" aria-hidden />
        <span className="own-navrow-icon own-navrow-icon--warn" aria-hidden>
          <WrenchIcon />
        </span>
        <span className="own-navrow-main">
          <b>保养与维修</b>
          <small>
            {hint === "保养与维修"
              ? "详情页持续开发中；记录的录入走对话"
              : lastM
                ? `${fmtDay(lastM.at)} · ${Math.round(lastM.odometerKm).toLocaleString()} km · ${lastM.items} · ${lastM.source}`
                : v.repairs.length > 0
                  ? `维修/问诊 ${v.repairs.length} 条 · 还没有保养记录`
                  : "还没有记录"}
          </small>
        </span>
        <span className="own-navrow-arrow" aria-hidden>
          ›
        </span>
      </button>

      <button type="button" className="own-row" onClick={() => setHint("车辆资料")}>
        <span className="own-dot" aria-hidden />
        <span className="own-navrow-icon own-navrow-icon--warn" aria-hidden>
          <DocIcon />
        </span>
        <span className="own-navrow-main">
          <b>车辆资料</b>
          <small>
            {hint === "车辆资料"
              ? "补录与查看持续开发中；VIN 也可以在对话里补"
              : isPendingVin(v.vin)
                ? "VIN 还没补，补上后可关联召回与保修"
                : `VIN ${maskVin(v.vin)}`}
          </small>
        </span>
        {isPendingVin(v.vin) && <span className="own-chip own-chip--outline">补充 VIN</span>}
        <span className="own-navrow-arrow" aria-hidden>
          ›
        </span>
      </button>

      <button type="button" className="own-row" onClick={() => setHint("档案变更记录")}>
        <span className="own-dot" aria-hidden />
        <span className="own-navrow-icon own-navrow-icon--warn" aria-hidden>
          <HistoryIcon />
        </span>
        <span className="own-navrow-main">
          <b>档案变更记录</b>
          <small>{hint === "档案变更记录" ? "持续开发中" : "谁在什么时候改了这份档案"}</small>
        </span>
        <span className="own-navrow-arrow" aria-hidden>
          ›
        </span>
      </button>
    </section>
  );
}

// ── 图标（内联 SVG，不引图标库）────────────────────────────────

const S = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none" } as const;

function CarBadgeIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="4" width="18" height="17" rx="3" />
      <path d="M3 9h18M7 2v4M17 2v4" />
      <path d="M7.5 16.5h9M8.5 14l1-2h5l1 2" strokeLinecap="round" />
      <circle cx="9" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 3.5a5 5 0 0 0-6.2 6.2L3.6 15.4a2 2 0 0 0 2.8 2.8l5.7-5.7a5 5 0 0 0 6.2-6.2l-2.9 2.9-2.6-.7-.7-2.6z" />
    </svg>
  );
}

function PieIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5V12h8.5" strokeLinecap="round" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M12 3l7 3v5.5c0 4.3-2.9 8-7 9.5-4.1-1.5-7-5.2-7-9.5V6z" />
      <path d="M9 12l2.2 2.2L15.5 10" strokeLinecap="round" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" strokeLinecap="round" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" strokeLinecap="round" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M4 12a8 8 0 1 0 2.4-5.7M4 5v4h4" strokeLinejoin="round" />
      <path d="M12 7.6V12l3 1.8" />
    </svg>
  );
}

function RoadIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M8 21 10 4M16 21 14 4" />
      <path d="M12 6v2M12 11v2M12 16v2" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M12 21s6.5-6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21z" />
      <circle cx="12" cy="10.5" r="2.3" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M9 3v5M15 3v5" />
      <path d="M6.5 8h11v3a5.5 5.5 0 0 1-11 0z" strokeLinejoin="round" />
      <path d="M12 16.5V21" />
    </svg>
  );
}

export default MobileOwnership;
