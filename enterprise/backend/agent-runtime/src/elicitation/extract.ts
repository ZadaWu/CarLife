/**
 * 从车主口述里抽 ④ 事实（施工单 M26-04，F-53-06，架构文档 §4.5）。
 *
 * # 为什么是这个形态
 *
 * §4.5 的判据："**如果你在写『识别用户说的是哪个数』的代码，那就是选错了**"。
 * 所以理解人话这一步交给模型——本文件不含任何抽数字的正则。
 *
 * 但它也**不是 A 型**（让模型自己决定调 `vehicle_profile_write`），
 * 原因是一个实测出来的事实：`ownership` 是 **B 型**子图，
 * 它自己 `invokeTool` 做双路检索，而应答那一步走**直连 narrator，
 * 系统提示词明写"你自己没有任何工具"**——模型在这条路上根本拿不到写工具。
 * 真跑里的表现是"答得很好、一个字没落库、权限门零次"（M26-04 验收 §5）。
 *
 * 折中因此是：**理解交给模型，决定写不写交给编排层**，与该子图既有形态一致。
 *
 * # 抽不出来就是抽不出来
 *
 * 任何一项拿不准都**缺席**，不给默认值、不猜。编错一条档案记录比这次没记上糟得多——
 * 车主可能拿它去和修理厂争议（F-23-11）。
 */

import type { ChatStreamer } from "../llm";

import type { ElicitedFacts } from "./service";

const PROMPT = `你在从车主的一句话里抽取两项事实，用于更新他的车辆档案。

只输出一个 JSON 对象，不要任何解释、不要代码块围栏：
{"lastServiceDate":"YYYY-MM-DD 或省略","items":"保养项目原话或省略","odometerKm":数字或省略}

规则：
- **拿不准就省略这一项**。宁可少抽，也不要猜——档案记录可能被拿去和修理厂争议。
- 里程按他说的口径换算成公里的整数："18 万 6 千多" → 186000，"3.2 万" → 32000。
  **不要四舍五入到更粗的位数**，也不要因为它看起来不合理就改。
- 相对日期按"今天是 {TODAY}"折算："上个月 12 号" → 上一个自然月的 12 日。
  折算不出确切某一天（如"前段时间""去年吧"）就省略。
- 他没提到的项一律省略；他明确说不想说时输出 {}。`;

/** 抽出来的 JSON。字段与提示词一一对应，命名刻意与 `ElicitedFacts` 略有差别以免混淆。 */
interface RawFacts {
  lastServiceDate?: unknown;
  items?: unknown;
  odometerKm?: unknown;
}

/** 从可能带围栏/前言的输出里取第一个完整 JSON 对象。 */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** 日期只接受 `YYYY-MM-DD`，且必须是真实存在的一天。 */
function parseDate(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ts = Date.UTC(y, mo - 1, d);
  const back = new Date(ts);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  // 未来的保养日期只能是抽错了——档案记的是已经发生的事。
  if (ts > Date.now()) return undefined;
  return ts;
}

/** 里程只接受正有限数，且挡住明显不可能的量级（百万公里）。 */
function parseKm(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return undefined;
  return Math.round(n);
}

export async function extractProfileFacts(
  streamer: ChatStreamer,
  userText: string,
  now = Date.now(),
): Promise<ElicitedFacts | undefined> {
  const today = new Date(now).toISOString().slice(0, 10);
  let raw = "";
  for await (const chunk of streamer(
    [
      { role: "user", content: `${PROMPT.replace("{TODAY}", today)}\n\n车主说：${userText}` },
    ],
    // `-task` 后缀让这个会话不思考：产出给代码解析的会话不该思考（内部开发指引）。
    { agent: "ownership-task" },
  )) {
    raw += chunk;
  }

  const json = firstJsonObject(raw);
  if (!json) return undefined;
  let o: RawFacts;
  try {
    o = JSON.parse(json) as RawFacts;
  } catch {
    return undefined;
  }

  const lastServiceAt = parseDate(o.lastServiceDate);
  const odometerKm = parseKm(o.odometerKm);
  const items = typeof o.items === "string" && o.items.trim() ? o.items.trim() : undefined;
  if (lastServiceAt === undefined && odometerKm === undefined) return undefined;
  return { lastServiceAt, odometerKm, items };
}
