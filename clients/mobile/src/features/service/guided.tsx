/**
 * 引导配合（施工单 M104-04，设计 UI-01 v1.1 第 3 步）：观察卡 + Agent 发起的交互卡，挂在对话列表末尾（`DialogScreen.trailing`）。
 *
 * 全部读结构化报告（`DiagnosisReport`），**不解析回答文本**。
 * M106-04 起补拍卡与追问卡由 `prompts.tsx` 的五型卡片取代：出哪几张、什么顺序由服务端的预算器定
 * （`report.prompts`），这里只负责把观察卡摆在它们上面。
 */
import { lampArt } from "./lamps";
import { PromptCards } from "./prompts";
import type { DiagnosisObservedItem, DiagnosisReport } from "./types";

import "./diagnosis.css";

const COLOR_ZH: Record<string, string> = { red: "红色", amber: "琥珀色", green: "绿色", blue: "蓝色", white: "白色", gray: "灰色", black: "黑色", unknown: "颜色未定" };
const CLASS_ZH: Record<string, string> = { fault: "故障类", reminder: "提醒类", status: "状态类" };

function itemCaption(it: DiagnosisObservedItem): string {
  const parts = [COLOR_ZH[it.color] ?? it.color];
  if (it.class) parts.push(CLASS_ZH[it.class] ?? it.class);
  if (it.manualAnchor) parts.push(it.manualAnchor);
  else parts.push("未能与手册完全对上");
  return parts.join(" · ");
}

/**
 * 那枚灯长什么样。
 *
 * **优先用手册里那张图**（`lampArt`，按 `symbolId` 取）——车主要分辨的正是符号本身，
 * 而在这之前每一条画的都是同一个三角感叹号：「安全带未系」和「胎压报警」在屏幕上
 * 一模一样，那一列图标等于没有（2026-09-18 用户走查）。
 *
 * 取不到才回落到按颜色着色的三角块：目录里新增一个符号时，端上该是少一枚图标，
 * 不是留一个破图。回落**不画具体形状**——端上"画一个像的"就是在手册之外
 * 另立一个真相源，那是这套观察层从一开始就不做的事。
 */
