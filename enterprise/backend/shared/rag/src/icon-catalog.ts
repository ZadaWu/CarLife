/**
 * 手册图标目录（施工单 M71-03，ACR-025）。
 *
 * 目录是一张 markdown 表（`data/kb-src/icons/<车型>.md`），人写；本文件只负责解析与规范化。
 * 每条：`symbol_id`、名称、类别（fault / reminder / status）、级别（stop / check_soon / info）、
 * 受控描述子（与 @carlife/tools vision 的词表同一套）、手册锚点、原文说明。
 *
 * # 名称与级别只在这里
 *
 * 观察层的 schema 结构上没有名称与级别的字段；它们唯一的来源就是这张表。
 * 级别是**类别 × 颜色**的二维表（`severityFor`），不是颜色一维：安全带是红的但只是提醒。
 *
 * # 描述子 → 检索串
 *
 * `normalizeDescriptor()` 把受控字段按固定顺序拼成中文短句（「红色 人形 斜带 点亮」），
 * 手册侧与用户侧用同一个函数——文本路检索天然对称。`literal` 不进来（模型会在里面写名称）。
 */

export type IconClass = "fault" | "reminder" | "status";
export type IconSeverity = "stop" | "check_soon" | "info";

export interface IconDescriptor {
  shape: string;
  color: string;
  state?: string;
  elements: string[];
  text: string[];
}

export interface IconCatalogEntry {
  symbolId: string;
  vehicleModel: string;
  name: string;
  class: IconClass;
  severity: IconSeverity;
  descriptor: IconDescriptor;
  manualAnchor: string;
  description: string;
  /**
   * 描述子来源：
   * - `manual-image` 对着手册图标逐条核对过；
   * - `standard-symbol` 按 ISO 2575 通用符号起草，未对图；
   * - `deprecated` **这个符号在该车型手册里不存在**（起草时凭空补的），保留占位但不进索引、不参与匹配。
   *   编号不复用不删行是本仓的一贯做法：删掉的条目半年后会被同一个人再补一遍。
   */
  descriptorSource: "manual-image" | "standard-symbol" | "deprecated";
  /** 图标图片文件名（相对目录所在目录的 `<车型>/`），没有则空 */
  imageFile: string;
}

/** 类别 × 颜色 → 级别。红色提醒类是 info，不是 stop——这张表存在的理由。 */
export function severityFor(cls: IconClass, color: string): IconSeverity {
  if (cls === "fault") return color === "red" ? "stop" : "check_soon";
  if (cls === "reminder") return "info";
  return "info";
}

const ZH: Record<string, string> = {
  red: "红色", amber: "琥珀色", green: "绿色", blue: "蓝色", white: "白色", gray: "灰色", black: "黑色", unknown: "",
  person: "人形", lamp: "灯形", circle: "圆形", triangle: "三角形", rectangle: "矩形", car_outline: "车轮廓", battery: "电池形",
  engine: "发动机形", wheel: "轮胎形", thermometer: "温度计形", droplet: "水滴形", wrench: "扳手形", steering_wheel: "方向盘形",
  letter_only: "字母", other: "",
  diagonal_band: "斜带", parentheses: "括号", wavy_lines: "波浪线", straight_lines: "直线", exclamation: "感叹号",
  arrow_left: "左箭头", arrow_right: "右箭头", arrow_both: "双向箭头", cross: "叉", check: "对勾", plus: "加号", minus: "减号",
  slash: "斜杠", circle_ring: "圆环", none: "",
  lit: "点亮", unlit: "未点亮", blinking: "闪烁",
};

/** 受控字段 → 中文检索串。顺序固定：颜色 形状 元素 文字 状态；未知与空项跳过。 */
export function normalizeDescriptor(d: IconDescriptor): string {
  const parts: string[] = [];
  const push = (k: string | undefined): void => {
    if (!k) return;
    const zh = ZH[k] ?? k;
    if (zh) parts.push(zh);
  };
  push(d.color);
  push(d.shape);
  for (const e of d.elements ?? []) push(e);
  for (const t of d.text ?? []) if (t.trim()) parts.push(`字 ${t.trim()}`);
  if (d.state && d.state !== "unknown") push(d.state);
  return parts.join(" ");
}

const splitList = (s: string): string[] =>
  s
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter((x) => x && x !== "-" && x !== "none");

/**
 * 解析目录 markdown。表头（顺序固定）：
 * `| symbol_id | 名称 | class | severity | shape | color | elements | text | 手册锚点 | 原文说明 | 描述子来源 | 图片 |`
 * 目录文件头部的 `vehicle:` 行给车型。
 */
export function parseIconCatalog(markdown: string): { vehicleModel: string; entries: IconCatalogEntry[]; errors: string[] } {
  const errors: string[] = [];
  const vehicle = /^vehicle:\s*(.+)$/m.exec(markdown)?.[1]?.trim() ?? "";
  if (!vehicle) errors.push("缺 `vehicle:` 行");
  const entries: IconCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 12 || cells[0] === "symbol_id" || /^-+$/.test(cells[0])) continue;
    const [symbolId, name, cls, severity, shape, color, elements, text, anchor, description, source, image] = cells;
    if (!/^[a-z0-9_]+$/.test(symbolId)) {
      errors.push(`symbol_id 不合规：${symbolId}`);
      continue;
    }
    if (seen.has(symbolId)) errors.push(`symbol_id 重复：${symbolId}`);
    seen.add(symbolId);
    if (!["fault", "reminder", "status"].includes(cls)) errors.push(`${symbolId}: class 越界 ${cls}`);
    if (!["stop", "check_soon", "info"].includes(severity)) errors.push(`${symbolId}: severity 越界 ${severity}`);
    const expected = severityFor(cls as IconClass, color);
    if (severity !== expected) errors.push(`${symbolId}: severity ${severity} 与 类别×颜色 表不符（应为 ${expected}）`);
    if (!["manual-image", "standard-symbol", "deprecated"].includes(source)) errors.push(`${symbolId}: 描述子来源越界 ${source}`);
    entries.push({
      symbolId,
      vehicleModel: vehicle,
      name,
      class: cls as IconClass,
      severity: severity as IconSeverity,
      descriptor: { shape, color, elements: splitList(elements), text: splitList(text) },
      manualAnchor: anchor,
      description,
      descriptorSource: source as IconCatalogEntry["descriptorSource"],
      imageFile: image === "-" ? "" : image,
    });
  }
  if (entries.length === 0) errors.push("没有解析到任何条目");
  return { vehicleModel: vehicle, entries, errors };
}
