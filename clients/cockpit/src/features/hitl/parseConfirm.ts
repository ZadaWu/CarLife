/**
 * HITL 明细 → 弹窗结构（施工单 M13-05 视觉重做，设计依据
 * `内部文档` §3）。
 *
 * 协议给的是 `{label, value}` 的人类可读文本（`PermissionDetail`），
 * 设计要的是天序时间线：日徽章、当日主题、景点 chips、住宿与价格。
 * 这一层只做**显示结构化**，三条边界：
 *
 *  1. **解析不出来就原样显示**，落回朴素的 `label / value` 行——
 *     版式退化好过内容失真。
 *  2. **绝不补内容**：没有价格就不显示价格，不猜、不填默认值。
 *  3. **「估算」只在源文本真的带（估算）时才打**——这个角标是可信度标记，
 *     凭空打上等于把估算说成事实，反过来漏打则是把估算冒充确定值。
 */

import type { PermissionDetail } from "@carlife/shared";

/** 动作摘要行的 label，由 agent-runtime 固定写入。 */
const ACTION_LABEL = "动作";
/** 大交通行的 label，由 `commitDisclosures` 固定写入。 */
const TRANSIT_LABEL = "大交通";

/** `第3天 荔湾人文日` —— 逐日明细的 label 形状。 */
const DAY_LABEL_RE = /^第\s*(\d+)\s*天\s*(.*)$/;
/** 源文本里的估算标记，形如 `（估算）`。 */
const ESTIMATE_RE = /[（(]\s*估算\s*[)）]/;
/** 住宿段：`；住 广州柏悦酒店 约900-1600/晚`。 */
const STAY_SPLIT_RE = /[;；]\s*住\s*/;
/** 行尾价格：`约280-450/晚` / `¥900-1600/晚`。 */
const PRICE_TAIL_RE = /(?:^|\s)((?:约|[¥￥])[^\s]*\d[^\s]*)$/;
/** 免责小字：`具体航班/车次以购票平台为准`。 */
const NOTE_TAIL_RE = /[，,]?\s*((?:具体|实际)[^；;，,]*为准)\s*$/;

export interface PlanStay {
  name: string;
  /** 源文本里就有的价格区间；没有就是没有，不推算。 */
  price?: string;
  estimated: boolean;
  /** 与前一天连住同店同价——端上折叠成「同前一晚」，见 `markRepeatedStays`。 */
  sameAsPrevious?: boolean;
}

export interface PlanDay {
  day: number;
  theme: string;
  spots: string[];
  stay?: PlanStay;
}

export interface TransitOption {
  /**
   * 出行方式（`飞机：约2小时…` 的冒号前半段）。源里没写就没有——
   * **不从时长价格反推**：反推出来的「飞机」会是我们编的，不是数据说的。
   */
  mode?: string;
  text: string;
  estimated: boolean;
}

export interface TransitBlock {
  options: TransitOption[];
  /** 「具体航班以购票平台为准」这类免责小字，独立成行而不是混进选项。 */
  note?: string;
}

export interface ConfirmView {
  /** 弹窗主标题。取动作摘要的前半段，**不显示工具名那种英文枚举**。 */
  title: string;
  /** 主标题后的胶囊，如「广州 · 4天」。源里没有就没有。 */
  subject?: string;
  days: PlanDay[];
  transit?: TransitBlock;
  /** 未能结构化的明细，原样逐行显示。 */
  rows: PermissionDetail[];
}

/** 剥掉（估算）标记并回报它出现过——角标由此而来，不由猜测而来。 */
function stripEstimate(text: string): { text: string; estimated: boolean } {
  return { text: text.replace(ESTIMATE_RE, "").trim(), estimated: ESTIMATE_RE.test(text) };
}

/** `NOGO城景公寓(汉溪长隆地铁站店) 约280-450/晚（估算）` → 名称 + 价格 + 估算。 */
function parseStay(raw: string): PlanStay {
  const { text, estimated } = stripEstimate(raw);
  const m = text.match(PRICE_TAIL_RE);
  if (!m) return { name: text, estimated };
  return { name: text.slice(0, m.index).trim(), price: m[1], estimated };
}

