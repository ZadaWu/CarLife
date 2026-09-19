/**
 * 拍照问诊的结构化报告（施工单 M104-01，FL-20 F-20-06 / F-20-09 / F-20-13）。
 *
 * # 三条边界
 *
 * 1. **只在问诊轮写**（`isDiagnosisTurn`）：agent 是 service / ownership，且这一轮有照片观察、警报，
 *    或意图 JSON 的 `symptom` 里任一为真。「空调怎么开」不该冒出一份「低风险」报告。
 * 2. **风险分级的输入向已经知道的人要**（ADR-012 / ADR-010）：三个症状布尔由意图 JSON 给；
 *    `warningLight` 由代码从观察层判（有点亮的 `warning_light` 项或活动警报），意图给了也算。
 *    这里**不从任何文本里正则抽症状**。
 * 3. **题库只管挑候选**（F-20-09，M106-02 起）：按结构化信号挑哪几道；「一轮几题、一共几轮、问过的不重复」
 *    是预算的事，搬去了 `prompt-budget.ts`——模型提议一路进来之后，这三条得对三路一起算。
 *    答案由车主点芯片作为一轮用户文本发出，下一轮意图的 `symptom` 由模型读它——这里不解析答案。
 *
 * `answer` 就是这一轮的回答正文（含 disclaimers 注在开头的那句）；「可能的原因」由它承担，
 * 不另起一次 LLM 抽 JSON（总览 M104-00 决策 3）。
 */

import { DIAGNOSIS_DISCLAIMER, DIAGNOSIS_RISK_ACTION, isAskPrompt, type DiagnosisObservedItem, type DiagnosisQuestion, type DiagnosisReport, type DiagnosisRiskLevel } from "@carlife/shared";

import { budgetPrompts, type BudgetInput, type BudgetResult } from "./prompt-budget";
import type { Intent } from "./state";
import { assessRisk, type SymptomSignal } from "./subgraphs/service";
import type { PhotoObservationState } from "./vision";

export type DiagnosisAgent = "service" | "ownership";

/**
 * `assessRisk` 在什么都没判出来时给的那一句，逐字相同。
 *
 * 在这里再写一遍是刻意的：拿掉它的条件（"看到灯了"）属于报告这一层的判断，
 * 不该反过来去改 `assessRisk` 的措辞——那条路上还有异响那一支在用它。
 * `diagnosis.test.ts` 有一条守着两边逐字一致。
 */
const NO_FINDING_BASIS = "无安全件牵涉、无警告灯、非持续症状";

export interface DiagnosisInput {
  threadId: string;
  agent: DiagnosisAgent;
  intent?: Intent;
  photoObservation?: PhotoObservationState;
  /** 上一轮的报告（跨轮存活）：追问轮次与问过的题从它累计。 */
  previous?: DiagnosisReport;
  /**
   * 本轮的预算裁决（M106-02）。`answerNode` 要在调 elicitation **之前**就算好它（剩余问题位得先传过去），
   * 所以由调用方算、传进来；不传 = 这里按「模型没提、没人占位」自己算一次（单测与离线路径）。
   */
  budget?: BudgetResult;
  answer: string;
  now?: number;
}

/**
 * 观察层里有没有"亮着的**警告**灯"——注意是警告灯，不是"有灯亮着"。
 *
 * # 手册怎么说，就按它算（ADR-010）
 *
 * 这里原来是「点亮的 warning_light 项就算」。但仪表上大半亮着的灯不是故障：
 * 安全带未系、驻车灯已开、READY，手册给它们的级别是 `info`。
 * 把它们算成警告灯，`assessRisk` 就直接升到 **high**，于是车主拍一张
 * 「安全带没系」的照片，拿回来的是「高风险 · 建议立即停止」，
 * 外加一整屏刹车失灵和异响的自查项——2026-09-18 用户走查原话：
 * 「我们就是安全带没系…给了很多无用的信息」。
 *
 * 目录里本来就有 `severity` 这一栏，只是从来没进过风险判断的输入。
 *
 * **没对上手册的灯照样算**：级别未知时宁可偏高（`assessRisk` 文件头那条不对称）。
 * 只有"对上了、且手册明说是 info"才被排除——那是有据可依的降级，不是猜。
 */
