/**
 * [F-20-08][AC-20-6] [F-20-09][AC-20-7] [F-20-06][AC-20-2] [F-20-14] [F-20-15][AC-20-1][AC-20-11]
 * 引导配合卡 / 诊断报告页 / 基于报告追问（施工单 M104-04）。读源码不渲染（本包无 jsdom）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const GUIDED = read("../src/features/service/guided.tsx");
const REPORT = read("../src/features/service/report.tsx");
const FOLLOW = read("../src/features/service/followup.tsx");
const PROMPTS = read("../src/features/service/prompts.tsx");
const APP = read("../src/app/index.tsx");
const CSS = read("../src/features/service/diagnosis.css");
const count = (s: string, n: string) => s.split(n).length - 1;

describe("[F-20-08][AC-20-6] 补拍卡：只在有补拍指引时出现，按钮回拍照页；不拒答", () => {
  it("这一轮没有照片时仍有「查看报告」的落点（一行小卡）", () => {
    assert.match(GUIDED, /report\.observation \? \(\s*<ObservationCard[\s\S]*?data-testid="dx-report-row"/);
  });

  it("补拍卡由服务端的 capture 型 prompt 驱动（M106-04）；按钮回拍照页；不拒答", () => {
    // 「一条提示怎么变成一张卡」收回服务端（`captureFromRetakeHints`）；端上不再读 retakeHints 拼卡。
    assert.ok(!GUIDED.includes("retakeHints"));
    assert.ok(!GUIDED.includes("RetakeCard") && !GUIDED.includes("QuestionsCard"), "两张旧卡已退役");
    assert.match(GUIDED, /<PromptCards key=\{report\.at\} prompts=\{report\.prompts\} onAnswer=\{onAnswer\} onCapture=\{onRetake\} \/>/);
    assert.match(APP, /onRetake=\{\(\) => setCaptureOpen\(true\)\}/);
    assert.match(PROMPTS, /data-testid="dx-capture"[\s\S]*?onClick=\{onCapture\}/);
  });
});

/*
 * 2026-09-19 用户走查：检测零符号那一轮，观察卡顶着「看到了 0 盏亮着的灯」这个自相矛盾的标题，
 * 卡里一条都没有（更早的版本连整份报告都不生成，见 `isDiagnosisTurn`）。
 * 「没认出来」也是一个结果 —— 而且必须说清是"我没认出来"，不是"你车上没有"。
 */
