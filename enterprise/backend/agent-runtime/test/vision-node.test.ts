/**
 * [F-20-03][AC-20-1] 观察节点：照片 → 受控观察 → 图标匹配 → 图状态；off 直通写 caveat；无附件直通。
 * [F-20-08][AC-20-6] 【图片观察】段与补拍指引：质量差 / 被裁时给具体方向，且不拒答。
 *
 * 视觉 provider 用 fake（按 tesla-01.png 的 sha8 回放 2026-09-08 的 qwen3-vl-plus 输出，零网络）；
 * 图标匹配用桩。图片字节只在本进程内，不经任何 LLM。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { createFakeVisionProvider } from "@carlife/tools";

import { PHOTO_INSTRUCTION, PHOTO_SECTION_HEADER, alertSection, buildPhotoObservation, composeRetrievalQuery, describeItem, observeAttachmentsNode, photoHasAlerts, photoHasSymbols, photoRetrievalTerms, photoSection, photoSummaryLine, retakeHintsFor, setVisionDeps, type IconMatcher, type PhotoObservationState, type PhotoAlert } from "../src/graph/vision";

const ROOT = new URL("../../../../", import.meta.url);
const PHOTO = readFileSync(new URL("evals/vision-observe/photos/tesla-01.png", ROOT));
const FIXTURES = new URL("evals/vision-observe/fixtures/by-sha", ROOT).pathname;
const provider = createFakeVisionProvider({ fixturesDir: FIXTURES });

const matcherSeatbeltOnly: IconMatcher = async ({ descriptor }) =>
  descriptor.shape === "person" && descriptor.color === "red"
    ? { matched: true, verified: false, semantics: { symbolId: "seatbelt_unfastened", name: "安全带未系提醒", class: "reminder", severity: "info", manualAnchor: "Model 3 车主手册 › 指示灯 › 安全带" }, sim: 0.93, margin: 0.12, evidence: "sim 0.93 · 未核验" }
    : { matched: false, reason: "below_delta", top: { symbolId: "low_beam", name: "近光灯已开", class: "status", severity: "info", manualAnchor: null }, sim: 0.49 };

/** 核验通过的安全带匹配（M78-01：手册图标图片到位后，生产真正会走到这一支）。 */
const matcherSeatbeltVerified: IconMatcher = async ({ descriptor }) =>
  descriptor.shape === "person" && descriptor.color === "red"
    ? { matched: true, verified: true, semantics: { symbolId: "seatbelt_unfastened", name: "安全带未系提醒", class: "reminder", severity: "info", manualAnchor: "Model 3 车主手册 › 指示灯 › 安全带" }, sim: 0.8, margin: 0.2, evidence: "sim 0.804 · margin 0.2043 · 成对核验 same" }
    : { matched: false, reason: "below_delta", top: { symbolId: "low_beam", name: "近光灯已开", class: "status", severity: "info", manualAnchor: null }, sim: 0.49 };

/** 核验答 different / unsure：decideMatch 既有行为是不匹配——宁可说没对上，不可说错名字。 */
const matcherVerifyRejects: IconMatcher = async () => ({ matched: false, reason: "verify_different", top: { symbolId: "seatbelt_unfastened", name: "安全带未系提醒", class: "reminder", severity: "info", manualAnchor: null }, sim: 0.8 });

const photoInput = [{ handle: "att_tesla01", contentType: "image/png", bytesBase64: PHOTO.toString("base64") }];