function LampGlyph({ item }: { item: DiagnosisObservedItem }) {
  const art = lampArt(item.symbolId);
  const tone = item.color === "red" ? "var(--hud-danger)" : item.color === "amber" ? "var(--hud-amber)" : "var(--hud-text-muted)";
  return (
    <span className="dx-lamp" aria-hidden="true">
      {art ? (
        <img className="dx-lamp__art" src={art} alt="" draggable={false} />
      ) : (
        <svg viewBox="0 0 24 24">
          <path d="M12 3l9 16H3z" fill={tone} />
          <path d="M12 9v5M12 16.5v.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

type Observation = NonNullable<DiagnosisReport["observation"]>;

/**
 * 卡的标题。**三种结果各有各的说法，不要合并**（2026-09-19 用户走查）：
 * 「没读出来」是图坏了，「没认出符号」是图好好的但我们没认出来——后者才是走查那张的情形，
 * 而在这之前它会顶着「看到了 0 盏亮着的灯」这个自相矛盾的标题出现。
 */
function cardTitle(obs: Observation, lit: number): string {
  if (obs.unreadable) return "这张照片没读出来";
  if (obs.items.length === 0) return obs.alerts.length > 0 ? "读到了车机警报" : "这张没认出仪表上的符号";
  return `看到了 ${lit || obs.items.length} 盏亮着的灯`;
}

/**
 * 一条符号都没有时那句话。**说清楚是「我没认出来」而不是「你车上没有」**——
 * 后者是车主最容易读成的意思，而它可能正亮着一盏红灯。
 *
 * **这里不说「该怎么补拍」**：那一句归服务端出的拍照卡（`captureFromRetakeHints`），
 * 就在这张卡下面。端上照着 `retakeHints` 再拼一句，屏幕上就是同一句话连着出现两遍。
 */
function emptyNote(obs: Observation): string {
  return obs.unreadable ? "图片没能解出内容，换一张再试。" : "这不代表车上没有提示灯，只是这张没能和手册图标对上。";
}

/**
 * 说明行。**疑似的那条写成条件句**（`若是「X」：…`）。
 *
 * 2026-09-19 重放 turn-2f9f1a98 时撞见的：安全带那枚灯没对上，top 候选是「系统故障」，
 * 而它的手册原文是「遵照所显示的相关信息中的提示，联系 Tesla」。原样贴出来，
 * 一整段手册原文的份量会盖过旁边那枚「疑似」小徽章——车主读到的是一条确定的坏消息。
 * 条件句既留住了信息，又没有替手册下这个结论。
 */
function descLine(it: DiagnosisObservedItem): string {
  return it.suspected && it.name ? `若是「${it.name}」：${it.description}` : String(it.description);
}

export function ObservationCard({ report, onOpenReport }: { report: DiagnosisReport; onOpenReport?: () => void }) {
  const obs = report.observation;
  if (!obs) return null;
  const lit = obs.items.filter((it) => it.state === "lit").length;
  // 一条都没有时也要有个说法（2026-09-19 用户走查）：见 `emptyNote`。
  const empty = obs.items.length === 0 && obs.alerts.length === 0;
  return (
    <section className="dx-card" data-testid="dx-observation">
      <header className="dx-card__head">
        <b className="dx-card__title">{cardTitle(obs, lit)}</b>
        {onOpenReport && (
          <button type="button" className="dx-link" onClick={onOpenReport}>
            查看报告 ›
          </button>
        )}
      </header>
      {obs.items.map((it, i) => (
        <div className="dx-item" key={`${it.name ?? "?"}-${i}`}>
          <LampGlyph item={it} />
          <span className="dx-item__text">
            <b>{it.suspected ? `疑似：${it.name ?? "未知符号"}` : (it.name ?? "未能对上的符号")}</b>
            <span>{itemCaption(it)}</span>
            {/* 手册原文说明（2026-09-19）。分类与锚点是"它属于哪一类、去哪查"，这一行才是"它是什么意思"。 */}
            {it.description && <span className="dx-item__desc">{descLine(it)}</span>}
          </span>
          <span className={`dx-chip ${it.suspected || !it.name ? "dx-chip--amber" : "dx-chip--ok"}`}>{it.suspected || !it.name ? "疑似" : "已对上手册"}</span>
        </div>
      ))}
      {empty && <p className="dx-card__note">{emptyNote(obs)}</p>}
      {obs.alerts.length > 0 && (
        <p className="dx-card__note">读到 {obs.alerts.length} 条车机警报：{obs.alerts.map((a) => a.code).join("、")}</p>
      )}
    </section>
  );
}

export interface DiagnosisCardsProps {
  report: DiagnosisReport;
  onRetake: () => void;
  onAnswer: (text: string) => void;
  onOpenReport: () => void;
}

/**
 * 按 Brief 顺序：观察 → 交互卡（拍照 → 引导 → 提问，顺序由服务端给）。
 * 这一轮没有照片（比如答完追问的那一轮）时观察卡不在，「查看报告」得另有落点——一行小卡，
 * 否则报告就只能从主页那张卡的状态行进（2026-09-18 模拟器走查发现）。
 */
export function DiagnosisCards({ report, onRetake, onAnswer, onOpenReport }: DiagnosisCardsProps) {
  return (
    <div className="dx-cards" data-testid="dx-cards">
      {report.observation ? (
        <ObservationCard report={report} onOpenReport={onOpenReport} />
      ) : (
        <section className="dx-card dx-card--row" data-testid="dx-report-row">
          <span className="dx-card__title">诊断报告已更新</span>
          <button type="button" className="dx-link" onClick={onOpenReport}>
            查看报告 ›
          </button>
        </section>
      )}
      {/* `key={report.at}`：新一轮的报告 = 新的一组卡，选中态与「已发送」随之清掉。 */}
      <PromptCards key={report.at} prompts={report.prompts} onAnswer={onAnswer} onCapture={onRetake} />
    </div>
  );
}
