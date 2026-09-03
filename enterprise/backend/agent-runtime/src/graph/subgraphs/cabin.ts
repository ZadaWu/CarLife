/**
 * 座舱陪伴（US-19，§4.3④）。
 *
 * # 这条路上唯一真正的风险是"假装认识你"
 *
 * 陪伴场景没有知识库、没有出处、没有可核对的事实——正因为如此，
 * 它是五个 Agent 里**最容易编、也最难被发现在编**的一个。
 * 用车助手编错了会被"这个数哪来的"问住；陪伴编一句"你不是一直喜欢走国道吗"，
 * 用户只会觉得"它记错了"，不会觉得系统有问题。
 *
 * 所以这里做的事很窄：**把真实存在的③偏好取出来交给表述层，一条都不推断**。
 * 没有偏好就明说没有，不用"我记得你……"起头。
 *
 * # 未接入 / 降级 / 真的没有，三种情况必须分开
 *
 * - 未接入：我们的接线问题
 * - 降级（degraded）：**这次没查到不代表没有**，不能说成"我还不了解你"
 * - 零结果且未降级：用户确实还没有偏好，可以说
 *
 * 三者对用户说的话完全不同。合成一句"我还不太了解你"是最省事的写法，
 * 也正好在故障时说了一句谎。
 *
 * # 不读②情景
 *
 * 情景记忆带具体时间地点，混进闲聊会变成"我记得你上周去了哪儿"——
 * 那是一个产品决定（隐私观感、被记录感），不该由陪伴顺手做掉。
 */

import { invokeTool, type ToolCallContext } from "@carlife/tools";

export interface CabinPreference {
  content: string;
  confidence?: number;
}

export interface CabinResult {
  preferences: CabinPreference[];
  /** 这次能不能说"我知道你的习惯"。 */
  personalized: boolean;
  /** 交给 LLM 表述用的上下文。 */
  context: string;
  /** 必须如实告知用户的缺失说明。 */
  caveats: string[];
}

/**
 * 低于此置信度的偏好**不进上下文**。
 *
 * ③的写入路径允许低置信度条目存在（它们靠访问强化慢慢变可信）。
 * 但陪伴是把偏好**说出来**的场景，说错的代价比不说高得多——
 * 一条 0.3 置信度的"你好像喜欢听相声"被念出来，听起来和事实一样确定。
 */
const MIN_CONFIDENCE = 0.5;

export async function runCabinContext(args: {
  query: string;
  userId?: string;
  ctx: ToolCallContext;
}): Promise<CabinResult> {
  const { query, userId, ctx } = args;
  const caveats: string[] = [];

  if (!userId) {
    // 与双路那边同一条原则：分清"没有用户上下文"（我们的接线问题）
    // 与"这个用户没有数据"（用户的真实状态）。
    return {
      preferences: [],
      personalized: false,
      context: "说明：本次没有用户身份，读不到偏好。**不要用「我记得你……」这类说法**，按初次见面处理。",
      caveats: ["本次没有用户身份，读不到你的偏好"],
    };
  }

  let preferences: CabinPreference[] = [];
  let degraded = false;
  let unavailable = false;
  try {
    const r = (await invokeTool("preference_recall", { userId, query, limit: 5 }, ctx)) as {
      data: { preferences: Array<{ content: string; confidence?: number }>; degraded: boolean };
    };
    degraded = r.data.degraded;
    preferences = r.data.preferences.filter((p) => (p.confidence ?? 1) >= MIN_CONFIDENCE);
  } catch {
    unavailable = true;
  }

  if (unavailable) {
    caveats.push("偏好记忆这次读不到（不是你没有偏好，是我这边没读上）");
  } else if (degraded) {
    caveats.push("偏好检索处于降级状态——这次没查到不代表没有");
  }

  const personalized = preferences.length > 0 && !degraded && !unavailable;

  const parts = [
    personalized
      ? `已知的用户偏好（③记忆，可以据此说话）：\n${preferences.map((p) => `- ${p.content}`).join("\n")}`
      : "没有可用的用户偏好。",
    personalized
      ? "只用上面列出的偏好，**不要推断没写的**（例如从「常走市区」推出「不喜欢长途」）。"
      : unavailable || degraded
        ? "**不要说「我还不太了解你」**——那是把一次故障说成用户的状态。可以说这次没取到你的偏好。"
        : "这位用户确实还没有沉淀偏好，按初次了解处理，不要用「我记得你……」起头。",
    caveats.length > 0 ? `必须如实告知用户：\n- ${caveats.join("\n- ")}` : "",
  ].filter(Boolean);

  return { preferences, personalized, context: parts.join("\n\n"), caveats };
}

// ═══════════════════════════════════════════════════════════
// 直接控制路径（施工单 M24-04，F-49-05/08/12）
// ═══════════════════════════════════════════════════════════

import { parseCabinCommands } from "../cabin-commands";
import type { CabinControlData, CabinOpResult } from "@carlife/tools";

