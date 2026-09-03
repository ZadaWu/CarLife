/**
 * 车机端「车辆档案」页（施工单 M14-09，定稿 `内部文档`）。
 *
 * # 这一页最容易犯的错，是照着设计图把数字敲进去
 *
 * 定稿上的 `日均 46km`、`通勤道路为主`、`常在 19:00–21:00 充电`、`近 30 天 · 32 条行程`
 * 全是设计稿示意值。真实取数（⑥）拿不到时**一个数字都不渲染**，
 * 只渲染理由与行动说明（Brief §4 / F-22-08）。照抄示意值会让页面立刻"很完整"，
 * 而那份完整是假的——评审时没人分得出哪些是真的。
 *
 * 同一条纪律的三个面（见 types.ts）：
 *   读不到 ≠ 没有 / 没接入 ≠ 没有数据 / 样本不足 ≠ 数字是零。
 *
 * # 出口只有底部导航一处
 *
 * 本页顶部**没有**「返回主页」按钮（2026-08-28 产品定调，撤掉 M14-06 加的那个）：
 * 车机端的换页出口统一在底部导航，页内再放一个等于同一件事两个入口。
 * 注意这只针对**离开档案区**；档案区内部的子页（车辆信息/记录/变更/成员）
 * 各自的返回按钮要留着——它们回的是本页的车辆列表，底部导航到不了那一层。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CabinCard } from "./CabinCard";
import { SeatPicker } from "./SeatPicker";
import { characterInitial, vehicleCharacter, type CharacterTheme } from "@carlife/ui";

import {
  DEMO_USAGE,
  DEMO_VEHICLE,
  isPeopleDemo,
  isProfileDemo,
} from "../../data/demoVehicleProfile";
import { CockpitWizard } from "./CockpitWizard";
import { loadVehicleUsage, loadVehicles, setDefaultVehicle } from "./api";
import { ChangeLogScreen } from "./ChangeLogScreen";
import { MaintenanceEntryScreen } from "./MaintenanceEntryScreen";
import { MembersScreen } from "./MembersScreen";
import { RecordsScreen } from "./RecordsScreen";
import { VehicleInfoScreen } from "./VehicleInfoScreen";
import {
  chargeHoursLabel,
  ENERGY_LABEL,
  isPendingVin,
  maskVin,
  roadTypeLabel,
  type UsageState,
  type VehicleListState,
  type VehicleView,
} from "./types";
import "./ownership.css";

export interface OwnershipScreenProps {
  theme: CharacterTheme;
  /** ⑥采集开关（App 持有，因为 devbar 也在改它）。未接 Tauri 时缺席。 */
  collect?: { enabled: boolean; onToggle: () => void };
  /** 上车点选的出口（M24-09）：声明经既有对话通道发出。未接 Tauri 时缺席。 */
  onDeclareSeating?: (sentence: string) => void;
  /**
   * 选中车变了（M27）。HUD 的能量读数按它取——**档案页选了哪辆，HUD 就读哪辆**，
   * 两处各自解析会在用户切车后不一致，而那种不一致在屏幕上看不出来。
   */
  onActiveVinChange?: (vin: string, model?: string) => void;
  /**
   * 首屏数据到位时调一次（车辆列表出结果即可，用量是次要信息）。
   *
   * 「开车去档案」过场靠它决定什么时候开走。**失败也要报**——
   * 不报的话过场会一直开到超时上限，而屏幕后面其实早就是一条错误提示了，
   * 那三秒纯属让人干等。
   */
  onReady?: () => void;
  /*
   * 网关连接设置的入口**已经搬走**（M33-05）：它现在在底部导航的「设置」页。
   *
   * 原来放在档案页是权宜之计（ACR-004 第 3 步的注释："入口放在档案页而不是
   * devbar，把正式功能的设置藏在演示浮层里不符合内测软件的标准"）——
   * 档案页讲的是"这辆车的资料"，而网关地址讲的是"这台设备连哪台服务器"，
   * 两件事只是碰巧都叫"设置"。有了正经的设置页就该各归各位。
   */
}

type Page = "vehicle" | "members" | "wizard" | "records" | "note" | "info" | "changes";

