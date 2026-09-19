/**
 * [F-20-06][AC-20-2] [F-20-09][AC-20-7] [F-20-13] 拍照问诊的结构化报告（施工单 M104-01）。零依赖，纯函数。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { buildDiagnosisReport, isDiagnosisTurn, observedWarningLight, pickQuestions, symptomSignal, QUESTION_BANK } from "../src/graph/diagnosis";
import { bookingSubject, diagnosisSection } from "../src/graph/subgraphs/ownership";
import { assessRisk } from "../src/graph/subgraphs/service";
import type { PhotoObservationState } from "../src/graph/vision";

const SUPERVISOR = readFileSync(new URL("../src/graph/supervisor.ts", import.meta.url), "utf8");

function obs(over: Partial<PhotoObservationState> = {}): PhotoObservationState {
  return {
    handle: "h1",
    unreadable: false,
    frame: { cut_off_sides: [], cutOffSource: "none", quality: {} },
    items: [],
    notes: [],
    caveats: [],
    retakeHints: [],
    timings: {} as PhotoObservationState["timings"],
    model: {} as PhotoObservationState["model"],
    alerts: [],
    noActiveAlerts: false,
    ...over,
  };
}
const seatbelt = {
  category: "warning_light" as const,
  shape: "person",
  color: "red",
  state: "lit",
  elements: ["diagonal_band"],
  text: [],
  confidence: 0.9,
  colorAgreement: "agree" as never,
  undeterminable: [],
  match: { symbolId: "seatbelt", name: "安全带未系提醒", class: "reminder" as const, severity: "info" as const, manualAnchor: "手册 › 指示灯", verified: true, evidence: "" },
};

describe("[F-20-06][AC-20-2] 风险分级进真路径：输入来自意图布尔 + 观察层的灯", () => {
  /**
   * 2026-09-18 改判：**手册说 info 的灯不升风险**。
   *
   * 这条以前断言的正好相反（安全带灯 → 高风险 · 建议立即停止）。用户走查拍了一张
   * 「安全带没系」的照片，拿回来一份高风险报告外加一屏刹车失灵与异响的自查项，
   * 原话是「我们就是安全带没系…给了很多无用的信息」。
   *
   * 目录里 `severity` 这一栏一直都有，只是从没进过风险判断的输入（ADR-010）。
   */
  it("手册列为 info 的灯（安全带未系）不升风险：low，且依据说清「看见了，不是故障」", () => {
    const r = buildDiagnosisReport({ threadId: "t", agent: "ownership", photoObservation: obs({ items: [seatbelt] }), answer: "答", now: 0 });
    assert.equal(r.risk.level, "low");
    assert.equal(r.risk.action, "可继续观察");
    assert.equal(r.risk.basis.some((b) => b.includes("伴随仪表警告灯")), false, "它不是警告灯");
    assert.match(r.risk.basis.join(" "), /安全带未系提醒.*提醒或状态类/, "不能读成「我没看见灯」");
    assert.equal(r.observation?.items[0].name, "安全带未系提醒");
    assert.equal(r.observation?.items[0].symbolId, "seatbelt", "端上按它取手册那枚图标");
    assert.equal(r.observation?.items[0].suspected, false);
    assert.equal(r.at, "1970-01-01T00:00:00.000Z");
  });

  /**
   * 「不知道它是什么」与「现在必须停车」是两回事。
   *
   * 认不出来的灯抬到**中风险**（建议尽快检查），不是高风险——狼来了喊多了，
   * 手册真说要停的那次就没人当回事。这也是走查那张图的正题：一盏安全带灯
   * 加一个没认出来的琥珀三角，不该换回「建议立即停止」。
   */
  it("没跟手册对上的灯抬到 medium，不是 high", () => {
    const unknown = { ...seatbelt, match: null, suspected: { name: "车辆故障提示", symbolId: "system_fault" } };
    const r = buildDiagnosisReport({ threadId: "t", agent: "ownership", photoObservation: obs({ items: [unknown] }), answer: "答" });
    assert.equal(r.risk.level, "medium");
    assert.equal(r.risk.action, "建议尽快检查");
    assert.ok(r.risk.basis.some((b) => b.includes("没跟手册对上")));
    assert.equal(r.risk.basis.includes("伴随仪表警告灯"), false, "没认出来的灯不算「伴随仪表警告灯」");
    assert.deepEqual(r.stopNowSigns, [], "认不出来也不等于要立刻停车");
    assert.equal(r.observation?.items[0].symbolId, "system_fault", "「疑似」也要给 id——图标是「像什么」，与敢不敢下结论是两件事");
  });

  /**
   * 兜底那句在两个文件里各写了一遍（`assessRisk` 一份、`diagnosis.ts` 的 `NO_FINDING_BASIS` 一份）。
   * 不逐字相同的话，"看到灯就把它拿掉"这条会静默失效——依据栏又会冒出「无警告灯」。
   */
  it("兜底依据两边逐字一致，「看到灯就拿掉它」才成立", () => {
    const none = assessRisk(symptomSignal(undefined, undefined));
    assert.deepEqual(none.basis, ["无安全件牵涉、无警告灯、非持续症状"]);
    const r = buildDiagnosisReport({ threadId: "t", agent: "ownership", photoObservation: obs({ items: [seatbelt] }), answer: "答" });
    assert.equal(r.risk.basis.some((b) => b.includes("无警告灯")), false, "明明拍到一盏亮着的灯");
  });

  it("手册确认是故障级的灯才是 high：severity=stop → 建议立即停止", () => {
    const fault = { ...seatbelt, match: { ...seatbelt.match, symbolId: "brake_system_fault", name: "制动系统故障", class: "fault" as const, severity: "stop" as const } };
    const r = buildDiagnosisReport({ threadId: "t", agent: "ownership", photoObservation: obs({ items: [fault] }), answer: "答" });
    assert.equal(r.risk.level, "high");
    assert.equal(r.risk.action, "建议立即停止");
    assert.ok(r.risk.basis.includes("伴随仪表警告灯"));
  });

  /**
   * 三份清单**从观察里长出来**，不是照异响模板发一份。
   *
   * 走查那份报告里「记录异响出现的时机」「拍一段带声音的视频」「刹车踏板变软」
   * 对着一张仪表盘照片全都不成立——每一条都对不上比条目少更伤信任。
   */
  it("照片驱动那一轮：自查项按看到的灯说；没有要立即处理的灯就不给停车清单、不给到店问题", () => {
    const r = buildDiagnosisReport({ threadId: "t", agent: "ownership", photoObservation: obs({ items: [seatbelt] }), answer: "答" });
    assert.equal(r.selfChecks.some((c) => /异响|带声音的视频/.test(c)), false, "仪表盘照片里没有异响这回事");
    assert.ok(r.selfChecks.some((c) => c.includes("安全带未系提醒")), "自查项要点名看到的那盏灯");
    assert.deepEqual(r.stopNowSigns, [], "手册没把任何一盏列为立即处理，就没有「必须停车」可讲");
    assert.deepEqual(r.questionsForShop, [], "全是 info 级的灯，没什么要到店问的");
  });

  it("有要立即处理的灯时，停车清单与到店问题照常给（用 assessRisk 那份原文）", () => {
    const r = buildDiagnosisReport({ threadId: "t", agent: "service", photoObservation: obs({ items: [{ ...seatbelt, match: { ...seatbelt.match, severity: "stop", class: "fault" } }] }), answer: "答" });
    assert.deepEqual(r.stopNowSigns, assessRisk(symptomSignal(undefined, undefined)).stopNowSigns);
    assert.ok(r.questionsForShop.length > 0);
    assert.ok(r.selfChecks[0].includes("先靠边停车"));
  });

  it("车主说了异响又拍了照：那一轮不覆盖，异响那几条仍然成立", () => {
    const intent = { goal: "x", constraints: [], context: "", riskBoundary: "", riskCategory: "none" as const, symptom: { persistent: true } };
    const r = buildDiagnosisReport({ threadId: "t", agent: "service", intent, photoObservation: obs({ items: [seatbelt] }), answer: "答" });
    assert.ok(r.selfChecks.some((c) => c.includes("记录异响出现的时机")));
  });

  it("有照片但没灯、没症状 → low · 可继续观察（没有「放心」两个字）", () => {
    const r = buildDiagnosisReport({ threadId: "t", agent: "ownership", photoObservation: obs({ items: [{ ...seatbelt, state: "unlit", match: null, suspected: { name: "安全带未系提醒", symbolId: "seatbelt" } }] }), answer: "答" });
    assert.equal(r.risk.level, "low");
    assert.equal(r.risk.action, "可继续观察");
    assert.equal(/放心|没问题/.test(r.risk.action), false);
    assert.equal(r.observation?.items[0].suspected, true);
  });

  it("意图给的症状布尔进 assessRisk；非布尔当没给", () => {
    const s = symptomSignal({ goal: "x", constraints: [], context: "", riskBoundary: "", riskCategory: "none", symptom: { safetyCritical: true } }, undefined);
    assert.equal(s.safetyCritical, true);
    assert.equal(s.warningLight, false);
    assert.equal(observedWarningLight(obs({ alerts: [{ code: "DI_a223", title: "x", subtitle: "", iconColor: "red", active: true, at: "", manual: null }] })), true);
  });

  it("目录把某盏点亮的灯列为 stop → 多一条依据，assessRisk 规则不动", () => {
    const r = buildDiagnosisReport({ threadId: "t", agent: "service", photoObservation: obs({ items: [{ ...seatbelt, match: { ...seatbelt.match, severity: "stop", class: "fault" } }] }), answer: "答" });
    assert.ok(r.risk.basis.includes("手册把观察到的某盏灯列为需立即处理"));
  });
});