describe("[F-20-08][AC-20-6] 观察卡：无论检测结果如何都出得来，且每条带手册原文说明", () => {
  it("三种结果各有各的标题，不合并", () => {
    // 「没读出来」= 图坏了；「没认出符号」= 图好好的但我们没认出来。合并了就分不出该重拍还是该换个角度。
    assert.match(GUIDED, /function cardTitle\(obs: Observation, lit: number\): string \{/);
    assert.match(GUIDED, /if \(obs\.unreadable\) return "这张照片没读出来";/);
    assert.match(GUIDED, /if \(obs\.items\.length === 0\) return obs\.alerts\.length > 0 \? "读到了车机警报" : "这张没认出仪表上的符号";/);
    assert.match(GUIDED, /<b className="dx-card__title">\{cardTitle\(obs, lit\)\}<\/b>/, "标题走那个函数，不再内联三元在 JSX 里");
  });

  it("一条都没有时有一句说明，且明说不代表车上没有提示灯", () => {
    assert.match(GUIDED, /const empty = obs\.items\.length === 0 && obs\.alerts\.length === 0;/);
    assert.match(GUIDED, /\{empty && <p className="dx-card__note">\{emptyNote\(obs\)\}<\/p>\}/);
    assert.ok(GUIDED.includes("这不代表车上没有提示灯"));
    // 「该怎么补拍」归服务端那张拍照卡；端上再拼一句，屏幕上同一句话会出现两遍。
    assert.ok(!GUIDED.includes("retakeHints"));
  });

  it("每条灯带手册原文说明：对话卡封两行，报告页给全文", () => {
    assert.match(GUIDED, /\{it\.description && <span className="dx-item__desc">\{descLine\(it\)\}<\/span>\}/);
    // 疑似那条写成条件句：一整段手册原文的份量会盖过旁边那枚「疑似」小徽章。
    assert.match(GUIDED, /return it\.suspected && it\.name \? `若是「\$\{it\.name\}」：\$\{it\.description\}` : String\(it\.description\);/);
    assert.ok(REPORT.includes("若是「"), "报告页同样是条件句");
    assert.match(CSS, /\.dx-item__desc \{[^}]*-webkit-line-clamp: 2;/);
    // 多一行说明会把徽章拽到第二行文字旁边，所以这时候改成顶部对齐。
    assert.match(CSS, /\.dx-item:has\(\.dx-item__desc\) \{ align-items: flex-start; \}/);
    assert.ok(!/\.dx-seen__desc \{[^}]*line-clamp/.test(CSS), "报告页不封行——对话卡封两行就是为了把全文让给它");
  });

  it("报告页的「照片里看到的」在零符号时也不是一张空卡", () => {
    assert.match(REPORT, /obs\.items\.length === 0 \? \(/);
    assert.ok(REPORT.includes("这张没认出仪表上的符号"));
  });
});

describe("[F-20-09][AC-20-7] 追问卡：芯片点选、答案合成一句发出", () => {
  it("提问型合进一张卡；全答完才能「发送」；只有一道不带其他的单选时选中即发；发出去之后锁住", () => {
    assert.match(PROMPTS, /const ready = composeAnswers\(asks, state\) !== null;/);
    assert.match(PROMPTS, /disabled=\{!ready \|\| sent\}/);
    assert.match(PROMPTS, /if \(sendsOnPick\(asks, opt\)\) send\(next\);/);
    assert.match(PROMPTS, /const needsSend = !\(asks\.length === 1 && asks\[0\]!\.kind === "single" && !asks\[0\]!\.allowOther\);/);
    assert.match(APP, /onAnswer=\{\(text\) => void sendText\(text\)\}/);
    assert.ok(PROMPTS.includes("点一下就行，不用打字"));
  });
});

describe("[F-20-06][AC-20-2] 报告页：风险卡第一眼、三档三色、红只给 high、必须停车迹象在", () => {
  it("等级标题 = 「中风险 · 建议尽快检查」这种形状；high 时停车卡上移并默认展开", () => {
    assert.match(REPORT, /return `\$\{LEVEL_LABEL\[report\.risk\.level\]\} · \$\{report\.risk\.action\}`;/);
    assert.match(REPORT, /const \[stopOpen, setStopOpen\] = useState\(high\);/);
    // 位置不变（high 时上移、否则在自查之后），但**空了就整张不出**——
    // 2026-09-18 起服务端在没有「必须立即停车」可讲时给空数组（`graph/diagnosis.ts` 的 `lampFacts`），
    // 一张「安全带没系」的照片不该再带出一张刹车失灵清单。
    assert.match(REPORT, /\{high && hasStop && stopCard\}[\s\S]*\{!high && hasStop && stopCard\}/);
    assert.match(REPORT, /const hasStop = report\.stopNowSigns\.length > 0;/);
    assert.match(CSS, /\.dx-risk--high \{ --dx-tone: var\(--hud-danger\)/);
    assert.match(CSS, /\.dx-risk--medium \{ --dx-tone: var\(--hud-warn/);
    assert.match(CSS, /\.dx-risk--low \{ --dx-tone: var\(--hud-pin\)/);
    // 红只出现在 high 那一条规则里
    assert.equal(count(CSS, "--hud-danger"), 1, "danger 只给 high 的色调（引导卡的红灯图标走 guided.tsx 的内联色，不在 CSS）");
  });
  it("报告页不解析回答文本：正文只按空行分段渲染，等级 / 观察 / 自查全来自 report 字段", () => {
    assert.match(REPORT, /report\.answer\s*\n?\s*\.split\(\/\\n\{2,\}\/\)/);
    assert.equal(/answer\.match\(|answer\.replace\(|RegExp\(/.test(REPORT), false);
    assert.match(REPORT, /report\.selfChecks\.map/);
    assert.match(REPORT, /report\.questionsForShop\.map/);
    assert.match(REPORT, /report\.stopNowSigns\.map/);
  });

  /**
   * 三张清单卡空了就不出。留一张空标题的卡，比那份无关内容好不了多少——
   * 车主看到的是「到店可以这样问」下面什么都没有。
   */
  it("到店问题与自查项也一样：列表空就不渲染那张卡", () => {
    assert.match(REPORT, /\{report\.questionsForShop\.length > 0 && \(/);
    assert.match(REPORT, /\{report\.selfChecks\.length > 0 && \(/);
  });
});

describe("[F-20-14] 免责只在报告页脚一处", () => {
  it("report.disclaimer 只渲染一次，且不在别的卡里重复", () => {
    assert.equal(count(REPORT, "report.disclaimer"), 1);
    assert.equal(GUIDED.includes("disclaimer"), false);
    assert.equal(FOLLOW.includes("disclaimer"), false);
  });
});

describe("[F-20-15][AC-20-1][AC-20-11] 接线：报告随轮拉取、追问态钉顶 + 快捷芯片、报告页车辆行来自默认车", () => {
  it("每轮助手回复落地后 loadDiagnosis；换会话清空", () => {
    assert.match(APP, /if \(!last \|\| last\.role !== "assistant"\) return;[\s\S]{0,120}loadDiagnosis\(currentSessionId\)/);
    assert.match(APP, /diagnosisSessionRef\.current = currentSessionId;\s*setDiagnosis\(null\);\s*setFollowupOpen\(false\);\s*\}, \[currentSessionId\]\);/);
  });
  it("追问态：pinned 是 ReportPin、trailing 是 QuickReplies、占位「基于报告继续问…」；引导态 trailing 是三张卡", () => {
    assert.match(APP, /pinned=\{report && !viewing && followupOpen \? <ReportPin/);
    // M106-04：追问态在快捷芯片之上多了 Agent 新发起的卡——此前这一态下服务端给的题没处显示。
    assert.match(APP, /followupOpen \? \(\s*<>[\s\S]*?<PromptCards key=\{report\.at\} prompts=\{report\.prompts\}[\s\S]*?<QuickReplies/);
    assert.match(APP, /<DiagnosisCards\s+report=\{report\}/);
    // 手机端恒定给占位：默认那句「打字输入…（驾驶中请用语音）」指向一个手机端没有的入口（2026-09-18）。
    assert.match(APP, /inputPlaceholder=\{report && followupOpen \? "基于报告继续问…" : "打字输入…"\}/);
    assert.deepEqual(FOLLOW.match(/text: "[^"]+"/g), ['text: "灯灭了"', 'text: "还亮着"', 'text: "预约门店检查"']);
  });
  it("「预约门店检查」= 带具体事由的一句话进对话（走既有预约子图 + HITL），报告页与芯片共用", () => {
    /*
     * 事由必须带（2026-09-18 真跑 turn-81976fd8）：固定一句「…门店检查一下这个问题」既命不中
     * 编排层的预约入口，agent 也不知道要约什么，车主收到的是「预约这块我这次没查到」。
     */
    assert.match(FOLLOW, /export function bookingPrompt\(report: DiagnosisReport\): string/);
    assert.match(FOLLOW, /帮我预约维修检查：\$\{subject\}/);
    assert.match(APP, /void sendText\(bookingPrompt\(report\)\);/);
    assert.match(APP, /onBook=\{bookInspection\}/);
    assert.equal(count(APP, "bookInspection"), 3, "定义一处 + 报告页 + 快捷芯片");
  });
  it("报告页车辆行来自默认车（vehicle / vehicleState），没有档案给「去建档」", () => {
    assert.match(APP, /<MobileDiagnosisReport\s+report=\{report\}\s+vehicle=\{homeVehicle\}\s+vehicleState=\{homeVehicleState\}/);
    assert.ok(REPORT.includes("去建档"));
  });
});

describe("报告页正文与对话气泡同一个渲染（2026-09-18 走查图二）", () => {
  it("`**关键信息**` 走 @carlife/ui 的 splitHighlights，不直出字符串", () => {
    assert.match(REPORT, /import \{ splitHighlights \} from "@carlife\/ui";/);
    assert.match(REPORT, /splitHighlights\(p\)\.map/);
    assert.match(REPORT, /className="dlg-key"/, "高亮样式与气泡共用一条，别在这里另写一套");
  });
})
