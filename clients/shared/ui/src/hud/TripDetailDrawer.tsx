/**
 * 行程详情抽屉（施工单 M83-03，设计 `内部文档`）。
 *
 * 胶囊 → 工具按钮 → 「行程详情」打开它。它是**这一程的目录**：Day 页签选一天，
 * 下面的沿途服务与行程时间轴只画那一天。
 *
 * # 不是路线比选
 *
 * 参考卡顶部的「智能推荐 / 更快到达 / 更省电」与并列的方案一 / 二 / 三**全部没做**：
 * 比选在确认之前（HITL 弹窗 + `trip_plan_commit`）就完成了，选中的这一程只有一份。
 * 照搬会让车主以为还有两份方案能切。Day 卡上也没有「推荐」角标。
 *
 * # 独立浮层，不是轮播的第三页
 *
 * 右侧那个窗口里的「行前温馨提示 / 目的地推荐」每 6 秒翻一页（见 `HighlightsCard` 文件头）。
 * 抽屉做成它的第三页的话，编辑到一半会被翻走（M83-04 更受不了）。所以抽屉盖在它之上，
 * 由页面层在打开期间**暂停**轮播。
 *
 * # 纯受控
 *
 * 选中哪一天、开没开、编不编辑都在上层。抽屉自己不记状态——"换了一程就关掉"
 * 这类判断只有页面层做得了。
 */

import {
  dayMetrics,
  dayServices,
  dayTimeline,
  dayTouched,
  driveLabel,
  editableRows,
  moveInOrder,
  pushMove,
  pushRemove,
  pushReorder,
  chargeStopNames,
  rowChangeLabel,
  rowChanges,
  undoRemove,
  serviceAreasFor,
  servicePoisFor,
  serviceCellTitle,
  type EditableRow,
  type RowChange,
  type ServiceCategoryKey,
  type TimelineRow,
} from "./trip-detail";

import { SERVICE_ICON_PATHS } from "../map/service-marker";

import {
  applyStructureEdits,
  structureEditSummary,
  type TripPlanListEntry,
  type TripPlanSnapshot,
  type TripStructureEdit,
} from "@carlife/shared";

export interface TripDetailDrawerProps {
  plan: TripPlanSnapshot;
  entry: TripPlanListEntry;
  /** 选中的是第几天（1 起）。 */
  selectedDay: number;
  onSelectDay: (day: number) => void;
  onClose: () => void;
  /**
   * 能不能进编辑态。行驶中为 false——**按钮禁用并写出原因**，不静默消失
   * （拦住用户却不说为什么被拦住，是缺陷不是设计）。
   */
  canEdit?: boolean;
  /** 禁用时那一句原因，如「行驶中不能调整」。 */
  editDisabledReason?: string;
  /** 进编辑态（M83-04）。 */
  onStartEdit?: () => void;
  /** 编辑态（M83-04）：是不是在编辑、当前的变更集。组件仍然纯受控。 */
  editing?: boolean;
  edits?: readonly TripStructureEdit[];
  onChangeEdits?: (next: TripStructureEdit[]) => void;
  onCancelEdit?: () => void;
  onSave?: (edits: readonly TripStructureEdit[]) => void;
  /** 保存中：两个出口都禁用。 */
  saving?: boolean;
  /** 不能发送时的原因（浏览器走查里发不出去），写在「保存调整」旁。 */
  saveDisabledReason?: string;
  /**
   * 选中了哪几类沿途服务（M93-05）——**受控**，状态在页面层。
   *
   * 地图在兄弟组件里，选中集合要同时喂给这一排格子和那一层标记，
   * 所以它只能住在共同父级；抽屉自持一份的话，两边迟早不同步。
   */
  selectedServices?: readonly ServiceCategoryKey[];
  /** 点某一格：父级负责取反。没有明细的格子不会触发它。 */
  onToggleService?: (key: ServiceCategoryKey) => void;
  /** 有未保存变更时想关掉：由页面层弹确认。 */
  confirmDiscard?: boolean;
  onConfirmDiscard?: () => void;
  onKeepEditing?: () => void;
}

