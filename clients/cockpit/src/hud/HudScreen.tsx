/**
 * 车机端 HUD 默认视图（施工单 M1-02 组装；数据与交互由 M1-03 接入）
 *
 * 布局依据 Brief §6：
 *   可读的地理背景 + 有序生活环：家(出发) → ① → ② → ③ → ④
 *   放大卡通助手（点击对话 / 长按说话）   集中行前温馨提示卡（3项/页）
 *                                        预计里程 · 当前电量 · 预计需电量
 */
import { useCallback, useEffect, useState } from "react";

import {
  AmapBackdrop,
  AmapTripLayer,
  AssistantDock,
  HudScene,
  HudStage,
  LifeRing,
  LODGING_LABEL,
  MicIndicator,
  NavBar,
  NODE_ANCHORS,
  PoiNode,
  PortraitTimeline,
  SPRITES,
  HighlightsCard,
  LocateButton,
  StatusBar,
  TipsCard,
  TripCalendarCard,
  TripDateBanner,
  spriteFor,
  type HudTripMapProps,
  type ListenState,
  type NavTripProgress,
  type ThemeName,
  type UseMapViewportResult,
} from "@carlife/ui";

// 行程地图入参、跟车顶栏、精灵语义映射自 M65-01 起在 @carlife/ui（两端共用）；保住 App 的既有 import 路径。
export type { HudNavProps, HudTripMapProps } from "@carlife/ui";

import { CabinArrivalDemo } from "../features/cabin/CabinArrivalDemo";
import type { TripPlanLeg, TripPlanListEntry, TripPlanSnapshot } from "@carlife/shared";
import { EnRouteReminderCard, useEnRouteReminders, type EnRouteEvent, type ReminderDensity } from "@carlife/ui";
import { isHighlightsPage, type HudSnapshot } from "../data/types";

