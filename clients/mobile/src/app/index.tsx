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
  DEMO_TRIP_PLAN,
  DialogScreen,
  assistantMode,
  canRetire,
  createArrivalAnnouncer,
  createGatewayHudSource,
  demoEnergy,
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
} from "@carlife/ui";
import {
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
  type TripPlanSnapshot,
  type WeatherKind,
} from "@carlife/shared";

import { subscribeBridge } from "../bridge";
import { createMockHudSource, makeSnapshot, MOCK_HOME } from "../data/mockSource";
import { invokeFetchEnergy, invokeFetchTripPlan } from "../data/gatewayInvoke";
import { tripActiveFor } from "../data/tripMode";
import { resolveTheme, setRootTheme } from "./theme";
import { loadVehicles } from "../features/ownership/api";
import { createInflight, INFLIGHT_BOOTSTRAP, INFLIGHT_NEW_SESSION } from "../data/inflight";
import { planBootstrap } from "../data/bootstrapSession";
import { sendWithSessionRetry } from "../data/sendWithRetry";
import { MobileGuide, useGuideBrief, useGuideJobs } from "../features/guide";
import { MobileDeparture } from "../features/departure";
import { GuideJobsPanel } from "@carlife/ui";
import { MobileHud } from "../features/hud";
import { MobileOwnership } from "../features/ownership";
import { MobileSettings } from "../features/settings";
import { ConfirmDialog } from "../features/confirm";
import { resumeDisposition } from "../features/confirm/decide";
import { MobileBuying } from "../features/buying";
import "../features/buying/buying.css";

/** 跨重启复用会话——"重启后历史仍在"的前提。 */
/**
 * 引导的在飞闸（M50-01）。模块级：StrictMode 的两次 effect 合并成一次建会话。
 * 判据与踩过的坑写在 `data/inflight.ts` 的模块注释里。
 */
const sessionInflight = createInflight();

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
  const [nav, setNav] = useState<NavView>("hud");
  /** 购车页是覆盖层，不占底部导航（M15-05，理由见渲染处）。 */
  const [buyingOpen, setBuyingOpen] = useState(false);

  // ── 真实行程数据源（M13-04 / M65-01）：Tauri 内轮询网关的已确认行程；浏览器走查维持 mock 源 + `?plan=demo`。
  const [fetchedPlan, setFetchedPlan] = useState<TripPlanSnapshot | null>(null);
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

  const source = useMemo(
    () =>
      isTauriEnv()
        ? createGatewayHudSource({
            base: () => makeSnapshot(weather),
            fetchPlanJson: invokeFetchTripPlan,
            onPlan: setFetchedPlan,
            onHome: setHome,
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
  const [activeVin, setActiveVin] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauriEnv()) return;
    let alive = true;
    void loadVehicles().then((r) => {
      if (alive && r.kind === "ready" && r.vehicles[0]) setActiveVin(r.vehicles[0].vin);
    });
    return () => {
      alive = false;
    };
  }, []);
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
  const tripActive = tripActiveFor({ plan, amapFailed, today: new Date().toISOString().slice(0, 10) });
  /*
   * 跟车（M31-03）：判据在 `@carlife/shared`（`tripPlanNavDay`）。手机端**没有位置源**，
   * 车标位置与车机同一套"按真实路线与车程模拟"（nav-position.ts），倍速恒为 1——
   * 真实 GPS 跟车不在本 Sprint（M65-00 约束 4）。跟车时只看当天那一段。
   */
  const navDay = plan ? tripPlanNavDay(plan, new Date().toISOString()) : undefined;
  const viewDay = navDay;
  const tripStops = useMemo(() => (plan ? tripPlanStops(plan, viewDay) : []), [plan, viewDay]);

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
  const [lastInteractionAt, setLastInteractionAt] = useState<number | undefined>(undefined);
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
  const ensureUsableSession = useCallback(async (): Promise<string> => {
    const sid = sessionIdRef.current;
    if (!sid) return startNewSession();
    const retire = canRetire({
      lastInteractionAt,
      now: Date.now(),
      streaming: streaming !== null,
      awaitingPermission: permission !== null,
    });
    return retire ? startNewSession() : sid;
  }, [lastInteractionAt, streaming, permission, startNewSession]);

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
    async (content: string) => {
      setLastInteractionAt(Date.now());
      await sendWithSessionRetry({
        ensure: ensureUsableSession,
        send: (sessionId, text) => invoke("send_text_message", { sessionId, content: text }),
        startNew: startNewSession,
        isExpired: (err) => String(err).includes(SESSION_EXPIRED),
        content,
      });
    },
    [ensureUsableSession, startNewSession],
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
    if (spot) openGuide(spot);
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
    externalState: wakeUntil > Date.now()
      ? "listening"
      : (serverAvatarState ?? view.assistantState),
    // 点助手 = 进入对话层（有后果的操作都在对话层经 Guard + HITL）
    onOpenDialog: () => setNav("dialog"),
    voice,
  });

  return (
    <>
      {/* HUD 保持挂载：切层往返不丢状态机与轮播上下文 */}
      <div style={{ display: nav === "hud" ? "contents" : "none" }}>
        <MobileHud
          theme={theme}
          snapshot={{ ...view, assistantState: assistant.state }}
          tipsPage={carousel.page}
          tipsGestureProps={carousel.gestureProps}
          assistantGestureProps={assistant.gestureProps}
          onSpotClick={openGuide}
          mapView={mapView}
          home={home}
          tripMap={tripMap}
          onDepart={() => setDepartOpen(true)}
          assistantMode={assistantMode({
            messageCount: messages.length,
            lastInteractionAt,
            // `clock` 只是让这个派生值随时间重算；判据本身用的是真实 now。
            now: Math.max(clock, Date.now()),
            wakeUntil: wakeUntil || undefined,
          })}
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
                : undefined
          }
        />
      </div>

      {/* 导览采集进度（M40-03）：底部折叠节，展开是共享面板；导览页开着时让位。只列未完成的（见 guideJobsOutstanding）。 */}
      {nav === "hud" && !guide && guideJobs.jobs && guideJobsOutstanding && guideJobsOutstanding.spots.length > 0 && (
        <details className="mobile-guide-jobs">
          <summary>
            景点导览采集 · {guideJobs.jobs.summary.ready}/{guideJobs.jobs.summary.total} 就绪
          </summary>
          <GuideJobsPanel jobs={guideJobsOutstanding} onFetch={guideJobs.fetchSpot} onOpen={openGuide} />
        </details>
      )}

      {/* 出发卡（2026-09-02）：底部升起的 sheet，压在 HUD 与导览条之上、HITL 确认之下；导览页开着时让位。 */}
      {nav === "hud" && !guide && departOpen && (
        <MobileDeparture plan={plan} vin={activeVin ?? undefined} onClose={() => setDepartOpen(false)} />
      )}

      {/* 景区导览页（M36-04）：覆盖层压在 HUD 之上，返回即关；层级低于 HITL 确认。 */}
      {nav === "hud" && guide && (
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
            messages={viewing ? viewing.messages : messages}
            streaming={viewing ? null : streaming}
            progress={viewing ? null : toolProgress.progress}
            branchFaults={viewing ? undefined : branchFaults.faults}
            connection={connection}
            onSendText={isTauriEnv() ? sendText : undefined}
            currentSessionId={currentSessionId}
            viewing={viewing ? { sessionId: viewing.sessionId, onExit: exitViewing } : null}
            sessions={
              isTauriEnv()
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