describe("[F-20-03][AC-20-1] observeAttachmentsNode", () => {
  it("无附件 → 直通，photoObservation 为空", async () => {
    setVisionDeps({ provider, matchIcon: matcherSeatbeltOnly });
    const r = await observeAttachmentsNode({ photoInput: undefined } as never);
    assert.equal(r.photoObservation, undefined);
  });

  it("有附件 → 观察 8 项、警示灯 4 个；安全带对上（未核验）、其余「未能对上」带疑似；trace kind=vision", async () => {
    setVisionDeps({ provider, matchIcon: matcherSeatbeltOnly });
    const traces: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const r = await observeAttachmentsNode({ photoInput } as never, { configurable: { onTrace: (e: { kind: string; data: Record<string, unknown> }) => traces.push(e) } });
    const obs = r.photoObservation!;
    assert.equal(obs.unreadable, false);
    assert.equal(obs.items.length, 8);
    const warn = obs.items.filter((i) => i.category === "warning_light");
    assert.equal(warn.length, 4);
    const seat = warn.find((i) => i.shape === "person")!;
    assert.equal(seat.match?.name, "安全带未系提醒");
    assert.equal(seat.match?.verified, false);
    assert.equal(seat.match?.severity, "info");
    const others = warn.filter((i) => i.shape !== "person");
    assert.ok(others.every((i) => i.match === null && i.suspected?.symbolId === "low_beam"));
    // 像素定色是权威：安全带 red、自动远光灰
    assert.equal(seat.color, "red");
    assert.deepEqual(obs.frame.cut_off_sides, ["right", "bottom"]);
    assert.equal(obs.frame.cutOffSource, "model");
    assert.ok(obs.caveats.some((c) => c.includes("未经图片核验")));
    assert.equal(traces.length, 1);
    assert.equal(traces[0].kind, "vision");
    assert.equal(traces[0].data.matched, 1);
    assert.equal(traces[0].data.warningLights, 4);
  });

  it("CARLIFE_VISION=off（provider=null）→ unreadable + caveat「本次未分析图片」，不抛", async () => {
    setVisionDeps({ provider: null });
    const r = await observeAttachmentsNode({ photoInput } as never);
    assert.equal(r.photoObservation?.unreadable, true);
    assert.ok(r.photoObservation?.caveats[0].includes("未分析图片"));
  });

  it("没有 fixture 的图片 → 检测失败降级 unreadable，不抛", async () => {
    setVisionDeps({ provider, matchIcon: matcherSeatbeltOnly });
    const r = await observeAttachmentsNode({ photoInput: [{ handle: "x", contentType: "image/png", bytesBase64: Buffer.from("not-a-real-png").toString("base64") }] } as never);
    assert.equal(r.photoObservation?.unreadable, true);
    assert.ok(r.photoObservation?.retakeHints[0].includes("没读出来"));
  });

  it("不装索引（matchIcon 缺省）→ 警示灯全部「未能对上」，reason=index_off", async () => {
    setVisionDeps({ provider });
    const r = await observeAttachmentsNode({ photoInput } as never);
    const warn = r.photoObservation!.items.filter((i) => i.category === "warning_light");
    assert.ok(warn.every((i) => i.match === null && i.matchReason === "index_off"));
    assert.ok(r.photoObservation!.caveats.some((c) => c.includes("未能与手册图标对上")));
  });
});

describe("[F-20-08][AC-20-6] 【图片观察】段与补拍指引", () => {
  const base: PhotoObservationState = {
    handle: "h",
    unreadable: false,
    frame: { cut_off_sides: ["right"], cutOffSource: "model", quality: { blur: true, dark: false, glare: false, partial: true, occluded: false } },
    items: [
      { category: "warning_light", shape: "person", color: "red", state: "lit", elements: ["diagonal_band"], text: [], confidence: 0.9, colorAgreement: "agree", undeterminable: [], match: { symbolId: "seatbelt_unfastened", name: "安全带未系提醒", class: "reminder", severity: "info", manualAnchor: "手册 › 指示灯", verified: false, evidence: "" } },
      { category: "warning_light", shape: "lamp", color: "green", state: "lit", elements: ["wavy_lines"], text: [], confidence: 0.3, colorAgreement: "agree", undeterminable: [], match: null, suspected: { name: "近光灯已开", symbolId: "low_beam" } },
      { category: "readout", shape: "letter_only", color: "gray", state: "lit", elements: [], text: ["60", "%"], confidence: 1, colorAgreement: "agree", undeterminable: [], match: null },
    ],
    notes: [],
    caveats: [],
    retakeHints: [],
    timings: { detectMs: 1, describeMs: 1, totalMs: 2 },
    model: { detect: "fake", describe: "fake" },
  };

  it("describeItem 只有观察，没有名称", () => {
    assert.equal(describeItem(base.items[0]), "红色 人形 斜带（点亮）");
    assert.equal(describeItem(base.items[2]), "灰色 文字 含字 60%（点亮）");
  });

  it("补拍指引具体到方向；cutOffSource=model 只说「可能」；低置信符号提示离近", () => {
    const hints = retakeHintsFor(base);
    assert.ok(hints.some((h) => h.includes("糊")));
    assert.ok(hints.some((h) => h.includes("右侧可能没拍全")));
    assert.ok(hints.some((h) => h.includes("离近一点")));
    assert.deepEqual(retakeHintsFor({ ...base, unreadable: true }), ["这张照片没读出来，请把仪表盘正对镜头、开灯后再拍一张"]);
    const code = retakeHintsFor({ ...base, frame: { ...base.frame, cutOffSource: "code", quality: {} }, items: [] });
    assert.ok(code.some((h) => h === "右侧没拍到，请补一张"));
  });

  it("段落：匹配项带名称/类别/级别/出处并标未核验；未匹配项写「未能与手册对上」与疑似；末尾是应答指令", () => {
    const section = photoSection({ ...base, retakeHints: retakeHintsFor(base) });
    assert.ok(section.startsWith(PHOTO_SECTION_HEADER));
    assert.ok(section.includes("安全带未系提醒 · 提醒类 · 提醒/状态 · 出处：手册 › 指示灯（未核验，只能说「疑似」）"));
    assert.ok(section.includes("→ 未能与手册对上（最接近的是「近光灯已开」，不足以确认）"));
    assert.ok(section.includes("【补拍指引】"));
    assert.ok(section.endsWith(PHOTO_INSTRUCTION));
    // 「可以放心」只允许出现在指令的禁语清单里，不出现在观察行里
    assert.ok(!section.replace(PHOTO_INSTRUCTION, "").includes("可以放心"));
  });

  it("给意图的一行摘要只有观察，不带目录名称", () => {
    const line = photoSummaryLine(base);
    assert.ok(line.includes("指示灯 2 个"));
    assert.ok(line.includes("红色 人形 斜带"));
    assert.ok(!line.includes("安全带未系提醒"));
  });

  it("buildPhotoObservation：匹配器抛错 → 该项 matchReason=match_failed，不整体失败", async () => {
    const obs = await (await import("@carlife/tools")).observePhoto(PHOTO, provider);
    const r = await buildPhotoObservation("h", PHOTO, obs, async () => { throw new Error("db down"); });
    assert.ok(r.items.filter((i) => i.category === "warning_light").every((i) => i.matchReason?.startsWith("match_failed")));
  });
});

