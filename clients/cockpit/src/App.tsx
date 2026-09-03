/**
 * 车机端应用外壳（施工单 M1-03 / M2-05 装配收口）
 *
 * 职责：消费数据源 → 驱动 HUD；承载轮播与助手交互；弱网降级；
 * M2-05：会话引导与跨重启复用、桥接事件单点订阅（消息/状态/连接）、
 * HUD ⇄ 对话层切换（HUD 保持挂载，切层不丢上下文）。
 * 红线：HUD 内不出现任何有后果的动作，点击助手只是**进入对话层**（Brief §7-6）；
 * HUD 层无文字输入框（US-01 AC-01-1）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BottomNav,
  GuideScreen,
  GuideJobsPanel,
  GUIDE_JOBS_POLL_MS,
  applyGuideFetchOptimistic,
  outstandingGuideJobs,
  readyGuideSpots,
  shouldPollGuideJobs,
  useAssistantInteraction,
  useBranchFaults,
  useCarousel,
  useMapViewport,
  useToolProgress,
  type GuideScreenState,
  type NavView,
  type ThemeName,
  type LiveEnergy,
} from "@carlife/ui";

import { guideBriefIsEmpty } from "@carlife/shared";
import type {
  AssistantState,
  ChatMessage,
  GuideBriefResponse,
  GuideJobsResponse,
  GuideJobsStatus,
  PermissionRequest,
} from "@carlife/shared";
import { SESSION_EXPIRED } from "@carlife/shared";

import { HudScreen, type HudTripMapProps } from "./hud/HudScreen";
import type { NavTripProgress } from "@carlife/ui";
import {
  createGatewayHudSource,
  createMockHudSource,
  invokeFetchEnergy,
  invokeFetchTripPlan,
  makeSnapshot,
  type GatewayHudSource,
  MOCK_HOME,
  type HomePlace,
} from "./data/mockSource";
import {
  highlightsPage,
  tripDayIndex,
  tripPlanHasCoords,
  tripPlanNavDay,
  tripPlanStops,
  validateHudSnapshot,
  type HudSnapshot,
  WEATHER_KINDS,
  WEATHER_LABELS,
  type WeatherKind,
} from "./data/types";
import type { TripPlanSnapshot } from "@carlife/shared";
import { DEMO_TRIP_PLAN, withDemoNav } from "./data/demoTripPlan";
import { DEMO_PERMISSION, isHitlDemo } from "./data/demoPermission";
import { devFetch } from "./devAuth";
import { createVoicePort, isTauriEnv } from "./voice/tauriVoicePort";
import { subscribeBridge } from "./bridge";
// 对话层、会话列表与会话生命周期判据自 M65-02 起在 @carlife/ui（两端共用一份）。
import {
  DialogScreen,
  assistantMode,
  canRetire,
  sessionResumable,
  type SessionBrief,
  type StreamingTurn,
} from "@carlife/ui";
import { OwnershipScreen } from "./features/ownership/OwnershipScreen";
import { DriveTransition } from "./features/nav/DriveTransition";
import { loadVehicles } from "./features/ownership/api";
// 实时能量与到站播报判据自 M65-01 起在 @carlife/ui（两端共用）。
import { createArrivalAnnouncer, demoEnergy, startEnergyPolling } from "@carlife/ui";
import { ConfirmSheet } from "./features/hitl/ConfirmSheet";
import { SettingsSheet } from "./features/settings/SettingsSheet";
import { SettingsScreen } from "./features/settings/SettingsScreen";
import { demoTheme, isProfileDemo } from "./data/demoVehicleProfile";
import { planBootstrap } from "./data/bootstrapSession";
import { createInflight, INFLIGHT_BOOTSTRAP, INFLIGHT_NEW_SESSION } from "./data/inflight";

/**
 * 建会话的在飞闸（M50-01）。**模块级而不是 `useRef`**：
 * StrictMode 的两次 effect 虽然共用同一个组件实例（ref 也够），
 * 但模块级还能挡住"App 整体被重新挂载"的那一档，代价只是一个 Map。
 * 判据与踩过的坑写在 `data/inflight.ts` 的模块注释里。
 */
const sessionInflight = createInflight();

/** 跨重启复用会话（Demo 脚本第 5 步"重启后历史仍在"的前提）。 */
const SESSION_STORAGE_KEY = "carlife.sessionId";
/** 与 id 成对保存的本地创建时间；用于区分新建空会话与旧的空会话。 */
const SESSION_META_KEY = "carlife.sessionMeta";

function rememberSession(sessionId: string, createdAt = Date.now()): void {
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  if (Number.isFinite(createdAt)) {
    localStorage.setItem(SESSION_META_KEY, JSON.stringify({ sessionId, createdAt }));
  } else {
    localStorage.removeItem(SESSION_META_KEY);
  }
}