export interface HudScreenProps {
  theme: ThemeName;
  snapshot: HudSnapshot;
  /** 提示卡当前页（1 起）与手势属性，由 M1-03 的容器提供。 */
  tipsPage?: number;
  tipsGestureProps?: Record<string, unknown>;
  tipsFooter?: React.ReactNode;
  assistantGestureProps?: Record<string, unknown>;
  /**
   * 休息 / 办公（M22-03）。与五态正交：办公中仍有那五态。
   * 判据在 `App.tsx`，是**派生值**（本会话有没有说过话），不是另存的状态位。
   */
  assistantMode?: "rest" | "work";
  /** 点「退下」结束这段对话；不给就不渲染那个按钮。 */
  onAssistantDismiss?: () => void;
  /**
   * 覆盖暖暖卡片两行文案（走查 2026-08-29 ②：麦克风未授权时挂文字说明）。
   * 不给就走 AssistantDock 的默认状态文案。
   */
  assistantHint?: { primary: string; secondary?: string };
  /** 真实地图行程模式（M13-06）；缺省走装饰生活环。 */
  tripMap?: HudTripMapProps;
  /**
   * 出发卡的数据源（0830）：HUD 此刻展示的那份行程，透传给出发入口
   * （CabinArrivalDemo）。不给 = 出发卡如实说"还没有已确认的行程"。
   */
  departurePlan?: TripPlanSnapshot | null;
  /**
   * 哨兵监听指示（M25-04，F-52-06）。状态来自 Rust 采集层的真实快照
   * （`voice:sentinel` 事件），**页面不推断**；不给就不渲染（浏览器开发态）。
   */
  mic?: {
    state: ListenState;
    micEnabled: boolean;
    degraded?: boolean;
    onToggleMic?: (next: boolean) => void;
  };
  /**
   * 地图视图记忆（`useMapViewport()`）。给了就：上次拖到哪、下次打开还在哪；
   * 并渲染右下角的「定位到我」按钮。
   *
   * **优先级高于 `home`**：常住地是"没有别的信息时的合理猜测"，而上次的构图
   * 是用户自己摆出来的——他把地图拖到公司门口，下次不该被拽回常住地。
   * 不传（或端上没存过）时行为与此前一字不差。
   */
  mapView?: UseMapViewportResult;
  /**
   * 车主常住地（M13-10）。**没有行程时地图落在这里**，出发锚点显示城市名。
   *
   * 缺省（网关没给／读失败）时地图退回内置默认中心——那是个写死的坐标，
   * 对住在别处的车主就是「地图停在一个他没去过的城市」，所以它只是兜底不是答案。
   */
  home?: { city: string; lat: number; lon: number };
  /**
   * 右上角行程列表（M72-04）。`entries` 为空时**不渲染**且提示卡窗保持原尺寸——
   * 空列表卡比没有更像故障。选中与打开摘要都上抛给 App（卡不碰网络、不做判断）。
   */
  trips?: {
    entries: readonly TripPlanListEntry[];
    /** 选中的那程；空 = 未选中态（周日历卡、无提示卡、地图跟列表首条）。 */
    selectedPlanId?: string;
    /** 本地今天（YYYY-MM-DD）：周条与相对时间的口径。 */
    today: string;
    onSelect: (planId: string) => void;
    onOpenReview: (planId: string) => void;
    /** 顶部日期条的 ×：回未选中态。 */
    onClearSelection: () => void;
  };
  /**
   * 我的座驾（新版 UI 的屏底状态栏）：车型名 + 形象图。形象由档案页的活动车辆决定
   * （`vehicleCharacter`），匹配不到就 undefined，状态栏画中性车图标——不拿别的车顶替。
   */
  vehicle?: { model?: string; art?: string };
  /**
   * 途中提醒（M77-06，FL-62）：跟车中按快照分段与进度出停靠提前 / 连续驾驶提醒。
   * `speak` 不传就只卡片（浏览器走查）；`onRestActive` 让 App 把暖暖切到 alert 态。
   */
  reminders?: {
    legs?: TripPlanLeg[];
    limitMin?: number;
    density?: ReminderDensity;
    enabled?: boolean;
    muted?: boolean;
    speak?: (line: string, kind: "stop" | "rest") => Promise<boolean>;
    isInFlight?: () => boolean;
    onEvent?: (e: EnRouteEvent) => void;
    onRestActive?: (active: boolean) => void;
    /** 语音「闭嘴」的计数信号（M77-07）：每变一次，控制器 hush 一次（本段静默）。 */
    hushSignal?: number;
  };
}

