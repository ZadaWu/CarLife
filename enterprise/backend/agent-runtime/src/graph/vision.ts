/**
 * 观察节点（施工单 M71-04，ACR-024 / ACR-025）：照片 → 受控观察 → 手册图标匹配 → 图状态。
 *
 * # 放在路由之前，与 ASR 同位
 *
 * 它是输入转换：把照片变成文字观察，`intent` 只拿一行摘要，`ownershipDual` 把它拼成【图片观察】段。
 * 图片字节不进任何 LLM 文本上下文、不进 pi、不穿过 ACP。
 *
 * # 名称与级别不是模型说的
 *
 * 观察层的 schema 结构上没有名称 / 级别字段；这里出现的「安全带未系提醒 · reminder · info」
 * 全部来自手册图标目录的匹配（向量只召回，两道闸门 + 成对核验裁决）。没对上就写「未能与手册对上」，
 * 没有图标图片核验不了就标「未核验」——下游只能说「疑似」。
 *
 * # 绝不让整轮失败
 *
 * 没有 provider（`CARLIFE_VISION=off`）→ 直通并写 caveat；观察失败 → `unreadable` + caveat；
 * 匹配失败 → 该项「未能对上」。任何一步都不抛到图外。
 */

import type { RunnableConfig } from "@langchain/core/runnables";

import { extractCrop, observePhoto, type AlertReading, type ObservedItem, type PhotoObservation, type VisionProvider } from "@carlife/tools";
import type { IconDescriptor, MatchResult } from "@carlife/rag";

import type { GraphState } from "./state";
import { pickFigures, type FigureHitLite } from "./subgraphs/ownership";
import type { ChatGraphConfigurable } from "./supervisor";

export interface PhotoInput {
  handle: string;
  contentType: string;
  bytesBase64: string;
}

export interface PhotoMatch {
  symbolId: string;
  name: string;
  class: "fault" | "reminder" | "status";
  severity: "stop" | "check_soon" | "info";
  manualAnchor: string | null;
  verified: boolean;
  evidence: string;
}

export interface PhotoObservedItem {
  category: ObservedItem["category"];
  shape: string;
  color: string;
  state: string;
  elements: string[];
  text: string[];
  confidence: number;
  colorAgreement: ObservedItem["colorAgreement"];
  undeterminable: string[];
  /** 对上的手册图标；null = 未能对上（`matchReason` 说为什么） */
  match: PhotoMatch | null;
  matchReason?: string;
  /** 闸门没过时的 top 候选（只用于「疑似」措辞，不当结论） */
  suspected?: { name: string; symbolId: string };
}

/** 一条读到的车机警报（M80-10）。字面照抄，含义与措施来自知识库的官方警报代码表。 */
export interface PhotoAlert {
  code: string;
  title: string;
  subtitle: string;
  iconColor: string;
  active: boolean;
  at: string;
  /**
   * 官方警报代码表里的那一条（M80-10）。`null` = 表里没有收录——**与"这次没检索到"不是一回事**，
   * 下游据此说「这条代码手册里没有收录」，而不是留白让模型去补。
   */
  manual: { title: string; meaning: string[]; action: string[]; models: string[] } | null;
}

export interface PhotoObservationState {
  handle: string;
  unreadable: boolean;
  frame: { cut_off_sides: string[]; cutOffSource: "model" | "code" | "none"; quality: Record<string, boolean> };
  items: PhotoObservedItem[];
  notes: string[];
  /** 必须如实告知用户的缺失（并进【必须如实告知用户的缺失】段） */
  caveats: string[];
  /** 补拍指引（F-20-08）：具体到方向，不拒答 */
  retakeHints: string[];
  timings: PhotoObservation["timings"];
  model: PhotoObservation["model"];
  /**
   * 车机「警报」列表页读到的条目（M80-10）。**与图标观察并存而不是二选一**：
   * 同一张照片理论上可以既有仪表灯又有警报弹窗，而且"这张不是警报页"本身也是有用的信息
   * （`isAlertScreen:false` 时这里是空数组，下游照常走图标那条路）。
   */
  alerts: PhotoAlert[];
  /** 屏幕上明写「无活动警报」。与"没读到"完全不同：前者能说"当前没有活动警报"，后者只能说没看清。 */
  noActiveAlerts: boolean;
  /**
   * 手册图示召回（ACR-029）：观察层切出的指示灯 crop 对手册图文索引做近邻，命中的图带锚定段与出处。
   * 可选——开关 off / 未装配 / 老检查点都没有；问诊节点直接拿它拼【手册图示】段，不再裁一次。
   */
  figures?: FigureHitLite[];
}

