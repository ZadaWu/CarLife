/**
 * JSON → 表格的**形状判定**（2026-09-15）——纯逻辑，渲染在 `JsonTable.tsx`。
 *
 * # 为什么自研而不是引库
 *
 * 2026-09-15 调研过公开候选：表格形态、键文案可定制、维护中、体积小四项同时满足的库不存在
 * （最接近的 `@redheadphone/react-json-grid` 单人维护、246 KB、没有键文案钩子；其余是折叠树、
 * 停更多年或 GPL）。这里要的只是"业务人员看得懂的表"：数组 → 列表、对象 → 键值两列、
 * 嵌套 → 子表，表头「中文(英文)」。按仓库的依赖政策，小而稳的行为自研，零依赖零升级风险；
 * 渲染是一个文件，将来要换库只改那一处。
 *
 * # 判定规则
 *
 * - 对象数组 → `rows`：列是各行键的**并集**，按首次出现顺序（第一条缺的字段不会把列吞掉）；
 * - 其它数组 → `list`（原始值一列；混着对象的当作 list，每项各自再判）；
 * - 对象 → `record`；
 * - 原始值 → `scalar`，并给出显示文本（null → —，布尔 → 是/否，数字按本地格式）。
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export type Shape =
  | { kind: "scalar"; text: string; long: boolean }
  | { kind: "empty" }
  | { kind: "list"; items: JsonValue[] }
  | { kind: "rows"; columns: string[]; rows: Array<Record<string, JsonValue>> }
  | { kind: "record"; entries: Array<[string, JsonValue]> };

/** 超过这个长度的字符串按多行文本渲染，不塞进单元格里挤成一行。 */
const LONG_TEXT = 80;

function isRecord(v: JsonValue): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function scalarText(v: null | boolean | number | string): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("zh-CN") : v.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
  return v;
}

export function shapeOf(v: JsonValue): Shape {
  if (v === null || typeof v !== "object") {
    const text = scalarText(v);
    return { kind: "scalar", text, long: text.length > LONG_TEXT || text.includes("\n") };
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return { kind: "empty" };
    if (v.every(isRecord)) {
      const columns: string[] = [];
      for (const row of v) for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
      return { kind: "rows", columns, rows: v };
    }
    return { kind: "list", items: v };
  }
  const entries = Object.entries(v);
  return entries.length === 0 ? { kind: "empty" } : { kind: "record", entries };
}

/**
 * 入参 / 出参在轨迹里是 JSON **文本**（可能被截断过）。解析得了就当结构渲染，
 * 解析不了（截断的尾巴、或本来就是一段散文）就退回原文——不猜、不修补。
 */
export function parseJsonText(text: string): { value: JsonValue } | { raw: string } {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return { raw: text };
  try {
    return { value: JSON.parse(trimmed) as JsonValue };
  } catch {
    return { raw: text };
  }
}