describe("[F-20-09][AC-20-7] 追问：封闭题库、一轮 ≤2 题、会话 ≤2 轮、不重复", () => {
  const lit = { safetyCritical: false, worsensWithSpeedOrBraking: false, persistent: false, warningLight: true };
  const noLight = { ...lit, warningLight: false };
  it("有灯 → parked + since；无灯 → when + worse", () => {
    assert.deepEqual(pickQuestions({ signal: lit }).map((q) => q.id), ["parked", "since"]);
    assert.deepEqual(pickQuestions({ signal: noLight }).map((q) => q.id), ["when", "worse"]);
    assert.ok(QUESTION_BANK.every((q) => q.options.length === 3));
  });
  /*
   * 多选逐题判（2026-09-19 用户走查）。判据是「两个选项能不能同时为真」：
   * 能同时为真却只让点一个，车主要么漏说要么乱点；反过来让互斥项可多选，答案就没法用了。
   * 这条断言锁的是判据本身，不是"当前恰好两题是多选"——加题时得回来想清楚它属于哪一边。
   */
  it("语义上能同时成立的题才是多选：when / since 可多选，parked / worse 互斥", () => {
    assert.deepEqual(
      QUESTION_BANK.map((q) => [q.id, q.multi === true]),
      [["parked", false], ["since", true], ["when", true], ["worse", false]],
    );
  });
  it("两轮之后不再问；问过的 id 不重复", () => {
    const r1 = buildDiagnosisReport({ threadId: "t", agent: "service", photoObservation: obs({ items: [seatbelt] }), answer: "a" });
    assert.equal(r1.askedRounds, 1);
    const r2 = buildDiagnosisReport({ threadId: "t", agent: "service", photoObservation: obs({ items: [seatbelt] }), previous: r1, answer: "b" });
    assert.deepEqual(r2.prompts, [], "两题都问过了，第二轮没有新题");
    assert.equal(r2.askedRounds, 1, "没出题就不算一轮");
    const r3 = buildDiagnosisReport({ threadId: "t", agent: "service", previous: r1, intent: { goal: "x", constraints: [], context: "", riskBoundary: "", riskCategory: "none", symptom: { persistent: true } }, answer: "c" });
    assert.deepEqual(r3.prompts.map((q) => q.id), ["when", "worse"]);
    assert.equal(r3.askedRounds, 2);
    const r4 = buildDiagnosisReport({ threadId: "t", agent: "service", previous: r3, intent: r3 && { goal: "x", constraints: [], context: "", riskBoundary: "", riskCategory: "none", symptom: { persistent: true } }, answer: "d" });
    assert.deepEqual(r4.prompts, []);
  });
});