export function OwnershipScreen({
  theme,
  collect,
  onDeclareSeating,
  onActiveVinChange,
  onReady,
}: OwnershipScreenProps) {
  const [state, setState] = useState<VehicleListState>({ kind: "loading" });
  // `?page=people` 让截图脚本直接落到人员页（M14-14）。
  const [page, setPage] = useState<Page>(isPeopleDemo() ? "members" : "vehicle");
  const [activeVin, setActiveVin] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageState>({ kind: "loading" });

  /*
   * `onReady` 走 ref，**不进 `reload` 的依赖**。
   *
   * 调用方多半传的是内联箭头（App 就是），它每次渲染都是新身份；
   * 进了依赖就等于"父组件一重渲染，档案页重新拉一遍车辆列表"——
   * 而父组件在过场期间因为 ready/driving 两个 state 正好一直在重渲染，
   * 那是一个自己喂自己的循环。组件的取数次数不该由调用方的写法决定。
   */
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const reload = useCallback(() => {
    // `?profile=demo`：浏览器版式走查用的固定快照（M14-14，同 ?hitl=demo 先例）。
    // Tauri 窗口不带 query，真实档案永远走 fetch_vehicles。
    if (isProfileDemo()) {
      setState({ kind: "ready", vehicles: [DEMO_VEHICLE] });
      onReadyRef.current?.();
      return;
    }
    setState({ kind: "loading" });
    // 成败都报就绪：失败时页面上已经是一条错误提示，过场没有理由继续等（见 onReady 注释）。
    void loadVehicles().then((r) => {
      setState(r);
      onReadyRef.current?.();
    });
  }, []);

  useEffect(reload, [reload]);

  const vehicles = state.kind === "ready" ? state.vehicles : [];
  // 列表首位是默认车（服务端排序）。activeVin 只在用户主动切换时才偏离它。
  const active = vehicles.find((v) => v.vin === activeVin) ?? vehicles[0];

  useEffect(() => {
    if (!active) return;
    onActiveVinChange?.(active.vin, active.model);
    if (isProfileDemo()) {
      setUsage(DEMO_USAGE);
      return;
    }
    setUsage({ kind: "loading" });
    void loadVehicleUsage(active.vin).then(setUsage);
  }, [active?.vin]);

  const setDefault = async (vin: string) => {
    setSwitching(vin);
    try {
      await setDefaultVehicle(vin);
    } catch (err) {
      console.warn("[ownership] 设默认车失败", err);
    } finally {
      setSwitching(null);
      reload();
    }
  };

  if (page === "wizard") {
    return (
      <CockpitWizard
        onDone={() => {
          setPage("vehicle");
          reload();
        }}
        onCancel={() => setPage("vehicle")}
      />
    );
  }

  if (page === "members") {
    return (
      <MembersScreen
        theme={theme}
        vehicle={active}
        onBack={() => setPage("vehicle")}
      />
    );
  }

  // 详情页挂在有车的前提下（M29-02）；没有 active 时入口本来就不渲染。
  if (page === "records" && active) {
    return <RecordsScreen theme={theme} vehicle={active} onBack={() => setPage("vehicle")} />;
  }

  // 档案变更记录（M29-05）。
  if (page === "changes" && active) {
    return <ChangeLogScreen theme={theme} vehicle={active} onBack={() => setPage("vehicle")} />;
  }

  // 车辆资料（M29-04）：补录成功后 VIN 变了，必须整页 reload 再回主页面。
  if (page === "info" && active) {
    return (
      <VehicleInfoScreen
        theme={theme}
        vehicle={active}
        onSaved={() => {
          reload();
          setPage("vehicle");
        }}
        onBack={() => setPage("vehicle")}
      />
    );
  }

  // 记一笔（M29-03）：保存成功 → 刷新档案并落到详情页，让新记录立刻可见。
  if (page === "note" && active) {
    return (
      <MaintenanceEntryScreen
        theme={theme}
        vehicle={active}
        onSaved={() => {
          reload();
          setPage("records");
        }}
        onCancel={() => setPage("vehicle")}
      />
    );
  }

  return (
    <div className={`cown cown--${theme}`} aria-label="车辆档案">
      <div className="cown-sheet">
        <header className="cown-head">
          <span className="cown-head-icon" aria-hidden>
            <CarBadgeIcon />
          </span>
          <h2 className="cown-title">车辆档案</h2>

          {active && vehicles.length > 1 && (
            <div className="cown-picker">
              <button type="button" className="cown-pick" onClick={() => setPicking(!picking)}>
                {active.model}
                <span className={`cown-caret${picking ? " is-open" : ""}`} aria-hidden>
                  ⌄
                </span>
              </button>
              {picking && (
                <ul className="cown-pick-menu">
                  {vehicles.map((v) => (
                    <li key={v.vin}>
                      <button
                        type="button"
                        className={v.vin === active.vin ? "is-active" : undefined}
                        onClick={() => {
                          setActiveVin(v.vin);
                          setPicking(false);
                        }}
                      >
                        {v.model} · {v.modelYear} 款
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {active && vehicles.length === 1 && <span className="cown-pick cown-pick--static">{active.model}</span>}

          {active && (
            <span className="cown-chip">
              {active.modelYear} 款 · {active.energyType ? ENERGY_LABEL[active.energyType] : "动力形式未记录"}
            </span>
          )}
          {active && active.vin === vehicles[0]?.vin && (
            <span className="cown-chip cown-chip--star">☆ 当前默认车</span>
          )}

        </header>

        {state.kind === "loading" && <p className="cown-note">正在读取…</p>}

        {/* offline ≠ empty：读不到绝不显示"还没有车辆"（Brief §4） */}
        {state.kind === "offline" && (
          <div className="cown-card cown-note">
            <p>暂时读不到车辆档案。</p>
            <p className="cown-dim">{state.reason}</p>
            <button type="button" className="cown-btn" onClick={reload}>
              重试
            </button>
          </div>
        )}

        {state.kind === "empty" && (
          <div className="cown-card cown-note">
            <p>还没有车辆档案。</p>
            <p className="cown-dim">建档后可以获得针对这辆车的保养推算与说明书检索。</p>
            <button type="button" className="cown-btn cown-btn--primary" onClick={() => setPage("wizard")}>
              添加车辆
            </button>
          </div>
        )}

        {active && (
          <div className="cown-grid2">
            <div className="cown-col">
              <VehicleCard
                v={active}
                theme={theme}
                isDefault={active.vin === vehicles[0]?.vin}
                busy={switching === active.vin}
                onSetDefault={() => void setDefault(active.vin)}
              />
              <ForecastCard
                v={active}
                onViewRecords={() => setPage("records")}
                onAddNote={() => setPage("note")}
              />
              <RecordsCard
                v={active}
                onAddVehicle={() => setPage("wizard")}
                onOpenRecords={() => setPage("records")}
                onOpenInfo={() => setPage("info")}
                onOpenChanges={() => setPage("changes")}
              />
              {collect && <CollectCard enabled={collect.enabled} onToggle={collect.onToggle} />}
            </div>

            <div className="cown-col">
              <UsageCard state={usage} />
              <CabinCard vin={active.vin} />
              {onDeclareSeating && <SeatPicker vin={active.vin} onDeclare={onDeclareSeating} />}
              <button type="button" className="cown-row cown-row--link" onClick={() => setPage("members")}>
                <span className="cown-row-icon cown-row-icon--blue" aria-hidden>
                  <PersonIcon />
                </span>
                <span className="cown-row-main">
                  <b>人员档案</b>
                  <small>管理常用人员与个人偏好</small>
                </span>
                <span className="cown-row-arrow" aria-hidden>
                  ›
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 左列（车本身：车辆卡、保养推算、保养与维修、数据采集）──────

function VehicleCard({
  v,
  theme,
  isDefault,
  busy,
  onSetDefault,
}: {
  v: VehicleView;
  theme: CharacterTheme;
  isDefault: boolean;
  busy: boolean;
  onSetDefault: () => void;
}) {
  // 形象匹配不到就不给图（M14-09 约束 2）：拿别款顶替，用户会以为系统认得这辆车。
  const art = vehicleCharacter(v.model, theme);
  const pending = isPendingVin(v.vin);
  return (
    <section className="cown-card cown-card--hero">
      <h3 className="cown-hero-title">
        {v.model} · {v.modelYear} 款 ·{" "}
        {v.energyType ? ENERGY_LABEL[v.energyType] : "动力形式未记录"}
      </h3>
      <div className="cown-hero-body">
        <div className="cown-art">
          {art ? (
            <img src={art} alt="" />
          ) : (
            <span className="cown-art-fallback" aria-hidden>
              {characterInitial(v.model)}
            </span>
          )}
        </div>
        <dl className="cown-facts">
          <div>
            <dt>
              <span className="cown-fact-icon" aria-hidden><GaugeIcon /></span>表显里程
            </dt>
            <dd className="cown-num">
              {Math.round(v.odometerKm).toLocaleString()} <span>km</span>
            </dd>
          </div>
          <div>
            <dt>
              <span className="cown-fact-icon" aria-hidden><CalendarIcon /></span>购入
            </dt>
            <dd>{fmtMonth(v.purchasedAt)}</dd>
          </div>
          <div>
            <dt>
              <span className="cown-fact-icon" aria-hidden><ShieldMiniIcon /></span>VIN
            </dt>
            {/* 占位 VIN 不渲染值（M14-05 纪律）：它不是 VIN，只是主键 */}
            <dd>{pending ? <span className="cown-dim">待补</span> : maskVin(v.vin)}</dd>
          </div>
          <div className="cown-facts-foot">
            {isDefault ? (
              <span className="cown-star">☆ 当前默认车</span>
            ) : (
              <button type="button" className="cown-btn cown-btn--sm" disabled={busy} onClick={onSetDefault}>
                {busy ? "切换中…" : "设为默认车"}
              </button>
            )}
          </div>
        </dl>
      </div>
      {/*
        知识库关联（M14-08）放在卡底而不是 facts 列表里：
        定稿的 facts 是**三行**（里程 / 购入 / VIN）+ 默认车行，
        插第四行会把这张卡撑高、把右列的节奏也带歪。它是一句话不是一个数值。
      */}
      <p className="cown-cardfoot">{knowledgeLine(v.knowledge)}</p>
    </section>
  );
}

function ForecastCard({
  v,
  onViewRecords,
  onAddNote,
}: {
  v: VehicleView;
  onViewRecords: () => void;
  onAddNote: () => void;
}) {
  const f = v.forecast;
  const last = v.maintenance[v.maintenance.length - 1];
  return (
    <section className="cown-card cown-card--forecast">
      <span className="cown-badge-round" aria-hidden>
        <WrenchIcon />
      </span>
      <div className="cown-forecast-main">
        <div className="cown-forecast-head">
          <b>{f && f.remainingKm < 0 ? "保养已超期约" : "距下次保养约"}</b>
          {f && (
            <span className="cown-chip cown-chip--quiet">
              {f.degraded ? "通用周期" : "厂商手册"}
              {last ? ` · 上次保养 ${fmtDay(last.at)}` : " · 无保养记录"}
            </span>
          )}
        </div>
        {f ? (
          <p className="cown-forecast-value">
            {Math.abs(Math.round(f.remainingKm)).toLocaleString()} <span>km</span>
          </p>
        ) : (
          // 推算拿不到就说拿不到，不显示 0
          <p className="cown-dim">还算不出保养推算——补一次保养记录后就能给出。</p>
        )}
        {f && (
          /*
           * 依据与数值同视区（Brief §2），但**定稿里它是一行小字不是一段**。
           * 直接把三条 basis 拼起来会顶掉半张卡；折叠起来、默认给最要紧的那条。
           *
           * `**` 必须剥掉：`forecastMaintenance` 的 basis 里带 markdown 强调
           * （给对话层用的），直接渲染到 DOM 上就是一串裸星号。手机端一直有
           * 这个 replace，车机端漏了。
           */
          <details className="cown-basis">
            <summary>{stripEmphasis(f.basis[0] ?? "推算依据")}</summary>
            <ul>
              {f.basis.slice(1).map((b) => (
                <li key={b}>{stripEmphasis(b)}</li>
              ))}
            </ul>
          </details>
        )}
        <div className="cown-actions">
          {/* 两个按钮自 M29-02/03 起都是真入口。 */}
          <button type="button" className="cown-btn cown-btn--outline" onClick={onViewRecords}>
            查看保养记录
          </button>
          <button type="button" className="cown-btn cown-btn--warn" onClick={onAddNote}>
            记一笔
          </button>
        </div>
        <p className="cown-dim cown-tiny">也可以在对话里说一句「刚做完保养」，助手会记下。</p>
      </div>
    </section>
  );
}

function CollectCard({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <section className="cown-card cown-card--row">
      <span className="cown-row-icon cown-row-icon--blue" aria-hidden>
        <ShieldIcon />
      </span>
      <div className="cown-row-main">
        <b>
          用车数据采集
          <span className={`cown-pill${enabled ? " cown-pill--on" : ""}`}>{enabled ? "已开启" : "已关闭"}</span>
        </b>
        <small>采集行程、路况、充电时段，不采集车内音视频</small>
      </div>
      <button type="button" className="cown-btn cown-btn--outline cown-btn--sm" onClick={onToggle}>
        {enabled ? "关闭采集" : "开启采集"}
      </button>
    </section>
  );
}

function RecordsCard({
  v,
  onAddVehicle,
  onOpenRecords,
  onOpenInfo,
  onOpenChanges,
}: {
  v: VehicleView;
  onAddVehicle: () => void;
  onOpenRecords: () => void;
  onOpenInfo: () => void;
  onOpenChanges: () => void;
}) {
  const lastM = v.maintenance[v.maintenance.length - 1];
  return (
    <section className="cown-card cown-timeline">
      {/* 「保养与维修」自 M29-02 起进详情页；后两行的页面在 M29-04/05 接。 */}
      <button type="button" className="cown-row" onClick={onOpenRecords}>
        <span className="cown-dot" aria-hidden />
        <span className="cown-row-icon cown-row-icon--warn" aria-hidden>
          <WrenchIcon />
        </span>
        <span className="cown-row-main">
          <b>保养与维修</b>
          <small>
            {lastM
              ? `${fmtDay(lastM.at)} · ${Math.round(lastM.odometerKm).toLocaleString()} km · ${lastM.items} · ${lastM.source}`
              : v.repairs.length > 0
                ? `维修/问诊 ${v.repairs.length} 条 · 还没有保养记录`
                : "还没有记录"}
          </small>
        </span>
        <span className="cown-row-arrow" aria-hidden>
          ›
        </span>
      </button>

      {/* 「车辆资料」自 M29-04 起进资料页；占位车的「补充 VIN」chip 同一去向。 */}
      <button type="button" className="cown-row" onClick={onOpenInfo}>
        <span className="cown-dot" aria-hidden />
        <span className="cown-row-icon cown-row-icon--warn" aria-hidden>
          <DocIcon />
        </span>
        <span className="cown-row-main">
          <b>车辆资料</b>
          <small>
            {isPendingVin(v.vin)
              ? "VIN 还没补，补上后可关联召回与保修"
              : `VIN ${maskVin(v.vin)}`}
          </small>
        </span>
        {isPendingVin(v.vin) && <span className="cown-chip cown-chip--outline">补充 VIN</span>}
        <span className="cown-row-arrow" aria-hidden>
          ›
        </span>
      </button>

      {/* 「档案变更记录」自 M29-05 起进真实页面——本卡最后一个占位入口就此清零。 */}
      <button type="button" className="cown-row" onClick={onOpenChanges}>
        <span className="cown-dot" aria-hidden />
        <span className="cown-row-icon cown-row-icon--warn" aria-hidden>
          <HistoryIcon />
        </span>
        <span className="cown-row-main">
          <b>档案变更记录</b>
          <small>谁在什么时候改了这份档案</small>
        </span>
        <span className="cown-row-arrow" aria-hidden>
          ›
        </span>
      </button>

      <div className="cown-timeline-foot">
        <button type="button" className="cown-btn cown-btn--sm" onClick={onAddVehicle}>
          添加车辆
        </button>
      </div>
    </section>
  );
}

/** 三态（M14-08）：读不到绝不写成"没有资料"。 */
function knowledgeLine(k: VehicleView["knowledge"]): string {
  if (!k || k.state === "unavailable") {
    return `暂时读不到覆盖情况${k?.reason ? `（${k.reason}）` : ""}`;
  }
  const stale = k.state === "stale" ? "（可能不是最新）" : "";
  if (k.links.length === 0) return `暂无这一款的资料${stale}`;
  return `${stale}${k.links.map((l) => `${l.datasetName} ${l.documents.length} 篇`).join(" · ")}`;
}

// ── 右列（用车画像、座舱、乘员与人员）───────────────────────

function UsageCard({ state }: { state: UsageState }) {
  return (
    <section className="cown-card">
      <div className="cown-card-head">
        <span className="cown-head-icon cown-head-icon--sm" aria-hidden>
          <PieIcon />
        </span>
        <b>这辆车的用车画像</b>
      </div>

      {state.kind === "loading" && <p className="cown-dim">正在读取…</p>}

      {/* 三种"没有数字"的原因，措辞各不相同——合并成一句会把系统故障说成用户开得少 */}
      {state.kind === "offline" && <p className="cown-dim">暂时读不到用车数据（{state.reason}）。</p>}
      {state.kind === "unconfigured" && (
        <p className="cown-dim">用车数据还没有接入（{state.reason}），所以这里没有画像——不是你开得少。</p>
      )}
      {state.kind === "unusable" && (
        <p className="cown-dim">
          {state.reason}
          {state.sampleSize > 0 ? `（目前 ${state.sampleSize} 条行程）` : ""}。
          再积累一段时间就能给出日均里程、路况与充电时段。
        </p>
      )}

      {state.kind === "ready" && <UsageFacts state={state} />}
    </section>
  );
}

function UsageFacts({ state }: { state: Extract<UsageState, { kind: "ready" }> }) {
  const s = state.profile.summary;
  const road = roadTypeLabel(s.dominantRoadType);
  const charge = chargeHoursLabel(s.commonChargeHours);
  return (
    <>
      <p className="cown-dim cown-tiny">
        近 {s.windowDays} 天 · {s.sampleSize} 条行程 ·{" "}
        {s.staleDays < 1 ? "今日同步" : s.staleDays < 2 ? "昨日同步" : `${Math.round(s.staleDays)} 天前同步`}
      </p>
      <div className="cown-stats">
        <div className="cown-stat">
          <span className="cown-stat-icon cown-stat-icon--blue" aria-hidden>
            <RoadIcon />
          </span>
          <div>
            <small>日均</small>
            <b>
              {s.avgDailyKm.toFixed(s.avgDailyKm < 10 ? 1 : 0)} <span>km</span>
            </b>
          </div>
        </div>
        {/* 路况与充电时段**没有就整块不出现**，不留一个写着"未知"的格子 */}
        {road && (
          <div className="cown-stat">
            <span className="cown-stat-icon cown-stat-icon--blue" aria-hidden>
              <PinIcon />
            </span>
            <div>
              <b className="cown-stat-text">{road}</b>
            </div>
          </div>
        )}
        {charge && (
          <div className="cown-stat">
            <span className="cown-stat-icon cown-stat-icon--green" aria-hidden>
              <PlugIcon />
            </span>
            <div>
              <small>常在</small>
              <b className="cown-stat-text">{charge} 充电</b>
            </div>
          </div>
        )}
      </div>
      {s.derivation.length > 0 && (
        // 可解释性的落点（F-22-06）：每个数字由哪些字段算出。
        // 定稿这一行是带图标的链接行，不是一个裸三角。
        <details className="cown-derivation">
          <summary>
            <span className="cown-derivation-icon" aria-hidden>
              <BarsIcon />
            </span>
            这些数字怎么来的
          </summary>
          <ul>
            {s.derivation.map((d) => (
              <li key={d}>{stripEmphasis(d)}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

// ── 工具 ──────────────────────────────────────────────────────

function fmtMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

function fmtDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 剥掉 `**强调**`。
 *
 * `forecastMaintenance` 与 `summary.derivation` 的文案是给**对话层**写的，
 * 里面带 markdown 强调。直接塞进 DOM 就是一串裸星号——手机端一直有这个
 * replace，车机端漏了，于是保养卡上出现了 `（**档案未记录，此为通用参考**）`。
 */
function stripEmphasis(s: string): string {
  return s.replace(/\*\*/g, "");
}

// ── 图标（内联 SVG：车机端不引图标库，包体与离线都更省心）──────

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

function GaugeIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 12l3.6-3.2" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="15" rx="3" />
      <path d="M4 10h16M8.5 3v4M15.5 3v4" strokeLinecap="round" />
    </svg>
  );
}

function ShieldMiniIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M12 3.5l6.5 2.8v4.9c0 3.9-2.7 7.3-6.5 8.6-3.8-1.3-6.5-4.7-6.5-8.6V6.3z" />
      <circle cx="12" cy="11" r="2.4" />
    </svg>
  );
}

function BarsIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <path d="M6 19v-6M12 19V6M18 19v-9" />
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