export type IconMatcher = (args: { crop: Buffer; descriptor: IconDescriptor; vehicleModel?: string }) => Promise<MatchResult>;

export type AlertLookup = (code: string) => { title: string; meaning: string[]; action: string[]; models: string[] } | null;

export interface VisionDeps {
  /** null = `CARLIFE_VISION=off`：节点直通并写 caveat */
  provider: VisionProvider | null;
  /** 官方警报代码表的查表（M80-10）。缺省不装：那时读到的警报只有屏幕上的原话，没有官方解释。 */
  lookupAlert?: AlertLookup;
  /** 缺省 = 不匹配（`CARLIFE_ICON_INDEX=off` 或索引未接） */
  matchIcon?: IconMatcher;
  /** 手册图示召回（ACR-029）：拿观察层的 crop 去查手册图文索引。缺省不装 = 这一路不跑。 */
  recallFigures?: (crops: Buffer[]) => Promise<FigureHitLite[]>;
}

let visionDeps: VisionDeps | undefined;

export function setVisionDeps(d: VisionDeps | undefined): void {
  visionDeps = d;
}
export function getVisionDeps(): VisionDeps | undefined {
  return visionDeps;
}

const ZH_COLOR: Record<string, string> = { red: "红色", amber: "琥珀色", green: "绿色", blue: "蓝色", white: "白色", gray: "灰色", black: "黑色", unknown: "颜色不明" };
const ZH_SHAPE: Record<string, string> = {
  person: "人形", lamp: "灯形", circle: "圆形", triangle: "三角形", rectangle: "矩形", car_outline: "车轮廓", battery: "电池形",
  engine: "发动机形", wheel: "轮胎形", thermometer: "温度计形", droplet: "水滴形", wrench: "扳手形", steering_wheel: "方向盘形",
  letter_only: "文字", other: "符号",
};
const ZH_ELEMENT: Record<string, string> = {
  diagonal_band: "斜带", parentheses: "括号", wavy_lines: "波浪线", straight_lines: "直线", exclamation: "感叹号", arrow_left: "左箭头",
  arrow_right: "右箭头", arrow_both: "双向箭头", cross: "叉", check: "对勾", plus: "加号", minus: "减号", slash: "斜杠", circle_ring: "圆环",
};
const ZH_STATE: Record<string, string> = { lit: "点亮", unlit: "未点亮", blinking: "闪烁", unknown: "亮灭不明" };
const ZH_SEVERITY: Record<PhotoMatch["severity"], string> = { stop: "停车级", check_soon: "尽快检查", info: "提醒/状态" };
const ZH_CLASS: Record<PhotoMatch["class"], string> = { fault: "故障类", reminder: "提醒类", status: "状态类" };

/** 「红色 人形 斜带（点亮）」——只有观察，没有名称。 */
export function describeItem(it: Pick<PhotoObservedItem, "color" | "shape" | "elements" | "text" | "state">): string {
  const parts = [ZH_COLOR[it.color] ?? it.color, ZH_SHAPE[it.shape] ?? it.shape, ...it.elements.filter((e) => e !== "none").map((e) => ZH_ELEMENT[e] ?? e)];
  if (it.text.length) parts.push(`含字 ${it.text.join("")}`);
  return `${parts.join(" ")}（${ZH_STATE[it.state] ?? it.state}）`;
}