describe("只在问诊轮写", () => {
  it("ownership + 无照片无症状 → 不是问诊轮；general 永远不是", () => {
    assert.equal(isDiagnosisTurn({ agent: "ownership" }), false);
    assert.equal(isDiagnosisTurn({ agent: "general", photoObservation: obs({ items: [seatbelt] }) }), false);
    assert.equal(isDiagnosisTurn({ agent: "ownership", photoObservation: obs({ items: [seatbelt] }) }), true);
    assert.equal(isDiagnosisTurn({ agent: "service", intent: { goal: "x", constraints: [], context: "", riskBoundary: "", riskCategory: "none", symptom: { persistent: true } } }), true);
    assert.equal(isDiagnosisTurn({ agent: "ownership", photoObservation: obs({ unreadable: true }) }), true, "没读出来也要出报告——补拍指引在里面");
  });

  /*
   * turn-2f9f1a98（2026-09-19 用户走查）：车主拍了亮着四盏灯的车机屏，检测器零框、非警报页、
   * 图又解得开 —— 三项判据全不成立，整条问诊链一张卡都没出。
   * 「没认出来」也是一个结果，车主有权看见它。
   */
  it("这一轮真的附了照片 ⇒ 一定是问诊轮，哪怕一个符号都没框到", () => {
    assert.equal(isDiagnosisTurn({ agent: "ownership", photoObservation: obs() }), true);
    assert.equal(isDiagnosisTurn({ agent: "service", photoObservation: obs() }), true);
    // 报告真的出得来，且 observation 不是 null —— 端上那张观察卡就挂在这个字段上。
    const r = buildDiagnosisReport({ threadId: "t", agent: "ownership", photoObservation: obs({ retakeHints: ["退后一点把整块屏幕拍全再来一张"] }), answer: "a" });
    assert.deepEqual(r.observation?.items, []);
    assert.deepEqual(r.observation?.retakeHints, ["退后一点把整块屏幕拍全再来一张"]);
    assert.ok(r.prompts.some((p) => p.kind === "capture"), "补拍指引要变成一张拍照卡");
  });

  /*
   * 手册原文说明（2026-09-19 用户走查）：卡上原先只有「红色 · 提醒类 · 锚点」——那是分类不是解释。
   * 说明与名称同一条链：对上取核验结果那条，没对上取 top 候选那条。
   */
  it("观察项带手册原文说明；对不上时取疑似那条的；都没有就是 null", () => {
    const withDesc = { ...seatbelt, match: { ...seatbelt.match, description: "乘客座椅安全带未系好（指示灯为红色），请参阅座椅安全带" } };
    const guess = { ...seatbelt, match: null, suspected: { name: "近光灯已开", symbolId: "low_beam", source: "catalog" as const, description: "近光灯已打开" } };
    const bare = { ...seatbelt, match: null };
    const r = buildDiagnosisReport({ threadId: "t", agent: "service", photoObservation: obs({ items: [withDesc, guess, bare] as never }), answer: "a" });
    assert.deepEqual(r.observation?.items.map((i) => i.description), [
      "乘客座椅安全带未系好（指示灯为红色），请参阅座椅安全带",
      "近光灯已打开",
      null,
    ]);
  });

  it("沿用上一张照片的观察（inherited）不靠这一条 —— 这一轮车主没发图", () => {
    // 不然车主打一行纯文字，屏幕上会再冒出一张空的观察卡，看起来像系统把那行字当成了照片。
    assert.equal(isDiagnosisTurn({ agent: "ownership", photoObservation: obs({ inherited: true }) }), false);
    // 沿用的观察里有东西时照旧算 —— 那条老路一行没动。
    assert.equal(isDiagnosisTurn({ agent: "ownership", photoObservation: obs({ inherited: true, items: [seatbelt] }) }), true);
  });
});