function storedSessionCreatedAt(sessionId: string): number | undefined {
  const raw = localStorage.getItem(SESSION_META_KEY);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const meta = parsed as { sessionId?: unknown; createdAt?: unknown };
    if (meta.sessionId !== sessionId || typeof meta.createdAt !== "number") return undefined;
    return Number.isFinite(meta.createdAt) ? meta.createdAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 演示车速的候选档（M31-03）。
 *
 * ×1 留在最后一档，是为了走查时能看真实节奏——但它在现场演不完，
 * 所以默认不是它。三档循环，不做输入框：车机上没人愿意敲数字。
 */
const NAV_SPEEDUPS: number[] = [60, 120, 1];

/**
 * 车机端主界面。
 *
 * `declaredSessionId`：上车声明（`BoardingGate`）刚建出来的会话（M50-02）。
 * 车机是**车辆级 token**，`POST /v1/session` 要求显式声明谁在用（M48-05），
 * 所以车机上唯一能建出会话的入口是那道门——懒建之后，第一句话要用的 sid
 * 必须由它交过来，App 自己建不出来。个人身份 / 浏览器走查下它是 undefined。
 *
 * `onNeedBoarding`：车机上建会话被服务端判为"没声明谁在用"时回调，
 * 由外层重新挂出上车声明。**不静默失败**——静默的后果是车主说了话没有任何反应。
 */
export function App({
  declaredSessionId,
  onNeedBoarding,
}: {
  declaredSessionId?: string;
  onNeedBoarding?: () => void;
} = {}) {
  // 初始主题可由 ?theme=dark 指定（截图脚本用，见 demoVehicleProfile.ts）。
  const [theme, setTheme] = useState<ThemeName>(demoTheme() ?? "light");

  /*
   * 主题同时写到文档根（M13-05 视觉重做时发现）。
   *
   * `data-theme` 原本只挂在 `.hud-viewport` 上，而**盖在 App 层的覆盖层
   * （HITL 确认弹层）是它的兄弟节点**——取不到深色 token，于是深色主题下
   * 弹层仍是一张白卡。此前没暴露，是因为那版弹层的颜色全是写死的字面量。
   * 挂在根上，任何在 HUD 之外渲染的层都能拿到同一套 token。
   */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [weather, setWeather] = useState<WeatherKind>("sunny");
  const [snapshot, setSnapshot] = useState<HudSnapshot | null>(null);
  /*
   * 当前这辆车（M27）。HUD 右下角的能量读数按它取。
   *
   * 真相源在档案页（`OwnershipScreen` 的 `activeVin`，默认取列表首位＝默认车），
   * 但 HUD 在没进过档案页时也得有能量——所以 App 自己解析一次默认车，
   * 之后由档案页的切换回调覆盖。两处写同一个 state，不各存一份。
   */
  const [activeVin, setActiveVin] = useState<string | null>(null);
  /*
   * 过场动画里开的是**这辆车**的形象，所以要跟着 vin 一起记车型
   * （`vehicleCharacter` 的键是 `Vehicle.model`）。记不到就画中性剪影。
   */
  const [activeModel, setActiveModel] = useState<string | undefined>(undefined);
  /*
   * 「开车去档案」过场（M-nav）。两个状态各管一件事，合成一个会绕：
   *  - `driving`：这一层在不在。进档案时置起，动画自己放完后落下；
   *  - `profileReady`：档案页的数据到了没有。它是过场从"一直开"转到"开走"的信号。
   * **从任何页面切进档案都放**（产品定调，2026-08-28）：过场本身就是
   * 档案页的开场白，从对话/设置进来没有它反而像两种产品。已在档案页时
   * 重复点档案不再开一趟——那不是"进入"。
   */
  const [driving, setDriving] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [liveEnergy, setLiveEnergy] = useState<LiveEnergy | undefined>(demoEnergy);
  const [stale, setStale] = useState(false);
  // ⑥用车流水的采集开关与最近一次上报结果（M11-01，仅 Tauri 内有效）
  const [tripCollect, setTripCollect] = useState(true);
  const [tripNote, setTripNote] = useState("");
  /*
   * `?profile=demo` 直接落在档案页并隐藏 devbar（M14-14）。
   * 它是**版式截图入口**：`scripts/assets/ui-diff.py` 要拿一张与定稿同尺寸、
   * 且不含验收开关的图去比。真实运行不带 query，行为一字不变。
   */
  const profileDemo = isProfileDemo();
  /* `?hitl=demo`：直接弹确认层并隐藏 devbar，同款版式截图入口（见 demoPermission.ts）。 */
  const hitlDemo = isHitlDemo();
  const [nav, setNav] = useState<NavView>(profileDemo ? "profile" : "hud");
  /*
   * devbar 默认收起（只留一个「功能演示」圆钮）。
   * 展开后按钮会越加越多，所以这里不是"藏起来好看"——**默认铺开时它会盖住
   * HUD 顶部的时间轴与天气**，而那两样正是走查时要看的东西。
   */
  const [devbarOpen, setDevbarOpen] = useState(false);

  // ── 真实地图行程模式（M13-06）────────────────────────────────
  // fetchedPlan 来自数据源；demoPlan 是 devbar 的演示开关（浏览器走查唯一路径）。
  const [fetchedPlan, setFetchedPlan] = useState<TripPlanSnapshot | null>(null);
  /*
   * 这次长按为什么没录成（2026-09-02 iPad 走查）。
   *
   * 现场是「正在聆听」闪一下退回「长按说话」，手指还按着，屏幕上没有任何交代——
   * 原因在 Rust 侧被 emit 成 `voice:capture` 的 failed，也在 invoke 的 reject 里，
   * 但两处此前都没有人显示。录成一次就清掉：它说的是"刚才那一次"，不是长期状态。
   */
  const [captureFault, setCaptureFault] = useState<string | undefined>(undefined);
  /*
   * 车主常住地（M13-10）：没有行程时 HUD 的地图落点，与行程同一次轮询回来。
   * 浏览器（无 Tauri invoke）没有那一路，用 mock 值——否则这一层走查不到。
   */
  const [home, setHome] = useState<HomePlace | undefined>(
    isTauriEnv() ? undefined : MOCK_HOME,
  );
  const [demoPlan, setDemoPlan] = useState(false);
  const [dayMode, setDayMode] = useState<"all" | number>("all");
  const [amapFailed, setAmapFailed] = useState(false);
  /*
   * 演示车速（M31-03）。默认 ×60：一段 40 分钟的市内车程约 40 秒走完，
   * 现场演得完，又不至于快到看不清车在走哪条路。
   * 真实定位接进来之后这个开关连同模拟源一起退场（二期）。
   */
  const [navSpeedup, setNavSpeedup] = useState(60);
  /** 跟车演示开关（浏览器走查用，见 withDemoNav）。 */
  const [demoNav, setDemoNav] = useState(false);
  /*
   * 网关设置页（ACR-004 第 3 步）。`firstRun` 只在"地址还没有任何来源"时真——
   * `source === "default"` 就是这个意思（既没存过、env 也不在），此时 iPad 上
   * 默认的 localhost 指向 iPad 自己，不引导就是"装好了但全是空的"。
   * 桌面不弹：env 恒在，`source` 是 `env`，地址至少是通的。
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFirstRun, setSettingsFirstRun] = useState(false);
  useEffect(() => {
    if (!isTauriEnv()) return;
    void invoke<{ platform: string; storedUrl: string | null; source: string }>(
      "get_gateway_settings",
    ).then((v) => {
      if (v.platform === "ios" && v.source === "default") {
        setSettingsFirstRun(true);
        setSettingsOpen(true);
      }
    }).catch(() => {
      // 旧版 Rust 侧没有这个命令（升级中间态）：不弹、不报——设置只是打不开
    });
  }, []);

  // 真实数据源（M13-04）：Tauri 内轮询网关的已确认行程；没有可展示的行程时
  // 源自己回落基线快照。浏览器 mock 环境维持原 mock 源。
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

  /*
   * 给 appendMessage 用的引用通道。appendMessage 的身份变化会重跑整段
   * bootstrap（见它内部 M28-01 的事故注释），所以 source 不能进它的依赖——
   * 而 source 挂在 weather 上，天气一变就是一个新对象。
   */
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useEffect(() => {
    return source.subscribe(
      (s) => {
        const problems = validateHudSnapshot(s);
        if (problems.length) console.warn("HUD 快照不满足 Brief 约束:", problems);
        setSnapshot(s);
        setStale(false);
      },
      () => {
        // 弱网降级：保留最近有效快照并标记「数据更新中」，不空白、不全屏遮挡
        setStale(true);
      },
    );
  }, [source]);

  /*
   * 默认车解析（M27）。只在 Tauri 里做——浏览器走查没有网关那一路，
   * 硬拉只会拿到一句"没有桥"，然后把它显示成"车机读不到"，
   * 那是把环境限制说成设备故障。
   */
  useEffect(() => {
    if (!isTauriEnv()) return;
    let alive = true;
    void loadVehicles().then((r) => {
      // 列表首位是默认车（服务端排序），与档案页的初值口径一致。
      if (alive && r.kind === "ready" && r.vehicles[0]) {
        setActiveVin(r.vehicles[0].vin);
        setActiveModel(r.vehicles[0].model);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  /* 能量轮询：换车即重起一路，旧的立刻停——否则切完车还会收到上一辆的读数。 */
  useEffect(() => {
    if (!isTauriEnv()) return;
    const poller = startEnergyPolling(activeVin, setLiveEnergy, { fetchEnergyJson: invokeFetchEnergy });
    return () => poller.stop();
  }, [activeVin]);

  // 首帧到达前使用同源的默认快照，避免空白页（Brief §6）
  const effective = snapshot ?? makeSnapshot(weather);
  const withEnergy: HudSnapshot =
    liveEnergy === undefined ? effective : { ...effective, energy: { ...effective.energy, live: liveEnergy } };
  const fresh: HudSnapshot = stale
    ? { ...withEnergy, freshness: { stale: true, updatedAt: withEnergy.freshness.updatedAt } }
    : withEnergy;

  /*
   * 目的地推荐页（M32-03 走查用）。
   *
   * 真实链路早在 M32-02 就接好了：网关带回 `destinationHighlights`，
   * `createGatewayHudSource` 经 `tripPlanToHud` 把它投影成第二页。
   * 但**浏览器里 HUD 快照来自 mock 源**（没有 Tauri invoke，接不上网关），
   * 那条路不经 `tripPlanToHud`——所以走查时这一页永远不会出现。
   * 这里补的就是那条缝，只在 devbar「行程演示」开着时生效。
   *
   * 造页走 shared 的 `highlightsPage()` 而不是自己拼一个对象：
   * "三段全空不造页"这条纪律必须只有一份实现。
   */
  const demoHighlightsPage = useMemo(
    () => (demoPlan ? highlightsPage(DEMO_TRIP_PLAN.destinationHighlights) : undefined),
    [demoPlan],
  );
  const view: HudSnapshot = demoHighlightsPage
    ? { ...fresh, tips: { ...fresh.tips, pages: [...fresh.tips.pages, demoHighlightsPage] } }
    : fresh;

  // 真实地图报废（无 key/离线）→ 回落装饰概览。memo 化：内联箭头函数会被
  // 地图层当成"配置变了"，那正是白屏事故的引信（AmapTripLayer 的注释）。
  const onTripMapFallback = useCallback(() => setAmapFailed(true), []);

  // 行程模式判定：确认过、未过期、有真实坐标、且真实地图没有报废——缺一样都回落装饰概览。
  /*
   * 跟车演示的 nav 只挂一次（useMemo）：每次渲染新造一份会让 startedAt 一直往前跑，
   * navKey 跟着变，跟车于是每帧从头起跑——车标钉在起点一动不动。
   */
  const demoNavPlan = useMemo(() => withDemoNav(DEMO_TRIP_PLAN, 2), [demoNav]);
  const plan = demoPlan ? (demoNav ? demoNavPlan : DEMO_TRIP_PLAN) : fetchedPlan;
  const tripActive =
    !amapFailed &&
    plan !== null &&
    plan.status === "confirmed" &&
    tripDayIndex(plan, new Date().toISOString().slice(0, 10)) !== null &&
    tripPlanHasCoords(plan);

  /*
   * ── 跟车模式（M31-03）───────────────────────────────────────
   *
   * 判据在 `@carlife/shared`（`tripPlanNavDay`），端上不自己判：
   * 「还算不算在导航」牵涉过期规则（跨天作废），两处各写一份必然漂移，
   * 而漂移的表现是"车机说在导航、服务端说没有"。
   *
   * 演示倍速经 devbar 开关；**大于 1 时顶栏恒显角标**（HudScreen 的 NavBar 保证）。
   */
  const navDay = plan ? tripPlanNavDay(plan, new Date().toISOString()) : undefined;

  /*
   * 跟车时**只看当天那一段**。
   *
   * 不收窄的话，车会沿着整程路线跑——包括别的天的酒店与景点，
   * 于是"跟车"跟的是一条今天根本不会走的路。这不是取景问题，是走错路。
   */
  const viewDay = navDay ?? (dayMode === "all" ? undefined : dayMode);

  // stops 同样要稳定引用：每次渲染换新数组会让覆盖物每帧重建、路线动画不停重启。
  const tripStops = useMemo(
    () => (plan ? tripPlanStops(plan, viewDay) : []),
    [plan, viewDay],
  );

  /*
   * 「结束导航」走**同一条语音链路**而不是直接调工具：
   * 按钮与说「结束导航」必须落到同一处处置，否则两条路的状态迟早对不上
   * （而且图状态那边不会知道按钮按过）。
   *
   * 经 ref 取 `sendText`——它声明在下面几百行处，而这里要早于它算出 tripMap。
   * 按钮点下去时 ref 必然已经赋值（同一次渲染的末尾就赋了）。
   */
  const sendTextRef = useRef<((content: string) => Promise<void>) | null>(null);
  const onNavEnd = useCallback(() => {
    if (isTauriEnv()) void sendTextRef.current?.("结束导航");
  }, []);

  /*
   * 到站播报（M31-03）：把到站这件事发上去，由助手回一句，**车机既有的 TTS
   * 链路自然就念了**（TTS 全在 Rust 侧、挂在"助手回了一句话"上）。
   * 去重与在飞防叠的判据在 `@carlife/ui` 的 `createArrivalAnnouncer`（M65-01 上提，两端共用、有单测）。
   */
  const announcer = useMemo(
    () => createArrivalAnnouncer((note) => sendTextRef.current?.(note) ?? Promise.resolve()),
    [],
  );
  const onNavProgress = useCallback(
    (p: NavTripProgress) => {
      if (!isTauriEnv()) return;
      announcer.onProgress(p);
    },
    [announcer],
  );

  /*
   * ── 景区导览页（M36-03）─────────────────────────────────────
   *
   * 点击地图上的景点标记 → 全屏导览页（覆盖层，HUD 保持挂载）。
   * 冷启是三分支采集（最坏 90s 量级），所以先出"采集中"态；
   * 返回后迟到的结果按序号丢弃——旧请求的数据盖上新页面是最迷惑的一种错。
   */
  const [guide, setGuide] = useState<{ spot: string; state: GuideScreenState } | null>(null);
  const guideSeqRef = useRef(0);
  const openGuide = useCallback(
    (spotName: string, opts?: { force?: boolean }) => {
      const seq = ++guideSeqRef.current;
      setGuide({ spot: spotName, state: { status: "collecting" } });
      const body = {
        spotName,
        // 行程上下文顺手带上：目的地当城市线索、出发日进提示词（缺了也能查）。
        ...(plan?.destination ? { city: plan.destination } : {}),
        ...(plan?.startDate ? { date: plan.startDate } : {}),
        selfDrive: true,
        // 「重新采集」：跳过服务端持久层（2026-08-29，简报只采一次）。
        ...(opts?.force ? { force: true } : {}),
      };
      const request = async (): Promise<GuideBriefResponse> => {
        if (isTauriEnv()) {
          // 网络在 Rust（§2.2 C2）：invoke 原样 JSON 往返，契约在 shared。
          return JSON.parse(
            await invoke<string>("get_guide_brief", { bodyJson: JSON.stringify(body) }),
          ) as GuideBriefResponse;
        }
        /*
         * 浏览器走查形态（vite 直开 1430，无 Rust 桥）：走 vite 的 /v1 代理到本机网关。
         * 只在 dev 存在——release 客户端恒为 Tauri 环境，不会走进这个分支。
         *
         * 鉴权见 `devAuth`：走查者自己贴一枚真 token。原来这里硬编码
         * `Bearer demo-token`，而网关自 M48-02 删掉那把万能钥匙后它恒 401——
         * 界面上只显示"采集失败"，与"这个景点确实采不到"分不开。
         */
        const r = await devFetch("/v1/guide/brief", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) return { status: "failed" };
        return (await r.json()) as GuideBriefResponse;
      };
      void request()
        .catch(() => ({ status: "failed" }) as GuideBriefResponse)
        .then((resp) => {
          if (guideSeqRef.current !== seq) return; // 已返回/重开，迟到结果作废
          setGuide((cur) =>
            cur && cur.spot === spotName
              ? {
                  spot: spotName,
                  state:
                    // 三支全空的"ready"按 failed 呈现（有重试钮），空栏目页不诚实。
                    resp.status === "ready" && resp.brief && !guideBriefIsEmpty(resp.brief)
                      ? { status: "ready", brief: resp.brief, cached: resp.cached }
                      : { status: "failed" },
                }
              : cur,
          );
        });
    },
    [plan],
  );
  const closeGuide = useCallback(() => {
    guideSeqRef.current += 1; // 在途请求作废
    setGuide(null);
  }, []);

  /*
   * ── 导览采集进度面板（M40-02，数据面 ACR-008）──────────────
   *
   * 面板以 `/v1/guide/jobs` 为唯一真相源（服务端按鉴权身份取当前行程），
   * **不依赖 HUD 地图上摆的是哪份行程**——演示开关下地图可能是 demo 行程，
   * 而进度对的是库里真实确认的那份，两者对不上时以真实为准（不标不猜的延伸）。
   * 节流与乐观规则是共享纯逻辑（clients/shared/ui jobs-logic，两端一字一样）。
   */
  const [guideJobs, setGuideJobs] = useState<GuideJobsStatus | null>(null);
  const guideJobsBusyRef = useRef(false);
  const refreshGuideJobs = useCallback(async () => {
    if (guideJobsBusyRef.current) return; // 上一发未归不叠发
    guideJobsBusyRef.current = true;
    try {
      const raw = isTauriEnv()
        ? await invoke<string>("get_guide_jobs")
        : await (
            await devFetch("/v1/guide/jobs")
          ).text();
      const parsed = JSON.parse(raw) as GuideJobsResponse;
      setGuideJobs(parsed.jobs ?? null);
    } catch {
      // 轮询面不出声：拿不到保持上一份——进度卡短暂陈旧比弹错误卡好
    } finally {
      guideJobsBusyRef.current = false;
    }
  }, []);
  // 首拉：进 HUD / 关导览页时刷一次
  useEffect(() => {
    if (nav !== "hud" || guide) return;
    void refreshGuideJobs();
  }, [nav, guide, refreshGuideJobs]);
  // 节流轮询：只在 HUD 可见、导览页关着、且有在途任务时 10s 一轮（总览约束 1）
  useEffect(() => {
    if (nav !== "hud" || guide || !shouldPollGuideJobs(guideJobs)) return;
    const t = setInterval(() => void refreshGuideJobs(), GUIDE_JOBS_POLL_MS);
    return () => clearInterval(t);
  }, [nav, guide, guideJobs, refreshGuideJobs]);
  /*
   * HUD 小卡只挂"还欠着的"：ready 的行采完即从卡上消失，全采完整张卡收掉。
   * 卡是待办条不是索引——已就绪的导览入口在地图景点标记上（onStopClick → openGuide），
   * 从卡上撤掉不等于没处进。summary 不动，进度头照旧是服务端账本的 x/N。
   */
  const guideJobsOutstanding = useMemo(
    () => (guideJobs ? outstandingGuideJobs(guideJobs) : null),
    [guideJobs],
  );
  /*
   * 索引的那一半：ready 的景点在地图胶囊上挂「✓ 导览」角标（AmapTripLayer.guidedSpots）。
   * 卡上撤掉了，标记上就得标出来——否则用户只能挨个点开试哪个有导览。
   * 与 guideJobs 同源（服务端账本），不另存一份"已看过"。
   */
  const guidedSpots = useMemo(() => readyGuideSpots(guideJobs), [guideJobs]);
  const fetchGuideSpot = useCallback(
    (spotName: string) => {
      // 乐观置 pending（按了要有反应，总览约束 2）；真相以响应后的刷新为准
      setGuideJobs((cur) => (cur ? applyGuideFetchOptimistic(cur, spotName) : cur));
      const req = async () => {
        if (isTauriEnv()) {
          await invoke<string>("trigger_guide_job", { bodyJson: JSON.stringify({ spotName }) });
        } else {
          await devFetch("/v1/guide/jobs/trigger", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ spotName }),
          });
        }
      };
      void req()
        .catch(() => {}) // 失败由下一拍刷新如实纠正（乐观态被真实态覆盖）
        .finally(() => void refreshGuideJobs());
    },
    [refreshGuideJobs],
  );

  const tripMap: HudTripMapProps | undefined = tripActive
    ? {
        stops: tripStops,
        // 点击景点标记 → 导览页（M36-03）。AmapTripLayer 只对 kind=spot 回调。
        onStopClick: (stop) => openGuide(stop.name),
        // 导览已就绪的景点挂角标——点之前就知道哪些能看。
        guidedSpots,
        ...(navDay !== undefined
          ? {
              nav: {
                // 换一次导航（换天/重新出发）就重新起跑。
                key: `${plan.updatedTurnId}:${navDay}:${plan.nav?.startedAt ?? ""}`,
                speedup: navSpeedup,
                onProgress: onNavProgress,
                onEnd: onNavEnd,
              },
            }
          : {}),
        // 行程身份：确认/更新都会换轮次 id，换行程时地图收回镜头否决权重新取景。
        planKey: plan.updatedTurnId,
        showDayBadge: viewDay === undefined,
        /*
         * 单日视图闭环：酒店 → 景点 → 回酒店（首日放行李/末日寄存的场景语义）。
         * **跟车时不闭环**：车不会在到达最后一站之后自己开回酒店，
         * 画上那一段就是给一条今天不会走的路。
         */
        closeLoop: viewDay !== undefined && navDay === undefined,
        /*
         * 顶部逐日胶囊**暂时隐藏**（用户走查 M13-09）：默认只看全程安排，
         * 每个站点自己带 Day N · 时刻，逐日切换的信息量已经在标记上了。
         * 空数组 = 不渲染切换条（`tabs.length > 1` 才渲染），
         * 保留字段与 dayMode 状态是为了随时能开回来，不删链路。
         */
        tabs: [],
        active: dayMode,
        onSelect: setDayMode,
        onFallback: onTripMapFallback,
        // 住宿策略横幅（M34-02）：只有带 lodging 的天（换酒店日/到达日）出现。
        lodgingNotes: plan.skeleton
          .filter((d) => d.lodging)
          .map((d) => ({ day: d.day, strategy: d.lodging!.strategy, note: d.lodging!.note })),
      }
    : undefined;

  // ── M2-04/05：会话引导（复用或新建）+ 桥接事件单点订阅 ────────────────
  const sessionIdRef = useRef<string | null>(null);
  /**
   * 当前会话 id 的**可渲染副本**（M28-01）。
   *
   * `sessionIdRef` 是 ref，换会话不会触发重渲染——左侧列表的高亮靠它就永远不动。
   * 两份不是冗余：ref 供回调里同步读（`sendText` 那些地方拿的必须是最新值），
   * state 供渲染。**两处必须一起改**，所以只在 `adoptCurrentSession` 里改。
   */
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  /**
   * 系统麦克风授权现状（走查 2026-08-29 ②）。null = 还没查到（非 Tauri 环境恒为 null）。
   * 不是 granted 时暖暖卡片挂文字说明——没有这行字，新设备上的表现是
   * "长按了、松手了、什么都没发生"，车主没法知道缺的是系统权限。
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
      /* 查不到不挂说明——别拿一个不确定的状态吓人 */
    }
  }, []);
  useEffect(() => {
    void refreshMicPermission();
  }, [refreshMicPermission]);
  const [serverAvatarState, setServerAvatarState] = useState<AssistantState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /*
   * 会话生命周期（M22-03）。
   *
   * `lastInteractionAt` 只驱动**形象**——正确性由服务端兜（过期的会话
   * `POST /messages` 直接 409）。所以这个时钟粗一点没关系：30 秒一跳，
   * 比每秒重渲染整屏 HUD 划算得多。
   */
  const [lastInteractionAt, setLastInteractionAt] = useState<number | undefined>(undefined);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [streaming, setStreaming] = useState<StreamingTurn | null>(null);
  /**
   * 工具进展（F-08-05）：填那十几秒空白。**不进历史**——
   * 它只是一个内存态，轮次收口时 reset。
   */
  const toolProgress = useToolProgress();
  // 分支失败的"部分结果"标识（M37-01）。与工具进展不同：**不在本轮收口时清**——
  // 横幅标注的是"这轮答案缺了什么"，要跟着答案一起被读；清理时机是下一轮开始，
  // 以及换会话（下面这个 effect）：别的会话的缺失不该挂在新会话头上。
  const branchFaults = useBranchFaults();
  useEffect(() => {
    branchFaults.reset();
  }, [currentSessionId, branchFaults.reset]);
  const [connection, setConnection] = useState<"online" | "reconnecting" | "unknown">("unknown");

  /*
   * 左侧会话历史（M28-01）。懒加载一次 20 条。
   *
   * **列表是服务端那份的投影，不是端上另攒的一份**：不在这里插入/删除会话，
   * 只在换会话时整页重拉。端上自己维护一份的话，"新建了一个会话但列表里没有"
   * 与"服务端那边真的没建成"就再也分不开了。
   */
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  /**
   * 正在回看的历史会话（M28-01）。`null` = 在看当前会话。
   *
   * 回看**不碰会话所有权**：不换 localStorage、不切 SSE 流、不动哨兵绑定。
   * 碰了的话，车主翻一眼旧对话就把语音唤醒指向了一个已经关闭的会话——
   * 而那时说话是一个字都不会有回应的（服务端 409），端上却毫无表示。
   */
  const [viewing, setViewing] = useState<{ sessionId: string; messages: ChatMessage[] } | null>(
    null,
  );

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
          // 不去重的话 React 会因 key 重复整片报错，而现象只是"列表突然空了"。
          const seen = new Set(prev.map((s) => s.sessionId));
          return [...prev, ...page.sessions.filter((s) => !seen.has(s.sessionId))];
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
  /*
   * 引导流程要用 `loadSessions`，但它的 deps 里有 `sessionsCursor`——
   * 直接进那个 effect 的依赖数组会让**整段会话引导每翻一页就重跑一次**
   * （重建会话、重起流）。所以用 ref 递最新的那一份。
   */
  const loadSessionsRef = useRef(loadSessions);
  useEffect(() => {
    loadSessionsRef.current = loadSessions;
  }, [loadSessions]);
  /**
   * 唤醒窗口截止时刻（M25-03）。0 = 没有唤醒态。派生进 `assistantMode`：
   * 喊一声「暖暖」она就切办公，哪怕消息还没落库；窗口过了自然消散。
   * Rust 侧窗口过期不发关闭事件（被动过期），所以这里存的是**截止时刻**
   * 而不是布尔——布尔会在错过关闭事件时永远卡在 true。
   */
  const [wakeUntil, setWakeUntil] = useState(0);
  /**
   * 语音最近一次把闲聊旁路拨到了哪一边（M33-04 的 `SidecarSwitched`）。
   * 只喂给设置页显示——偏好本身在 Rust 侧已经改完了，这里不改任何行为。
   */
  const [sidecarOn, setSidecarOn] = useState<boolean | undefined>(undefined);
  /**
   * 哨兵指示快照（M25-04）：唯一来源是 Rust `voice:sentinel` 事件——
   * MicIndicator 的纪律是"不接受由页面推断出来的值"。null = 事件还没来
   * （哨兵未启动/浏览器开发态），此时不渲染指示。
   */
  const [sentinelInd, setSentinelInd] = useState<{
    switchOn: boolean;
    state: "off" | "idle" | "listening" | "uploading" | "suspended";
    degraded: boolean;
  } | null>(null);
  /** 播报总开关（M3-07 F-02-12）：车机默认开，关闭状态跨重启保持。 */
  const [broadcast, setBroadcast] = useState(true);

  useEffect(() => {
    if (!isTauriEnv()) return;
    void invoke<boolean>("get_broadcast_enabled").then(setBroadcast);
    void invoke<boolean>("get_trip_collect_enabled").then(setTripCollect);
  }, []);

  const toggleBroadcast = useCallback(async () => {
    const next = !broadcast;
    setBroadcast(next); // 乐观：开关必须手感即时
    try {
      const applied = await invoke<boolean>("set_broadcast_enabled", { enabled: next });
      setBroadcast(applied);
    } catch {
      setBroadcast(!next); // 失败回滚，不留一个"看起来关了其实没关"的开关
    }
  }, [broadcast]);

  /**
   * 发送文字消息（施工单 M3-07，F-03-09）。
   * 网络在 Rust 侧（§2.2 C2）：WebView 只 invoke，不直接访问网关。
   * 用户消息与助手回复都由 SSE 事件回流，这里不做乐观插入——
   * 避免"本地先显示、服务端却失败"的两份真相。
   */
  // HITL 确认弹层（M13-05）：盖 App 层——确认常发生在语音场景，用户人在 HUD 层。
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  /** resume 没被接住时的告知文案——**不能静默收起**，见 decidePermission。 */
  const [permissionNotice, setPermissionNotice] = useState<string | undefined>(undefined);
  // devbar 的弹层演示开关（浏览器走查唯一路径），真实中断始终优先。
  const [demoPermission, setDemoPermission] = useState(hitlDemo);

  /**
   * 建一个新会话并接管：写 localStorage、起流、清空当前消息列表。
   *
   * **历史不删**——服务端那份还在，上滑仍能翻阅（D4）。这里清空的只是
   * "当前这段对话"的显示，否则新会话一开场就挂着上一段的气泡，
   * 而暖暖的形象判据（本会话有没有说过话）会立刻判成办公。
   */
  const doStartNewSession = useCallback(async (): Promise<string> => {
    const sid = await invoke<string>("create_session");
    rememberSession(sid);
    sessionIdRef.current = sid;
    setCurrentSessionId(sid);
    // 换了会话就退出回看：否则屏幕上摊着旧对话，而车主说的话进的是新会话。
    setViewing(null);
    setMessages([]);
    setStreaming(null);
    setLastInteractionAt(undefined);
    await invoke("start_session_stream", { sessionId: sid });
    // 哨兵跟上新会话（M25-02）：语音唤醒的指令要落进"现在这段对话"。
    // 绑不上不挡会话建立——哨兵是增强入口，不是前置条件。
    invoke("sentinel_bind_session", { sessionId: sid }).catch(() => {});
    // 新会话要出现在左侧列表里（M28-01）。整页重拉而不是本地插一条：
    // 本地插的那条与服务端真的建成了，是两件事。
    void loadSessionsRef.current?.(true);
    return sid;
  }, []);

  /**
   * 建会话失败时分流：服务端说"先声明谁在用"就请外层挂回上车声明，其余原样抛。
   *
   * `active_user_required` 只可能出现在**车辆级 token**上（M48-05）。
   * 把它当普通错误吞掉，现象是"车主说了话、屏幕上什么都没发生"。
   */
  const needBoardingOrRethrow = useCallback(
    (err: unknown): never => {
      if (String(err).includes("active_user_required")) {
        console.info("[session] 服务端要求先声明谁在用——挂回上车声明");
        onNeedBoarding?.();
      }
      throw err;
    },
    [onNeedBoarding],
  );

  /**
   * 对外的"新建会话"。**并发的两次合并成一次**（M50-01）：
   * 连点「新建对话」、以及"会话过期重发"与别处同时触发时，
   * 各自拿到同一个 sid，而不是各建一个、丢掉一个空会话。
   */
  const startNewSession = useCallback(
    (): Promise<string> => sessionInflight.run(INFLIGHT_NEW_SESSION, doStartNewSession),
    [doStartNewSession],
  );

  /**
   * 发之前确认会话还能用；没有就现建，该退休就先换一个（M50-02 之后这是**唯一**
   * 会建出会话的路径，除了上车声明那一条）。
   *
   * 车机上建会话会被服务端要求"先声明谁在用"（M48-05）——那不是错误，是要求
   * 重新走上车声明。**不能静默吞掉**：吞掉的现象是车主说了话什么都没发生。
   */
  const ensureUsableSession = useCallback(async (): Promise<string> => {
    const sid = sessionIdRef.current;
    if (!sid) return startNewSession().catch(needBoardingOrRethrow);
    const retire = canRetire({
      lastInteractionAt,
      now: Date.now(),
      streaming: streaming !== null,
      awaitingPermission: permission !== null,
    });
    return retire ? startNewSession().catch(needBoardingOrRethrow) : sid;
  }, [lastInteractionAt, streaming, permission, startNewSession, needBoardingOrRethrow]);

  /**
   * 结束当前这段对话：关掉它、把端上的会话位置空，**不预建下一个**（M50-02）。
   *
   * 原先这里是"关旧的 + 立刻 `startNewSession()`"，于是"退下之后没再说话"
   * 就留下一个零消息会话。下一句话由 `ensureUsableSession` 现建——它建完立刻发，
   * 从不留空会话。
   *
   * **历史不删**：`close_session` 是软关闭，上滑仍能翻阅（M22-01）。
   * 两个入口（HUD 的「退下」按钮、语音口令退下）共用这一条，避免两份各自漂移。
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
    setCurrentSessionId(null);
    setViewing(null);
    setMessages([]);
    setStreaming(null);
    setLastInteractionAt(undefined);
    // 列表里那条要变成"已关闭"，重拉一次（不 await，拉不到不挡收尾）。
    void loadSessionsRef.current?.(true);
  }, []);

  /** 车主点「退下」：关掉这段对话并收尾。 */
  const dismissAssistant = useCallback(
    () => endCurrentSession({ close: true }),
    [endCurrentSession],
  );
  /*
   * 语音口令「退下」经桥接事件回来，而那个订阅挂在只跑一次的大 effect 里
   * （依赖只有稳定的 appendMessage，见它的注释）——直接闭包捕获会捕到第一版。
   * 与 `sendTextRef` / `loadSessionsRef` 同一形态。
   */
  const endCurrentSessionRef = useRef(endCurrentSession);
  endCurrentSessionRef.current = endCurrentSession;

  /**
   * 收编 Rust 侧因 409 新建的会话（M25-03）。
   * 暖暖休息时绑定会话往往已过期；唤醒指令不能丢，Rust 已新建并重发，
   * 这里把前端的会话所有权切过去：换存储、切流、拉新会话的历史。
   */
  const adoptSession = useCallback(async (sid: string) => {
    rememberSession(sid);
    sessionIdRef.current = sid;
    setCurrentSessionId(sid);
    setViewing(null);
    setMessages([]);
    setStreaming(null);
    setLastInteractionAt(Date.now());
    try {
      await invoke("start_session_stream", { sessionId: sid });
      // PTT 收编也要让哨兵跟上；否则下一次免手指令仍会打到旧会话。
      invoke("sentinel_bind_session", { sessionId: sid }).catch(() => {});
      const history = await invoke<ChatMessage[]>("refresh_history", { sessionId: sid });
      setMessages(history);
    } catch (err) {
      console.warn("[sentinel] 收编新会话失败", err);
    }
  }, []);

  /**
   * 上车声明刚建出来的会话直接接管（M50-02）。
   *
   * 车机建会话的唯一入口是那道门（车辆级 token 必须显式声明谁在用，M48-05），
   * 所以这条不是"顺手复用"，是车机拿到 sid 的**正路**。
   * 依赖只挂 sid：`adoptSession` 是稳定引用，声明一次只接管一次。
   */
  useEffect(() => {
    if (!declaredSessionId) return;
    void adoptSession(declaredSessionId)
      .catch((err) => console.warn("[session] 接管上车声明的会话失败", err))
      .finally(() => {
        /*
         * 声明落地即重拉个人域数据（2026-09-02 iPad 走查：主页行程要等一分钟）。
         *
         * 本组件与 BoardingGate 同时挂载，HUD 源一订阅就去拉行程，而那一跳赶在
         * `create_session_as` 之前——`acting::session()` 还是 None，请求不带
         * `x-carlife-session`，网关按"没有人"回 401（导览任务面同一时刻同一原因）。
         * 401 只置 stale，声明完成后没人再拉，只能等 60s 轮询的下一拍：
         * 网关日志里三次冷启动 401 → 首次 200 都是精确 60 秒。
         * `fetch_trip_plan` 每次都 `GatewayClient::new`，这里重拉自然带上新头。
         * 放在 finally：接管失败不影响"现在已经有身份了"这件事。
         */
        const src = sourceRef.current;
        if ("refresh" in src) (src as GatewayHudSource).refresh();
        void refreshGuideJobs();
      });
  }, [declaredSessionId, adoptSession, refreshGuideJobs]);

  /**
   * 点开左侧列表里的一条会话（M28-01）。
   *
   * **两条路，判据是"服务端还收不收这条会话的消息"**（`sessionResumable`，
   * 与网关的 `checkSessionUsable` 同一条，含边界方向）：
   *
   *  - 还能接着说 → 把会话所有权切过去（存储 / 流 / 哨兵一起换），继续对话；
   *  - 已经结束 → **只回看**，一个都不换。
   *
   * 分不清这两条的代价是具体的：给一个躺了两天的会话摆出输入框，车主打完字
   * 发出去才拿到 409，端上默默换了个新会话——他以为自己在续上一段对话，
   * 实际是在一段空对话里说话，而屏幕上还留着旧的气泡。
   */
  const openSession = useCallback(
    async (row: SessionBrief) => {
      if (row.sessionId === sessionIdRef.current) {
        setViewing(null);
        return;
      }
      let history: ChatMessage[] = [];
      try {
        history = await invoke<ChatMessage[]>("refresh_history", { sessionId: row.sessionId });
      } catch (err) {
        // 拉不到就什么都不做——**不要半切**：切了流却没有历史，
        // 屏幕上会是一段空对话，看起来像这条会话的记录丢了。
        console.warn("[session] 历史读取失败，保持原状", err);
        setSessionsError("这段对话读不出来");
        return;
      }

      if (!sessionResumable(row, Date.now())) {
        setViewing({ sessionId: row.sessionId, messages: history });
        return;
      }

      // 接着聊：与 `adoptSession` 同一套动作。**顺序照抄**——
      // 先落存储与 ref，再起流、再绑哨兵，中途失败也不会留下"ref 指向 A、流在 B"。
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
    },
    [],
  );

  const exitViewing = useCallback(() => setViewing(null), []);

  /*
   * 给左栏的两个回调过一遍 useCallback：SessionList 里"没占满就再要一页"的 effect
   * 以 onLoadMore 为依赖，裸箭头函数会让它每次渲染都重跑一遍判断。
   * 判断本身有 loading/hasMore 闸，不至于风暴，但没必要空转。
   */
  const onSelectSession = useCallback((row: SessionBrief) => void openSession(row), [openSession]);
  const onLoadMoreSessions = useCallback(() => void loadSessionsRef.current?.(false), []);

  /**
   * 左栏「新建对话」（走查 2026-08-29 ①）：会话被闲置软关闭后，人站在对话层里
   * 没有任何主动另起一段的入口——「退下」在 HUD 层，且语义是"结束"（会 close 旧会话）。
   * 这里**不关旧会话**：旧的留在列表里还能接着聊，关不关交给服务端的空闲判定。
   *
   * **点它不建会话，只是把手上这段放下**（M50-02）：真正的新会话在下一句话时现建。
   * 原先点一下就 `create_session`，点完不说话就留下一个零消息会话——
   * 而屏幕上的表现（清空的对话层）两种做法完全一样。
   * 防连点也随之不需要了：这条路上没有任何网络请求。
   */
  const onNewSession = useCallback(
    () => endCurrentSession({ close: false }),
    [endCurrentSession],
  );

  const sendText = useCallback(async (content: string) => {
    const sid = await ensureUsableSession();
    setLastInteractionAt(Date.now());
    try {
      await invoke("send_text_message", { sessionId: sid, content });
    } catch (err) {
      /*
       * **服务端才是权威**（M22-01）：端上那份计时器只管形象。
       * 端上算漏了（比如车机休眠期间计时器没跑）时，这里会拿到 409；
       * 换一个会话重发一次，而不是把车主的话丢掉。
       */
      if (!String(err).includes(SESSION_EXPIRED)) throw err;
      const fresh = await startNewSession();
      await invoke("send_text_message", { sessionId: fresh, content });
    }
  }, [ensureUsableSession, startNewSession]);
  // 上面 onNavEnd 经 ref 用它（声明顺序所迫，见那里的说明）。
  sendTextRef.current = sendText;


  const appendMessage = useCallback((m: ChatMessage) => {
    setMessages((prev) =>
      prev.some((x) => x.messageId === m.messageId) ? prev : [...prev, m],
    );
    // 新一轮从用户这条消息开始：上一轮的"部分结果"横幅到此为止（M37-01）。
    // 留着它会把上一轮的缺失标到这一轮头上，变成假警报。
    if (m.role === "user") branchFaults.reset();
    // 用户说的与助手回的**都算交互**：D1 定的是"空闲 30 分钟"，
    // 不是"两次发言间隔"。助手长回答期间不该被判成空闲。
    setLastInteractionAt(Date.now());
    // 助手完整回复到达 → 该轮流式气泡结束
    if (m.role === "assistant") {
      setStreaming((s) => (s && s.turnId === m.turnId ? null : s));
      // 本轮收口：进展一律清掉。**不能只靠工具自己的 succeeded**——
      // 分支超时那一路的完成事件根本不会来，留着就是一句永远挂在那的"正在查天气"。
      toolProgress.reset();
      // 本轮已经收官还挂着弹窗 = 服务端那头已收敛（超时按"未确认=不执行"）——
      // 留着它用户按下去也只会得到 interrupt_expired，收起。
      setPermission(null);
      /*
       * 行程状态可能刚被这轮对话改掉（M28-02）。"定下来"走确认层，批准后有
       * decidePermission 里那次立即刷新；**"取消/改期"不弹确认层，没有任何
       * 刷新触发器**，HUD 只能等 60s 轮询的下一拍——实测取消后地图挂着
       * 已不存在的行程最多一分钟。所以每轮回复落地都刷一次：
       * 接口实测 3~6ms，一轮一次没有成本；比枚举"哪些话会改行程"可靠得多。
       * source 经 ref 取（见 sourceRef 的注释），不进本回调的依赖。
       */
      const src = sourceRef.current;
      if ("refresh" in src) (src as GatewayHudSource).refresh();
    }
    /*
     * **依赖只挂 `toolProgress.reset`，不挂整个 `toolProgress`**（M28-01 事故修复）。
     *
     * `useToolProgress()` 每次渲染返回一个新对象（progress 是派生值，天然每次都新），
     * 挂整个对象等于让本回调每次渲染都换身份；而下面那个订阅 + bootstrap 的大 effect
     * 又以本回调为依赖——于是**每次渲染都重跑整段 bootstrap**：重新订阅桥接事件
     * （异步 cleanup 赛跑，经常漏退订）、重新 refresh_history、重新起流。
     *
     * 这个循环存量就在（gateway 日志里几 MB 的 refresh_history 刷屏），但每轮只孵出
     * 约一次渲染，勉强稳态；M28-01 在 bootstrap 里加了会话列表拉取（一轮多出四五个
     * setState）之后增殖系数 > 1，变成指数风暴，几秒内把 WebView 内存耗尽——
     * 表现是**发一条消息后整屏变白**，而白屏上没有任何报错。
     *
     * `reset` 是 useCallback([]) 出来的稳定引用，本回调用到的也只有它。
     * branchFaults.reset 同一形态（useBranchFaults 返回值 memo，reset 稳定）。
     */
  }, [toolProgress.reset, branchFaults.reset]);

  const decidePermission = useCallback(
    async (approved: boolean) => {
      const sid = sessionIdRef.current;
      if (!sid || !permission) return;
      setPermissionBusy(true);
      /*
       * resume 失败必须**说出来**（M13-12 实测）。
       *
       * 原先这里只写一行 console.warn 然后照常收起弹层：车主看到的是
       * "点了确认、窗关了"，于是以为定了——而实际上什么都没发生。
       * 那次的成因是服务端进程在确认挂起期间重启（挂起在内存里，随进程消失），
       * 但成因不重要：**任何一次 resume 没被接住，都不能表现得像成功**。
       *
       * 失败时弹层不收、改成告知态；只有确实被接住才收起。
       */
      try {
        const accepted = await invoke<boolean>("resume_interrupt", {
          sessionId: sid,
          interruptId: permission.interruptId,
          approved,
        });
        if (!accepted) {
          setPermissionNotice(
            "这次确认没有生效——服务端已经不在等这条确认了（多半是超时或服务重启）。行程没有保存，请再说一次。",
          );
          return;
        }
      } catch (err) {
        console.warn("[hitl] resume 发送失败", err);
        setPermissionNotice("确认没能送达（网络或服务异常）。行程没有保存，请稍后再说一次。");
        return;
      } finally {
        setPermissionBusy(false);
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
    subscribeBridge({
      onAssistantState: (s) => setServerAvatarState(s),
      onDelta: (d) =>
        setStreaming((prev) =>
          prev && prev.turnId === d.turnId
            ? { turnId: d.turnId, text: prev.text + d.text }
            : { turnId: d.turnId, text: d.text },
        ),
      onMessage: appendMessage,
      onToolCall: toolProgress.onToolCall,
      // 分支起止（M37-01）：failed/timeout 聚合成"部分结果"横幅的数据源。
      onBranch: branchFaults.onBranch,
      onConnection: (c) => setConnection(c.state),
      /*
       * 采集状态（走查 2026-08-29 ②）：只关心权限相关的两条。
       *  - started：真录上了，说明权限已到手——把"未授权"的文字说明收掉；
       *  - failed(permission_denied)：重查一次系统状态（undetermined→denied
       *    的迁移只有系统知道），让暖暖的说明从"长按弹授权框"换成"去设置开"。
       */
      onCaptureStatus: (s) => {
        if (s.kind === "started") {
          setMicPermission("granted");
          // 录上了就把上一次的失败说明收掉，别让旧错误挂在卡上。
          setCaptureFault(undefined);
        } else if (s.kind === "failed") {
          setCaptureFault(s.reason);
          if (s.reason.startsWith("permission_denied")) void refreshMicPermission();
        }
      },
      onPermission: (p) => setPermission(p),
      onWakeStatus: (w) => {
        switch (w.kind) {
          case "woken":
            // 命中即亮：带指令时消息很快落库接管形象，这里先给 10s 的桥
            setWakeUntil(Date.now() + 10_500);
            break;
          case "listening_window":
            // 与 Rust 侧 WindowConfig 默认值（10s/5s）保持镜像，各 +500ms 余量
            setWakeUntil(w.open ? Date.now() + 10_500 : 0);
            break;
          case "followup_window":
            if (w.open) setWakeUntil(Date.now() + 5_500);
            break;
          case "dismissed":
            // 服务端已软关闭；端上走与「退下」按钮相同的收尾（不再 close 一次，
            // 也**不预建下一个**——下一句话由 ensureUsableSession 现建，M50-02）。
            setWakeUntil(0);
            void endCurrentSessionRef
              .current?.({ close: false })
              .catch((err) => console.warn("[sentinel] 退下收尾失败", err));
            break;
          case "session_adopted":
            void adoptSession(w.session_id);
            break;
          case "sentinel_degraded":
            // 降级/恢复的可见状态走 voice:sentinel 快照；这里不用重复处理
            break;
          case "sidecar_switched":
            /*
             * 车主用语音拨了闲聊旁路的开关（M33-04）。这里只**记下来**，
             * 交给设置页显示——本层不改任何行为：偏好已经在 Rust 侧改完了。
             * 不记的话，设置页开着时说「不要废话了」，那个开关还亮着，
             * 用户看到的是"我说了它没听"。
             */
            setSidecarOn(w.on);
            break;
        }
      },
      onSentinelStatus: (s) => setSentinelInd(s),
      /*
       * 会话标题（M28-01）。事件走的是**当前会话**那一路 SSE，
       * 所以归属就是 `sessionIdRef.current`——载荷里不带 sessionId 是刻意的
       * （封套上有，桥接层只把 payload 递上来）。
       *
       * 就地改那一行，不整页重拉：重拉会把列表滚动位置弹回顶部，
       * 而首轮刚结束时车主的手很可能正停在列表上。
       * 列表里还没有这一条（新会话）时补一条占位——不补的话，
       * 名字起好了却要等下次进页面才看得见。
       */
      onSessionTitle: (t) => {
        const sid = sessionIdRef.current;
        if (!sid) return;
        setSessions((prev) => {
          const hit = prev.some((x) => x.sessionId === sid);
          if (hit) {
            return prev.map((x) => (x.sessionId === sid ? { ...x, title: t.title } : x));
          }
          const now = new Date().toISOString();
          return [
            {
              sessionId: sid,
              title: t.title,
              createdAt: now,
              updatedAt: now,
              closedAt: null,
              messageCount: 0,
            },
            ...prev,
          ];
        });
      },
    }).then((un) => {
      cleanup = un;
    });

    const bootstrap = async () => {
      /*
       * 1) 上次那个会话还能不能接着用。判定在 `data/bootstrapSession.ts`（纯函数，
       *    可单测）——**它只会给出"接着用"或"手上没有会话"，没有"新建"那一支**。
       *    太旧就不复用的理由见 M22-03：复用一个三天前的会话，
       *    就是让模型带着三天前的结论继续说话。
       */
      const stored = localStorage.getItem(SESSION_STORAGE_KEY);
      const storedCreatedAt = stored ? storedSessionCreatedAt(stored) : undefined;
      let history: ChatMessage[] | null = null;
      if (stored) {
        history = await invoke<ChatMessage[]>("refresh_history", { sessionId: stored }).catch(
          () => null,
        );
      }
      const plan = planBootstrap({ stored, createdAt: storedCreatedAt, history, now: Date.now() });
      let sid: string | null = null;
      if (plan.kind === "resume") {
        sid = plan.sessionId;
        setMessages(history ?? []);
        setLastInteractionAt(history?.[history.length - 1]?.ts);
        console.info(`[session] 复用 ${sid}（历史 ${history?.length ?? 0} 条）`);
      } else {
        console.info(`[session] 不复用上次会话（${plan.reason}）`);
      }
      /*
       * **引导只复用，不新建**（M50-01/02）。
       *
       * 这里原先是"复用不了就 `create_session`"——于是开机即建：启动后没说话、
       * 或者又重启一次，那个会话就永远零消息地挂在库里（服务端是懒关闭，
       * 没人再访问它就永远不落 `closed_at`）。2026-08-31 读 dev 库：
       * 双胞胎修掉之后仍剩 18 个这么来的空会话。
       *
       * 建会话统一交给 `ensureUsableSession`——它建完立刻就发消息，从不留下空会话。
       * 车机还有一条：上车声明产出的 sid 由 `adoptDeclaredSession` 直接接管。
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
        console.info(`[session] 流已启动 ${sid}`);
        // 哨兵跟上这段对话（M25-02）。没有会话时不绑——见下面 sentinel_start 的说明。
        invoke("sentinel_bind_session", { sessionId: sid }).catch(() => {});
      }
      /*
       * 哨兵监听（M25-01/02）：**没有会话也要启动**。
       *
       * 这条与"绑定"分开：绑定要有会话才有意义，而启动是"开始听"——
       * 懒建之后"还没有会话"是常态，此时不开麦就等于喊了名字没人应，
       * 而那正好是车主最容易判成"坏了"的现象。无会话时的唤醒指令由
       * Rust 侧发 `session_required` 事件回来，见下面的处理。
       */
      invoke<boolean>("sentinel_start")
        .then((started) => console.info(`[sentinel] ${started ? "已启动" : "已在运行"}`))
        .catch(() => {});
      // 左侧历史（M28-01）。**放最后且不 await**：列表拉不到不该挡住对话可用。
      void loadSessionsRef.current?.(true);
    };
    /*
     * **整段引导走在飞闸**（M50-01）。
     *
     * 两个端都包在 `<React.StrictMode>` 里，React 18 的开发构建会把每个 effect
     * 跑成 effect → cleanup → effect；而上面这段从「读 localStorage 的旧 sid」到
     * 「`rememberSession` 写回」之间全是 await，**中间没有互斥**——两次运行都读到
     * 同一个旧值、都判"不可复用"、于是各建一个会话，后完成的覆盖存储，
     * 先建的那个零消息且永不关闭（服务端是懒关闭），从此挂在会话列表里。
     *
     * 2026-08-31 读 dev 库：73 个零消息会话里 55 个是这么来的，
     * 而且按「相隔 <100ms」聚类**每一簇恰好 2 个**——这是"一个 effect 跑了两遍"
     * 的签名，不是重启多。cleanup 只退订桥接事件，**取消不了在飞的 bootstrap**，
     * 所以闸必须挡在这里而不是靠 cleanup。
     */
    sessionInflight
      .run(INFLIGHT_BOOTSTRAP, bootstrap)
      .catch((err) => console.warn("[session] 引导失败（网关未启动？）", err));

    return () => cleanup?.();
  }, [appendMessage]);

  const voice = useMemo(
    () =>
      createVoicePort(
        () => sessionIdRef.current,
        (outcome) => {
          console.info("[voice] 已上传", outcome);
          if (outcome.sessionId) {
            void adoptSession(outcome.sessionId).catch((err) =>
              console.warn("[voice] 收编新会话失败", err),
            );
          }
        },
      ),
    [adoptSession],
  );

  /*
   * 地图视图记忆：上次把地图拖到哪，下次打开还在哪。
   *
   * 放在 App 而不是 HudScreen 里，是因为它有**两个消费者**：主页那张底图，
   * 以及设置页里点「立即定位」之后要把镜头挪过去。各拿一份的话，
   * 在设置里定位完回到主页，地图还停在原处。
   */
  const mapView = useMapViewport();

  const carousel = useCarousel(view.tips.pages.length);
  const assistant = useAssistantInteraction({
    // 服务端事件流优先（M2-04），HUD mock 快照兜底；本地交互态在 hook 内仍最优先。
    externalState: serverAvatarState ?? view.assistantState,
    voice,
    /*
     * **不传 onOpenDialog**——车机端进对话只有底部导航的「对话」按钮一条路。
     *
     * Brief §3.4 原本是"点击助手进对话、长按说话"，两种手势共用同一块区域。
     * 那在鼠标上成立，在触屏上不成立：iPad 走查里想说话的 press 稍短就被判成
     * 点击，屏幕当场翻去对话页；而车主的手正搭在方向盘边上，很难控制按多久。
     * 判错的代价也不对称——想说话却跳走，比"点了没反应"难受得多。
     * 所以助手身上只留长按说话，进对话交给一个不会被误触的显式按钮。
     */
    /*
     * 单击 = 打断（施工单 M33-02）。这块区域此前点了什么都不发生，正好空着。
     *
     * **只在她真的在说 / 在想的时候才生效**：空闲时点一下应该什么也不做，
     * 而不是发一次没有目标的取消。这既是产品判断，也是约束 1 的降级方案——
     * 万一单击与长按在某台设备上分不干净，长按说话时形象不是 speaking/thinking，
     * 天然不会被误判成打断。
     *
     * 判定用的是**服务端事件流给的状态**（`serverAvatarState`），不是 hook 的
     * 本地交互态：后者在长按过程中会变成 listening/thinking，拿它判会把
     * "长按刚结束"也算成可打断。
     */
    /*
     * 长按被拒时的原因（2026-09-02）。`voice:capture` 的 failed 事件盖不全所有路径——
     * `already_recording` 那条在 Rust 侧直接返回 Err、不发事件，只有 invoke 的 reject 里有。
     * 两条都收到这里，卡上才不会出现"按了没反应且没有交代"。
     */
    onVoiceError: (reason) => setCaptureFault(reason),
    onTap: () => {
      if (!isTauriEnv()) return;
      if (serverAvatarState !== "speaking" && serverAvatarState !== "thinking") return;
      void invoke<boolean>("interrupt_assistant_cmd").catch((err) => {
        // 打断失败不弹窗：车主要的那件事（别说了）在 Rust 侧已经同步做完了
        console.warn("[interrupt] 打断请求失败", err);
      });
    },
  });

  return (
    <>
      {/* HUD 保持挂载：切层往返不丢状态机与轮播上下文 */}
      <div style={{ display: nav === "hud" ? "contents" : "none" }}>
        <HudScreen
          theme={theme}
          home={home}
          snapshot={{ ...view, assistantState: assistant.state }}
          tipsPage={carousel.page}
          tipsGestureProps={carousel.gestureProps}
          assistantGestureProps={assistant.gestureProps}
          /*
           * 未授权的文字说明（走查 2026-08-29 ②）。两种未授权文案不同：
           * undetermined 长按会弹系统框，denied 长按只能带去系统设置——
           * 写反了车主会照着做然后发现"它说的事没发生"。
           */
          assistantHint={
            micPermission === "denied"
              ? { primary: "麦克风未授权", secondary: "长按打开系统设置，允许使用麦克风" }
              : micPermission === "undetermined"
                ? { primary: "麦克风待授权", secondary: "长按并在系统弹窗中允许" }
                : /*
                   * 其余失败原样说出来（2026-09-02）：原文里带着是哪一步断的
                   * （`device_busy: setCategory(playAndRecord) 失败` 这种），
                   * 排障时它就是唯一的线索，压成一句"录音失败"等于把线索删了。
                   */
                  captureFault
                  ? { primary: "这次没录上", secondary: captureFault }
                  : undefined
          }
          tripMap={tripMap}
          departurePlan={plan}
          mapView={mapView}
          assistantMode={assistantMode({
            messageCount: messages.length,
            lastInteractionAt,
            // `clock` 只是让这个派生值随时间重算；判据本身用的是真实 now。
            now: Math.max(clock, Date.now()),
            wakeUntil: wakeUntil || undefined,
          })}
          mic={
            sentinelInd
              ? {
                  // suspended（PTT/播报/流未建）对用户就是"未在收音"
                  state: sentinelInd.state === "suspended" || sentinelInd.state === "off"
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
          onAssistantDismiss={isTauriEnv() ? dismissAssistant : undefined}
        />
      </div>

      {/* 导览采集进度卡（M40-02）：右下小卡，导览页开着时让位；只列未完成的（见 outstandingGuideJobs）。 */}
      {nav === "hud" && !guide && guideJobsOutstanding && guideJobsOutstanding.spots.length > 0 && (
        <div className="hud-guide-jobs-slot">
          <GuideJobsPanel jobs={guideJobsOutstanding} onFetch={fetchGuideSpot} onOpen={openGuide} />
        </div>
      )}

      {/* 景区导览页（M36-03）：覆盖层压在 HUD 之上，返回即关，HUD 状态不丢。 */}
      {nav === "hud" && guide && (
        <GuideScreen
          spotName={guide.spot}
          state={guide.state}
          onBack={closeGuide}
          onRetry={() => openGuide(guide.spot)}
          onRegenerate={() => openGuide(guide.spot, { force: true })}
        />
      )}

      {nav === "dialog" && (
        <DialogScreen
          /*
           * 回看态下摊的是那段历史，且**没有流式气泡、没有工具进展**（M28-01）：
           * 那两样讲的都是"此刻正在发生什么"，而此刻正在发生的事属于当前会话，
           * 不属于屏幕上这段已经结束的对话。
           */
          messages={viewing ? viewing.messages : messages}
          streaming={viewing ? null : streaming}
          progress={viewing ? null : toolProgress.progress}
          /*
           * 部分结果横幅与流式/进展同一回看纪律（M28-01）：它讲的是"此刻这轮
           * 缺了什么"，回看历史时不显示——历史里的缺失已经写在当时的正文里。
           */
          branchFaults={viewing ? undefined : branchFaults.faults}
          connection={connection}
          onSendText={isTauriEnv() ? sendText : undefined}
          broadcast={isTauriEnv() ? { enabled: broadcast, onToggle: toggleBroadcast } : undefined}
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
      )}

      {/* 档案页（M14-05 / M14-06）。没有页内返回按钮：换页出口统一在底部导航
          （2026-08-28 产品定调，见 OwnershipScreen 文件头）。 */}
      {nav === "profile" && (
        <OwnershipScreen
          theme={theme}
          onActiveVinChange={(vin, model) => {
            setActiveVin(vin);
            if (model) setActiveModel(model);
          }}
          // 档案页数据到位 → 过场从"一直开"转到"开走"（见 DriveTransition 文件头）
          onReady={() => setProfileReady(true)}
          onDeclareSeating={isTauriEnv() ? (t) => void sendText(t) : undefined}
          collect={
            // 演示入口也给一张采集卡：定稿右列有它，缺了那格 diff 会一路错位。
            // 它只在 ?profile=demo 下出现，开关是空操作（见 demoVehicleProfile.ts）。
            profileDemo
              ? { enabled: true, onToggle: () => {} }
              : isTauriEnv()
              ? {
                  enabled: tripCollect,
                  onToggle: () => {
                    const next = !tripCollect;
                    void invoke<boolean>("set_trip_collect_enabled", { enabled: next }).then(setTripCollect);
                  },
                }
              : undefined
          }
        />
      )}

      {/*
        「开车去档案」过场（主页 → 档案）。挂在 HITL 之前 = z 序在它之下：
        确认弹层任何时候都必须压在最上面，一段过场动画不该盖住有后果的确认。
      */}
      {driving && (
        <DriveTransition
          ready={profileReady}
          theme={theme}
          model={activeModel}
          onDone={() => setDriving(false)}
        />
      )}

      {/* HITL 确认弹层：HUD 与对话层都可见（M13-05）。 */}
      {(permission || demoPermission) && (
        <ConfirmSheet
          request={permission ?? DEMO_PERMISSION}
          busy={permissionBusy}
          notice={permissionNotice}
          onDismissNotice={() => {
            setPermissionNotice(undefined);
            setPermission(null);
            setDemoPermission(false);
          }}
          // 演示弹层没有真实中断点，resume 会拿到 interrupt_expired——直接收起。
          onDecide={permission ? decidePermission : () => setDemoPermission(false)}
        />
      )}

      {/* 网关连接设置（ACR-004 第 3 步）：iOS 首启自动弹（引导语境），其余经「设置」按钮 */}
      <SettingsSheet
        open={settingsOpen}
        firstRun={settingsFirstRun}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsFirstRun(false);
        }}
      />

      {/* 设置页（M33-05）。与档案页同级的整页形态；iOS 首启引导仍是弹层
          （见下面的 SettingsSheet）——那时候不该先教用户认底部导航。 */}
      {nav === "settings" && (
        <SettingsScreen
          theme={theme === "dark" ? "dark" : "light"}
          sidecarOn={sidecarOn}
          // 哨兵总开关的真相源是 Rust 的指示快照——设置页与 HUD 麦克风图标
          // 拨的是同一个开关，两边显示必须由同一个事实驱动（M60-01）。
          sentinelOn={sentinelInd?.switchOn}
          onLocated={(fix) => mapView.focusOn({ lat: fix.lat, lon: fix.lon, zoom: 15 })}
        />
      )}

      <BottomNav
        active={nav}
        onSelect={(next) => {
          /*
           * 从**任何页面**切进档案都放过场（理由见 `driving` 的声明处）；
           * 已在档案页时不算"进入"，不重放。
           * 起过场的同时把 ready 归零：上一次留下的 true 会让这一趟
           * 刚开进画面就立刻开走，看起来像闪了一下。
           */
          if (next === "profile" && nav !== "profile") {
            setProfileReady(false);
            setDriving(true);
          } else if (next !== "profile") {
            /*
             * 过场途中改主意（点了档案又立刻点主页/对话）：**立刻撤遮罩**。
             * 不撤的话它会接着把动画放完，而那一秒盖住的是用户真正想去的那一页——
             * 表现为"点了没反应"，正是这一层本来要治的病。
             */
            setDriving(false);
          }
          setNav(next);
        }}
        profileDisabled={false}
        // 第四项只给车机（M33-05）：手机端不传即维持三项，一行不用改。
        showSettings
      />

      {/*
        验收用临时开关，非最终产品交互（工单 M1-02 任务 3）。
        **只在主页出现**：它是 fixed 定位的，压在对话与档案的内容之上，
        而那两页本身有完整的操作面——一个演示用的浮层挂在那里，
        既挡内容又让人以为是产品功能。
      */}
      <div
        className="hud-devbar"
        style={nav !== "hud" || profileDemo || hitlDemo ? { display: "none" } : undefined}
      >
        <button
          type="button"
          className="hud-devbar-toggle"
          aria-expanded={devbarOpen}
          onClick={() => setDevbarOpen((v) => !v)}
        >
          <span className="hud-devbar-chevron" aria-hidden="true">
            ›
          </span>
          功能演示
        </button>
        {devbarOpen && (
        <div className="hud-devbar-row">
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          主题：{theme}
        </button>
        {/* 走查用：在全部天气种类之间轮转，逐个看图标（M20-05） */}
        <button
          onClick={() =>
            setWeather(WEATHER_KINDS[(WEATHER_KINDS.indexOf(weather) + 1) % WEATHER_KINDS.length])
          }
        >
          天气：{WEATHER_LABELS[weather]}
        </button>
        {isTauriEnv() && (
          <button
            onClick={() => {
              // M2-04 验收：标准样例序列走真实 fan-out 路径（thinking→delta→idle + 消息落缓存）
              void invoke("start_mock_stream");
            }}
          >
            回放 Mock 流
          </button>
        )}
        <button onClick={() => setStale(!stale)}>
          数据：{stale ? "更新中" : "正常"}
        </button>
        {/* 行程演示（M13-06）：浏览器没有 Tauri invoke，这是真实地图标注层
            能在浏览器里被走查的唯一路径。数据名称自带「演示」字样。 */}
        <button onClick={() => setDemoPlan((v) => !v)}>
          行程演示：{demoPlan ? "开" : "关"}
        </button>
        {/*
          演示车速（M31-03）：把几小时的车程压进现场能演完的时长。
          它**只压缩时间不改变路径**（nav-position.ts 有单测钉住），
          且顶栏恒显「演示车速 ×N」——车并没有真的在那个位置。
        */}
        <button onClick={() => setDemoNav((v) => !v)}>
          跟车演示：{demoNav ? "开" : "关"}
        </button>
        <button onClick={() => setNavSpeedup((v) => NAV_SPEEDUPS[(NAV_SPEEDUPS.indexOf(v) + 1) % NAV_SPEEDUPS.length]!)}>
          演示车速：×{navSpeedup}
        </button>
        {/* 确认弹层演示（M13-05 视觉重做）：弹层只在真实动作触发时闪现一次，
            这是横屏/竖屏/双主题版式能被走查的唯一路径。数据自带「演示」字样。 */}
        <button onClick={() => setDemoPermission((v) => !v)}>
          确认弹窗：{demoPermission ? "开" : "关"}
        </button>
        {isTauriEnv() && (
          <>
            {/*
              ⑥用车流水（M11-01）。**标题写死"模拟"两个字**：
              真实采集要接车辆信号（点火/熄火/里程表/SOC），而那一层还没有。
              一个只写"上报行程"的按钮会让人以为系统在自动采集，
              而"以为在采集其实没有"会让画像按一份不完整的样本算出看起来正常的数字。
            */}
            <button
              title="POC 期为模拟触发：合成一段行程并上报。真实采集需接车辆信号。"
              onClick={() => {
                void invoke<{ accepted: number; pending: number; note: string }>("record_trip", {
                  distanceKm: 18.4,
                  minutes: 42,
                  roadType: "city",
                  ambientTempC: 28,
                }).then((r) => setTripNote(`${r.note}（已收 ${r.accepted}，待发 ${r.pending}）`));
              }}
            >
              模拟上报行程
            </button>
            <button
              onClick={() => {
                const next = !tripCollect;
                void invoke<boolean>("set_trip_collect_enabled", { enabled: next }).then((v) => {
                  setTripCollect(v);
                  setTripNote(v ? "采集已开启" : "采集已关闭——不会再产生任何上报请求");
                });
              }}
            >
              采集：{tripCollect ? "开" : "关"}
            </button>
            {tripNote && <span className="hud-devbar-note">{tripNote}</span>}
          </>
        )}
        {/*
          事实补录询问（§4.6，US-53）。它是**顺带问**的：没有独立的提问界面，
          问句挂在一次正常用车问答的末尾。所以这个按钮做的事就是发起那一次
          正常问答，而不是"弹一个补录框"——弹框会把要演示的东西演示掉。

          前提是这辆车的 ④ 真的陈旧。答完之后它就新鲜了，再点不会再问；
          要重来跑 `corepack pnpm demo:reset && corepack pnpm demo:seed`。
        */}
        {isTauriEnv() && (
          <button
            title="发起一次正常的用车问答；若 ④ 档案确实陈旧，助手会在回答末尾顺带问一句里程与上次保养。数据不陈旧时不会问——这是设计如此。"
            onClick={() => {
              setNav("dialog");
              void sendText("我这车最近开着感觉有点费电，正常吗？");
            }}
          >
            车辆数据更新
          </button>
        )}
        </div>
        )}
      </div>
    </>
  );
}
