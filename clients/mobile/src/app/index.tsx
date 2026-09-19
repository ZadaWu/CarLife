/**
 * 手机端应用外壳（施工单 A3）。
 *
 * 职责：会话引导（复用或新建）→ 桥接事件单点订阅 → 驱动 HUD 与对话层。
 * 与 cockpit 的 App 同构，差异见各处注释。
 *
 * 红线：HUD 内不出现任何有后果的动作；有后果的都在对话层经 Guard + HITL。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BottomNav,
  DEMO_TRIP_ENTRIES,
  DEMO_DIALOG_MESSAGES,
  DEMO_DIALOG_SESSIONS,
  DEMO_DIALOG_STREAMING,
  DEMO_TRIP_PLAN,
  isDialogDemo,
  isGuideDemo,
  DialogScreen,
  SPRITES,
  TripReviewSheet,
  assistantMode,
  canRetire,
  createArrivalAnnouncer,
  createGatewayHudSource,
  demoEnergy,
  hudAlertFrom,
  mockVoicePort,
  sessionResumable,
  startEnergyPolling,
  useAssistantInteraction,
  useBranchFaults,
  useCarousel,
  useMapViewport,
  useToolProgress,
  withDemoNav,
  type AssistantVoicePort,
  type GatewayHudSource,
  type HomePlace,
  type HudTripMapProps,
  type LiveEnergy,
  type NavTripProgress,
  type NavView,
  type SessionBrief,
  type StreamingTurn,
  type ThemeName,
  outstandingGuideJobs,
  readyGuideSpots,
  tripActiveFor,
} from "@carlife/ui";
import type { OnDeviceDetectResult } from "@carlife/ui";
import type { ClientDetections } from "@carlife/shared";
import {
  ACCOUNT_EVENTS,
  SESSION_EXPIRED,
  highlightsPage,
  tripPlanNavDay,
  tripPlanStops,
  validateHudSnapshot,
  type AssistantState,
  type ChatMessage,
  type HudSnapshot,
  type PermissionRequest,
  type SentinelIndication,
  type TripPlanListEntry,
  type TripPlanSnapshot,
  type WeatherKind,
  type AttachmentKind,
  type AttachmentRef,
} from "@carlife/shared";

import { listen } from "@tauri-apps/api/event";

import { subscribeBridge } from "../bridge";
import { createMockHudSource, makeSnapshot, MOCK_HOME } from "../data/mockSource";
import { invokeAckTripReview, invokeFetchEnergy, invokeFetchTripPlan } from "../data/gatewayInvoke";
import { resolveTheme, setRootTheme } from "./theme";
import { loadVehicles } from "../features/ownership/api";
import { createInflight, INFLIGHT_BOOTSTRAP, INFLIGHT_NEW_SESSION } from "../data/inflight";
import { planBootstrap } from "../data/bootstrapSession";
import { sendWithSessionRetry } from "../data/sendWithRetry";
import { buildUploadHeaders } from "../data/attachmentUpload";
import { createAttachmentSessions } from "../data/attachmentSessions";
import { MobileGuide, useGuideBrief, useGuideJobs } from "../features/guide";
import { MobileDeparture } from "../features/departure";
import { MobileTripSheet } from "../features/trip";
import { GuideJobsPanel } from "@carlife/ui";
import { MobileHud } from "../features/hud";
import { MobileHome, isHomeDemo, DEMO_HOME_VEHICLE, DEMO_HOME_TRIP_COUNT, DEMO_HOME_REMINDER } from "../features/home";
import { maintenanceReminder, toHomeVehicle, type HomeVehicle, type VehicleReadState } from "../features/home/model";
import { MobileTripPage } from "../features/trip/secondary";
import type { VehicleView } from "../features/ownership/types";
import { MobileOwnership } from "../features/ownership";
import { MobileSettings } from "../features/settings";
import { ConfirmDialog } from "../features/confirm";
import { resumeDisposition } from "../features/confirm/decide";
import { MobileBuying } from "../features/buying";
import {
  bookingPrompt,
  DEMO_DIAGNOSIS_MESSAGES_FOLLOWUP,
  DEMO_DIAGNOSIS_MESSAGES_GUIDED,
  DEMO_DIAGNOSIS_REPORT,
  DiagnosisCards,
  MobileCapture,
  MobileDiagnosisReport,
  PromptCards,
  QuickReplies,
  ReportPin,
  diagnosisDemoView,
  loadDiagnosis,
  type DiagnosisState,
} from "../features/service";
import "../features/buying/buying.css";

/** 跨重启复用会话——"重启后历史仍在"的前提。 */
/**
 * 引导的在飞闸（M50-01）。模块级：StrictMode 的两次 effect 合并成一次建会话。
 * 判据与踩过的坑写在 `data/inflight.ts` 的模块注释里。
 */
const sessionInflight = createInflight();

/**
 * 句柄 → 上传时的会话（`data/attachmentSessions.ts`）。模块级：与 `sessionInflight` 同理，
 * StrictMode 的两次挂载共用同一份，重挂载也不该把刚拍的那张照片的归属忘掉。
 */
const attachmentSessions = createAttachmentSessions();

const SESSION_STORAGE_KEY = "carlife.mobile.sessionId";
/** 与 id 成对保存的本地创建时间（M65-02，与车机同款）：只给日志与列表回落用，不改复用判定。 */
const SESSION_META_KEY = "carlife.mobile.sessionMeta";

function rememberSession(sessionId: string, createdAt = Date.now()): void {
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  if (Number.isFinite(createdAt)) {
    localStorage.setItem(SESSION_META_KEY, JSON.stringify({ sessionId, createdAt }));
  } else {
    localStorage.removeItem(SESSION_META_KEY);
  }
}

function forgetSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
  localStorage.removeItem(SESSION_META_KEY);
}

/**
 * 确认弹窗的预览样例（`?hitl=demo`）。
 *
 * 刻意用**试驾预约**：它是 `appointment` 工具的真实形态，
 * `disclosure` 两项与 `enterprise/backend/shared/tools` 的 `describeDisclosure()` 输出逐字一致
 * （含手机号掩码）。形状就是契约 `PermissionRequest`（M65-02）——真实事件与它同型。
 * **演示态没有真实中断点**，按下去只收起、不上行（见渲染处）。
 */