describe("[F-20-03][AC-20-1] 成对核验通过后的措辞（施工单 M78-01）", () => {
  it("verified=true → 段落不带「未核验」、caveats 里没有「疑似」那条", async () => {
    setVisionDeps({ provider, matchIcon: matcherSeatbeltVerified });
    const r = await observeAttachmentsNode({ photoInput } as never);
    const obs = r.photoObservation!;
    const seat = obs.items.find((i) => i.shape === "person")!;
    assert.equal(seat.match?.verified, true);
    const section = photoSection(obs);
    assert.ok(section.includes("安全带未系提醒"), "名称照常给出");
    // 段落头与末尾的应答指令里都有「未核验的只能说疑似」这句**总则**，那是对的、不能删；
    // 这里要断言的是**逐项**那一句后缀没了，所以先把这两段固定文案摘掉再看。
    const items = section.replace(PHOTO_INSTRUCTION, "").replace(PHOTO_SECTION_HEADER, "");
    assert.ok(!items.includes("未核验"), `核验过了就不该在这一项后面再说未核验：${items}`);
    assert.ok(!obs.caveats.some((c) => c.includes("未经图片核验")), `caveats 不该再提核验：${obs.caveats.join(" / ")}`);
  });

  it("核验答 different → 该项不匹配，段落写「未能与手册对上」而不是给个名字", async () => {
    setVisionDeps({ provider, matchIcon: matcherVerifyRejects });
    const r = await observeAttachmentsNode({ photoInput } as never);
    const obs = r.photoObservation!;
    const warn = obs.items.filter((i) => i.category === "warning_light");
    assert.ok(warn.every((i) => i.match === null), "核验没通过就不能算匹配");
    assert.ok(warn.every((i) => i.matchReason === "verify_different"));
    assert.ok(photoSection(obs).includes("未能与手册对上"));
  });

  it("取不到图标图片（iconImage 恒 null）→ 回到 verified=false 的老行为，不报错", async () => {
    setVisionDeps({ provider, matchIcon: matcherSeatbeltOnly });
    const r = await observeAttachmentsNode({ photoInput } as never);
    const seat = r.photoObservation!.items.find((i) => i.shape === "person")!;
    assert.equal(seat.match?.verified, false);
    assert.ok(photoSection(r.photoObservation!).includes("未核验"));
  });
});