export function HudScreen({
  theme,
  snapshot,
  tipsPage = 1,
  tipsGestureProps,
  tipsFooter,
  assistantGestureProps,
  assistantHint,
  tripMap,
  departurePlan,
  mapView,
  home,
  assistantMode,
  onAssistantDismiss,
  mic,
  trips,
  vehicle,
  reminders,
}: HudScreenProps) {
  // 哨兵指示：两个布局分支共用一份，贴在暖暖身侧（M26 走查）。
  // 原先浮在右上角，与「暖暖出发演示」的重播/关闭按钮叠在同一块位置；
  // 落位交给 `.hud-assistant-mic`（与 EDGE_ANCHORS.assistantHero 同源），
  // 不在这里写内联坐标——竖屏还要换一套锚点。
  const micNode = mic ? (
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
  const sprites = SPRITES[theme];
  const { trip, energy, tips, weather, assistantState, freshness, leg } = snapshot;

  /*
   * 跟车进度（M31-03）。**hook 必须在任何 return 之前**——下面的
   * `if (tripMap)` 是一条早退分支，把 useState 写在它里面会让两次渲染的
   * hook 数量不一致，React 直接抛。
   */
  const [navProgress, setNavProgress] = useState<NavTripProgress | undefined>(undefined);
  const navOnProgress = tripMap?.nav?.onProgress;
  /*
   * 途中提醒（M77-06）：判据与卡片状态在 @carlife/ui 的控制器里，这里只把进度帧喂进去。
   * 换一次导航（nav.key 变）控制器重建；不在跟车时归零。
   */
  const enRoute = useEnRouteReminders({
    active: Boolean(tripMap?.nav),
    navKey: tripMap?.nav?.key,
    legs: reminders?.legs,
    limitMin: reminders?.limitMin,
    density: reminders?.density,
    enabled: reminders?.enabled,
    speak: reminders?.speak,
    isInFlight: reminders?.isInFlight,
    onEvent: reminders?.onEvent,
  });
  const hushSignal = reminders?.hushSignal ?? 0;
  const enRouteHush = enRoute.hush;
  useEffect(() => {
    if (hushSignal > 0) enRouteHush();
  }, [hushSignal, enRouteHush]);
  const onRestActive = reminders?.onRestActive;
  const restActive = enRoute.card?.reminder.kind === "rest" && !enRoute.card.collapsed;
  useEffect(() => {
    onRestActive?.(Boolean(restActive));
  }, [onRestActive, restActive]);
  const enRouteOnProgress = enRoute.onProgress;
  const handleNavProgress = useCallback(
    (p: NavTripProgress) => {
      setNavProgress(p);
      navOnProgress?.(p);
      enRouteOnProgress(p);
    },
    [navOnProgress, enRouteOnProgress],
  );

  /*
   * 屏底状态栏的「开始行程」→ 出发动画（CabinArrivalDemo）。信号计数在这里，
   * 两条路径（钥匙 / 状态栏）播的是同一段动画，见 CabinArrivalDemo 的 `playSignal`。
   */
  const [departSignal, setDepartSignal] = useState(0);
  const startTrip = useCallback(() => setDepartSignal((n) => n + 1), []);

  const terminal = trip.nodes[trip.nodes.length - 1];
  const finalAnchor = terminal ? NODE_ANCHORS[terminal.anchor] : undefined;
  const page = tips.pages[tipsPage - 1] ?? tips.pages[0];
  /*
   * 没有贴纸的 key **不上卡**（M20-02）。
   *
   * 契约表（`PRETRIP_ITEMS`）与贴纸是两条独立补齐的线：先有 key 后有图是常态。
   * 少这一层过滤，`<img src={undefined}>` 会在卡上留一个有名字没有图的空格子——
   * 那比少推荐一件东西更像出了故障。
   */
  /*
   * 提示卡窗口里轮播的是**两类卡**（M32-03）：行前物品 / 目的地推荐。
   *
   * 分流收成下面这一个 `windowCard` 变量，而不是在两处渲染点各写一遍三元——
   * 本文件已经有过"只改一处"的教训（下面 AssistantDock 那条注释）。
   * 两类卡的 page/pageCount/gestureProps/footer 完全一样：它们共用同一套轮播状态。
   */
  const pageItems = isHighlightsPage(page)
    ? []
    : page.items
        .filter((it) => sprites.items[it.key] !== undefined)
        .map((it) => ({ ...it, icon: sprites.items[it.key] }));

  /*
   * 三态（M73-02）：无行程 = 只有提示卡；有行程未选中 = 右列只有周日历卡；选中 = 顶部日期条 + 紧凑列表 + 提示卡。
   * 提示卡在「有行程且未选中」时**不渲染**（由 React 决定，不靠 CSS 藏）。
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
   * 行程列表卡（M72-04）：与 `windowCard` 同一条纪律——**只写一处、用两处**。
   * 没有行程不渲染，`hud-stage--has-trips` 也不加，提示卡窗尺寸一字不变。
   */
  /*
   * 选中态**不再显示行程卡**（2026-09-08 产品走查）：右列只剩提示卡，顶部日期条是唯一的行程锚点，
   * 点 × 才回到周日历卡。所以 `hud-stage--has-trips`（提示卡下移让位）也只在未选中态加——
   * 那时提示卡本来就不渲染，这个类此刻只是给舞台一个"有行程"的标记。
   */
  const tripsCard = !trips || !hasTrips || selectedTrip ? null : (
    <TripCalendarCard
      entries={trips.entries}
      today={trips.today}
      homeCity={home?.city}
      weatherIcons={sprites.weather}
      poiIcons={sprites.poi}
      onSelect={trips.onSelect}
      onOpenReview={trips.onOpenReview}
    />
  );
  /*
   * 顶部日期条只在选中态，且**跟车时不渲染**——跟车顶栏占的是同一带（下一站与 ETA 比日期要紧）。
   */
  const dateBanner =
    trips && selectedTrip && !tripMap?.nav ? (
      <TripDateBanner entry={selectedTrip} today={trips.today} onClose={trips.onClearSelection} />
    ) : null;
  const stageClass = selectedTrip ? "hud-stage--trip-selected" : hasTrips ? "hud-stage--has-trips" : undefined;

  /*
   * 暖暖的对话气泡（新版 UI 定稿）。只在**没选中行程、她也闲着**时说「说说你的下一段旅程吧」——
   * 选中了行程再问下一段是答非所问；她在听/在想/在说时气泡会盖住状态卡的语义。
   * 覆盖文案（麦克风未授权那类）在场时也不说：那时卡上写的是故障，旁边还笑着邀约就很怪。
   */
  const bubble =
    !selectedTrip && assistantState === "idle" && !assistantHint ? "说说\n你的下一段旅程吧！" : undefined;

  /*
   * 屏底状态栏：两个布局分支共用一份（与 windowCard 同一条"只写一处"纪律）。
   * 它接替了右下角的能量胶囊。预计里程 / 用时 / 道路情况只认 `snapshot.leg`
   * （出发地 → 今天第一站的高德规划，网关每轮带来）；没有就三格「暂无」。
   */
  const statusBar = (
    <StatusBar summary={energy} leg={leg} stale={freshness.stale} vehicle={vehicle} onStart={startTrip} />
  );

  // ── 真实地图行程模式（M13-06）：真实坐标标注 + 路线动画 + 逐日切换。
  //    装饰生活环整套不渲染——两套坐标系叠加会打架。
  if (tripMap) {
    return (
      <HudStage theme={theme} className={stageClass}>
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
          guidedSpots={tripMap.guidedSpots}
        />
        {tripMap.nav && (
          <NavBar nav={tripMap.nav} progress={navProgress} />
        )}
        {tripMap.nav && enRoute.card && (
          <EnRouteReminderCard
            card={enRoute.card}
            density={reminders?.density}
            muted={reminders?.muted}
            onAck={enRoute.ack}
            onRestDecision={enRoute.decideRest}
          />
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
          // 住宿策略横幅（M34-02）：换酒店日/到达日的"行李怎么办"要在图上有答案。
          <div className="hud-lodging" aria-label="住宿安排">
            {tripMap.lodgingNotes.map((l) => (
              <span key={l.day} className="hud-lodging__item">
                <b>D{l.day}·{LODGING_LABEL[l.strategy]}</b>
                {l.note ? `：${l.note}` : ""}
              </span>
            ))}
          </div>
        )}
        {dateBanner}
        {tripsCard}
        {windowCard}
        {statusBar}
        <AssistantDock
          sprite={sprites.assistant}
          workingSprite={sprites.assistantWorking}
          state={assistantState}
          mode={assistantMode}
          onDismiss={onAssistantDismiss}
          gestureProps={assistantGestureProps}
          primaryLabel={assistantHint?.primary}
          secondaryLabel={assistantHint?.secondary}
          // 车机端点助手不进对话（触屏上会吃掉长按说话）——进对话只走底部「对话」按钮。
          // 那块短按手势现在归**打断**（M33-02）：她在说/在想时点一下就停。
          tapOpensDialog={false}
          tapInterrupts
          compact
          bubble={bubble}
        />
        {/* assistantState 下传给音景：暖暖说话时它全静（M64-03）。 */}
        <CabinArrivalDemo theme={theme} plan={departurePlan} assistantState={assistantState} playSignal={departSignal} />
        {micNode}
      </HudStage>
    );
  }

  return (
    <HudStage theme={theme} className={stageClass}>
      {/* ① 地图：铺满视口，任意屏幕比例都无信箱黑边。
          配了 AMAP_JS_KEY 走高德真实底图，未配/离线/加载失败回退程序化底图
          —— 回退在 AmapBackdrop 内部完成，这里不需要分支（M10-01）。 */}
      <AmapBackdrop
        theme={theme}
        center={mapView?.restored ?? (home ? { lat: home.lat, lon: home.lon } : undefined)}
        zoom={mapView?.restored?.zoom}
        focus={mapView?.focus ?? undefined}
        onViewportChange={mapView?.remember}
      />

      {/* 「定位到我」。只挪镜头，不下发任何指令——不违反 HUD 红线。
          定位关着时它也在，点了会说清楚去哪儿打开（见 LocateButton 文件头）。 */}
      {mapView && (
        <LocateButton
          onLocated={(fix) => mapView.focusOn({ lat: fix.lat, lon: fix.lon, zoom: 15 })}
        />
      )}

      {/* ② 竖屏 V2：与横屏生活环分开排布为自上而下时间轴（CSS 仅在真竖屏显示）。 */}
      <PortraitTimeline
        weatherIcon={sprites.weather[weather.kind] ?? sprites.weather.sunny}
        origin={{
          anchor: trip.origin.anchor,
          // 竖屏时间轴同款：没有行程时首格显示常住地而不是通用的「家」。
          name: home?.city ?? trip.origin.name,
          sprite: spriteFor(sprites, trip.origin),
          origin: true,
        }}
        nodes={trip.nodes.map((node, i) => ({
          anchor: node.anchor,
          name: node.name,
          sprite: spriteFor(sprites, node),
          index: i + 1,
          terminal: i === trip.nodes.length - 1,
        }))}
        animated={!freshness.stale}
      />

      {/* ③ 横屏/近方屏：固定 1672:941 等比生活环，构图永不拉伸。 */}
      <HudScene>
        <LifeRing
          activeSegment={trip.activeSegment}
          finalGlow={finalAnchor ? { cx: finalAnchor.cx, cy: finalAnchor.cy } : undefined}
          animated={!freshness.stale}
        />

        {/* 出发锚点：3D 小屋，定位 pin 仅辅助（Brief §3.1）。
            没有行程时它就是"家在哪"——名字用常住地城市名，让这一屏
            回答得出「现在停在哪」；拿不到常住地才退回通用的「家」。 */}
        <PoiNode
          anchor={trip.origin.anchor}
          sprite={spriteFor(sprites, trip.origin)}
          name={trip.origin.name}
          origin
          originLabel={home?.city}
        />

        {/* ①–④：序号徽章优先于地点名，随真实计划重新编号 */}
        {trip.nodes.map((node, i) => (
          <PoiNode
            key={node.anchor}
            anchor={node.anchor}
            sprite={spriteFor(sprites, node)}
            name={node.name}
            index={i + 1}
            terminal={i === trip.nodes.length - 1}
          />
        ))}
      </HudScene>

      {/* ④ 悬浮层：横屏贴视口边缘；竖屏按 V2 连续信息区重新落位。 */}
      {dateBanner}
      {tripsCard}
      {windowCard}

      {statusBar}

      {/* ⚠️ 本文件有**两处** AssistantDock（行程地图模式与默认模式）。
          只改一处的表现是"进了行程视图暖暖就永远在休息"，而那一屏不报任何错。 */}
      <AssistantDock
        sprite={sprites.assistant}
        workingSprite={sprites.assistantWorking}
        state={assistantState}
        mode={assistantMode}
        onDismiss={onAssistantDismiss}
        gestureProps={assistantGestureProps}
        primaryLabel={assistantHint?.primary}
        secondaryLabel={assistantHint?.secondary}
          // 车机端点助手不进对话（触屏上会吃掉长按说话）——进对话只走底部「对话」按钮。
          // 那块短按手势现在归**打断**（M33-02）：她在说/在想时点一下就停。
          tapOpensDialog={false}
          tapInterrupts
          compact
          bubble={bubble}
      />
      {/* assistantState 下传给音景：暖暖说话时它全静（M64-03）。 */}
      <CabinArrivalDemo theme={theme} plan={departurePlan} assistantState={assistantState} playSignal={departSignal} />
      {micNode}
    </HudStage>
  );
}