/** 权限门的最小面（同 supervisor 的用法；参数注入以便单测）。 */
export interface CabinGuardGate {
  check(req: {
    sessionId: string;
    agent: string;
    tool: string;
    summary: string;
    details?: string[];
  }): Promise<{ decision: "allow" | "deny" | string; reason?: string }>;
}

const ZONE_LABEL: Record<string, string> = {
  driver: "主驾",
  passenger: "副驾",
  rearLeft: "后排左",
  rearRight: "后排右",
  cabin: "全车",
  front: "前排",
  rear: "后排",
};

const FIELD_LABEL: Record<string, string> = {
  tempC: "温度",
  fanLevel: "风量",
  mode: "空调模式",
  recirculation: "内循环",
  sync: "分区同步",
  heating: "座椅加热",
  ventilation: "座椅通风",
  massage: "按摩",
  color: "氛围灯颜色",
  brightness: "氛围灯亮度",
  source: "播放内容",
  volume: "音量",
  volumeLimit: "音量上限",
  contentTag: "内容",
  intensity: "香氛浓度",
  scent: "香型",
  screenLock: "后排屏幕锁",
  childLock: "儿童锁",
};

/** "rearLeft.ventilation" / "ventilation" → 人话字段名（多分区键带前缀）。 */
function fieldLabel(key: string): string {
  const [a, b] = key.split(".");
  if (b) return `${ZONE_LABEL[a] ?? a}${FIELD_LABEL[b] ?? b}`;
  return FIELD_LABEL[a] ?? a;
}

function zonesLabel(zones: string[]): string {
  return zones.map((z) => ZONE_LABEL[z] ?? z).join("/");
}

function fmtValue(field: string, v: unknown): string {
  const base = field.split(".").pop() ?? field;
  if (base === "tempC") return `${v}℃`;
  if (base === "heating" || base === "ventilation" || base === "fanLevel") return `${v} 档`;
  if (base === "brightness" || base === "volume" || base === "volumeLimit") return String(v);
  if (v === true) return "开";
  if (v === false) return "关";
  return String(v);
}

/**
 * 把逐字段裁决翻成结构化转述清单（F-49-05）。
 *
 * **四态穷举**：applied 说结果、clamped 说边界值与原因、skipped 说原因、
 * rejected/invalid 说没做并给原因。转述层拿到的是成品清单——
 * 不靠模型自己读 JSON 猜（M20-04 的先例）。
 */
export function describeCabinResults(results: CabinOpResult[]): { done: string[]; adjusted: string[]; undone: string[] } {
  const done: string[] = [];
  const adjusted: string[] = [];
  const undone: string[] = [];
  for (const r of results) {
    if (r.status === "invalid" || r.status === "rejected") {
      undone.push(`${FIELD_LABEL[r.domain] ?? r.domain}：没做——${r.reason ?? "原因未知"}`);
      continue;
    }
    const zone = zonesLabel(r.zones);
    for (const [field, v] of Object.entries(r.applied)) {
      if (field in r.clamped) continue; // 夹过的进 adjusted，不重复报
      done.push(`${zone}${fieldLabel(field)}：${fmtValue(field, v)}`);
    }
    for (const [field, c] of Object.entries(r.clamped)) {
      adjusted.push(`${zone}${fieldLabel(field)}：您要 ${fmtValue(field, c.requested)}，${c.note}，已按 ${fmtValue(field, c.applied)} 执行`);
    }
    for (const [field, reason] of Object.entries(r.skipped)) {
      undone.push(`${zone}${fieldLabel(field)}：没做——${reason}`);
    }
  }
  return { done, adjusted, undone };
}

export interface CabinControlOutcome {
  /** 交给表述层的上下文（含表述纪律）。 */
  context: string;
  /**
   * 本轮覆盖候选（M24-08，F-50-10）："副驾调 26"要在同会话的后续应用里生效。
   * 只回温度——覆盖语义只对全车共享面有意义。**不回写偏好**。
   */
  roundOverride?: { tempC?: number };
  /** 轨迹用摘要。 */
  trace: {
    requestIds: string[];
    done: number;
    adjusted: number;
    undone: number;
    rebuilt: boolean;
    childDenied: boolean;
  };
}

/**
 * 设置路径：解析 → （儿童模式先确认）→ 下发 → 结构化转述。
 *
 * 返回 null = 这句话不是设置指令，调用方走陪聊路径——**陪聊行为与 M8 形态
 * 逐字节一致**（回归钉住），这是本单的红线。
 */
