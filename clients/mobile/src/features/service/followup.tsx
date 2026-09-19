/**
 * 基于报告继续问（施工单 M104-04，设计 UI-01 v1.1 第 5 步）：钉在对话列表上方的报告条 + 列表末尾的快捷回复芯片。
 * 两者都只读报告，不解析文本。
 */
import type { DiagnosisReport } from "./types";
import { riskTitle } from "./report";

import "./diagnosis.css";

export function ReportPin({ report, vehicleLabel, onOpen }: { report: DiagnosisReport; vehicleLabel?: string; onOpen: () => void }) {
  const d = new Date(report.at);
  const p = (n: number) => String(n).padStart(2, "0");
  const when = Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return (
    <div className={`dx-pin dx-risk--${report.risk.level}`} data-testid="dx-pin">
      <svg className="dx-pin__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h9l4 4v14H6z" />
        <path d="M15 3v4h4M9 12h6M9 16h6" />
      </svg>
      <span className="dx-pin__text">
        <b>车辆诊断报告 · {riskTitle(report).split(" · ")[0]}</b>
        <span>
          {when}
          {vehicleLabel ? ` · ${vehicleLabel}` : ""}
        </span>
      </span>
      <button type="button" className="dx-link" onClick={onOpen}>
        查看报告 ›
      </button>
    </div>
  );
}

/** 快捷回复：前两枚是对上一问的回答，第三枚走预约（与报告页同一句话）。 */
export const QUICK_REPLIES: ReadonlyArray<{ text: string; kind: "answer" | "book" }> = [
  { text: "灯灭了", kind: "answer" },
  { text: "还亮着", kind: "answer" },
  { text: "预约门店检查", kind: "book" },
];

export function QuickReplies({ onAnswer, onBook }: { onAnswer: (text: string) => void; onBook: () => void }) {
  return (
    <div className="dx-quick" data-testid="dx-quick" role="group" aria-label="快捷回复">
      {QUICK_REPLIES.map((q) => (
        <button key={q.text} type="button" className="dx-opt" onClick={() => (q.kind === "book" ? onBook() : onAnswer(q.text))}>
          {q.text}
        </button>
      ))}
    </div>
  );
}

/**
 * 「预约门店检查」发进对话的那句话——报告页与快捷芯片共用，后面是既有的维修预约子图
 * （repair_stations → repair_slots → appointment + HITL 确认弹窗）。
 *
 * **必须带上具体事由**（2026-09-18 真跑 turn-81976fd8）：原来发的是固定一句「帮我预约门店检查一下这个问题」，
 * 编排层的预约入口按「预约…维修/保养/检修」判，「门店检查」一字之差没命中，整条链走不到，
 * 车主收到的是「预约这块我这次没查到，您可以在 Tesla 手机应用里约」。服务端那道门已经补上了
 * 「门店检查」，这里同时把事由写进去——报告就在手边，没有理由让 agent 再反问一次「是哪个问题」。
 */
export function bookingPrompt(report: DiagnosisReport): string {
  const first = report.observation?.items.find((it) => it.name);
  const subject = first?.name ?? "这次问诊发现的问题";
  return `帮我预约维修检查：${subject}`;
}