export function observedWarningLight(obs: PhotoObservationState | undefined): boolean {
  if (!obs) return false;
  if (obs.alerts.some((a) => a.active)) return true;
  return obs.items.some((it) => it.category === "warning_light" && it.state === "lit" && it.match !== null && it.match.severity !== "info");
}

/** 这一轮亮着的灯，按手册级别分堆；`unknown` = 没跟手册对上的（含只有 top 候选的「疑似」）。 */
function litLamps(obs: PhotoObservationState) {
  const lit = obs.items.filter((it) => it.state === "lit");
  const named = (xs: typeof lit) => xs.map((it) => it.match?.name ?? it.suspected?.name).filter((n): n is string => Boolean(n));
  return {
    stop: named(lit.filter((it) => it.match?.severity === "stop")),
    soon: named(lit.filter((it) => it.match?.severity === "check_soon")),
    info: named(lit.filter((it) => it.match?.severity === "info")),
    unknown: lit.filter((it) => !it.match).length,
    total: lit.length,
  };
}

/**
 * 照片驱动那一轮的自查 / 停车信号 / 到店问题。
 *
 * # 为什么要覆盖 `assessRisk` 给的那三份
 *
 * `assessRisk` 那三份是照**异响 / 振动**写的（"记录异响出现的时机"、"拍一段带声音的视频"、
 * "刹车踏板变软"），它们对着一张仪表盘照片全都不成立。车主看到的是一份
 * 逐条都与自己这辆车无关的报告，而"每一条都对不上"比"条目少"更伤信任。
 *
 * # 只在真是照片驱动时覆盖
 *
 * 车主说了"有异响"又拍了张照的那一轮，`signal` 里的症状位是真的，
 * 那几条仍然成立——所以有任一症状位为真就不覆盖，两种内容都保留。
 *
 * 全部内容都从**观察到的东西**里长出来：灯的名字、没对上的个数、补拍指引。
 * 这里不编手册里没有的处置建议（那是 `answer` 那一步、带着检索出处去做的事）。
 */
function lampFacts(
  obs: PhotoObservationState,
  signal: SymptomSignal,
  /** `assessRisk` 给的那三份。留着当素材：该讲的时候用它原文，不另写一套。 */
  base: Pick<DiagnosisReport, "stopNowSigns" | "questionsForShop">,
): Pick<DiagnosisReport, "selfChecks" | "stopNowSigns" | "questionsForShop"> | null {
  if (signal.safetyCritical || signal.worsensWithSpeedOrBraking || signal.persistent) return null;
  const lamps = litLamps(obs);
  if (lamps.total === 0) return null;

  const selfChecks: string[] = [];
  if (lamps.stop.length > 0) selfChecks.push(`先靠边停车：手册把${lamps.stop.join("、")}列为要立即处理`);
  if (lamps.info.length > 0) selfChecks.push(`${lamps.info.join("、")}按手册处理一下，再看这盏灯灭没灭`);
  if (lamps.soon.length > 0) selfChecks.push(`${lamps.soon.join("、")}手册要求尽快检查，别拖到下次保养`);
  if (lamps.unknown > 0) selfChecks.push(`还有 ${lamps.unknown} 个符号没跟手册对上，正对仪表、离近一点再拍一张`);
  for (const hint of obs.retakeHints) selfChecks.push(hint);
  selfChecks.push("处理完回到对话里说一声这几盏灯还亮不亮");

  return {
    selfChecks,
    // 手册没把任何一盏列为「立即处理」时，就没有"什么时候必须立即停车"可讲。
    // 硬凑一张刹车失灵清单，只会让真出现那一条时没人当回事。
    stopNowSigns: lamps.stop.length > 0 ? [...base.stopNowSigns] : [],
    // 全是 info 级的灯（安全带、驻车灯）不用去店里问什么；有一盏要修的才留这张卡。
    questionsForShop: lamps.stop.length + lamps.soon.length + lamps.unknown > 0 ? [...base.questionsForShop] : [],
  };
}