/** 副标题：「徐州 · 3 天 · 9/9 → 9/11」；没定日期时末段是「日期待定」。 */
export function drawerSubtitle(entry: TripPlanListEntry): string {
  const { destination, days, startDate } = entry.plan;
  const head = `${destination} · ${days} 天`;
  if (!startDate) return `${head} · 日期待定`;
  const short = (iso: string) => {
    const [, mm, dd] = iso.split("-");
    return mm && dd ? `${Number(mm)}/${Number(dd)}` : iso;
  };
  const end = new Date(Date.parse(`${startDate}T00:00:00Z`) + (days - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  return `${head} · ${short(startDate)} → ${short(end)}`;
}

export function TripDetailDrawer({
  plan,
  entry,
  selectedDay,
  onSelectDay,
  onClose,
  canEdit = true,
  editDisabledReason = "行驶中不能调整",
  onStartEdit,
  editing = false,
  edits = [],
  onChangeEdits,
  onCancelEdit,
  onSave,
  saving = false,
  saveDisabledReason,
  selectedServices = [],
  onToggleService,
  confirmDiscard = false,
  onConfirmDiscard,
  onKeepEditing,
}: TripDetailDrawerProps) {
  const days = Array.from({ length: Math.max(plan.days, plan.skeleton.length) }, (_, i) => i + 1);
  /*
   * 预览用**契约里的** `applyStructureEdits`，不在组件里另写一套：
   * 屏上看到的与发给暖暖的那句话必须出自同一份数据，两套应用逻辑迟早对不上。
   */
  const preview = editing ? applyStructureEdits(plan, edits) : plan;
  const rows: EditableRow[] = editing
    ? editableRows(plan, preview, edits, selectedDay)
    : dayTimeline(plan, selectedDay).map((r) => ({ ...r }));
  /*
   * 四格的数据源是快照里的 `services`（沿途服务数据源交接，待执行事项 4）——按**预览**取：
   * 编辑里挪了景点，骨架指纹对不上，四格如实变回「待查」，不拿旧骨架的计数冒充。
   */
  const services = dayServices(preview, selectedDay);
  /** 当天高速段的服务区名（去程落第 1 天）。 */
  const serviceAreas = serviceAreasFor(preview, selectedDay);
  /** 整程补能点的展示名（去掉里程与绕行量那段注解）。 */
  const chargeNames = chargeStopNames(preview);
  /*
   * 每一格能不能点：有点位明细才能上图（M93-05）。老快照有计数没有 `pois`——
   * 那种格子置灰并说清原因，**不做成可点然后点了没反应**。
   */
  const poiCountOf = (key: ServiceCategoryKey): number => servicePoisFor(preview, selectedDay, key).length;
  const summary = structureEditSummary(edits);
  /*
   * 每行相对原计划变成了什么样（M83 走查追修）。**常驻在行上而不是做个动画**：
   * 走查里点一下 ▲ 只看到行跳一下，"挪到第几位、一共动过几下"全靠记；
   * 车机上手指还在屏幕上，动画早播完了。
   */
  const changes = editing ? rowChanges(plan, preview, selectedDay) : new Map<string, RowChange>();
  const spotRows = rows.filter((r) => r.kind === "spot" && !r.removed);

  /** 当天此刻的站序（预览后的），上下移要基于它重排。 */
  const orderNow = spotRows.map((r) => r.name);

  const move = (name: string, delta: number) => {
    const next = moveInOrder(orderNow, name, delta);
    if (next) onChangeEdits?.(pushReorder(edits, selectedDay, next));
  };

  return (
    <section className={`hud-card hud-tripdetail${editing ? " is-editing" : ""}`} aria-label="行程详情">
      <header className="hud-tripdetail__head">
        <ListIcon />
        <div className="hud-tripdetail__title">
          <h2>行程详情</h2>
          <p className="hud-tripdetail__subtitle">{drawerSubtitle(entry)}</p>
        </div>
        <button type="button" className="hud-tripdetail__close" aria-label="收起行程详情" onClick={onClose}>
          ×
        </button>
      </header>

      {/* 超过 3 天横向滚动：不折行、不分页——折行会让"这一程有几天"变成要数两遍的事。 */}
      <div className="hud-tripdetail__days" role="tablist" aria-label="按天查看">
        {days.map((d) => (
          <DayCard
            key={d}
            plan={preview}
            day={d}
            selected={d === selectedDay}
            touched={editing && dayTouched(edits, d)}
            onSelect={() => onSelectDay(d)}
          />
        ))}
      </div>

      {/*
        Day 页签钉住，沿途服务与时间轴合成一个滚动体（M83-03 走查定的）。
        Brief §3.2 原本要三段各自钉住、时间轴独占滚动，实测放不下：抽屉总高 613 基准单位，
        头部 81 + Day 卡 124 + 沿途服务 149 + 时间轴标题 56 就去掉 410，剩下的不够两行
        （一行 72）。三段都钉住的代价是时间轴只剩 1.6 行——那还不如没有。
        时间轴标题行 sticky，所以「调整行程」与编辑态的两个出口滚到哪儿都够得着。
      */}
      <div className="hud-tripdetail__body">
      <section className="hud-tripdetail__services" aria-label="沿途服务">
        <h3 className="hud-tripdetail__h3">沿途服务</h3>
        {/*
          格子是**开关**不是标签（M93-05）：点一下就在地图上画出这一类的点位，可多选。
          `role="switch"` + `aria-checked` 而不是 `aria-pressed`——它开的是一个图层，
          有明确的开/关两态，屏读器念出来就是"已选中/未选中"。
        */}
        <ul className="hud-tripdetail__cells">
          {services.map((c) => {
            const n = poiCountOf(c.key);
            const disabled = n === 0;
            /*
             * 亮 = **图上真的画着**，不是"选过它"（浏览器实测追修）。
             *
             * 选中集合是跨天保留的（切到下一天照旧画那一类，这是对的），但那一天没有点位时
             * 格子会亮着而图上空空如也——亮着就是在说"图上有"，那句话当时是假的。
             * 这里只改外观：集合本身不动，切回有点位的那天它自己就亮回来。
             */
            const on = selectedServices.includes(c.key) && !disabled;
            /*
             * 出处与口径挂在格子的 title 上（走查第四轮把屏幕上那段说明删了）：
             * 点不动的那一格优先说"为什么点不动"——那是此刻唯一要紧的事。
             */
            const hint = disabled
              ? "这一天没有存下点位，没法在地图上显示"
              : serviceCellTitle(preview, c.value);
            return (
              <li key={c.key}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-disabled={disabled || undefined}
                  disabled={disabled}
                  title={hint}
                  aria-label={`${c.label}，${c.value}，${on ? "已选中" : "未选中"}${
                    disabled ? "，没有点位可显示" : "，按此在地图上显示"
                  }`}
                  className={`hud-tripdetail__cell${on ? " is-on" : ""}`}
                  onClick={() => onToggleService?.(c.key)}
                >
                  <ServiceIcon kind={c.key} />
                  <span className="hud-tripdetail__celllabel">{c.label}</span>
                  <span className="hud-tripdetail__cellvalue">{c.value}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {/*
          补能点的**名字**（M83 走查追修）：只给一个数回答不了「在哪补」。
          整程口径——`energyStops` 不带天，摆进按天的格子里不标明就是在说没验证过的事。
          M93-05 起它**必定单独成行**：充电站那一格已经改口径为"当天周边有多少桩"，
          两件事再也不会互相顶掉。
        */}
        {chargeNames.length > 0 && (
          <p className="hud-tripdetail__charge">
            <b>整程补能点</b>
            {chargeNames.join("、")}
          </p>
        )}
        {serviceAreas.length > 0 && (
          <p className="hud-tripdetail__charge">
            <b>高速服务区</b>
            {serviceAreas.join("、")}
          </p>
        )}
      </section>

      <section className="hud-tripdetail__timeline" aria-label="行程时间轴">
        <div className="hud-tripdetail__timelinehead">
          <h3 className="hud-tripdetail__h3">行程时间轴</h3>
          {editing ? (
            <div className="hud-tripdetail__exits">
              <button type="button" className="hud-tripdetail__btn" disabled={saving} onClick={onCancelEdit}>
                取消调整
              </button>
              <button
                type="button"
                className="hud-tripdetail__btn hud-tripdetail__btn--cta"
                disabled={saving || edits.length === 0 || saveDisabledReason !== undefined}
                title={saveDisabledReason}
                onClick={() => onSave?.(edits)}
              >
                {saving ? "正在发送…" : "保存调整"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="hud-tripdetail__btn"
              disabled={!canEdit}
              title={canEdit ? undefined : editDisabledReason}
              onClick={onStartEdit}
            >
              调整行程
            </button>
          )}
        </div>
        {!editing && !canEdit && <p className="hud-tripdetail__why">{editDisabledReason}</p>}
        {editing && summary.count > 0 && <p className="hud-tripdetail__summary">{summary.text}</p>}
        {editing && saveDisabledReason && <p className="hud-tripdetail__why">{saveDisabledReason}</p>}
        <ol className="hud-tripdetail__rows">
          {rows.map((r, i) => (
            <TimelineLi
              key={`${r.kind}-${r.name}-${i}`}
              row={r}
              first={i === 0}
              last={i === rows.length - 1}
              editing={editing}
              days={days}
              day={selectedDay}
              canMoveUp={r.index !== undefined && r.index > 0}
              canMoveDown={r.index !== undefined && r.index < spotRows.length - 1}
              onUp={() => move(r.name, -1)}
              onDown={() => move(r.name, 1)}
              onRemove={() => onChangeEdits?.(pushRemove(edits, selectedDay, r.name))}
              onUndoRemove={() => onChangeEdits?.(undoRemove(edits, selectedDay, r.name))}
              onMoveDay={(toDay) => onChangeEdits?.(pushMove(edits, selectedDay, r.name, toDay))}
              change={r.removed ? { kind: "removed" } : changes.get(r.name)}
            />
          ))}
        </ol>
      </section>
      </div>

      {confirmDiscard && (
        <div className="hud-tripdetail__confirm" role="alertdialog" aria-label="有未保存的调整">
          <p>有未保存的调整，放弃？</p>
          <div className="hud-tripdetail__exits">
            <button type="button" className="hud-tripdetail__btn" onClick={onKeepEditing}>
              继续调整
            </button>
            <button type="button" className="hud-tripdetail__btn" onClick={onConfirmDiscard}>
              放弃
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function DayCard({
  plan,
  day,
  selected,
  touched,
  onSelect,
}: {
  plan: TripPlanSnapshot;
  day: number;
  selected: boolean;
  touched?: boolean;
  onSelect: () => void;
}) {
  const d = plan.skeleton.find((x) => x.day === day);
  const m = dayMetrics(plan, day);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={`hud-tripdetail__day${selected ? " is-on" : ""}${touched ? " is-touched" : ""}`}
      onClick={onSelect}
    >
      <span className="hud-tripdetail__dayhead">
        <b>Day {day}</b>
        {/* 改过的那天打一个点：切走之后仍看得出"我动过它"。 */}
        {touched && <span className="hud-tripdetail__daydot" aria-label="这一天有调整" />}
        {d?.date && <span className="hud-tripdetail__daydate">{shortDate(d.date)}</span>}
      </span>
      {/*
        日卡只留**行车时长**一行（2026-09-16 走查第四轮「豆腐块里就不需要展示文字」，
        第七轮「4 个景点、无补能停靠可以去掉，只保留行车时长」）。

        判据是"下面的时间轴有没有"：景点数 = 数一下时间轴的景点行；补能停靠同理，
        而且它多半是「无补能停靠」——一整行只为了说"没有这回事"。
        行车时长留着，是因为它**只在这里有**：时间轴给的是各段的钟点，
        一天开多久得自己去加。
      */}
      {/* legs 缺省时整行不画——这里没有"0 分钟"这个选项（见 trip-detail.ts 文件头）。 */}
      {m.driveMinutes !== undefined && (
        <span className="hud-tripdetail__daymetric">行车约 {driveLabel(m.driveMinutes)}</span>
      )}
    </button>
  );
}

/**
 * 时间轴的一行。
 *
 * # 编辑态不显示时间
 *
 * 不是为了腾地方（虽然也确实腾出了地方）：**那些时间正要被暖暖重排**。
 * 一边让车主改顺序、一边摆着改之前的时刻，是在展示一份下一秒就不成立的数据——
 * 与"不许用常数填一个看起来像真的时间"是同一条纪律。行宽预算顺带也就够了：
 * 一行 570 基准单位，四个控件占 252，留给站名 272（约 10 个汉字，与截断规则对上）。
 *
 * 出发行与酒店行**永远没有控件**：住宿是锚点不是 POI（M34-01），换酒店靠说话。
 */
function TimelineLi({
  row,
  first,
  last,
  editing = false,
  days = [],
  day,
  canMoveUp = false,
  canMoveDown = false,
  onUp,
  onDown,
  onRemove,
  onUndoRemove,
  onMoveDay,
  change,
}: {
  row: EditableRow;
  first: boolean;
  last: boolean;
  editing?: boolean;
  days?: number[];
  day?: number;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onRemove?: () => void;
  onUndoRemove?: () => void;
  onMoveDay?: (toDay: number) => void;
  /** 这一行相对原计划变成了什么样（M83 走查追修）；缺省 = 没动过。 */
  change?: RowChange;
}) {
  const editable = editing && row.kind === "spot";
  return (
    <li
      className={`hud-tripdetail__row hud-tripdetail__row--${row.kind}${row.removed ? " is-removed" : ""}${
        editing && row.kind !== "spot" ? " is-locked" : ""
      }`}
    >
      <span className={`hud-tripdetail__dot${first || last ? " is-end" : ""}`} aria-hidden="true" />
      {!editing && <span className="hud-tripdetail__time">{row.time ?? ""}</span>}
      <span className="hud-tripdetail__name">
        {/* 落脚行与末行是同一家店，图标也该是同一个（走查第九轮）。 */}
        {(row.kind === "hotel" || row.kind === "checkin") && <HotelIcon />}
        {row.name}
        {/* 变化标常驻：切走再切回来它还在，撤销才消失。 */}
        {change && (
          <span className={`hud-tripdetail__change hud-tripdetail__change--${change.kind}`}>
            {rowChangeLabel(change)}
          </span>
        )}
      </span>
      {!editing && <span className="hud-tripdetail__note">{row.note}</span>}
      {editable && !row.removed && (
        <span className="hud-tripdetail__ctrls">
          <select
            className="hud-tripdetail__daypick"
            aria-label={`把「${row.name}」调整到第几天`}
            value={day}
            onChange={(e) => onMoveDay?.(Number(e.target.value))}
          >
            {days.map((d) => (
              <option key={d} value={d}>
                Day {d}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="hud-tripdetail__ctrl"
            aria-label={`把「${row.name}」往前挪`}
            disabled={!canMoveUp}
            onClick={onUp}
          >
            ▲
          </button>
          <button
            type="button"
            className="hud-tripdetail__ctrl"
            aria-label={`把「${row.name}」往后挪`}
            disabled={!canMoveDown}
            onClick={onDown}
          >
            ▼
          </button>
          {/* 删除**不用红**：红只给「拥堵」与「读不到」（设计系统 §4.3 红色纪律）。 */}
          <button
            type="button"
            className="hud-tripdetail__ctrl"
            aria-label={`删除「${row.name}」`}
            onClick={onRemove}
          >
            <TrashIcon />
          </button>
        </span>
      )}
      {editable && row.removed && (
        <span className="hud-tripdetail__ctrls">
          <button type="button" className="hud-tripdetail__undo" onClick={onUndoRemove}>
            撤销
          </button>
        </span>
      )}
    </li>
  );
}

function TrashIcon() {
  return (
    <svg className="hud-tripdetail__ctrlicon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6" strokeLinecap="round" />
    </svg>
  );
}

/** 「2026-09-09」→「9/9」。日期只是辅助，不带星期（Day 卡放不下第二个词）。 */
function shortDate(iso: string): string {
  const [, mm, dd] = iso.split("-");
  return mm && dd ? `${Number(mm)}/${Number(dd)}` : iso;
}

function ListIcon() {
  return (
    <svg className="hud-tripdetail__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M9 6h11M9 12h11M9 18h11" strokeLinecap="round" />
      <circle cx="4.5" cy="6" r="1.2" />
      <circle cx="4.5" cy="12" r="1.2" />
      <circle cx="4.5" cy="18" r="1.2" />
    </svg>
  );
}

function HotelIcon() {
  return (
    <span className="hud-tripdetail__hotelicon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" focusable="false">
        <path d="M4 20V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v14M15 11h4a1 1 0 0 1 1 1v8M8 9h3M8 13h3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/**
 * 格子里的图标。path 数据来自 `map/service-marker.ts` 的 `SERVICE_ICON_PATHS`——
 * **与地图标记同一套**（M93-05）：这一排格子和图上的点是同一个开关的两端，
 * 各画一套的话，图上的闪电和格子里的闪电迟早长得不一样。
 */
function ServiceIcon({ kind }: { kind: ServiceCategoryKey }) {
  return (
    <svg className="hud-tripdetail__cellicon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d={SERVICE_ICON_PATHS[kind]} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