/** 给 `intent` 的一行摘要：只有观察，不带目录匹配——名称不进意图判断。 */
export function photoSummaryLine(obs: PhotoObservationState): string {
  // 警报页优先（M80-10）：意图层要据此判到售后（代码表在维修知识库），所以这一行必须说清是警报列表。
  if (photoHasAlerts(obs)) {
    const active = (obs.alerts ?? []).filter((a) => a.active);
    const listed = active.slice(0, 5).map((a) => `${a.code}${a.title ? ` ${a.title}` : ""}`).join("；");
    if (active.length === 0) return "【附件】用户附了 1 张车机「警报」列表截图，屏幕上写着无活动警报（另有若干早些时候的记录）。";
    return `【附件】用户附了 1 张车机「警报」列表截图，活动警报 ${active.length} 条：${listed}${active.length > 5 ? "…" : ""}。`;
  }
  if (obs.unreadable) return "【附件】用户附了 1 张照片，但没能读出内容。";
  const warn = obs.items.filter((i) => i.category === "warning_light");
  const listed = (warn.length ? warn : obs.items).slice(0, 6).map(describeItem).join("；");
  return `【附件】用户附了 1 张车辆仪表照片，观察到 ${obs.items.length} 项${warn.length ? `（其中指示灯 ${warn.length} 个）` : ""}：${listed || "无可辨识符号"}。`;
}

/** 补拍指引（F-20-08）：具体到方向；`cutOffSource=model` 时只说「可能」。 */
export function retakeHintsFor(obs: { unreadable: boolean; frame: PhotoObservationState["frame"]; items: PhotoObservedItem[] }): string[] {
  const hints: string[] = [];
  if (obs.unreadable) return ["这张照片没读出来，请把仪表盘正对镜头、开灯后再拍一张"];
  const q = obs.frame.quality;
  if (q.blur) hints.push("照片有些糊，拿稳再拍一张");
  if (q.dark) hints.push("画面偏暗，开灯或提高亮度后再拍");
  if (q.glare) hints.push("屏幕有反光，稍微换个角度");
  if (obs.frame.cut_off_sides.length) {
    const side: Record<string, string> = { left: "左", right: "右", top: "上", bottom: "下" };
    const s = obs.frame.cut_off_sides.map((x) => side[x] ?? x).join("、");
    hints.push(obs.frame.cutOffSource === "model" ? `${s}侧可能没拍全，如果那边还有灯请补一张` : `${s}侧没拍到，请补一张`);
  }
  const lowConf = obs.items.filter((i) => i.category === "warning_light" && i.confidence < 0.5).length;
  if (lowConf > 0) hints.push(`有 ${lowConf} 个符号看不太清，离近一点拍会更准`);
  return hints;
}

export const PHOTO_SECTION_HEADER = "【图片观察（只描述看到的；名称与级别来自手册图标目录，未核验的只能说「疑似」）】";
export const PHOTO_INSTRUCTION = "回答图片相关问题时：先说看到了什么、手册说它是什么（附锚点），再按级别给下一步；未核验或未对上的只能说「疑似」或「未能与手册对上」；不得说「没问题」「可以放心开」。";

export const ALERT_SECTION_HEADER = "【车机警报列表（代码与文字是屏幕上的原文；「手册说」几行来自官方警报代码表，标了「没有收录」的不得推断）】";
export const ALERT_INSTRUCTION =
  "回答警报相关问题时：先按「活动警报」逐条说代码与屏幕上的原话；" +
  "带「手册说」几行的引用它的含义与措施并附出处；**标了「没有收录」的明说「这条代码手册里没有收录」**，" +
  "只复述屏幕上那句提示，不得猜测原因或严重程度；历史分组的条目单独说一句「这些是早些时候的记录」。";