/**
 * 这一轮算不算问诊轮。
 *
 * **这一轮真的附了照片就一定算**（2026-09-19 用户走查）。在这之前还要求"框到了符号、
 * 或读到了警报、或整张读不出"——三项都不成立的那种照片（图解得开、检测器零框、不是警报页）
 * 正好落在缝里：`turn-2f9f1a98` 车主拍了亮着四盏灯的屏幕，整条问诊链一张卡都没出，
 * 连"这张我没认出来、再拍一张"都没说。**没认出来也是一个结果，得让车主看见。**
 *
 * 沿用上一张照片的观察（`inherited`）不适用这一条：那一轮车主没发图，
 * 凭一份旧观察再出一遍观察卡，车主会以为系统把他刚打的那行字当成了照片。
 * 沿用的观察要出报告，仍得靠下面那三项之一为真。
 */
export function isDiagnosisTurn(args: { agent: string; intent?: Intent; photoObservation?: PhotoObservationState }): boolean {
  if (args.agent !== "service" && args.agent !== "ownership") return false;
  const obs = args.photoObservation;
  if (obs && !obs.inherited) return true;
  if (obs && (obs.items.length > 0 || obs.alerts.length > 0 || obs.unreadable)) return true;
  const s = args.intent?.symptom;
  return Boolean(s && (s.safetyCritical || s.worsensWithSpeedOrBraking || s.persistent || s.warningLight));
}

/** 意图 + 观察 → `assessRisk` 的输入。缺席一律 false（宁可少判不猜）。 */
export function symptomSignal(intent: Intent | undefined, obs: PhotoObservationState | undefined): SymptomSignal {
  const s = intent?.symptom ?? {};
  return {
    safetyCritical: s.safetyCritical === true,
    worsensWithSpeedOrBraking: s.worsensWithSpeedOrBraking === true,
    persistent: s.persistent === true,
    warningLight: s.warningLight === true || observedWarningLight(obs),
  };
}

/**
 * 追问题库（F-20-09）。封闭：4 题，每题 3 个芯片；一轮最多 2 题。
 * 文案与 Brief 第 3 步逐字一致——端上直接渲染。
 * 挑题只看 `assessRisk` 的输入（有没有灯），**不读原话**（ADR-012）：按"异响"挑「声音像什么」那种
 * 要先从文本里认出异响，那正是不该在这里做的事。
 */
export const QUESTION_BANK: readonly DiagnosisQuestion[] = [
  // `multi` 逐题判（2026-09-19 用户走查）：判据是"两个选项能不能同时为真"。
  // 能同时为真却只让选一个，车主要么漏说、要么乱点；反过来允许多选，答案就没法用了。
  { id: "parked", text: "车现在是停着的吗？", options: ["停着", "在开", "刚停下"] },
  // 一张照片上常常不止一盏灯，「刚才亮的」和「一直亮着的」可以各指一盏。
  { id: "since", text: "这个灯是什么时候亮的？", options: ["刚才", "一直亮", "时亮时灭"], multi: true },
  // 冷车与热车都出现是最有价值的那个答案，单选时它无处可填。
  { id: "when", text: "什么时候出现？", options: ["冷车", "热车", "一直"], multi: true },
  // 「更明显」「没变化」「不确定」三者互斥。
  { id: "worse", text: "转向或刹车时更明显吗？", options: ["更明显", "没变化", "不确定"] },
];