describe("[F-20-03][AC-20-1] 照片给检索的词（M80-09）", () => {
  const base = { handle: "h", unreadable: false, frame: { cut_off_sides: [], cutOffSource: "none" as const, quality: {} }, notes: [], caveats: [], retakeHints: [], timings: { detectMs: 0, describeMs: 0, totalMs: 0 }, model: { detect: "x", describe: "y" } };
  const item = (over: Partial<Parameters<typeof photoSection>[0]["items"][number]>) => ({
    category: "warning_light" as const, shape: "person", color: "red", state: "lit", elements: ["diagonal_band"], text: [], confidence: 0.9, colorAgreement: "agree" as const, undeterminable: [], match: null, ...over,
  });
  const seatbelt = { symbolId: "seatbelt_unfastened", name: "安全带未系提醒", class: "reminder" as const, severity: "info" as const, manualAnchor: "Model 3 车主手册 › 指示灯 › 安全带", verified: true, evidence: "" };

  it("对上的项 → 名称 + 锚点末两级排在原话前；书名不进检索词", () => {
    const obs = { ...base, items: [item({ match: seatbelt })] };
    assert.deepEqual(photoRetrievalTerms(obs), ["安全带未系提醒", "指示灯", "安全带"]);
    assert.equal(composeRetrievalQuery("这咋啦？我的车", obs), "安全带未系提醒 指示灯 安全带 这咋啦？我的车");
  });
  it("没对上的项什么也不贡献——形状词只会把检索带偏；原话原样", () => {
    const obs = { ...base, items: [item({ match: null })] };
    assert.deepEqual(photoRetrievalTerms(obs), []);
    assert.equal(composeRetrievalQuery("这咋啦？我的车", obs), "这咋啦？我的车");
    assert.equal(photoHasSymbols(obs), true, "有符号但没对上：路由守卫仍认它是仪表照片");
  });
  it("读不出 / 空照片 / 无照片 → 没有词，也不算有符号", () => {
    assert.deepEqual(photoRetrievalTerms(undefined), []);
    assert.equal(photoHasSymbols({ ...base, unreadable: true, items: [] }), false);
    assert.equal(photoHasSymbols({ ...base, items: [] }), false);
  });
  it("原话里已经有的词不重复", () => {
    const obs = { ...base, items: [item({ match: seatbelt })] };
    assert.equal(composeRetrievalQuery("安全带的灯亮了", obs), "安全带未系提醒 指示灯 安全带的灯亮了");
  });
});

describe("[F-20-03][AC-20-1] 车机警报列表（M80-10）", () => {
  const base = { handle: "h", unreadable: false, frame: { cut_off_sides: [], cutOffSource: "none" as const, quality: {} }, items: [], notes: [], caveats: [], retakeHints: [], timings: { detectMs: 0, describeMs: 0, totalMs: 0 }, model: { detect: "x", describe: "y" }, alerts: [], noActiveAlerts: false };
  const a = (over: Partial<PhotoAlert>): PhotoAlert => ({ code: "DI_a223", title: "牵引力控制已停用", subtitle: "小心驾驶", iconColor: "red", active: true, at: "", ...over });

  it("段落：活动与历史分开；代码、原话、图标颜色都带上；末尾指令写明查不到不许推断", () => {
    const obs = { ...base, alerts: [a({}), a({ code: "APP_w009", title: "自动紧急制动不可用", subtitle: "", active: false, at: "10:21", iconColor: "gray" })] };
    const s = alertSection(obs);
    assert.match(s, /活动警报：/);
    assert.match(s, /DI_a223 牵引力控制已停用（屏幕提示：小心驾驶） · 图标红色/);
    assert.match(s, /早些时候（已不在活动列表）：/);
    assert.match(s, /APP_w009 自动紧急制动不可用 · 图标灰色 · 10:21/);
    assert.match(s, /这条代码手册里没有收录/, "查不到时的话术必须写死在指令里");
  });

  it("屏幕写着「无活动警报」→ 说出来；这与「没读到」是两件事", () => {
    const s = alertSection({ ...base, noActiveAlerts: true, alerts: [a({ active: false, at: "昨天 13:58" })] });
    assert.match(s, /屏幕上写着「无活动警报」/);
    assert.match(s, /早些时候/);
  });

  it("没有警报 → 空串，调用方不拼这一段", () => {
    assert.equal(alertSection(base), "");
  });

  it("检索词：活动警报的代码与标题都进，历史的不进（多数已自行恢复，会把检索拖偏）", () => {
    const obs = { ...base, alerts: [a({}), a({ code: "APP_w009", title: "自动紧急制动不可用", active: false })] };
    assert.deepEqual(photoRetrievalTerms(obs), ["DI_a223", "牵引力控制已停用"]);
    assert.equal(composeRetrievalQuery("这咋啦", obs), "DI_a223 牵引力控制已停用 这咋啦");
  });

  it("给意图的一行摘要说清是警报列表并带代码——意图层据此判到售后", () => {
    const line = photoSummaryLine({ ...base, alerts: [a({})] });
    assert.match(line, /车机「警报」列表截图/);
    assert.match(line, /DI_a223/);
    assert.match(photoSummaryLine({ ...base, noActiveAlerts: true }), /无活动警报/);
  });

  it("**读到警报页的照片不算读不出**——图标观察在这种截图上本来就该是零项", async () => {
    const st = await buildPhotoObservation("h", Buffer.alloc(0), { frame: { unreadable: true, cut_off_sides: [], cutOffSource: "none", quality: {}, item_count: 0 }, items: [], notes: [], timings: { detectMs: 0, describeMs: 0, totalMs: 0 }, model: { detect: "d", describe: "e" } } as never, undefined, undefined, { isAlertScreen: true, entries: [{ code: "DI_a223", title: "牵引力控制已停用", subtitle: "", iconColor: "red", active: true, at: "" }], noActiveAlerts: false, notes: ["有一条代码没看清"] });
    assert.equal(st.unreadable, false);
    assert.equal(st.alerts.length, 1);
    assert.deepEqual(st.caveats, [], "别再说「这张照片没看清」——每一行都抄下来了");
    assert.deepEqual(st.retakeHints, [], "警报页不给仪表照的补拍指引");
    assert.ok(st.notes.some((n) => n.includes("警报页：有一条代码没看清")));
  });

  it("**老检查点里没有 alerts 字段也不能抛**——M80-10 之前存下的会话恢复回来就是这样", () => {
    const legacy = { ...base } as Record<string, unknown>;
    delete legacy.alerts;
    assert.equal(photoHasAlerts(legacy as never), false);
    assert.equal(alertSection(legacy as never), "");
    assert.deepEqual(photoRetrievalTerms(legacy as never), []);
  });
});