/** 【车机警报列表】段（M80-10）。没有警报就返回空串，调用方不拼。 */
export function alertSection(obs: PhotoObservationState): string {
  if (!photoHasAlerts(obs)) return "";
  const lines: string[] = [ALERT_SECTION_HEADER];
  const active = (obs.alerts ?? []).filter((a) => a.active);
  const past = (obs.alerts ?? []).filter((a) => !a.active);
  if (obs.noActiveAlerts && active.length === 0) lines.push("- 屏幕上写着「无活动警报」");
  const fmt = (a: PhotoAlert): string =>
    `- ${a.code}${a.title ? ` ${a.title}` : ""}${a.subtitle ? `（屏幕提示：${a.subtitle}）` : ""}${a.iconColor !== "unknown" ? ` · 图标${a.iconColor === "red" ? "红色" : a.iconColor === "gray" ? "灰色" : "蓝/绿色"}` : ""}`;
  /**
   * 官方那一段紧跟在它自己那条下面，缩进两格。
   * **查不到时明写出来**，不留白：留白等于把"手册怎么说"这一格交给模型去填。
   */
  const withManual = (a: PhotoAlert): string[] => {
    const out = [fmt(a)];
    if (!a.manual) {
      out.push(`  · 官方警报代码表里没有收录这条代码`);
      return out;
    }
    const src = `出处：${a.manual.models.join(" / ")} 官方警报代码表 ${a.code}`;
    if (a.manual.meaning.length) out.push(`  · 手册说它的含义：${a.manual.meaning.join(" ")}`);
    if (a.manual.action.length) out.push(`  · 手册给的措施：${a.manual.action.join(" ")}`);
    out.push(`  · ${src}`);
    return out;
  };
  if (active.length) lines.push("活动警报：", ...active.flatMap(withManual));
  // 历史条目只报代码与原话：它们多数已自行恢复，展开官方长文会把注意力从活动警报上带走
  if (past.length) lines.push(`早些时候（已不在活动列表）：`, ...past.map((a) => `${fmt(a)}${a.at ? ` · ${a.at}` : ""}`));
  lines.push(ALERT_INSTRUCTION);
  return lines.join("\n");
}

/** 拼进双路上下文的段落。 */
export function photoSection(obs: PhotoObservationState): string {
  const lines: string[] = [PHOTO_SECTION_HEADER];
  if (obs.unreadable) {
    lines.push("- 照片没能读出内容");
  } else if (obs.items.length === 0) {
    lines.push("- 照片里没有辨识出指示符号");
  } else {
    for (const it of obs.items) {
      const seen = describeItem(it);
      if (it.match) {
        const m = it.match;
        lines.push(`- ${seen} → 手册图标：${m.name} · ${ZH_CLASS[m.class]} · ${ZH_SEVERITY[m.severity]}${m.manualAnchor ? ` · 出处：${m.manualAnchor}` : ""}${m.verified ? "" : "（未核验，只能说「疑似」）"}`);
      } else if (it.category === "warning_light") {
        lines.push(`- ${seen} → 未能与手册对上${it.suspected ? `（最接近的是「${it.suspected.name}」，不足以确认）` : ""}`);
      } else {
        lines.push(`- ${seen}`);
      }
    }
  }
  if (obs.retakeHints.length) lines.push(`【补拍指引】\n${obs.retakeHints.map((h) => `- ${h}`).join("\n")}`);
  lines.push(PHOTO_INSTRUCTION);
  return lines.join("\n");
}

/**
 * 照片有没有辨识出仪表符号（M80-09 路由守卫用）。
 * 读不出内容、或一项都没有的照片不算——那样的照片给不出「去翻车主手册哪一章」的线索。
 */
export function photoHasSymbols(obs: PhotoObservationState | undefined): boolean {
  return Boolean(obs && !obs.unreadable && obs.items.length > 0);
}

/**
 * 这张照片是不是读出了车机警报（M80-10）——「无活动警报」也算读出来了。
 *
 * `alerts` 用 `?.` 取：M80-10 之前存下的检查点里没有这个字段，恢复出来的会话第一轮会读到
 * `undefined`。这类"老状态遇到新字段"不该抛，`state.ts` 的默认值只对新建的状态生效。
 */