export async function runCabinControl(args: {
  query: string;
  userId?: string;
  ctx: ToolCallContext;
  gate?: CabinGuardGate;
  invoke?: typeof invokeTool;
}): Promise<CabinControlOutcome | null> {
  const parsed = parseCabinCommands(args.query);
  if (!parsed) return null;
  const call = args.invoke ?? invokeTool;

  if (!args.userId) {
    return {
      context:
        "用户想做座舱设置，但本次没有用户身份，定位不到他的车。如实说明设置不了，请他登录后再试；不要假装已设置。",
      trace: { requestIds: [], done: 0, adjusted: 0, undone: 0, rebuilt: false, childDenied: false },
    };
  }

  // 只有没解析出来的部分 → 让表述层追问具体值，不瞎猜。
  if (parsed.comfort.length === 0 && parsed.child.length === 0) {
    return {
      context: `用户在指挥座舱，但这几句没听出具体要设什么：${parsed.unparsed.join("；")}。请向他确认具体数值或动作（如"调到几度"），**不要替他猜一个值下发**。`,
      trace: { requestIds: [], done: 0, adjusted: 0, undone: 0, rebuilt: false, childDenied: false },
    };
  }

  const lines: string[] = [];
  const trace: CabinControlOutcome["trace"] = { requestIds: [], done: 0, adjusted: 0, undone: 0, rebuilt: false, childDenied: false };

  try {
    // ── 儿童模式先行：确认在前，任何下发在后（M24-03 混合单不变量）──
    if (parsed.child.length > 0) {
      const summary = parsed.child
        .map((op) => Object.entries(op.set).map(([f, v]) => `${FIELD_LABEL[f] ?? f}=${fmtValue(f, v)}`).join("、"))
        .join("；");
      const verdict = args.gate
        ? await args.gate.check({
            sessionId: args.ctx.sessionId,
            agent: "cabin",
            tool: "cabin_child_mode",
            summary: `儿童模式设置：${summary}`,
            details: ["影响后排乘员的乘坐体验，需要车主确认"],
          })
        : { decision: "deny" as const, reason: "权限门未装配，敏感动作一律拒绝" };
      if (verdict.decision !== "allow") {
        trace.childDenied = true;
        // 被拒 → **整单不发**（含舒适域）：不存在"部分生效后回滚"。
        return {
          context: `儿童模式设置未获确认（${verdict.reason ?? "已取消"}），本次**什么都没有下发**（包括同一句里的其它设置）。如实告知，并说明可以随时再要求一次。`,
          trace,
        };
      }
      const r = (await call("cabin_child_mode", { userId: args.userId, ops: parsed.child }, args.ctx)) as {
        data: CabinControlData;
      };
      trace.requestIds.push(r.data.requestId);
      trace.rebuilt ||= r.data.rebuilt;
      const d = describeCabinResults(r.data.results);
      lines.push(...d.done.map((s) => `✔ ${s}`), ...d.adjusted.map((s) => `≈ ${s}`), ...d.undone.map((s) => `✘ ${s}`));
      trace.done += d.done.length;
      trace.adjusted += d.adjusted.length;
      trace.undone += d.undone.length;
    }

    if (parsed.comfort.length > 0) {
      const r = (await call("cabin_control", { userId: args.userId, ops: parsed.comfort }, args.ctx)) as {
        data: CabinControlData;
      };
      trace.requestIds.push(r.data.requestId);
      trace.rebuilt ||= r.data.rebuilt;
      const d = describeCabinResults(r.data.results);
      lines.push(...d.done.map((s) => `✔ ${s}`), ...d.adjusted.map((s) => `≈ ${s}`), ...d.undone.map((s) => `✘ ${s}`));
      trace.done += d.done.length;
      trace.adjusted += d.adjusted.length;
      trace.undone += d.undone.length;
    }
  } catch (err) {
    // 未接入 / 未绑定 / 不可达——话术已由工具层写好（拦"假装调好"），原样交给表述。
    const message = err instanceof Error ? err.message : String(err);
    const followups = parsed.unparsed.length > 0 ? `\n另有没听清的部分可后续再问：${parsed.unparsed.join("；")}` : "";
    return {
      context: `座舱设置没有执行：${message}${followups}\n表述要求：如实转达以上原因，**不要说任何"已调好/已设置"**。`,
      trace,
    };
  }

  const clarify = parsed.unparsed.length > 0 ? `\n没听出具体值、需要向用户确认的：${parsed.unparsed.join("；")}` : "";
  const rebuiltNote = trace.rebuilt ? "\n说明：车机刚重新连接过（此前重启），之前的设置已回到默认。" : "";
  const tempOp = parsed.comfort.find((o) => o.domain === "climate" && typeof o.set.tempC === "number");
  const roundOverride = tempOp ? { tempC: tempOp.set.tempC as number } : undefined;
  return {
    roundOverride,
    context: `【座舱设置结果——来自车机（模拟系统），逐条如实转述】
${lines.join("\n")}${rebuiltNote}${clarify}

表述要求：✔=已生效、≈=按边界调整执行（要把"您要的值"和"实际值"都说出来）、✘=没做到（要说原因）。
**必须覆盖以上全部条目**；部分成功不得说成全部成功；不要添加清单外的设置；不要复述这些符号本身。`,
    trace,
  };
}