describe("[F-20-03][AC-20-1] 手册图示召回进观察状态（ACR-029）", () => {
  const makeHit = (id: string, sim: number) => ({ figureId: id, doc: "Model3_车主手册", page: 15, location: "第 13 页", breadcrumb: "Model3_车主手册 › 概述 › 指示灯", anchorText: "胎压报警（指示灯为琥珀色）。", caption: "", imgPath: "x/part-1/images/a.jpg", sim, via: "image" as const });
  it("装了 recallFigures → 拿匹配那一步的 crop 去召回，过门槛的进 state.figures；trace 里有 figures", async () => {
    let cropsSeen = 0;
    setVisionDeps({ provider, matchIcon: matcherSeatbeltOnly, recallFigures: async (crops) => { cropsSeen = crops.length; return [makeHit("a", 0.75), makeHit("b", 0.5)]; } });
    const traces: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const r = await observeAttachmentsNode({ photoInput } as never, { configurable: { onTrace: (e: { kind: string; data: Record<string, unknown> }) => traces.push(e) } });
    const obs = r.photoObservation!;
    assert.equal(cropsSeen, 4, "四个警示灯各一张 crop");
    assert.deepEqual(obs.figures?.map((f) => f.figureId), ["a"]);
    const v = traces.find((t) => t.kind === "vision")!;
    assert.deepEqual(v.data.figures, [{ figureId: "a", location: "第 13 页", sim: 0.75, via: "image" }]);
  });
  it("索引 off（没有 matchIcon）但装了 recallFigures → 仍裁 crop 召回", async () => {
    let cropsSeen = 0;
    setVisionDeps({ provider, recallFigures: async (crops) => { cropsSeen = crops.length; return []; } });
    const r = await observeAttachmentsNode({ photoInput } as never);
    assert.equal(cropsSeen, 4);
    assert.deepEqual(r.photoObservation!.figures, []);
  });
  it("召回抛错 → figures 为空、记一条 note、观察结果照常", async () => {
    setVisionDeps({ provider, matchIcon: matcherSeatbeltOnly, recallFigures: async () => { throw new Error("pgvector 不通"); } });
    const r = await observeAttachmentsNode({ photoInput } as never);
    const obs = r.photoObservation!;
    assert.deepEqual(obs.figures, []);
    assert.ok(obs.notes.some((n) => /手册图示召回失败：pgvector 不通/.test(n)));
    assert.equal(obs.items.length, 8);
  });
  it("没装 recallFigures → 没有 figures 字段（老检查点同形）", async () => {
    setVisionDeps({ provider, matchIcon: matcherSeatbeltOnly });
    const r = await observeAttachmentsNode({ photoInput } as never);
    assert.equal(r.photoObservation!.figures, undefined);
  });
});