/** 本地日期 `YYYY-MM-DD`（M75-02）：周日历的「今天」按手机的钟，不按 UTC。 */
function localDayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const DEMO_CONFIRM: PermissionRequest = {
  interruptId: "demo-interrupt",
  action: "appointment",
  title: "确认预约试驾？",
  details: [
    { label: "门店", value: "比亚迪深圳南山旗舰店" },
    { label: "时间", value: "2026-09-01 10:00" },
    { label: "车型", value: "汉 EV 2026 款" },
  ],
  scope: null,
  disclosure: [
    { label: "称呼", value: "林先生" },
    { label: "手机号", value: "138****8000" },
  ],
};

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function App() {
  /*
   * 主题跟随系统（M65-00 决策 5），`?theme=` 优先作截图入口。写到文档根：
   * 盖在 App 层的覆盖层（HITL 弹窗）是 `.hud-viewport` 的兄弟节点，不挂根上就取不到深色 token。
   */
  const [theme, setTheme] = useState<ThemeName>(() =>
    resolveTheme(window.location.search, window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false),
  );
  useEffect(() => {
    setRootTheme(document.documentElement, theme);
  }, [theme]);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setTheme(resolveTheme(window.location.search, mq.matches));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const [weather] = useState<WeatherKind>("sunny");
  const [snapshot, setSnapshot] = useState<HudSnapshot | null>(null);
  const [stale, setStale] = useState(false);
  /* `?dialog=demo` / `?buying=demo`：一进来就落在那一页（版式截图入口）。 */
  /** `?diagnosis=demo[&view=report|followup]`：拍照问诊三步的版式截图入口（M104-04）。 */
  const dxDemo = useMemo(() => diagnosisDemoView(), []);
  const [nav, setNav] = useState<NavView>(() => (isDialogDemo() || dxDemo ? "dialog" : "hud"));
  /** 购车页是覆盖层，不占底部导航（M15-05，理由见渲染处）。 */
  const [buyingOpen, setBuyingOpen] = useState(
    () => new URLSearchParams(window.location.search).get("buying") === "demo",
  );
  /*
   * 拍照问诊的报告（M104-04）：每轮助手回复落地后从网关拉一次（结构化，端上不解析回答文本）；
   * 换会话清空。`reportOpen` 是报告页，`followupOpen` 是"基于报告继续问"态（钉顶条 + 快捷芯片）。
   */
  const [diagnosis, setDiagnosis] = useState<DiagnosisState | null>(null);
  const [reportOpen, setReportOpen] = useState(() => dxDemo === "report");
  const [followupOpen, setFollowupOpen] = useState(() => dxDemo === "followup");
  /** 拍照问诊的拍照页（M104-03）：全屏层，不占底导；`?capture=demo` 是版式截图入口。 */
  const [captureOpen, setCaptureOpen] = useState(
    () => new URLSearchParams(window.location.search).get("capture") === "demo",
  );

  // ── 真实行程数据源（M13-04 / M65-01）：Tauri 内轮询网关的已确认行程；浏览器走查维持 mock 源 + `?plan=demo`。
  const [fetchedPlan, setFetchedPlan] = useState<TripPlanSnapshot | null>(null);
  /*
   * 行程列表与核查（M75-02，对齐车机 M72-04 / M73-02）：活动行程 + 每程最新核查，与行程同一次轮询回来。
   * `selectedPlanId` 只在端上记（不落库、不改服务端「当前行程」）；`reviewPlanId` 是打开着摘要的那程；
   * `tripsOpen` 是行程抽屉（清单与翻页在那里，竖屏主页只放得下紧凑卡）。
   */
  const [fetchedEntries, setFetchedEntries] = useState<TripPlanListEntry[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [reviewPlanId, setReviewPlanId] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [tripsOpen, setTripsOpen] = useState(false);
  /** 演示条目里点过「知道了」的（演示数据是静态的，得自己记）。 */
  const [demoAcked, setDemoAcked] = useState<ReadonlySet<string>>(() => new Set());
  /** 行驶中点了带点的那程：不弹，留一句话。 */
  const [tripHint, setTripHint] = useState<string | undefined>(undefined);
  /** 车主常住地（M13-10）：没有行程时 HUD 的地图落点。浏览器没有网关那一路，用 mock 值——否则这一层走查不到。 */
  const [home, setHome] = useState<HomePlace | undefined>(isTauriEnv() ? undefined : MOCK_HOME);
  const [amapFailed, setAmapFailed] = useState(false);
  /*
   * `?plan=demo`（`&nav=1` 附加跟车演示）：浏览器没有 Tauri invoke，这是真实地图标注层能在手机端被走查的
   * 唯一路径。数据与车机 devbar 是**同一份** `DEMO_TRIP_PLAN`（@carlife/ui），名称自带「演示」字样。
   */
  const demoQuery = useMemo(() => new URLSearchParams(window.location.search), []);
  const demoPlan = !isTauriEnv() && demoQuery.get("plan") === "demo";
  const demoNav = demoPlan && demoQuery.get("nav") === "1";
  // 跟车演示的 nav 只挂一次：每次渲染新造一份会让 startedAt 一直往前跑，车标钉在起点一动不动。
  const demoNavPlan = useMemo(() => withDemoNav(DEMO_TRIP_PLAN, 2), []);
  /*
   * 行程规划二级页（M103-02）：2026-09-17 起主页是功能入口页（`features/home`），`MobileHud` 整个是
   * 这一页的内容。`?plan=demo` / `?depart=1` / `?guide=` 这些走查入口看的都是行程页的东西，一进来就打开它。
   */
  const [tripOpen, setTripOpen] = useState(
    () => demoPlan || demoQuery.get("depart") === "1" || Boolean(demoQuery.get("guide")),
  );
  /**
   * 对话页的「请拉起一次选择器」计数（M103-02 加的 prop）。M104-03 起主页卡改开拍照页，
   * 这里没有调用方再递增它——留着是因为 `DialogScreen` 的 prop 还在（车机不传、零副作用）。
   */
  const [pickerRequest] = useState(0);

  const source = useMemo(
    () =>
      isTauriEnv()
        ? createGatewayHudSource({
            base: () => makeSnapshot(weather),
            fetchPlanJson: invokeFetchTripPlan,
            onPlan: setFetchedPlan,
            onHome: setHome,
            // 列表与核查（M75-02）。手机端不做点火播报（总览决策 5）：到达确认靠 alert + 红点 + 弹层。
            onPlans: (entries) => setFetchedEntries(entries),
          })
        : createMockHudSource(weather),
    [weather],
  );
  // appendMessage 里"每轮回复落地刷一次"经 ref 取 source（它挂在 weather 上），不进那个回调的依赖。
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  /*
   * 当前这辆车（M27）：能量读数按它取。真相源在档案页（列表首位＝默认车），
   * HUD 在没进过档案页时也得有能量——所以这里自己解析一次默认车。只在 Tauri 里做：
   * 浏览器没有网关那一路，硬拉只会把环境限制说成设备故障。
   */
  /*
   * M103-02 起整条默认车留住（入口页要 `model` / `odometerKm` / `forecast` / `repairs`），
   * `activeVin` 从它派生。浏览器预览没有网关那一路：`offline`，入口页照纪律写「暂无 / 读不到」，不 mock。
   */
  const [defaultVehicle, setDefaultVehicle] = useState<VehicleView | null>(null);
  const [vehicleState, setVehicleState] = useState<VehicleReadState>(() => (isTauriEnv() ? "loading" : "offline"));
  useEffect(() => {
    if (!isTauriEnv()) return;
    let alive = true;
    void loadVehicles().then((r) => {
      if (!alive) return;
      setVehicleState(r.kind);
      setDefaultVehicle(r.kind === "ready" ? (r.vehicles[0] ?? null) : null);
    });
    return () => {
      alive = false;
    };
  }, []);
  const activeVin = defaultVehicle?.vin ?? null;
  const [liveEnergy, setLiveEnergy] = useState<LiveEnergy | undefined>(demoEnergy);
  /* 能量轮询：换车即重起一路，旧的立刻停——否则切完车还会收到上一辆的读数。 */
  useEffect(() => {
    if (!isTauriEnv()) return;
    const poller = startEnergyPolling(activeVin, setLiveEnergy, { fetchEnergyJson: invokeFetchEnergy });
    return () => poller.stop();
  }, [activeVin]);

  useEffect(
    () =>
      source.subscribe(
        (s) => {
          const problems = validateHudSnapshot(s);
          if (problems.length) console.warn("HUD 快照不满足约束:", problems);
          setSnapshot(s);
          setStale(false);
        },
        // 弱网降级：保留最近有效快照并标记「数据更新中」，**不空白、不全屏遮挡**
        () => setStale(true),
      ),
    [source],
  );

  // 首帧到达前用同源默认快照，避免空白页
  const effective = snapshot ?? makeSnapshot(weather);
  const withEnergy: HudSnapshot =
    liveEnergy === undefined ? effective : { ...effective, energy: { ...effective.energy, live: liveEnergy } };
  const fresh: HudSnapshot = stale
    ? { ...withEnergy, freshness: { stale: true, updatedAt: withEnergy.freshness.updatedAt } }
    : withEnergy;
  // 目的地推荐页（M32-03 走查用）：浏览器里 HUD 快照来自 mock 源，不经 tripPlanToHud，这里补那条缝。
  const demoHighlightsPage = useMemo(
    () => (demoPlan ? highlightsPage(DEMO_TRIP_PLAN.destinationHighlights) : undefined),
    [demoPlan],
  );
  const view: HudSnapshot = demoHighlightsPage
    ? { ...fresh, tips: { ...fresh.tips, pages: [...fresh.tips.pages, demoHighlightsPage] } }
    : fresh;

  // 真实地图报废（无 key/离线）→ 回落装饰概览。memo 化：内联箭头函数会被地图层当成"配置变了"。
  const onTripMapFallback = useCallback(() => setAmapFailed(true), []);
  const plan = demoPlan ? (demoNav ? demoNavPlan : DEMO_TRIP_PLAN) : fetchedPlan;
  /*
   * 跟车（M31-03）：判据在 `@carlife/shared`（`tripPlanNavDay`）。手机端**没有位置源**，
   * 车标位置与车机同一套"按真实路线与车程模拟"（nav-position.ts），倍速恒为 1——
   * 真实 GPS 跟车不在本 Sprint（M65-00 约束 4）。跟车时只看当天那一段。
   */
  const navDay = plan ? tripPlanNavDay(plan, new Date().toISOString()) : undefined;
  const viewDay = navDay;
  const tripStops = useMemo(() => (plan ? tripPlanStops(plan, viewDay) : []), [plan, viewDay]);

  /*
   * 列表条目（M75-02）：真实数据来自轮询；浏览器 `?plan=demo` 用 `@carlife/ui` 的 7 程演示
   * （紧凑卡 / 抽屉 / 弹层能在浏览器里被走查的唯一路径）。演示条目点过「知道了」的在本地打上 ackedAt。
   */
  const tripEntries: TripPlanListEntry[] = useMemo(() => {
    if (!demoPlan) return fetchedEntries;
    return DEMO_TRIP_ENTRIES.map((e) =>
      e.review && demoAcked.has(e.review.reviewId)
        ? { ...e, review: { ...e.review, ackedAt: new Date().toISOString() } }
        : e,
    );
  }, [demoPlan, fetchedEntries, demoAcked]);
  /** 选中的那程：不回落到当前行程——有选中才是选中态（与车机 M73-02 同）。 */
  const highlightedPlanId =
    selectedPlanId && tripEntries.some((e) => e.planId === selectedPlanId) ? selectedPlanId : undefined;
  /*
   * 行程模式判定（判据在 `@carlife/ui` 的 `tripActiveFor`，与车机同一份）。
   * 排在 `highlightedPlanId` 之后是因为它要知道"这一程是不是车主自己点开的"：
   * 点开的那程即使已经走完也照画（2026-09-16 走查）。
   */
  const tripActive = tripActiveFor({
    plan,
    amapFailed,
    today: new Date().toISOString().slice(0, 10),
    selected: highlightedPlanId !== undefined,
  });
  const reviewEntry = reviewPlanId ? tripEntries.find((e) => e.planId === reviewPlanId) : undefined;
  /** 暖暖 alert：critical 且未确认、未作废（「知道了」即清除）。 */
  const hudAlert = hudAlertFrom(tripEntries);

  const onSelectTrip = useCallback(
    (planId: string) => {
      setSelectedPlanId(planId);
      setTripsOpen(false);
      if ("select" in source) (source as GatewayHudSource).select(planId);
    },
    [source],
  );
  /** 顶部日期条的 ×：回未选中态——紧凑卡回来、提示卡收起、地图回到列表首条。 */
  const onClearTripSelection = useCallback(() => {
    setSelectedPlanId(null);
    if ("select" in source) (source as GatewayHudSource).select(null);
  }, [source]);
  const onOpenTripReview = useCallback(
    (planId: string) => {
      if (navDay !== undefined) {
        // 行驶中不弹模态（Brief §2 / F-19-07）：留一句话，停车再看。
        setTripHint("停车后再看行程变化");
        window.setTimeout(() => setTripHint(undefined), 4000);
        return;
      }
      setTripsOpen(false);
      setReviewPlanId(planId);
    },
    [navDay],
  );

  const sessionIdRef = useRef<string | null>(null);
  const openGuideRef = useRef<((spot: string) => void) | null>(null);
  /**
   * 当前会话 id 的**可渲染副本**（M28-01 / M65-02）。
   * ref 供回调里同步读（`sendText` 那些地方拿的必须是最新值），state 供渲染（列表高亮）。
   * **两处必须一起改**——只在下面几个"接管会话"的函数里改。
   */
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [serverAvatarState, setServerAvatarState] = useState<AssistantState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamingTurn | null>(null);
  /** 工具进展（F-08-05）：填等待，**不进历史**，轮次收口即清。 */
  const toolProgress = useToolProgress();
  /**
   * 分支失败的"部分结果"标识（M37-01；M65-02 手机端接上）。与工具进展不同：
   * **不在本轮收口时清**——横幅标注的是"这轮答案缺了什么"，要跟着答案一起被读；
   * 清理时机是下一轮开始，以及换会话（下面这个 effect）。
   */
  const branchFaults = useBranchFaults();
  useEffect(() => {
    branchFaults.reset();
  }, [currentSessionId, branchFaults.reset]);
  const [connection, setConnection] = useState<"online" | "reconnecting" | "unknown">("unknown");
  /**
   * 哨兵指示快照（M60-01）：唯一来源是 Rust `voice:sentinel` 事件。
   * null = 事件还没来（哨兵未启动 / 浏览器走查），此时设置页那一组不渲染。
   */
  const [sentinelInd, setSentinelInd] = useState<SentinelIndication | null>(null);
  /**
   * 唤醒态到期时刻（ms）。喊了「暖暖」之后的聆听窗口里，助手形象要亮起来
   * ——手机端没有本地播报，**这是唯一的"我听见了"反馈**。0 = 不在窗口内。
   */
  const [wakeUntil, setWakeUntil] = useState(0);
  /**
   * HITL 确认请求（M65-02，F-04-08）。真实来源是网关 SSE `permission` 事件，
   * 经 Rust `events.rs` 转 `dialog:permission` 桥接事件到这里；真实中断始终优先于演示。
   * `?hitl=demo` 是版式预览入口：演示态没有真实中断点，按下去只收起。
   */
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  /** resume 没被接住时的告知文案——**不能静默收起**，见 decidePermission。 */
  const [permissionNotice, setPermissionNotice] = useState<string | undefined>(undefined);
  const [demoPermission, setDemoPermission] = useState(
    () => new URLSearchParams(window.location.search).get("hitl") === "demo",
  );
  /**
   * 会话生命周期（M22-03；M65-02 手机端对齐）。`lastInteractionAt` 只驱动**端上判定**——
   * 正确性由服务端兜（过期的会话 `POST /messages` 直接 409，下面 `sendText` 会换会话重发）。
   */
  const [lastInteractionAtState, setLastInteractionAtState] = useState<number | undefined>(undefined);
  /**
   * 判定用的**同步副本**（2026-09-18 真机 INC：拍照问诊「上传失败 attachment_not_owned」）。
   *
   * `ensureUsableSession` 会在同一个闭包里被连着调两次——先上传附件、紧接着发消息——
   * 而 `useCallback` 捕的是那一拍的 state：上传那一步刚建好的会话，在第二次调用里又被
   * 老的 `lastInteractionAt` 判成"该退休"，于是消息落到**另一段**会话，句柄按归属被网关
   * 400 拒收（实测 02:23:36.431 上传进 sess-82141ba8，18 ms 后又建了 sess-a911010f）。
   * 所以退休判定读 ref 不读 state；两者必须一起改，走下面这个 setter。
   */
  const lastInteractionRef = useRef<number | undefined>(undefined);
  const lastInteractionAt = lastInteractionAtState;
  const setLastInteractionAt = useCallback((ts: number | undefined) => {
    lastInteractionRef.current = ts;
    setLastInteractionAtState(ts);
  }, []);
  // 30 秒一跳只驱动**形象**（休息/办公）：比每秒重渲染整屏 HUD 划算得多。
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /*
   * 会话历史（M28-01；M65-02 手机端接上）。懒加载一次 20 条。
   * **列表是服务端那份的投影，不是端上另攒的一份**：不在这里插入/删除会话，只在换会话时整页重拉。
   */
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  /**
   * 正在回看的历史会话。`null` = 在看当前会话。回看**不碰会话所有权**：不换 localStorage、
   * 不切流、不动哨兵绑定——碰了的话，翻一眼旧对话就把语音唤醒指向了一个已关闭的会话。
   */
  const [viewing, setViewing] = useState<{ sessionId: string; messages: ChatMessage[] } | null>(
    null,
  );

  // 窗口到点自己熄灭。用一次性定时器而不是轮询：窗口是秒级的一次性许可，
  // 为它挂一个常驻 tick 不划算。
  useEffect(() => {
    const left = wakeUntil - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setWakeUntil(0), left);
    return () => clearTimeout(timer);
  }, [wakeUntil]);

  /** 拉一页会话。`reset` 时从头拉并丢掉游标（换会话 / 首次进入）。 */
  const loadSessions = useCallback(
    async (reset: boolean) => {
      if (!isTauriEnv()) return;
      setSessionsLoading(true);
      setSessionsError(null);
      try {
        const cursor = reset ? null : sessionsCursor;
        const raw = await invoke<string>("list_sessions", {
          limit: 20,
          cursor: cursor ?? undefined,
        });
        const page = JSON.parse(raw) as {
          sessions: SessionBrief[];
          hasMore: boolean;
          nextCursor: string | null;
        };
        setSessions((prev) => {
          if (reset) return page.sessions;
          // 去重：`updatedAt` 游标遇上同毫秒的两条会话时，第二页会重发一条。
          const seen = new Set(prev.map((x) => x.sessionId));
          return [...prev, ...page.sessions.filter((x) => !seen.has(x.sessionId))];
        });
        setSessionsCursor(page.nextCursor);
        setSessionsHasMore(page.hasMore);
      } catch (err) {
        setSessionsError("会话历史读取失败");
        console.warn("[session] 会话列表拉取失败", err);
      } finally {
        setSessionsLoading(false);
      }
    },
    [sessionsCursor],
  );
  // 引导与建会话要用它，但它的 deps 里有游标——经 ref 递最新的那一份，不让引导 effect 每翻一页重跑。
  const loadSessionsRef = useRef(loadSessions);
  useEffect(() => {
    loadSessionsRef.current = loadSessions;
  }, [loadSessions]);

  /**
   * 建一个新会话并接管：写 localStorage、起流、清空当前消息列表。
   * **历史不删**——服务端那份还在，列表里仍能翻阅。
   */
  const doStartNewSession = useCallback(async (): Promise<string> => {
    const sid = await invoke<string>("create_session");
    rememberSession(sid);
    sessionIdRef.current = sid;
    setCurrentSessionId(sid);
    setViewing(null);
    setMessages([]);
    setStreaming(null);
    setLastInteractionAt(undefined);
    await invoke("start_session_stream", { sessionId: sid });
    // 哨兵跟上这段对话（M60-01）：不绑的话，打字建的会话里喊「暖暖」
    // 会被 Rust 当成"还没有会话"，于是又建一个——同一次对话裂成两段。
    invoke("sentinel_bind_session", { sessionId: sid }).catch(() => {});
    void loadSessionsRef.current?.(true);
    return sid;
  }, []);

  /** 对外的"新建会话"：**并发的两次合并成一次**（M50-01）。 */
  const startNewSession = useCallback(
    (): Promise<string> => sessionInflight.run(INFLIGHT_NEW_SESSION, doStartNewSession),
    [doStartNewSession],
  );

  /**
   * 拿一个此刻能用的会话：没有就**现在**建，该退休就先换一个（M50-02 / M22-03）。
   * 引导不再预建会话，所以"还没有会话"是启动后的常态；建会话推到这里，
   * 因为这条路建完立刻就发消息——它从不留下零消息的空会话。
   */
  const ensureUsableSession = useCallback(async (opts?: { keep?: string }): Promise<string> => {
    const sid = sessionIdRef.current;
    /*
     * `keep` = 刚才把附件上传进去的那个会话（模块级的 `attachmentSessions` 记的账）。附件句柄**按会话归属**，
     * 换一个会话发就等于把车主刚拍的照片丢掉（网关 400 `attachment_not_owned`）。
     * 刚上传完本身就是一次交互，这里不该再走退休判定。
     */
    if (opts?.keep && opts.keep === sid) return sid;
    if (!sid) return startNewSession();
    const retire = canRetire({
      // 读 ref 不读 state：同一拍里连着调两次时，state 还是上一拍的值（见 `lastInteractionRef`）。
      lastInteractionAt: lastInteractionRef.current,
      now: Date.now(),
      streaming: streaming !== null,
      awaitingPermission: permission !== null,
    });
    return retire ? startNewSession() : sid;
  }, [streaming, permission, startNewSession]);

  /**
   * 结束当前这段对话：关掉它（可选）、把端上的会话位置空，**不预建下一个**（M50-02）。
   * 两个入口（HUD 的「退下」、语音口令退下）共用这一条。`close_session` 是软关闭，历史仍在。
   */
  const endCurrentSession = useCallback(async (opts: { close: boolean }) => {
    const sid = sessionIdRef.current;
    if (sid && opts.close) {
      try {
        await invoke("close_session", { sessionId: sid });
      } catch (err) {
        // 关不上不该挡住"我要收尾"这个诉求：端上照样收尾，旧的留给服务端的空闲判定收。
        console.warn("[session] 关闭旧会话失败，端上仍然收尾", err);
      }
    }
    sessionIdRef.current = null;
    forgetSession();
    setCurrentSessionId(null);
    setViewing(null);
    setMessages([]);
    setStreaming(null);
    setLastInteractionAt(undefined);
    void loadSessionsRef.current?.(true);
  }, []);
  /** 车主点「退下」：关掉这段对话并收尾（M22-03；M65-01 手机端接上）。 */
  const dismissAssistant = useCallback(
    () => endCurrentSession({ close: true }),
    [endCurrentSession],
  );
  // 语音口令「退下」经桥接事件回来，而那个订阅挂在只跑一次的大 effect 里——经 ref 取最新版。
  const endCurrentSessionRef = useRef(endCurrentSession);
  endCurrentSessionRef.current = endCurrentSession;

  /**
   * 收编 Rust 侧新建的会话（M60-01）。
   *
   * 唤醒指令到达时前端可能还没有会话（懒建），或原会话已过期——两种情况
   * Rust 都会现建一个再发，然后经 `SessionAdopted` 事件把 id 交回来。
   * **切流与 localStorage 归前端**：Rust 不碰这两样，所以不收编的后果是
   * 指令送出去了、回复走的是另一路流，屏幕上什么都不出现。
   */
  const adoptSession = useCallback(async (sessionId: string) => {
    rememberSession(sessionId);
    sessionIdRef.current = sessionId;
    setCurrentSessionId(sessionId);
    setViewing(null);
    setMessages([]);
    setStreaming(null);
    setLastInteractionAt(Date.now());
    try {
      await invoke("start_session_stream", { sessionId });
      // 收编也要让哨兵跟上；否则下一次免手指令仍会打到旧会话。
      invoke("sentinel_bind_session", { sessionId }).catch(() => {});
      const history = await invoke<ChatMessage[]>("refresh_history", { sessionId }).catch(
        () => invoke<ChatMessage[]>("read_cached_messages", { sessionId }),
      );
      setMessages(history);
    } catch (err) {
      console.warn("[sentinel] 收编新会话失败", err);
    }
  }, []);

  /**
   * 点开列表里的一条会话（M28-01）。两条路，判据是"服务端还收不收这条会话的消息"
   * （`sessionResumable`，与网关 `checkSessionUsable` 同一条）：还能接着说 → 把会话所有权
   * 切过去；已经结束 → **只回看**，一个都不换。
   */
  const openSession = useCallback(async (row: SessionBrief) => {
    if (row.sessionId === sessionIdRef.current) {
      setViewing(null);
      return;
    }
    let history: ChatMessage[] = [];
    try {
      history = await invoke<ChatMessage[]>("refresh_history", { sessionId: row.sessionId });
    } catch (err) {
      // 拉不到就什么都不做——**不要半切**：切了流却没有历史，看起来像这条会话的记录丢了。
      console.warn("[session] 历史读取失败，保持原状", err);
      setSessionsError("这段对话读不出来");
      return;
    }
    if (!sessionResumable(row, Date.now())) {
      setViewing({ sessionId: row.sessionId, messages: history });
      return;
    }
    // 接着聊：与 `adoptSession` 同一套动作，**顺序照抄**——先落存储与 ref，再起流、再绑哨兵。
    rememberSession(row.sessionId, Date.parse(row.createdAt));
    sessionIdRef.current = row.sessionId;
    setCurrentSessionId(row.sessionId);
    setViewing(null);
    setStreaming(null);
    setMessages(history);
    setLastInteractionAt(history[history.length - 1]?.ts);
    try {
      await invoke("start_session_stream", { sessionId: row.sessionId });
      invoke("sentinel_bind_session", { sessionId: row.sessionId }).catch(() => {});
    } catch (err) {
      console.warn("[session] 切换会话时起流失败", err);
    }
  }, []);
  const exitViewing = useCallback(() => setViewing(null), []);
  const onSelectSession = useCallback((row: SessionBrief) => void openSession(row), [openSession]);
  const onLoadMoreSessions = useCallback(() => void loadSessionsRef.current?.(false), []);
  /**
   * 「新建对话」：**不建会话，只是把手上这段放下**（M50-02）——真正的新会话在下一句话时现建。
   * 也**不关旧会话**：旧的留在列表里还能接着聊，关不关交给服务端的空闲判定。
   */
  const onNewSession = useCallback(
    () => endCurrentSession({ close: false }),
    [endCurrentSession],
  );

  /**
   * 发文字消息。过期（409 `SESSION_EXPIRED`）→ 换一个会话重发，不把车主的话丢掉；
   * 处置在 `data/sendWithRetry.ts`（纯函数、有单测）。**不做本地乐观插入**：用户消息与
   * 助手回复都由 SSE 回流。
   */
  const sendText = useCallback(
    async (content: string, attachments?: string[], detections?: Record<string, ClientDetections>) => {
      setLastInteractionAt(Date.now());
      await sendWithSessionRetry({
        // 带附件时把会话钉在上传的那一段（`data/attachmentSessions.ts`），不让退休判定把它换掉。
        ensure: () => ensureUsableSession({ keep: attachmentSessions.sessionFor(attachments) }),
        // 附件句柄随消息绑到本轮（M80-03）；句柄属于上传时的那个会话——会话过期换新会话重发时，
        // 老会话的句柄会被网关按归属拒绝（400 attachment_not_owned），那时让用户重选，不静默丢。
        // 端上框灯的结果（ACR-046）随句柄一起上行；服务端对带框的照片不再框图
        send: (sessionId, text) =>
          invoke("send_text_message", { sessionId, content: text, ...(attachments?.length ? { attachments } : {}), ...(detections ? { detections } : {}) }),
        startNew: startNewSession,
        isExpired: (err) => String(err).includes(SESSION_EXPIRED),
        content,
      });
    },
    [ensureUsableSession, startNewSession],
  );
  /*
   * 附件通路（M80-03，F-09-07 / F-09-09）。**字节走 Rust**：令牌不进 WebView（§2.2 C2），
   * 上传与取件都是 Tauri 命令。上传用 raw IPC（Uint8Array + 请求头），一段 40 MB 的视频不必先变成 JSON 数组；
   * 取件回 ArrayBuffer 再包成 Blob，交给 `<img>` / `<video>` 的 blob URL。浏览器 mock 环境没有这一路。
   */
  /*
   * 报告的拉取时机（M104-04）：最后一条消息是助手的 = 这一轮结束了，问一次网关有没有报告。
   * 3~6 ms 的只读端点，不做增量判断；换会话先清空——上一段的报告不该挂在新会话上。
   */
  const diagnosisSessionRef = useRef(currentSessionId);
  useEffect(() => {
    // 只在会话**真的换了**时清（挂载那一拍不算——`?diagnosis=demo&view=followup` 的初值要留住）。
    if (diagnosisSessionRef.current === currentSessionId) return;
    diagnosisSessionRef.current = currentSessionId;
    setDiagnosis(null);
    setFollowupOpen(false);
  }, [currentSessionId]);
  useEffect(() => {
    if (!isTauriEnv()) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    let alive = true;
    void loadDiagnosis(currentSessionId).then((s) => {
      if (alive) setDiagnosis(s);
    });
    return () => {
      alive = false;
    };
  }, [messages, currentSessionId]);

  const attachmentsPort = useMemo(
    () =>
      isTauriEnv()
        ? {
            upload: async (file: File): Promise<AttachmentRef> => {
              const sessionId = await ensureUsableSession();
              const bytes = new Uint8Array(await file.arrayBuffer());
              /*
               * 请求头一律先编码成 ASCII（M80-04）：Tauri 的 IPC 是 `new Headers(...)`，
               * 中文文件名会让整次 invoke 当场抛 `TypeError: Type error`，请求根本发不出去。
               * 编码与幂等键的拼法在 `data/attachmentUpload.ts`（纯函数、有单测）。
               */
              const headers = buildUploadHeaders({ sessionId, file });
              const r = await invoke<{ handle: string; kind: AttachmentKind; bytes: number }>("upload_attachment", bytes, { headers });
              // 句柄属于**这一个**会话；发消息时按它钉住，别让退休判定换掉（见 attachmentSessions）。
              attachmentSessions.remember(r.handle, sessionId);
              return {
                attachmentId: r.handle,
                kind: r.kind,
                handle: r.handle,
                // 落库的是网关按魔数纠正后的 MIME；端上这份只用于本地渲染，取归一化后的值。
                contentType: headers["content-type"],
                bytes: r.bytes,
                filename: file.name,
              };
            },
            load: async (ref: AttachmentRef): Promise<Blob> => {
              const buf = await invoke<ArrayBuffer>("fetch_attachment", { handle: ref.handle });
              return new Blob([buf], { type: ref.contentType ?? "application/octet-stream" });
            },
            // 端上框灯（ACR-044）：字节进 Rust、框出；不出端。开关在对话层。
            detect: async (file: File): Promise<OnDeviceDetectResult> => {
              const bytes = new Uint8Array(await file.arrayBuffer());
              return invoke<OnDeviceDetectResult>("vision_detect", bytes, { headers: { "content-type": file.type || "application/octet-stream" } });
            },
          }
        : undefined,
    [ensureUsableSession],
  );
  // 「结束导航」与到站播报走**同一条语音链路**而不是直调工具（与车机同一条纪律）。经 ref 取最新版。
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;
  const onNavEnd = useCallback(() => {
    if (isTauriEnv()) void sendTextRef.current("结束导航");
  }, []);
  /*
   * 到站播报（M31-03）：手机端没有 TTS，"播报"落成一条助手回复气泡。
   * 去重 + 在飞闸在 `@carlife/ui` 的 `createArrivalAnnouncer`（两端共用、有单测）。
   */
  const announcer = useMemo(
    () => createArrivalAnnouncer((note) => (isTauriEnv() ? sendTextRef.current(note) : Promise.resolve())),
    [],
  );
  const onNavProgress = useCallback((p: NavTripProgress) => announcer.onProgress(p), [announcer]);

  /*
   * 景区导览页（M36-04）。入口两处：
   *  1. HUD 时间轴节点点击（组织入口）——当前 HUD 是 mock 行程，节点名是
   *     演示地名；点它发的是**真实采集**，中间态如实（工单约束 1 已裁定可接受）；
   *  2. `?guide=普陀山` 演示入口（`?hitl=demo` 同款先例）：真实景区名的
   *     完整链路走查靠它，不必先等手机端接上真实行程数据。
   *
   * 这一段原来在 tripMap 之后几百行处、经 openGuideRef 反向取（2026-09-02 前移）：
   * 导览就绪的角标要进 tripMap，而 tripMap 算在下面，所以整段挪到它前面。ref 仍留着——
   * 时间轴点击那条路没改。
   */
  const { guide, open: openGuide, close: closeGuide } = useGuideBrief();
  openGuideRef.current = openGuide;
  useEffect(() => {
    const spot = new URLSearchParams(window.location.search).get("guide");
    /*
     * ⚠️ `?guide=demo` 是**版式截图入口**（`isGuideDemo()`，见 useGuideBrief 的初值），
     * 不是一个叫「demo」的景点。不排除的话这条深链会立刻拿这个哨兵去发真实请求，
     * 把演示态顶掉，页面变成「这次没有查到 demo 的导览资料」——两个 query 撞了名字。
     */
    if (spot && !isGuideDemo()) openGuide(spot);
  }, [openGuide]);

  // 导览采集进度（M40-03）：面板可见（HUD 层、导览页关着）才拉才轮。
  const guideJobs = useGuideJobs(nav === "hud" && !guide);
  /*
   * 采集完成标记（2026-09-02，对齐车机 93b74d41 / 63fe9e93）——同一份服务端账本的两半：
   *  - 底部折叠条只挂"还欠着的"：ready 的行采完即从条上消失，全采完整条收掉。
   *    它是待办条不是索引；summary 不动，标题里的 x/N 照旧是账本数字。
   *  - 索引的那一半：ready 的景点在地图胶囊上挂「✓ 导览」角标（AmapTripLayer.guidedSpots）。
   *    条上撤掉了，标记上就得标出来——否则用户只能挨个点开试哪个有导览。
   */
  const guideJobsOutstanding = useMemo(
    () => (guideJobs.jobs ? outstandingGuideJobs(guideJobs.jobs) : null),
    [guideJobs.jobs],
  );
  const guidedSpots = useMemo(() => readyGuideSpots(guideJobs.jobs), [guideJobs.jobs]);

  /*
   * 「开始行程」（2026-09-02，对齐车机 M66-04 的出发卡；M65-01 表第 31 项记的去向）。
   * `?depart=1` 是浏览器走查入口（`?plan=demo&depart=1` 能看到整张卡；与 `?guide=` 同款先例）。
   */
  const [departOpen, setDepartOpen] = useState(() => demoQuery.get("depart") === "1");

  const tripMap: HudTripMapProps | undefined =
    tripActive && plan
      ? {
          stops: tripStops,
          onStopClick: (stop) => openGuideRef.current?.(stop.name),
          // 导览已就绪的景点挂角标——点之前就知道哪些能看。
          guidedSpots,
          ...(navDay !== undefined
            ? {
                nav: {
                  key: `${plan.updatedTurnId}:${navDay}:${plan.nav?.startedAt ?? ""}`,
                  speedup: 1,
                  onProgress: onNavProgress,
                  onEnd: onNavEnd,
                },
              }
            : {}),
          planKey: plan.updatedTurnId,
          showDayBadge: viewDay === undefined,
          // 单日视图闭环；**跟车时不闭环**（车不会在到达最后一站之后自己开回酒店）。
          closeLoop: viewDay !== undefined && navDay === undefined,
          // 顶部逐日胶囊暂时隐藏（M13-09 走查裁定，与车机同）；链路保留。
          tabs: [],
          active: "all",
          onSelect: () => {},
          onFallback: onTripMapFallback,
          lodgingNotes: plan.skeleton
            .filter((d) => d.lodging)
            .map((d) => ({ day: d.day, strategy: d.lodging!.strategy, note: d.lodging!.note })),
        }
      : undefined;

  /**
   * 系统麦克风授权现状（走查 2026-08-29 ②）。null = 还没查到。
   * 不是 granted 时暖暖挂文字说明——不然新设备上长按毫无反应，没人知道缺权限。
   */
  const [micPermission, setMicPermission] = useState<
    "granted" | "denied" | "undetermined" | null
  >(null);
  const refreshMicPermission = useCallback(async () => {
    if (!isTauriEnv()) return;
    try {
      const status = await invoke<string>("mic_permission_status");
      setMicPermission(status as "granted" | "denied" | "undetermined");
    } catch {
      /* 查不到不挂说明 */
    }
  }, []);
  useEffect(() => {
    void refreshMicPermission();
  }, [refreshMicPermission]);

  /*
   * `voice` 的 useMemo 依赖是空数组（它只在挂载时决定走真实还是 mock），
   * 直接闭包捕获 `ensureUsableSession` 会捕到第一版——经 ref 取，与车机端同一形态。
   */
  const ensureSessionRef = useRef(ensureUsableSession);
  ensureSessionRef.current = ensureUsableSession;

  /**
   * 长按说话接真实录音命令（走查 2026-08-29 ②）。
   * A3 时代 Rust 命令就在，但这里一直挂的是 mockVoicePort——长按只演状态机，
   * 根本到不了 Rust 的权限门，"未授权拉起授权"无从谈起。
   */
  const voice = useMemo<AssistantVoicePort>(
    () =>
      isTauriEnv()
        ? {
            async startPushToTalk() {
              await invoke("start_push_to_talk");
            },
            async stopPushToTalk() {
              /*
               * **说了话就现建会话**（M50-02）。原先没有会话就把这段录音丢掉，
               * 那在"引导不再预建"之后会变成启动后第一句话必丢。
               * 建不出来才走原来的丢弃路径——仍要停止采集，否则麦克风不释放。
               */
              let sid: string;
              try {
                sid = await ensureSessionRef.current();
              } catch (err) {
                console.warn("[voice] 建会话失败，丢弃本段录音", err);
                await invoke("stop_push_to_talk", { sessionId: "sess-none" }).catch(() => {});
                return;
              }
              await invoke("stop_push_to_talk", { sessionId: sid });
            },
          }
        : mockVoicePort,
    [],
  );

  const appendMessage = useCallback((m: ChatMessage) => {
    setMessages((prev) => (prev.some((x) => x.messageId === m.messageId) ? prev : [...prev, m]));
    // 新一轮从用户这条消息开始：上一轮的"部分结果"横幅到此为止（M37-01）。
    if (m.role === "user") branchFaults.reset();
    // 用户说的与助手回的**都算交互**（D1 定的是"空闲 30 分钟"，不是"两次发言间隔"）。
    setLastInteractionAt(Date.now());
    // 助手完整回复到达 → 该轮流式气泡结束
    if (m.role === "assistant") {
      setStreaming((s) => (s && s.turnId === m.turnId ? null : s));
      // 本轮收口：进展一律清掉。分支超时那一路的完成事件根本不会来，
      // 留着就是一句永远挂在那的"正在查天气"。
      toolProgress.reset();
      // 本轮已经收官还挂着弹窗 = 服务端那头已收敛（超时按"未确认=不执行"）——
      // 留着它用户按下去也只会得到 not_waiting，收起（与车机 App.tsx 同一条）。
      setPermission(null);
      /*
       * 行程状态可能刚被这轮对话改掉（M28-02）："取消/改期"不弹确认层，没有任何刷新触发器，
       * HUD 只能等 60s 轮询的下一拍。所以每轮回复落地都刷一次；接口实测 3~6ms。
       */
      const src = sourceRef.current;
      if ("refresh" in src) (src as GatewayHudSource).refresh();
    }
    /*
     * 依赖只挂两个 `reset`（稳定引用），不挂整个 hook 返回值——车机 M28-01 的事故：
     * 本回调换身份会让下面那个订阅 + bootstrap 的大 effect 整段重跑，直至 WebView 白屏。
     */
  }, [toolProgress.reset, branchFaults.reset]);

  /**
   * HITL 裁决上行（M65-02，F-04-08）。三种结果的处置在 `features/confirm/decide.ts`
   * （纯函数、有单测）：只有服务端真接住了才收弹层；`resumed:false` 与网络失败
   * 都改成告知态——原先这里是一行 `console.warn` 然后收窗，那是假成功（M65-00 决策 3）。
   */
  const decidePermission = useCallback(
    async (approved: boolean) => {
      const sid = sessionIdRef.current;
      if (!sid || !permission) return;
      setPermissionBusy(true);
      let disposition;
      try {
        const accepted = await invoke<boolean>("resume_interrupt", {
          sessionId: sid,
          interruptId: permission.interruptId,
          approved,
        });
        disposition = resumeDisposition({ kind: accepted ? "accepted" : "not_waiting" });
      } catch (err) {
        console.warn("[hitl] resume 发送失败", err);
        disposition = resumeDisposition({ kind: "failed" });
      } finally {
        setPermissionBusy(false);
      }
      if (!disposition.close) {
        setPermissionNotice(disposition.notice);
        return;
      }
      setPermission(null);
      setPermissionNotice(undefined);
      // 确认动作大概率改变了行程状态（confirm/cancel）——立即刷 HUD，不等轮询。
      if (approved && "refresh" in source) (source as GatewayHudSource).refresh();
    },
    [permission, source],
  );

  /*
   * 账号级事件 → 整拉会话列表（ACR-033）。
   *
   * **回看态下照样重拉**：列表与「正在看哪一段」是两件事。回看时不刷新的话，
   * 车主翻着旧对话、车机上新聊的那段始终不出现，而他会以为是回看态的毛病。
   * 整拉而不是把那一条插进去：通道的语义就是整拉，端上自作增量会把乱序引回来。
   */
  useEffect(() => {
    if (!isTauriEnv()) return;
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen<{ reason: string }>(ACCOUNT_EVENTS.sessionsChanged, (e) => {
      console.info(`[session] 别处改了会话列表（${e.payload.reason}），重拉一次`);
      void loadSessionsRef.current?.(true);
    })
      .then((un) => {
        if (disposed) un();
        else stop = un;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriEnv()) return;
    let cleanup: (() => void) | undefined;

    void subscribeBridge({
      onAssistantState: setServerAvatarState,
      onDelta: (d) =>
        setStreaming((prev) =>
          prev && prev.turnId === d.turnId
            ? { turnId: d.turnId, text: prev.text + d.text }
            : { turnId: d.turnId, text: d.text },
        ),
      onMessage: appendMessage,
      onToolCall: toolProgress.onToolCall,
      onConnection: (c) => setConnection(c.state),
      // HITL 权限请求（M65-02）：真实中断始终优先于 `?hitl=demo` 的演示样例。
      onPermission: (p) => setPermission(p),
      // 分支起止（M37-01）：failed/timeout 聚合成"部分结果"横幅的数据源。
      onBranch: branchFaults.onBranch,
      /*
       * 会话标题（M28-01）。事件走的是**当前会话**那一路 SSE，归属就是 `sessionIdRef.current`。
       * 就地改那一行，不整页重拉（重拉会把列表滚动位置弹回顶部）；列表里还没有这一条时补一条占位。
       */
      onSessionTitle: (t) => {
        const sid = sessionIdRef.current;
        if (!sid) return;
        setSessions((prev) => {
          if (prev.some((x) => x.sessionId === sid)) {
            return prev.map((x) => (x.sessionId === sid ? { ...x, title: t.title } : x));
          }
          const now = new Date().toISOString();
          return [
            { sessionId: sid, title: t.title, createdAt: now, updatedAt: now, closedAt: null, messageCount: 0 },
            ...prev,
          ];
        });
      },
      // 采集状态（走查 2026-08-29 ②）：真录上说明权限到手；权限失败就重查。
      onCaptureStatus: (s) => {
        if (s.kind === "started") setMicPermission("granted");
        else if (s.kind === "failed" && s.reason.startsWith("permission_denied")) {
          void refreshMicPermission();
        }
      },
      /*
       * 唤醒状态（M60-01）。窗口时长与 Rust 侧 `WindowConfig` 默认值镜像
       * （聆听 10s），各 +500ms 余量：两边各自计时，端上先熄的话会出现
       * "屏幕已经不听了、其实还在听"，那比多亮半秒难解释得多。
       */
      onWakeStatus: (w) => {
        switch (w.kind) {
          case "woken":
            setWakeUntil(Date.now() + 10_500);
            break;
          case "listening_window":
            setWakeUntil(w.open ? Date.now() + 10_500 : 0);
            break;
          case "session_adopted":
            void adoptSession(w.session_id);
            break;
          case "dismissed":
            /*
             * 服务端已软关闭。端上走与「退下」按钮相同的收尾（不再 close 一次，
             * 也**不预建下一个**——下一句话由 `ensureUsableSession` 现建，M50-02）。
             */
            setWakeUntil(0);
            void endCurrentSessionRef
              .current?.({ close: false })
              .catch((err) => console.warn("[sentinel] 退下收尾失败", err));
            break;
          case "followup_window":
          case "sentinel_degraded":
            // 追问窗口挂在播报结束上，手机端没有本地播报，恒不开；
            // 降级状态走 voice:sentinel 快照，这里不重复处理。
            break;
          case "sidecar_switched":
            // 闲聊旁路是车机端的偏好，手机端没有对应开关。
            break;
        }
      },
      onSentinelStatus: (s) => setSentinelInd(s),
    }).then((un) => {
      cleanup = un;
    });

    const bootstrap = async () => {
      /*
       * 先试复用上次会话：权威历史可回源即有效。判定在 `data/bootstrapSession.ts`
       * （纯函数，可单测）——**它只会给出"接着用"或"手上没有会话"**。
       */
      const stored = localStorage.getItem(SESSION_STORAGE_KEY);
      const history = stored
        ? await invoke<ChatMessage[]>("refresh_history", { sessionId: stored }).catch(() => null)
        : null;
      const plan = planBootstrap({ stored, history });
      let sid: string | null = null;
      if (plan.kind === "resume") {
        sid = plan.sessionId;
        setMessages(history ?? []);
        setLastInteractionAt(history?.[history.length - 1]?.ts);
      } else {
        console.info(`[session] 不复用上次会话（${plan.reason}）`);
      }
      /*
       * **引导只复用，不新建**（M50-02）。
       *
       * 这里原先是"复用不了就 `create_session`"，于是开机即建：启动后没说话
       * 就留下一个零消息会话，而服务端是懒关闭（没人再访问它就永远不落 `closed_at`），
       * 它会一直显示成活着的会话。建会话统一交给发送侧——它建完立刻就发。
       */
      if (!sid) {
        console.info("[session] 没有可复用的会话——等第一句话再建");
        sessionIdRef.current = null;
        setCurrentSessionId(null);
        setMessages([]);
      } else {
        sessionIdRef.current = sid;
        setCurrentSessionId(sid);
        await invoke("start_session_stream", { sessionId: sid });
        // 哨兵跟上这段对话（M60-01）。没有会话时不绑——见下面 sentinel_start 的说明。
        invoke("sentinel_bind_session", { sessionId: sid }).catch(() => {});
      }
      /*
       * 账号级事件流（ACR-033）：车机上动了会话列表，这条流会来叫我们重拉。
       *
       * **不 await 也不挡引导**：它断了只是列表不会自动刷新，对话一切照常。
       * 与会话流各跑各的——那条每换一次会话被替换，这条与登录态同寿。
       */
      invoke("start_user_events_stream").catch((err) =>
        console.warn("[session] 账号事件流启动失败，列表仍可手动刷新", err),
      );
      // 会话历史（M28-01）。**放最后且不 await**：列表拉不到不该挡住对话可用。
      void loadSessionsRef.current?.(true);
    };
    /*
     * 哨兵监听（M60-01）：**没有会话也要启动，总开关关着也要启动**。
     *
     *  - 与"绑定"分开：绑定要有会话才有意义，而启动是"开始听"；懒建之后
     *    "还没有会话"是常态，那时的唤醒指令由 Rust 现建会话再发（SessionAdopted）。
     *  - 总开关关着时循环起来但不建 cpal 流，麦克风不占用；它存在只是为了
     *    `voice:sentinel` 指示事件有来源——不然设置页那一组会因为"没有事件"
     *    而整个不渲染，用户看到的是功能消失而不是功能关着。
     *
     * 放在飞闸之外：它与会话无关，不该被引导失败（网关没起）拖住。
     */
    void invoke<boolean>("sentinel_start")
      .then((started) => console.info(`[sentinel] ${started ? "已启动" : "已在运行"}`))
      .catch(() => {});
    /*
     * **整段引导走在飞闸**（M50-01）。`<React.StrictMode>` 下 React 18 的开发构建
     * 把 effect 跑成 effect → cleanup → effect，而上面这段从「读 localStorage」到
     * 「写回 sid」之间全是 await——两次运行各建一个会话，后完成的覆盖存储，
     * 先建的那个零消息且永不关闭（服务端是懒关闭）。cleanup 只退订桥接事件，
     * 取消不了在飞的 bootstrap，所以闸挡在这里。车机端同一处理。
     */
    sessionInflight
      .run(INFLIGHT_BOOTSTRAP, bootstrap)
      .catch((err) => console.warn("[session] 引导失败（网关未启动？）", err));

    return () => cleanup?.();
  }, [appendMessage, adoptSession]);


  /*
   * 地图视图记忆（与车机端同一个 hook）：上次把地图拖到哪，下次打开还在哪。
   * 放在 App 而不是 MobileHud 里，是因为设置页里点「定位」之后也要挪镜头，
   * 各拿一份的话在设置里定位完回到主页，地图还停在原处。
   */
  const mapView = useMapViewport();

  /**
   * 「拍照问诊」（M104-03 起）：开拍照页。快门在页内、在用户手势栈里直接点那枚 capture 的 input——
   * M103-02 那条"切页后在 effect 里 click，出了手势栈 iOS 不弹"的尾巴由此解掉。
   * `pickerRequest` 那条路保留给对话页自己（现在没有调用方递增它）。
   */
  const openDiagnosis = useCallback(() => setCaptureOpen(true), []);

  /*
   * 主页暖暖**只响应点一下**（进对话层）：长按 PTT 不挂（2026-09-18 用户第三次定调「手机端不要语音」）。
   * M103 那一版只把界面上的「长按说话」去掉、手势还留着——界面不写、长按却真的在录音，
   * 是"只有读过代码的人才知道"的功能，误触时车主只看到暖暖忽然「正在聆听」。
   * 状态（listening / alert）仍由 `assistant.state` 驱动，那是哨兵唤醒与服务端事件的显示，不受这里影响。
   */
  const homeAssistantGesture = useMemo(() => ({ onClick: () => setNav("dialog") }), []);

  const carousel = useCarousel(view.tips.pages.length);
  const assistant = useAssistantInteraction({
    // 服务端事件流优先，HUD mock 快照兜底；本地交互态在 hook 内最优先
    /*
     * 唤醒窗口内**优先显示 listening**（M60-01）。
     *
     * 手机端没有本地播报，喊完「暖暖」如果屏幕上也不动，用户与"根本没听见"
     * 分不开——这是这条链路在手机上唯一的到达确认。窗口一过（或被指令消耗）
     * 就交回服务端事件流。
     */
    // 唤醒窗口之后是行程 alert（M75-02）：critical 未确认的核查让暖暖亮起来，「知道了」即清。
    externalState: wakeUntil > Date.now()
      ? "listening"
      : hudAlert ? "alert" : (serverAvatarState ?? view.assistantState),
    // 点助手 = 进入对话层（有后果的操作都在对话层经 Guard + HITL）
    onOpenDialog: () => setNav("dialog"),
    voice,
  });

  const derivedAssistantMode = assistantMode({
    messageCount: messages.length,
    lastInteractionAt,
    // `clock` 只是让这个派生值随时间重算；判据本身用的是真实 now。
    now: Math.max(clock, Date.now()),
    wakeUntil: wakeUntil || undefined,
  });
  /*
   * 入口页的数据（M103-02）。`?home=demo` 是版式截图入口：浏览器没有 Tauri，不喂演示数据的话
   * 车辆 / 能量全是「暂无 / 读不到」，版式看不出来。演示文案自带「（演示）」。
   */
  // `?diagnosis=demo` 也喂演示车：报告页的车辆行要有东西看。
  const homeDemo = isHomeDemo() || Boolean(dxDemo);
  const homeVehicle: HomeVehicle | null = homeDemo ? DEMO_HOME_VEHICLE : defaultVehicle ? toHomeVehicle(defaultVehicle) : null;
  const homeVehicleState: VehicleReadState = homeDemo ? "ready" : vehicleState;
  const homeTripCount = homeDemo ? DEMO_HOME_TRIP_COUNT : tripEntries.length;
  const maintenance = maintenanceReminder(homeVehicle?.forecastRemainingKm);
  const homeReminder = tripHint
    ? { title: tripHint, body: "行程上的红点会一直留着", linkLabel: "查看行程 ›", onLink: () => setTripOpen(true) }
    : homeDemo
      ? { ...DEMO_HOME_REMINDER, onLink: () => setNav("profile") }
      : maintenance
        ? { ...maintenance, linkLabel: "查看保养记录 ›", onLink: () => setNav("profile") }
        : undefined;

  /** 当前可用的报告：演示态用演示报告；真实态只认拉到的那份。 */
  const report = dxDemo ? DEMO_DIAGNOSIS_REPORT : diagnosis?.kind === "ready" ? diagnosis.report : null;
  /**
   * 「预约门店检查」——报告页与快捷芯片共用一句话，后面是既有的维修预约子图 + HITL 确认弹窗。
   * 句子带上报告里的具体事由（见 `bookingPrompt`）：没有报告就不该走到这里。
   */
  const bookInspection = () => {
    if (!report) return;
    setReportOpen(false);
    setNav("dialog");
    void sendText(bookingPrompt(report));
  };
  const homeVehicleLabel = homeVehicle ? `${homeVehicle.model}` : undefined;

  return (
    <>
      {/* 主页 = 功能入口页（M103-02）。保持挂载：切层往返不丢暖暖的状态。 */}
      <div style={{ display: nav === "hud" && !tripOpen ? "contents" : "none" }}>
        <MobileHome
          theme={theme}
          assistantState={assistant.state}
          assistantMode={derivedAssistantMode}
          assistantGestureProps={homeAssistantGesture}
          onAssistantDismiss={isTauriEnv() ? dismissAssistant : undefined}
          vehicle={homeVehicle}
          vehicleState={homeVehicleState}
          energy={liveEnergy}
          tripCount={homeTripCount}
          reminder={homeReminder}
          onOpenDiagnosis={openDiagnosis}
          onOpenTrips={() => setTripOpen(true)}
        />
      </div>

      {/* 行程规划二级页（M103-02）：`MobileHud` 整个是它的内容，保持挂载——跟车进度与轮播上下文都在它里面。 */}
      <div style={{ display: nav === "hud" && tripOpen ? "contents" : "none" }}>
        <MobileTripPage
          tripCount={tripEntries.length}
          navigating={navDay !== undefined}
          onBack={() => setTripOpen(false)}
          onOpenList={() => setTripsOpen(true)}
        >
        <MobileHud
          theme={theme}
          // 二级页没有暖暖（她在主页）；哨兵指示跟她一起收。
          assistant={false}
          snapshot={{ ...view, assistantState: assistant.state }}
          tipsPage={carousel.page}
          tipsGestureProps={carousel.gestureProps}
          assistantGestureProps={assistant.gestureProps}
          onSpotClick={openGuide}
          mapView={mapView}
          home={home}
          tripMap={tripMap}
          reminders={{ legs: plan?.legs }}
          onDepart={() => setDepartOpen(true)}
          trips={{
            entries: tripEntries,
            selectedPlanId: highlightedPlanId,
            today: localDayKey(),
            onSelect: onSelectTrip,
            onOpenReview: onOpenTripReview,
            onClearSelection: onClearTripSelection,
            onOpenList: () => setTripsOpen(true),
          }}
          assistantMode={derivedAssistantMode}
          onAssistantDismiss={isTauriEnv() ? dismissAssistant : undefined}
          /*
           * 未授权的文字说明（走查 2026-08-29 ②）。两种未授权文案不同：
           * undetermined 长按会弹系统框，denied 长按只能带去系统设置。
           */
          /*
           * 哨兵指示（M60-01）。`suspended`（PTT 占用 / 流未建）与 `off` 对用户
           * 就是"未在收音"——不把内部相位原样端出去，那两个词解释不清。
           */
          mic={
            sentinelInd
              ? {
                  state:
                    sentinelInd.state === "suspended" || sentinelInd.state === "off"
                      ? "idle"
                      : sentinelInd.state,
                  micEnabled: sentinelInd.switchOn,
                  degraded: sentinelInd.degraded,
                  onToggleMic: (next) => {
                    void invoke("sentinel_set_switch", { on: next }).catch((err) =>
                      console.warn("[sentinel] 切总开关失败", err),
                    );
                  },
                }
              : undefined
          }
          assistantHint={
            micPermission === "denied"
              ? { primary: "麦克风未授权", secondary: "长按打开系统设置，允许使用麦克风" }
              : micPermission === "undetermined"
                ? { primary: "麦克风待授权", secondary: "长按并在系统弹窗中允许" }
                : tripHint
                  ? { primary: tripHint, secondary: "行程上的红点会一直留着" }
                  : undefined
          }
        />
        </MobileTripPage>
      </div>

      {/* 导览采集进度（M40-03）：底部折叠节，展开是共享面板；导览页开着时让位。只列未完成的（见 guideJobsOutstanding）。 */}
      {nav === "hud" && tripOpen && !guide && guideJobs.jobs && guideJobsOutstanding && guideJobsOutstanding.spots.length > 0 && (
        <details className="mobile-guide-jobs">
          <summary>
            景点导览采集 · {guideJobs.jobs.summary.ready}/{guideJobs.jobs.summary.total} 就绪
          </summary>
          <GuideJobsPanel jobs={guideJobsOutstanding} onFetch={guideJobs.fetchSpot} onOpen={openGuide} />
        </details>
      )}

      {/* 出发卡（2026-09-02）：底部升起的 sheet，压在 HUD 与导览条之上、HITL 确认之下；导览页开着时让位。 */}
      {nav === "hud" && tripOpen && !guide && departOpen && (
        <MobileDeparture plan={plan} vin={activeVin ?? undefined} onClose={() => setDepartOpen(false)} />
      )}

      {/* 行程抽屉（M75-02）：完整周日历卡（清单 + 翻页）；与出发卡同层，导览页开着时让位。 */}
      {nav === "hud" && tripOpen && !guide && tripsOpen && (
        <MobileTripSheet
          entries={tripEntries}
          selectedPlanId={highlightedPlanId}
          today={localDayKey()}
          homeCity={home?.city}
          weatherIcons={SPRITES[theme].weather}
          onSelect={onSelectTrip}
          onOpenReview={onOpenTripReview}
          onClose={() => setTripsOpen(false)}
        />
      )}

      {/* 行程变化摘要（M75-02，组件与车机同一份）：「知道了」→ ack；「让暖暖调整」→ 一句话进会话并切到对话页。 */}
      {nav === "hud" && tripOpen && reviewEntry?.review && (
        <TripReviewSheet
          entry={reviewEntry}
          busy={reviewBusy}
          canAdjust={isTauriEnv() && navDay === undefined}
          onClose={() => setReviewPlanId(null)}
          onAck={() => {
            const review = reviewEntry.review!;
            if (demoPlan) {
              setDemoAcked((prev) => new Set([...prev, review.reviewId]));
              setReviewPlanId(null);
              return;
            }
            setReviewBusy(true);
            void invokeAckTripReview(reviewEntry.planId, review.reviewId)
              .catch((err) => console.warn("[trip-review] 确认失败（下一轮刷新如实纠正）", err))
              .finally(() => {
                setReviewBusy(false);
                setReviewPlanId(null);
                // 立即重拉：红点熄灭不该等下一个轮询周期。
                if ("refresh" in source) (source as GatewayHudSource).refresh();
              });
          }}
          onAdjust={(prompt) => {
            setReviewPlanId(null);
            void sendText(prompt);
            // 后面是既有链路（无草案装载 → 细化 → 确认弹窗），车主要看到暖暖在说什么。
            setNav("dialog");
          }}
        />
      )}

      {/* 景区导览页（M36-04）：覆盖层压在 HUD 之上，返回即关；层级低于 HITL 确认。 */}
      {nav === "hud" && tripOpen && guide && (
        <MobileGuide
          spotName={guide.spot}
          state={guide.state}
          onBack={closeGuide}
          onRetry={() => openGuide(guide.spot)}
          onRegenerate={() => openGuide(guide.spot, { force: true })}
        />
      )}

      {nav === "dialog" && (
        <>
          {/*
            购车页入口放在对话层（M15-05）。
            **不进底部导航**：那要改 `clients/shared/ui` 的 `NavView`，
            而购车页是一次对话的后续，不是与 HUD/对话/档案并列的第四个常驻面。
          */}
          <button type="button" className="buy-entry" onClick={() => setBuyingOpen(true)}>
            打开购车对比
          </button>
          {/*
            与车机同一份 DialogScreen（M65-02）；手机竖屏放不下左栏，会话历史折成顶部抽屉。
            回看态下没有流式气泡、工具进展与部分结果横幅——那些讲的是"此刻正在发生什么"，
            而此刻发生的事属于当前会话。播报开关不传：手机端无本地 TTS（刻意不对齐）。
          */}
          <DialogScreen
            railMode="drawer"
            /* `?dialog=demo`：喂演示消息/会话/进展——版式截图入口，见 @carlife/ui 的 demo-dialog.ts。 */
            messages={
              dxDemo
                ? dxDemo === "followup"
                  ? DEMO_DIAGNOSIS_MESSAGES_FOLLOWUP
                  : DEMO_DIAGNOSIS_MESSAGES_GUIDED
                : isDialogDemo()
                  ? DEMO_DIALOG_MESSAGES
                  : viewing
                    ? viewing.messages
                    : messages
            }
            streaming={isDialogDemo() ? DEMO_DIALOG_STREAMING : viewing ? null : streaming}
            progress={isDialogDemo() ? "正在查天气（演示）" : viewing ? null : toolProgress.progress}
            branchFaults={viewing ? undefined : branchFaults.faults}
            connection={connection}
            onSendText={isTauriEnv() || isDialogDemo() ? sendText : undefined}
            attachments={attachmentsPort}
            pickerRequest={pickerRequest}
            /* 主页没有长按说话了（M103）：空态不能再指着一个不存在的手势。 */
            emptyHint="还没有对话。回到主页点一下暖暖，或拍一张照片试试。"
            /*
             * 拍照问诊（M104-04）：报告在手、且不是在回看历史时——
             *  - 追问态：报告钉在列表上方 + 列表末尾三枚快捷芯片，输入框占位换成「基于报告继续问…」；
             *  - 引导态：列表末尾挂观察 / 补拍 / 追问三张卡。
             * 全部读结构化报告；换会话时报告已清空，槽自然消失。
             */
            pinned={report && !viewing && followupOpen ? <ReportPin report={report} vehicleLabel={homeVehicleLabel} onOpen={() => setReportOpen(true)} /> : undefined}
            trailing={
              report && !viewing ? (
                followupOpen ? (
                  <>
                    {/* 追问态也要看得到 Agent 新发起的卡（M106-04）：此前这一态只有三枚固定芯片，服务端给的题没处显示。 */}
                    <div className="dx-cards">
                      <PromptCards key={report.at} prompts={report.prompts} onAnswer={(text) => void sendText(text)} onCapture={() => setCaptureOpen(true)} />
                    </div>
                    <QuickReplies onAnswer={(text) => void sendText(text)} onBook={bookInspection} />
                  </>
                ) : (
                  <DiagnosisCards
                    report={report}
                    onRetake={() => setCaptureOpen(true)}
                    onAnswer={(text) => void sendText(text)}
                    onOpenReport={() => setReportOpen(true)}
                  />
                )
              ) : undefined
            }
            /* 手机端恒定给占位：默认那句是「打字输入…（驾驶中请用语音）」，而手机端没有语音入口（2026-09-18）。 */
            inputPlaceholder={report && followupOpen ? "基于报告继续问…" : "打字输入…"}
            currentSessionId={currentSessionId}
            viewing={viewing ? { sessionId: viewing.sessionId, onExit: exitViewing } : null}
            sessions={
              isDialogDemo()
                ? {
                    items: DEMO_DIALOG_SESSIONS,
                    hasMore: false,
                    loading: false,
                    onSelect: () => {},
                    onLoadMore: () => {},
                    onNew: () => {},
                  }
                : isTauriEnv()
                ? {
                    items: sessions,
                    hasMore: sessionsHasMore,
                    loading: sessionsLoading,
                    error: sessionsError,
                    onSelect: onSelectSession,
                    onLoadMore: onLoadMoreSessions,
                    onNew: () => void onNewSession(),
                  }
                : undefined
            }
          />
        </>
      )}

      {/*
        购车功能页（M15-05，F-15-14）。覆盖式，不占底部导航。
        它只**读**结构化结果；改假设与约试驾都发回对话层，
        绝不在页面上直接调工具（那会绕过 §8.4 的权限门）。
      */}
      {/* 诊断报告页（M104-04）：覆盖层，与购车页同形态；两枚出口——预约门店检查（HITL）/ 基于报告继续问。 */}
      {reportOpen && report && (
        <MobileDiagnosisReport
          report={report}
          vehicle={homeVehicle}
          vehicleState={homeVehicleState}
          onClose={() => setReportOpen(false)}
          onBook={bookInspection}
          onFollowup={() => {
            setReportOpen(false);
            setFollowupOpen(true);
            setNav("dialog");
          }}
          onGoProfile={() => {
            setReportOpen(false);
            setNav("profile");
          }}
        />
      )}

      {/* 拍照页（M104-03）：全屏层，压在底导之上、HITL 之下；拍完发出去就关，落到对话页。 */}
      {captureOpen && (
        <MobileCapture
          attachments={attachmentsPort}
          onSend={(handle, detections) => sendText("", [handle], detections)}
          onDone={() => {
            setCaptureOpen(false);
            setNav("dialog");
          }}
          onClose={() => setCaptureOpen(false)}
        />
      )}

      {buyingOpen && (
        <MobileBuying
          sessionId={sessionIdRef.current}
          onAsk={(text) => {
            void sendText(text);
          }}
          onClose={() => setBuyingOpen(false)}
        />
      )}

      {/* 档案页（M14-04 页壳）。建档向导（M14-05）从空态 CTA 进入。 */}
      {nav === "profile" && <MobileOwnership theme={theme === "dark" ? "dark" : "light"} />}

      {/* 设置页（定位授权在这里）。第四项由 `showSettings` 显式打开——
          在定位之前手机端确实没有任何可设的东西，那时不打开是对的。 */}
      {nav === "settings" && (
        <MobileSettings
          onLocated={(fix) => mapView.focusOn({ lat: fix.lat, lon: fix.lon, zoom: 15 })}
          // 哨兵总开关的真相源是 Rust 的指示快照，不是设置页自己的 state（M60-01）。
          sentinelOn={sentinelInd?.switchOn}
        />
      )}

      <BottomNav active={nav} onSelect={setNav} profileDisabled={false} showSettings />

      {/*
        HITL 确认：层级高于 HUD 与对话层，**不随 nav 切换消失**——
        权限门挂起时用户可能已经切走，而那笔动作还挂着。
        真实中断（SSE permission → `dialog:permission` → setPermission）优先；
        `?hitl=demo` 的演示样例没有真实中断点，resume 会拿到 not_waiting——直接收起。
      */}
      {(permission || demoPermission) && (
        <ConfirmDialog
          request={permission ?? DEMO_CONFIRM}
          busy={permissionBusy}
          notice={permissionNotice}
          onDismissNotice={() => {
            setPermissionNotice(undefined);
            setPermission(null);
            setDemoPermission(false);
          }}
          onDecide={permission ? decidePermission : () => setDemoPermission(false)}
        />
      )}
    </>
  );
}
