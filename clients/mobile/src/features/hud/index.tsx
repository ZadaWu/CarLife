/**
 * 手机端 HUD 首页（施工单 A3，对齐 FL-01；M65-01 对齐车机 34 项清单）。
 *
 * 与 cockpit 的 HudScreen 用**同一套** `@carlife/ui` 组件、同一套精灵资产、同一份行程地图入参
 * （`HudTripMapProps`）与同一份精灵语义映射（`spriteFor`）。差异只有排布：
 * 手机是竖屏为主，默认走 `PortraitTimeline`，不画 1672:941 的等比生活环（刻意不对齐，见 M65-01 表第 18 项）。
 *
 * 红线（Brief §7-6 / US-01 AC-01-1）：
 *  - HUD 内**不出现任何有后果的动作**，点助手只是进入对话层；
 *  - HUD 层**无文字输入框**。
 *
 * ⚠️ 本文件有**两处** AssistantDock（行程地图模式与默认模式），与车机同一条注释：
 * 只改一处的表现是"进了行程视图暖暖就永远在休息"，而那一屏不报任何错。
 * 行程入口与日期条（M75-02）同一条纪律：两处渲染点都要挂，三态只判一处。
 * （2026-09-12：常驻周日历卡撤了，位置让给「我的行程」按钮 + 抽屉。）
 *
 * # 三态（M75-02，对齐车机 M73-02，竖屏自己的落位）
 *
 * 无行程 → 提示卡；有行程未选中 → 提示卡的槽位换成**紧凑**周日历卡（周条 + 色块，清单在抽屉）；
 * 选中 → 顶部日期条（可 ×）+ 提示卡回到槽位。跟车时不渲染日期条（顶部是下一站与 ETA）。
 */
import { useCallback, useState } from "react";
import {
  AmapBackdrop,
  AmapTripLayer,
  AssistantDock,
  EnergyCapsule,
  HighlightsCard,
  HudStage,
  LODGING_LABEL,
  LocateButton,
  MicIndicator,
  NavBar,
  EnRouteReminderCard,
  useEnRouteReminders,
  PortraitTimeline,
  SPRITES,
  TipsCard,
  TripDateBanner,
  spriteFor,
  type HudTripMapProps,
  type ListenState,
  type NavTripProgress,
  type ThemeName,
  type UseMapViewportResult,
} from "@carlife/ui";
import { isHighlightsPage, type HudSnapshot, type TripPlanLeg, type TripPlanListEntry } from "@carlife/shared";

export interface MobileHudProps {
  theme: ThemeName;
  snapshot: HudSnapshot;
  tipsPage?: number;
  tipsGestureProps?: Record<string, unknown>;
  tipsFooter?: React.ReactNode;
  assistantGestureProps?: Record<string, unknown>;
  /**
   * 点击时间轴上的某一站 → 景区导览页（M36-04）。开页是**无后果**动作
   * （只读，与点助手进对话层同级），不违反"HUD 内不出现有后果动作"的红线。
   * 地图行程模式下同样接到 `AmapTripLayer.onStopClick`（只对 kind=spot 触发）。
   */
  onSpotClick?: (name: string) => void;
  /** 覆盖暖暖卡片两行文案（走查 2026-08-29 ②：麦克风未授权时挂文字说明）。 */
  assistantHint?: { primary: string; secondary?: string };
  /**
   * 休息 / 办公（M22-03；M65-01 手机端接上）。与五态正交，是**派生值**（本会话有没有说过话），
   * 判据在 `@carlife/ui` 的 `assistantMode`，App 算好传进来。
   */
  assistantMode?: "rest" | "work";
  /** 点「退下」结束这段对话；不给就不渲染那个按钮。 */
  onAssistantDismiss?: () => void;
  /** 地图视图记忆（`useMapViewport()`）；给了就渲染「定位到我」。优先级高于 `home`。 */
  mapView?: UseMapViewportResult;
  /**
   * 车主常住地（M13-10；M65-01 手机端接上）。**没有行程时地图落在这里**，时间轴首格显示城市名。
   * 缺省时地图退回内置默认中心——那只是兜底不是答案。
   */
  home?: { city: string; lat: number; lon: number };
  /** 真实地图行程模式（M13-06；M65-01 手机端接上）；缺省走装饰时间轴。 */
  tripMap?: HudTripMapProps;
  /** 途中提醒（M77-06）：手机端只卡不声。 */
  reminders?: { legs?: TripPlanLeg[]; limitMin?: number };
  /**
   * 「开始行程」入口（2026-09-02，对齐车机的车钥匙挂板）。开的是出发卡（只读：看今天去哪、
   * 规划方案，「开始导航」跳的是高德 App），不下发任何车辆指令——不违反 HUD 红线。
   * 不给就不渲染那颗按钮。
   */
  onDepart?: () => void;
  /**
   * 要不要渲染暖暖与哨兵指示（施工单 M103-02）。默认 true（车机不传）。
   * 2026-09-17 起本组件整个是「行程规划」二级页的内容，暖暖只在主页（`features/home`）——
   * 二级页传 false。两处渲染点插的还是同一个 assistantNode / micNode，只在定义处判空，
   * 与文件头"两处 AssistantDock"那条纪律同源：判一处、挂两处。
   */
  assistant?: boolean;
  /** 哨兵监听指示与麦克风总开关（M60-01，F-52-06 / F-02-08）。状态来自 Rust 快照，页面不推断。 */
  mic?: {
    state: ListenState;
    micEnabled: boolean;
    degraded?: boolean;
    onToggleMic?: (next: boolean) => void;
  };
  /**
   * 行程列表与两态（M75-02）。`entries` 空 → 与没传一样（提示卡照旧）；
   * `selectedPlanId` 有值且在列表里 → 选中态。`onOpenList` 开抽屉（清单与翻页在那里）。
   */
  trips?: {
    entries: readonly TripPlanListEntry[];
    selectedPlanId?: string;
    /** 本地今天（YYYY-MM-DD）。 */
    today: string;
    onSelect: (planId: string) => void;
    onOpenReview: (planId: string) => void;
    onClearSelection: () => void;
    onOpenList: () => void;
  };
}