export function photoHasAlerts(obs: PhotoObservationState | undefined): boolean {
  return Boolean(obs && !obs.unreadable && ((obs.alerts?.length ?? 0) > 0 || obs.noActiveAlerts));
}

/**
 * 照片给检索的词（M80-09）：对上手册图标的项 → 手册名称 + 锚点末两级（「指示灯 › 安全带」→「指示灯 安全带」）。
 *
 * 为什么不用观察描述子（「红色 人形 斜带」）：那是形状词，手册正文里不这么写；能命中手册章节的是
 * 目录给的**名称**与**锚点**。没对上的项什么也不贡献——宁可只用车主原话，也不拿形状词把检索带偏。
 */
export function photoRetrievalTerms(obs: PhotoObservationState | undefined): string[] {
  const out: string[] = [];
  /*
   * 警报页（M80-10）：**代码与屏幕标题都进检索词**。
   * 2026-09-10 实测 24 组真实条目：官方代码表按代码只命中 4 组、按标题只命中 2 组——
   * 两个都带上是因为哪一个能命中事先不知道，而带错一个的代价只是多几个没命中的词。
   * 只带活动警报：历史分组里那些「今天稍早时」的多数已经自行恢复，带上会把检索拖向已经过去的事。
   */
  for (const a of obs?.alerts ?? []) {
    if (!a.active) continue;
    out.push(a.code);
    if (a.title) out.push(a.title);
  }
  if (!photoHasSymbols(obs)) return [...new Set(out)];
  for (const it of obs!.items) {
    if (!it.match) continue;
    out.push(it.match.name);
    if (it.match.manualAnchor) {
      const segs = it.match.manualAnchor.split("›").map((x) => x.trim()).filter(Boolean);
      // 去掉第一级（「Model 3 车主手册」是书名，不是检索词）
      out.push(...segs.slice(1).slice(-2));
    }
  }
  return [...new Set(out)];
}

/**
 * 双路检索用的词 = 照片给的词 + 车主原话（或意图目标）。
 *
 * 2026-09-10 真跑（turn-d2d04bcb）：检索词只有「这咋啦？我的车」，翻出来的是胎压与座椅清洁——
 * 照片里认出的东西一个字都没进检索。名称在前：向量检索对前面的词更敏感。
 */
export function composeRetrievalQuery(userQuery: string, obs: PhotoObservationState | undefined): string {
  const terms = photoRetrievalTerms(obs).filter((t) => !userQuery.includes(t));
  return terms.length ? `${terms.join(" ")} ${userQuery}`.trim() : userQuery;
}

const semanticsToMatch = (r: Extract<MatchResult, { matched: true }>): PhotoMatch => ({
  symbolId: r.semantics.symbolId,
  name: r.semantics.name,
  class: r.semantics.class,
  severity: r.semantics.severity,
  manualAnchor: r.semantics.manualAnchor,
  verified: r.verified,
  evidence: r.evidence,
});