/**
 * 挑这一轮的**候选**题：在看一盏灯 → parked + since；否则 when + worse。
 * 轮次上限、跨轮去重、每轮几题都不在这里（见文件头第 3 条）。
 *
 * `anyLamp` 与 `signal.warningLight` 是两件事，别合并：后者问的是"要不要升风险"
 * （手册说 info 的灯不升，见 `observedWarningLight`），这里问的是"该问什么"。
 * 车主拍的是一盏安全带灯时，「转向或刹车时更明显吗」是一句没头没脑的话——
 * 该问的仍然是「车现在停着吗」「这灯什么时候亮的」。
 */
export function pickQuestions(args: { signal: SymptomSignal; anyLamp?: boolean }): DiagnosisQuestion[] {
  const wanted = args.signal.warningLight || args.anyLamp ? ["parked", "since"] : ["when", "worse"];
  return wanted.flatMap((id) => QUESTION_BANK.filter((x) => x.id === id));
}

function observedItems(obs: PhotoObservationState): DiagnosisObservedItem[] {
  return obs.items.map((it) => ({
    name: it.match?.name ?? it.suspected?.name ?? null,
    // 端上按这个 id 去取手册里那枚图标（见契约里 `symbolId` 那段）。
    // 与 `name` 同源同一条链：对上了取核验结果的，没对上取 top 候选的。
    symbolId: it.match?.symbolId ?? it.suspected?.symbolId ?? null,
    suspected: !it.match && Boolean(it.suspected),
    class: it.match?.class ?? null,
    severity: it.match?.severity ?? null,
    color: it.color,
    state: it.state,
    manualAnchor: it.match?.manualAnchor ?? null,
    // 手册原文说明（2026-09-19）。与 `name` / `symbolId` 同一条链：对上取核验结果那条，没对上取 top 候选那条。
    description: it.match?.description ?? it.suspected?.description ?? null,
  }));
}

/**
 * 最终风险等级：`assessRisk` 的结果，加「没跟手册对上的灯抬到中」那一档（理由见 `buildDiagnosisReport` 里那段）。
 * 抽出来是因为预算器也要它（`high` 不放行引导），而预算得在报告之前算。
 */
function finalLevel(riskLevel: DiagnosisRiskLevel, unknownLit: number): DiagnosisRiskLevel {
  return unknownLit > 0 && riskLevel === "low" ? "medium" : riskLevel;
}

/**
 * 预算器的三路输入里由问诊这一侧出的部分：题库候选、补拍指引、风险等级、跨轮累计。
 * `proposals`（模型一路）与 `reservedAsks` 由 `answerNode` 补上。纯函数。
 */
export function budgetInputFor(input: Pick<DiagnosisInput, "intent" | "photoObservation" | "previous">): Omit<BudgetInput, "proposals" | "reservedAsks"> {
  const signal = symptomSignal(input.intent, input.photoObservation);
  const obs = input.photoObservation;
  const lamps = obs ? litLamps(obs) : null;
  return {
    bank: pickQuestions({ signal, anyLamp: (lamps?.total ?? 0) > 0 }),
    retakeHints: obs?.retakeHints ?? [],
    riskLevel: finalLevel(assessRisk(signal).level, lamps?.unknown ?? 0),
    ...(input.previous ? { previous: { askedRounds: input.previous.askedRounds, askedIds: input.previous.askedIds } } : {}),
  };
}