describe("[F-20-13] answer 节点：报告随轮写入，service 轮的 consultation 带等级", () => {
  it("源码：isDiagnosisTurn 门 + diagnosisPatch 进两处返回 + riskLevel 随报告", () => {
    // M106-02 起这道门提前了：预算要在 elicitation 之前算，而预算只在问诊轮算；报告跟着预算走，门还是同一道。
    assert.match(SUPERVISOR, /const diagnosisTurn = isDiagnosisTurn\(\{ agent: diagnosisAgent, intent: state\.intent, photoObservation: state\.photoObservation \}\);/);
    // M106-03：门再提前到应答流之前（提议要与应答并发起跑）；`budgetBase` 只在过了这道门时才有。
    assert.match(SUPERVISOR, /const budgetBase = diagnosisTurn\s+\? budgetInputFor\(/);
    assert.match(SUPERVISOR, /const promptBudget: BudgetResult \| undefined = budgetBase\s+\? budgetPrompts\(/);
    assert.match(SUPERVISOR, /const diagnosis = promptBudget\s+\? buildDiagnosisReport\(/);
    // 顺序是本单的要点：预算 → elicitation（拿剩余位）→ 报告。
    const at = (needle: string) => SUPERVISOR.indexOf(needle);
    assert.ok(at("const promptBudget") < at("questionBudgetLeft: promptBudget.asksLeft"));
    assert.ok(at("questionBudgetLeft: promptBudget.asksLeft") < at("const diagnosis = promptBudget"));
    assert.equal(SUPERVISOR.split("...diagnosisPatch").length - 1, 2, "两处 return 都要带上 diagnosisPatch");
    assert.match(SUPERVISOR, /riskLevel: diagnosis\.risk\.level/);
  });
});

describe("[F-20-12] 【本次问诊结论】段：把报告放进下一轮的输入（M104-06，ADR-010）", () => {
  const withLamp = buildDiagnosisReport({
    threadId: "t",
    agent: "ownership",
    photoObservation: obs({ items: [seatbelt] }),
    answer: "上一轮的回答",
  });

  it("没有报告就不出段——上下文与现状逐字节相同", () => {
    assert.equal(diagnosisSection(undefined), undefined);
  });

  it("段里有等级、依据、观察项与手册锚点；**不含**上一轮的回答正文", () => {
    const text = diagnosisSection(withLamp)!;
    assert.match(text, /【本次问诊结论/);
    // 安全带灯是 info 级（2026-09-18 改判），所以这份报告是 low。
    assert.match(text, /风险分级：低风险 · 可继续观察/);
    assert.match(text, /判定依据：.*提醒或状态类/);
    assert.match(text, /安全带未系提醒（手册 › 指示灯）/);
    assert.equal(text.includes("上一轮的回答"), false, "正文塞回去会让模型复读自己");
  });

  it("段里明写预约事由，堵住「缺对象先反问」那条规则", () => {
    const text = diagnosisSection(withLamp)!;
    assert.match(text, /不要再问他是哪个问题/);
    assert.match(text, /预约事由用上面这些/);
    assert.equal(bookingSubject(withLamp), "安全带未系提醒（低风险）");
  });

  it("一个符号都没认出来时，事由退回等级，不编一个部件名", () => {
    const blank = buildDiagnosisReport({ threadId: "t", agent: "service", photoObservation: obs({ unreadable: true }), answer: "x" });
    assert.equal(bookingSubject(blank), "低风险问诊结论，需到店检查");
    assert.match(diagnosisSection(blank)!, /这张照片没读出来/);
  });

  it("接线：ownershipDual 节点把 state.diagnosis 传进双路", () => {
    assert.match(SUPERVISOR, /diagnosis: state\.diagnosis,/);
  });
});