/** 把观察层输出 + 匹配结果折成图状态。导出是为了单测不经图。 */
export async function buildPhotoObservation(
  handle: string,
  image: Buffer,
  obs: PhotoObservation,
  matchIcon: IconMatcher | undefined,
  vehicleModel?: string,
  /** 读警报页那一遍的结果（M80-10）；没跑或没读到就传 undefined。 */
  alerts?: AlertReading,
  /** 官方代码表查表（M80-10）；不给就每条都是「手册里没有收录」。 */
  lookupAlert?: AlertLookup,
  /** 手册图示召回（ACR-029）；不给就不跑。拿的是匹配那一步裁好的 crop，不再裁一次。 */
  recallFigures?: VisionDeps["recallFigures"],
): Promise<PhotoObservationState> {
  const items: PhotoObservedItem[] = [];
  const caveats: string[] = [];
  const crops: Buffer[] = [];
  for (const it of obs.items) {
    const base: PhotoObservedItem = {
      category: it.category,
      shape: it.shape,
      color: it.color,
      state: it.state,
      elements: it.elements,
      text: it.text,
      confidence: it.confidence,
      colorAgreement: it.colorAgreement,
      undeterminable: it.undeterminable,
      match: null,
    };
    if (it.category === "warning_light" && !matchIcon && recallFigures) {
      // 索引 off 但图示召回 on：裁一次只给召回用
      try {
        crops.push(await extractCrop(image, it.bbox, 0.5));
      } catch {
        /* 裁不出来就不进召回 */
      }
    }
    if (it.category === "warning_light" && matchIcon) {
      try {
        const crop = await extractCrop(image, it.bbox, 0.5);
        crops.push(crop);
        const r = await matchIcon({ crop, descriptor: { shape: it.shape, color: it.color, state: it.state, elements: it.elements, text: it.text }, vehicleModel });
        if (r.matched) base.match = semanticsToMatch(r);
        else {
          base.matchReason = r.reason;
          if (r.top) base.suspected = { name: r.top.name, symbolId: r.top.symbolId };
        }
      } catch (e) {
        base.matchReason = `match_failed:${(e as Error).message}`;
      }
    } else if (it.category === "warning_light") {
      base.matchReason = "index_off";
    }
    items.push(base);
  }
  const warn = items.filter((i) => i.category === "warning_light");
  const alertEntries: PhotoAlert[] = alerts?.isAlertScreen ? alerts.entries.map((a) => ({ ...a, manual: lookupAlert?.(a.code) ?? null })) : [];
  if (obs.frame.unreadable && alertEntries.length === 0 && !alerts?.noActiveAlerts) caveats.push("本次附的照片没能读出内容");
  else if (alertEntries.length === 0 && warn.length && warn.every((i) => !i.match)) caveats.push("照片里的指示灯未能与手册图标对上，以下只基于可见描述");
  else if (warn.some((i) => i.match && !i.match.verified)) caveats.push("图标匹配未经图片核验，名称与级别只是「疑似」");
  const state: PhotoObservationState = {
    handle,
    unreadable: obs.frame.unreadable,
    frame: { cut_off_sides: obs.frame.cut_off_sides, cutOffSource: obs.frame.cutOffSource, quality: obs.frame.quality },
    items,
    notes: obs.notes,
    caveats,
    retakeHints: [],
    timings: obs.timings,
    model: obs.model,
    alerts: alertEntries,
    noActiveAlerts: Boolean(alerts?.isAlertScreen && alerts.noActiveAlerts),
  };
  /*
   * 读到警报页时**照片不算 unreadable**：图标观察在这种截图上本来就该是零项（屏幕上没有仪表灯），
   * 那不是"没读出来"。不覆盖的话下游会说"这张照片没看清"，而我们明明把每一行都抄下来了。
   */
  if (alertEntries.length > 0 || state.noActiveAlerts) state.unreadable = false;
  for (const n of alerts?.notes ?? []) state.notes.push(`警报页：${n}`);
  state.retakeHints = photoHasAlerts(state) ? [] : retakeHintsFor(state);
  // 手册图示召回（ACR-029）：失败只记 note，不拖垮观察结果。
  // 这里多留几条（12）：观察节点不知道车型，问诊节点还要按车型过滤再取前 3——只留 3 条的话，
  // 同一枚灯在 Model 3 手册里的三张图就把 Model Y 车主的那张挤出去了（2026-09-11 真跑踩到）。
  if (recallFigures && crops.length) {
    try {
      state.figures = pickFigures(await recallFigures(crops), undefined, 12);
    } catch (e) {
      state.figures = [];
      state.notes.push(`手册图示召回失败：${(e as Error).message}`);
    }
  }
  return state;
}