function parseDay(day: number, theme: string, value: string): PlanDay {
  const [spotsPart, stayPart] = value.split(STAY_SPLIT_RE);
  const spots = (spotsPart ?? "")
    .split(/[、,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { day, theme: theme.trim(), spots, stay: stayPart ? parseStay(stayPart) : undefined };
}

function parseTransit(value: string): TransitBlock {
  let rest = value.trim();
  let note: string | undefined;
  const m = rest.match(NOTE_TAIL_RE);
  if (m && m.index !== undefined) {
    note = m[1].trim();
    rest = rest.slice(0, m.index).trim();
  }
  const options = rest
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const { text, estimated } = stripEstimate(s);
      const i = text.indexOf("：");
      return i > 0
        ? { mode: text.slice(0, i).trim(), text: text.slice(i + 1).trim(), estimated }
        : { text, estimated };
    });
  return { options, note };
}

/**
 * 动作摘要拆成标题与胶囊：`确认多天行程并保存：广州 4天` → 标题 + 「广州 · 4天」。
 * 没有「：」时整句就是标题——**不硬拆**，拆错了标题就成了半句话。
 */
function parseAction(summary: string): { title: string; subject?: string } {
  const i = summary.indexOf("：");
  if (i <= 0) return { title: summary };
  const subject = summary.slice(i + 1).trim();
  /*
   * 尾巴不像"动作对象"就整句当标题，**不硬拆成胶囊**。
   *
   * 实测踩过：某条路径的摘要是「工具描述（入参：{"op":"cancel",…}）」，
   * 按第一个冒号一拆，标题成了半句描述，琥珀胶囊里是一串原始 JSON。
   * 服务端那头已经改掉了（见 tools-endpoint 的 summarizeAction），
   * 这一层仍要挡：胶囊是给"广州 · 4天"这种短对象用的，长东西/结构化文本一律不进。
   */
  const looksStructured = /[{}[\]"]|^\s*$/.test(subject) || subject.length > 24;
  if (looksStructured) return { title: summary };
  return {
    title: summary.slice(0, i).trim(),
    // 空格换成间隔号只是排版，不改内容。
    subject: subject.replace(/\s+/g, " · "),
  };
}

/**
 * 连住同一家酒店时，后一天标「同前一晚」（Brief §3.2，定稿也是这么画的）。
 *
 * **只在名称与价格都逐字相同时才折叠**：价格不同意味着换了房型或档期，
 * 那不是"同一晚"，折叠掉就等于把用户要批的东西藏了一项。
 */
function markRepeatedStays(days: PlanDay[]): PlanDay[] {
  return days.map((d, i) => {
    const prev = days[i - 1]?.stay;
    const same = prev && d.stay && prev.name === d.stay.name && prev.price === d.stay.price;
    return same ? { ...d, stay: { ...d.stay!, sameAsPrevious: true } } : d;
  });
}

export function parseConfirm(details: PermissionDetail[], fallbackTitle: string): ConfirmView {
  const days: PlanDay[] = [];
  const rows: PermissionDetail[] = [];
  let transit: TransitBlock | undefined;
  let action: { title: string; subject?: string } | undefined;

  for (const d of details) {
    const label = d.label.trim();
    if (label === ACTION_LABEL) {
      action = parseAction(d.value.trim());
      continue;
    }
    if (label === TRANSIT_LABEL) {
      transit = parseTransit(d.value);
      continue;
    }
    const day = label.match(DAY_LABEL_RE);
    if (day) {
      days.push(parseDay(Number(day[1]), day[2] ?? "", d.value));
      continue;
    }
    rows.push(d);
  }

  return {
    title: action?.title ?? fallbackTitle,
    subject: action?.subject,
    days: markRepeatedStays(days),
    transit,
    rows,
  };
}

/**
 * 影响范围的中文标签。**英文枚举不外露**——`trip` 对用户没有意义。
 * 认不出的值原样显示：显示一个陌生词，也好过悄悄吞掉"这次动作影响谁"。
 */
const SCOPE_LABELS: Record<string, string> = {
  trip: "行程",
  itinerary: "行程",
  buying: "购车",
  ownership: "用车",
  service: "售后",
  cabin: "座舱",
  cockpit: "座舱",
  supervisor: "总控",
};

export function scopeLabel(scope: string | null | undefined): string | undefined {
  if (!scope) return undefined;
  const key = scope.trim();
  return SCOPE_LABELS[key] ?? key;
}