/** 拼报告。纯函数，无 IO。 */
export function buildDiagnosisReport(input: DiagnosisInput): DiagnosisReport {
  const signal = symptomSignal(input.intent, input.photoObservation);
  const risk = assessRisk(signal);
  const obs = input.photoObservation;
  // 目录把某盏点亮的灯列为「需立即处理」时，多一条依据——只加依据，不改 assessRisk 的规则。
  const stopMatched = obs?.items.some((it) => it.state === "lit" && it.match?.severity === "stop") ?? false;
  const lamps = obs ? litLamps(obs) : null;
  /*
   * 依据这一栏要说的是"为什么是这个等级"。
   *
   * 看到了灯、但手册把它们都列为提醒 / 状态类时，`assessRisk` 给的那句
   * 「无安全件牵涉、无警告灯、非持续症状」字面上不假，读起来却像"我没看见灯"
   * ——而车主明明拍到了一盏亮着的。这里换成说清楚"看见了，手册说它不是故障"。
   */
  const lampOnlyInfo = lamps !== null && lamps.total > 0 && lamps.stop.length === 0 && lamps.soon.length === 0 && lamps.unknown === 0;
  /*
   * 看到了灯的时候，`assessRisk` 那句兜底「无安全件牵涉、无警告灯、非持续症状」要拿掉：
   * 字面不假，读起来却是"我没看见灯"——而车主明明拍到了一盏亮着的。
   * 拿掉之后由下面几条按观察说话；一条都没剩时再放回去（那就是真的什么都没看到）。
   */
  const seenLamp = lamps !== null && lamps.total > 0;
  let base = seenLamp ? risk.basis.filter((b) => b !== NO_FINDING_BASIS) : risk.basis;
  if (lampOnlyInfo && risk.level === "low") base = [...base, `看到的灯（${lamps.info.join("、")}）手册列为提醒或状态类，不是故障`];
  // 一定是新数组：下面那条 `push` 若落在 `risk.basis` 上，就把 assessRisk 的返回值改掉了。
  const basis = stopMatched ? [...base, "手册把观察到的某盏灯列为需立即处理"] : [...base];

  /*
   * 没跟手册对上的灯：抬到**中风险**，不是高风险。
   *
   * "不知道它是什么"与"现在必须停车"是两回事。`observedWarningLight` 只认手册确认过的灯，
   * 所以这里补一档：认不出来就说「尽快检查」。
   *
   * 这是 2026-09-18 走查那张图的正题——车主拍到一盏安全带灯加一个没认出来的琥珀三角，
   * 拿回来的是「高风险 · 建议立即停止」。狼来了喊多了，手册真说要停的那次就没人当回事。
   */
  const unknownLit = lamps?.unknown ?? 0;
  const level = finalLevel(risk.level, unknownLit);
  if (level !== risk.level) basis.push(`有 ${unknownLit} 个符号没跟手册对上，先按「需要检查」看待`);
  else if (unknownLit > 0) basis.push(`另有 ${unknownLit} 个符号没跟手册对上`);
  if (basis.length === 0) basis.push(NO_FINDING_BASIS);
  // 照片驱动那一轮把三份清单换成从观察里长出来的（见 `lampFacts`）；拿不到就照旧。
  const facts = obs ? lampFacts(obs, signal, risk) : null;
  const budget = input.budget ?? budgetPrompts({ ...budgetInputFor(input), proposals: [] });
  const prevIds = input.previous?.askedIds ?? [];
  const asked = budget.prompts.some(isAskPrompt);
  return {
    threadId: input.threadId,
    at: new Date(input.now ?? Date.now()).toISOString(),
    agent: input.agent,
    risk: { level, action: DIAGNOSIS_RISK_ACTION[level], basis },
    observation: obs
      ? {
          items: observedItems(obs),
          unreadable: obs.unreadable,
          retakeHints: [...obs.retakeHints],
          alerts: obs.alerts.map((a) => ({ code: a.code, title: a.title })),
        }
      : null,
    prompts: budget.prompts,
    // 只有提问算一轮（F-20-09）：补拍与引导不计——补拍三次也还是在帮车主把同一件事弄清楚。
    askedRounds: (input.previous?.askedRounds ?? 0) + (asked ? 1 : 0),
    askedIds: [...prevIds, ...budget.prompts.map((p) => p.id).filter((id) => !prevIds.includes(id))],
    ...(facts ?? { selfChecks: [...risk.selfChecks], stopNowSigns: [...risk.stopNowSigns], questionsForShop: [...risk.questionsForShop] }),
    answer: input.answer,
    disclaimer: DIAGNOSIS_DISCLAIMER,
  };
}