/** 图节点：没有附件 → 直通；有 → 观察第一张（多张只取第一张，其余记 note）。 */
export const observeAttachmentsNode = async (state: typeof GraphState.State, config?: RunnableConfig): Promise<Partial<typeof GraphState.State>> => {
  const inputs = state.photoInput;
  if (!inputs || inputs.length === 0) return { photoObservation: undefined };
  const configurable = config?.configurable as ChatGraphConfigurable | undefined;
  const deps = visionDeps;
  const first = inputs[0];
  const t0 = Date.now();
  if (!deps?.provider) {
    const off: PhotoObservationState = {
      handle: first.handle,
      unreadable: true,
      frame: { cut_off_sides: [], cutOffSource: "none", quality: {} },
      items: [],
      notes: ["CARLIFE_VISION=off：本次未分析图片"],
      caveats: ["本次未分析图片（视觉观察层未启用）"],
      retakeHints: [],
      timings: { detectMs: 0, describeMs: 0, totalMs: 0 },
      model: { detect: "off", describe: "off" },
      alerts: [],
      noActiveAlerts: false,
    };
    configurable?.onTrace?.({ kind: "vision", data: { handle: first.handle, mode: "off", ms: 0 } });
    return { photoObservation: off };
  }
  const image = Buffer.from(first.bytesBase64, "base64");
  let result: PhotoObservationState;
  try {
    /*
     * 两遍并行（M80-10）：图标观察与读警报页问的是同一张照片的两件事，谁也不依赖谁。
     * 串行会把警报页那一轮的耗时白加 1~2 秒；而 `readAlerts` 可选——端侧检测器与 fake 档没有它，
     * 那时这一遍直接跳过，照片照常走图标那条路。读警报失败也只是没有这一段，不拖垮整轮。
     */
    const [obs, alerts] = await Promise.all([
      observePhoto(image, deps.provider),
      deps.provider.readAlerts?.(image).catch((e: unknown) => {
        console.warn("[vision] 读警报页失败，本次只走图标观察", e);
        return undefined;
      }) ?? Promise.resolve(undefined),
    ]);
    result = await buildPhotoObservation(first.handle, image, obs, deps.matchIcon, undefined, alerts, deps.lookupAlert, deps.recallFigures);
  } catch (e) {
    // 观察层自己已经把检测/解码失败折成 unreadable；这里兜的是意料之外的异常——照样不让整轮失败。
    result = {
      handle: first.handle,
      unreadable: true,
      frame: { cut_off_sides: [], cutOffSource: "none", quality: {} },
      items: [],
      notes: [`观察失败：${(e as Error).message}`],
      caveats: ["本次附的照片没能读出内容"],
      retakeHints: retakeHintsFor({ unreadable: true, frame: { cut_off_sides: [], cutOffSource: "none", quality: {} }, items: [] }),
      timings: { detectMs: 0, describeMs: 0, totalMs: Date.now() - t0 },
      model: deps.provider.models,
      alerts: [],
      noActiveAlerts: false,
    };
  }
  if (inputs.length > 1) result.notes.push(`本轮附了 ${inputs.length} 张，只分析第一张`);
  configurable?.onTrace?.({
    kind: "vision",
    data: {
      handle: first.handle,
      model: result.model,
      unreadable: result.unreadable,
      items: result.items.length,
      warningLights: result.items.filter((i) => i.category === "warning_light").length,
      matched: result.items.filter((i) => i.match).length,
      verified: result.items.filter((i) => i.match?.verified).length,
      cutOff: result.frame.cut_off_sides,
      caveats: result.caveats,
      retakeHints: result.retakeHints,
      notes: result.notes,
      ms: Date.now() - t0,
      observed: result.items.slice(0, 8).map((i) => ({ seen: describeItem(i), match: i.match?.name ?? null, verified: i.match?.verified ?? false })),
      // 警报页（M80-10）：代码进轨迹，回放时才看得出"这一轮到底读到了哪几条"
      alerts: result.alerts.map((a) => ({ code: a.code, title: a.title, active: a.active, inManual: a.manual !== null })),
      noActiveAlerts: result.noActiveAlerts,
      // 手册图示（ACR-029）：命中了哪几张图、相似度多少——回放时看得出"这一轮为什么挂了这张图"
      figures: (result.figures ?? []).map((f) => ({ figureId: f.figureId, location: f.location, sim: Number(f.sim.toFixed(3)), via: f.via })),
    },
  });
  return { photoObservation: result };
};
