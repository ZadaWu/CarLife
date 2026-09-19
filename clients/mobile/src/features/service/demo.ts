/**
 * `?diagnosis=demo`：拍照问诊三步（引导卡 / 报告页 / 追问）的版式截图入口（施工单 M104-04）。
 * `&view=report` 直接落报告页、`&view=followup` 落追问态。数据文案自带「（演示）」，与 `?plan=demo` 同一纪律。
 */
import type { ChatMessage } from "@carlife/shared";

import type { DiagnosisReport } from "./types";

export function diagnosisDemoView(): "guided" | "report" | "followup" | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  if (q.get("diagnosis") !== "demo") return null;
  const v = q.get("view");
  return v === "report" || v === "followup" ? v : "guided";
}

const T0 = Date.parse("2026-09-17T14:32:00+08:00");
const sid = "demo-diagnosis";

export const DEMO_DIAGNOSIS_REPORT: DiagnosisReport = {
  threadId: "demo-thread",
  at: "2026-09-17T06:41:00.000Z",
  agent: "ownership",
  // 与服务端现在会给的形状一致（`graph/diagnosis.ts`）：一盏 info 级的灯 + 一个没对上的符号
  // → 中风险，依据按观察说话，不出现「无警告灯」也不出现「建议立即停止」。
  risk: { level: "medium", action: "建议尽快检查", basis: ["有 1 个符号没跟手册对上，先按「需要检查」看待"] },
  observation: {
    items: [
      // `symbolId` 取手册目录里的真 id：演示数据也要能看出那一列图标长不长对
      // ——版式截图走的就是这条路（`?dialog=demo`）。
      // `description` 照抄目录里那条的原文说明：版式走查要量的正是"两行封得住封不住"。
      {
        name: "安全带未系提醒",
        symbolId: "seatbelt_unfastened",
        suspected: false,
        class: "reminder",
        severity: "info",
        color: "red",
        state: "lit",
        manualAnchor: "手册 › 指示灯",
        description: "乘客座椅安全带未系好（指示灯为红色），请参阅座椅安全带",
      },
      // 没对上手册的那条 `description` 为 null：端上该是少一行，不是留一句占位话。
      { name: "车辆故障提示", symbolId: "system_fault", suspected: true, class: null, severity: null, color: "amber", state: "lit", manualAnchor: null, description: null },
    ],
    unreadable: false,
    retakeHints: ["右侧没拍到，请补一张"],
    alerts: [],
  },
  /*
   * 演示态五型给齐（M106-04）：`?diagnosis=demo` 一屏看全版式。
   * 真实一轮过不了预算器的那几条线（问题位 2、总数 4）——这里是版式走查，不是一轮真实的裁决结果。
   */
  prompts: [
    { id: "c-retake-demo", origin: "code", kind: "capture", title: "右侧没拍到，请补一张", hint: "仪表右半边在框外，如果那边还有灯亮着，补拍后判断会更准。" },
    {
      id: "m-guidance-demo",
      origin: "model",
      kind: "guidance",
      title: "检查副驾安全带卡扣",
      steps: ["把副驾座位上的物品拿走（包、水、快递都算）", "把副驾安全带插舌拔出，再插到底，听到咔哒一声", "等十秒，看仪表上这盏灯灭没灭"],
      source: "用户手册 › 指示灯 › 安全带提醒",
      outcomes: ["灯灭了", "还亮着", "做不了"],
    },
    { id: "m-single-demo", origin: "model", kind: "single", text: "副驾座位上现在放着东西吗？", options: ["放着", "没放", "坐着人"], allowOther: true },
    { id: "m-multi-demo", origin: "model", kind: "multi", text: "除了这盏灯，还有哪些情况？", options: ["有提示音", "屏幕弹了警报", "车开不动", "都没有"], allowOther: true },
    { id: "m-open-demo", origin: "model", kind: "open", text: "这盏灯大概是开了多久之后亮的？", placeholder: "比如：上高速半小时后" },
  ],
  askedRounds: 1,
  askedIds: ["parked", "since"],
  selfChecks: ["安全带未系提醒按手册处理一下，再看这盏灯灭没灭", "还有 1 个符号没跟手册对上，正对仪表、离近一点再拍一张", "右侧没拍到，请补一张", "处理完回到对话里说一声这几盏灯还亮不亮"],
  // 手册没把任何一盏列为「立即处理」→ 空数组，报告页整张卡不出（2026-09-18）。
  stopNowSigns: [],
  questionsForShop: ["这个症状你们判断是哪个部件？依据是什么？", "更换与维修两种方案的价格与寿命差别？", "如果不修，最坏会发展成什么？多久？"],
  answer:
    // 正文里带 `**`：这是服务端现在会给的形状（关键信息标注，见 `llm/answer-format.ts`），
    // 版式截图要能看出高亮长什么样。端上渲染走 `splitHighlights`，星号不上屏。
    "风险：中。照片里那盏红色人形加斜带的灯是**安全带提醒**，手册 › 指示灯 写到：副驾座椅上放了较重的物品时它也会亮；旁边琥珀色的三角**只能说疑似**车辆故障提示，没有与手册完全对上。可能的原因按可能性排：副驾座椅上有物品被识别为乘客；安全带卡扣未完全插入；座椅占用传感器需要检查。（演示）",
  disclaimer: "以上是按可能性排序的判断，不是维修结论；是否需要维修请由专业人员检查确认。",
};

const msg = (i: number, role: "user" | "assistant", content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `demo-dx-m${i}`,
  sessionId: sid,
  turnId: `demo-dx-t${Math.ceil(i / 2)}`,
  role,
  source: "text",
  content,
  ts: T0 + i * 20_000,
  ...extra,
});

/** 引导态：车主只发了一张照片（没有文字）。浏览器没有取件端口，气泡里是「📷 照片」占位，不假装有图。 */
export const DEMO_DIAGNOSIS_MESSAGES_GUIDED: ChatMessage[] = [
  msg(1, "user", "", { attachments: [{ attachmentId: "demo-a1", kind: "image", handle: "demo-a1", contentType: "image/jpeg", bytes: 1_843_200, filename: "IMG_2317.jpg" }] }),
  msg(2, "assistant", DEMO_DIAGNOSIS_REPORT.answer),
];

/** 追问态：基于报告继续问了一句。 */
export const DEMO_DIAGNOSIS_MESSAGES_FOLLOWUP: ChatMessage[] = [
  ...DEMO_DIAGNOSIS_MESSAGES_GUIDED,
  msg(3, "user", "安全带我系了啊，为什么还亮？"),
  msg(4, "assistant", "报告里那盏红色人形加斜带的灯是安全带提醒，不只看驾驶位。手册 › 指示灯 写到：副驾座椅上放了较重的物品时，它也会亮。可以先把副驾上的包拿开，再看灯有没有熄灭。（演示）"),
];