export function MobileHud({
  theme,
  snapshot,
  tipsPage = 1,
  tipsGestureProps,
  tipsFooter,
  assistantGestureProps,
  onSpotClick,
  assistantHint,
  assistantMode,
  onAssistantDismiss,
  mapView,
  home,
  tripMap,
  onDepart,
  mic,
  trips,
  reminders,
  assistant = true,
}: MobileHudProps) {
  const sprites = SPRITES[theme];
  const { trip, energy, tips, weather, assistantState, freshness, leg } = snapshot;

  /*
   * 跟车进度（M31-03）。**hook 必须在任何 return 之前**——下面的 `if (tripMap)` 是一条早退分支，
   * 把 useState 写在它里面会让两次渲染的 hook 数量不一致，React 直接抛。
   */
  const [navProgress, setNavProgress] = useState<NavTripProgress | undefined>(undefined);
  const navOnProgress = tripMap?.nav?.onProgress;
  const enRoute = useEnRouteReminders({
    active: Boolean(tripMap?.nav),
    navKey: tripMap?.nav?.key,
    legs: reminders?.legs,
    limitMin: reminders?.limitMin,
  });
  const enRouteOnProgress = enRoute.onProgress;
  const handleNavProgress = useCallback(
    (p: NavTripProgress) => {
      setNavProgress(p);
      navOnProgress?.(p);
      enRouteOnProgress(p);
    },
    [navOnProgress, enRouteOnProgress],
  );

  const page = tips.pages[tipsPage - 1] ?? tips.pages[0];
  /*
   * 提示卡窗口里轮播的是**两类卡**（M32-03）：行前物品 / 目的地推荐。
   * 分流收成下面这一个 `windowCard` 变量，而不是在两处渲染点各写一遍三元（与车机同一份纪律）。
   * 没有贴纸的 key 不上卡（M20-02）：有名字没有图的空格子比少推荐一件东西更像故障。
   */
  const pageItems = isHighlightsPage(page)
    ? []
    : page.items
        .filter((it) => sprites.items[it.key] !== undefined)
        .map((it) => ({ ...it, icon: sprites.items[it.key] }));

  /*
   * 三态只判一处（M75-02）：提示卡只在「无行程」或「选中」时渲染；
   * 有行程未选中时它的槽位归紧凑周日历卡。
   */
  const hasTrips = Boolean(trips && trips.entries.length > 0);
  const selectedTrip = trips && trips.selectedPlanId ? trips.entries.find((e) => e.planId === trips.selectedPlanId) : undefined;
  const showTips = !hasTrips || selectedTrip !== undefined;

  const windowCard = !showTips ? null : isHighlightsPage(page) ? (
    <HighlightsCard
      highlights={page.highlights}
      page={tipsPage}
      pageCount={tips.pages.length}
      gestureProps={tipsGestureProps}
      footer={tipsFooter}
    />
  ) : (
    <TipsCard
      weatherIcon={sprites.weather[weather.kind] ?? sprites.weather.sunny}
      headline={tips.headline}
      items={pageItems}
      page={tipsPage}
      pageCount={tips.pages.length}
      gestureProps={tipsGestureProps}
      footer={tipsFooter}
    />
  );

  /*
   * 「我的行程」（2026-09-12）：主页上**不再常驻周日历卡**，日历整张进抽屉，
   * 这枚按钮是它唯一的入口（与原来紧凑卡右上角那枚「全部 N 程 ›」同一个动作）。
   *
   * 为什么撤掉常驻卡：它和车况条一起压在屏幕最下面那 200px 里，两张卡黏在一起
   * （用户 2026-09-12）。日历是"要翻的东西"，翻它的时候人本来就会停下来看，
   * 适合抽屉；主页上留一枚带程数的按钮就够回答"这周有没有安排"。
   *
   * 一程都没有时不渲染：一枚点开是空抽屉的按钮比没有按钮更让人找原因。
   */
  const tripsEntryNode =
    !trips || !hasTrips ? null : (
      <button
        type="button"
        className="hud-trips-entry"
        onClick={trips.onOpenList}
        aria-label={`我的行程，共 ${trips.entries.length} 程`}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
        <span>我的行程</span>
        {/* 程数走琥珀底片：红色纪律里红只给「拥堵」与「读不到」，不给计数角标。 */}
        <em className="hud-trips-entry__count">{trips.entries.length}</em>
      </button>
    );
  const dateBanner =
    trips && selectedTrip && !tripMap?.nav ? (
      <TripDateBanner entry={selectedTrip} today={trips.today} onClose={trips.onClearSelection} />
    ) : null;
  const stageClass = selectedTrip ? "hud-stage--trip-selected" : hasTrips ? "hud-stage--has-trips" : undefined;

  // 哨兵指示：两个布局分支共用一份，贴在暖暖身侧（落点见 hud.css 竖屏段的 `.hud-assistant-mic`）。
  const micNode = assistant === false ? null : mic ? (
    <MicIndicator
      size="cockpit"
      variant="icon"
      className="hud-assistant-mic"
      mode="always-on"
      state={mic.state}
      micEnabled={mic.micEnabled}
      degraded={mic.degraded}
      onToggleMic={mic.onToggleMic}
    />
  ) : null;

  /*
   * 「开始行程」：与助手、哨兵指示一样两个布局分支共用一份（落点见 app.css 的 `.hud-depart-entry`，
   * 暖暖右上那块空档——车机的钥匙挂板也是"落在暖暖头顶偏右的空档"）。
   * ⚠️ 与文件头那条"两处 AssistantDock"同一纪律：只加在一个分支的表现是"进了行程视图入口就没了"。
   */
  const departNode =
    onDepart || tripsEntryNode ? (
      /*
       * 两枚入口同一行：「我的行程」在左（次要，白底描边）、「开始行程」在右（主行动，实心橙）。
       * 一屏只有一个实心橙——底导那枚药丸是导航态，不算主行动。
       * 整行与下面的车况条、再下面的暖暖是同一摞，落点见 app.css 的 `.hud-home-actions`。
       */
      <div className="hud-home-actions">
        {tripsEntryNode}
        {onDepart && (
          <button type="button" className="hud-depart-entry" onClick={onDepart} aria-label="开始行程">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11" />
              <rect x="3" y="11" width="18" height="6" rx="2" />
              <path d="M6 17v2M18 17v2M7 14h.1M17 14h.1" />
            </svg>
            <span>开始行程</span>
          </button>
        )}
      </div>
    ) : null;

  // 手机端点助手 = 进对话层（与车机的"单击打断"是刻意不同的取舍，见 M65-01 表第 27 项）。
  const assistantNode = assistant === false ? null : (
    <AssistantDock
      sprite={sprites.assistant}
      workingSprite={sprites.assistantWorking}
      state={assistantState}
      mode={assistantMode}
      onDismiss={onAssistantDismiss}
      gestureProps={assistantGestureProps}
      primaryLabel={assistantHint?.primary}
      secondaryLabel={assistantHint?.secondary}
    />
  );

  // ── 真实地图行程模式（M13-06）：真实坐标标注 + 路线动画 + 跟车。装饰时间轴整套不渲染——两套坐标系叠加会打架。
  if (tripMap) {
    return (
      <HudStage theme={theme} mode="portrait" className={stageClass}>
        <AmapTripLayer
          theme={theme}
          stops={tripMap.stops}
          showDayBadge={tripMap.showDayBadge}
          closeLoop={tripMap.closeLoop}
          planKey={tripMap.planKey}
          animated={!freshness.stale}
          navKey={tripMap.nav?.key}
          navSpeedup={tripMap.nav?.speedup}
          onNavProgress={tripMap.nav ? handleNavProgress : undefined}
          onFallback={tripMap.onFallback}
          onStopClick={tripMap.onStopClick}
          // 导览已就绪的景点挂「✓ 导览」角标——点之前就知道哪些能看（与车机同一份 AmapTripLayer）。
          guidedSpots={tripMap.guidedSpots}
        />
        {tripMap.nav && <NavBar nav={tripMap.nav} progress={navProgress} />}
        {tripMap.nav && enRoute.card && (
          <EnRouteReminderCard card={enRoute.card} muted onAck={enRoute.ack} onRestDecision={enRoute.decideRest} />
        )}
        {tripMap.tabs.length > 1 && (
          <div className="hud-daytabs" role="tablist" aria-label="行程视图切换">
            {tripMap.tabs.map((t) => (
              <button
                key={String(t.value)}
                type="button"
                role="tab"
                aria-selected={tripMap.active === t.value}
                className={tripMap.active === t.value ? "is-active" : ""}
                onClick={() => tripMap.onSelect(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {tripMap.lodgingNotes && tripMap.lodgingNotes.length > 0 && (
          <div className="hud-lodging" aria-label="住宿安排">
            {tripMap.lodgingNotes.map((l) => (
              <span key={l.day} className="hud-lodging__item">
                <b>D{l.day}·{LODGING_LABEL[l.strategy]}</b>
                {l.note ? `：${l.note}` : ""}
              </span>
            ))}
          </div>
        )}
        {windowCard}
        {dateBanner}
        <EnergyCapsule summary={energy} leg={leg} stale={freshness.stale} updatedAt={freshness.updatedAt} />
        {assistantNode}
        {micNode}
        {departNode}
      </HudStage>
    );
  }

  return (
    // portrait 档位固定：手机不会横过来变成车机，让它按视口比例自适应
    // 反而会在横屏时切成条形屏排布，那套构图是给 1920×720 设计的。
    <HudStage theme={theme} mode="portrait" className={stageClass}>
      <AmapBackdrop
        theme={theme}
        center={mapView?.restored ?? (home ? { lat: home.lat, lon: home.lon } : undefined)}
        zoom={mapView?.restored?.zoom}
        focus={mapView?.focus ?? undefined}
        onViewportChange={mapView?.remember}
      />

      {/* 「定位到我」：只挪镜头，不下发任何指令——不违反 HUD 红线。 */}
      {mapView && (
        <LocateButton
          onLocated={(fix) => mapView.focusOn({ lat: fix.lat, lon: fix.lon, zoom: 15 })}
        />
      )}

      <PortraitTimeline
        weatherIcon={sprites.weather[weather.kind] ?? sprites.weather.sunny}
        origin={{
          anchor: trip.origin.anchor,
          // 没有行程时首格显示常住地而不是通用的「家」（与车机同款）。
          name: home?.city ?? trip.origin.name,
          sprite: spriteFor(sprites, trip.origin),
          origin: true,
        }}
        nodes={trip.nodes.map((node, i) => ({
          anchor: node.anchor,
          name: node.name,
          // 图标按 kind 语义取（M13-04 走查修正）：第 2 天的景点落在 charge 位不该顶着充电桩图标。
          sprite: spriteFor(sprites, node),
          index: i + 1,
          terminal: i === trip.nodes.length - 1,
        }))}
        animated={!freshness.stale}
        onNodeClick={onSpotClick ? (stop) => onSpotClick(stop.name) : undefined}
      />

      {windowCard}
      {dateBanner}

      <EnergyCapsule summary={energy} leg={leg} stale={freshness.stale} updatedAt={freshness.updatedAt} />

      {assistantNode}
      {micNode}
      {departNode}
    </HudStage>
  );
}
