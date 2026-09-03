/**
 * 双路检索单测（施工单 M8-02，§6）。零依赖。
 *
 * 重点是**降级不能冒充个性化**——F-16-08 说这比"没有个性化"更严重。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractWarnings, runDualPath } from "../src/graph/subgraphs/ownership";

const chunks = [{ content: "锂电池低温下离子活性下降", source: { document: "说明书.pdf", location: "第 42 页" } }];
const summary = { avgDailyKm: 42, lowTempRangeKm: 320, mildTempRangeKm: 400, sampleSize: 18 };

describe("双路合成", () => {
  it("两路齐全 → 个性化，且上下文含出处与实测数据", async () => {
    const r = await runDualPath(async () => chunks, async () => ({ summary }));
    assert.equal(r.personalized, true);
    assert.match(r.context, /说明书\.pdf/);
    assert.match(r.context, /320km/);
    assert.match(r.context, /结合起来/);
    assert.deepEqual(r.caveats, []);
  });

  it("**RAG 挂了仍作答**，但标注未引用出处（F-16-07）", async () => {
    const r = await runDualPath(
      async () => {
        throw new Error("RAGFlow 504");
      },
      async () => ({ summary }),
    );
    assert.equal(r.rag.ok, false);
    assert.equal(r.personalized, false, "少一路就不能声称个性化");
    // **失败与零命中的话术必须不同**：前者是我们的问题（该修系统），
    // 后者是知识库的信息（该补文档）。合成一句就分不出该做哪件事。
    assert.ok(r.caveats.some((c) => c.includes("检索说明书失败")));
  });

  it("**用车数据不足 → 退化为通用回答并说明原因**，不冒充个性化（F-16-08）", async () => {
    const r = await runDualPath(async () => chunks, async () => ({ unusableReason: "样本不足（2 条）" }));
    assert.equal(r.personalized, false);
    assert.ok(r.caveats.some((c) => c.includes("样本不足")));
    assert.match(r.context, /不具备个性化依据/);
    assert.match(r.context, /不要暗示这是针对这辆车的结论/);
  });

  it("两路都挂也不抛错——单次问答不该整体失败", async () => {
    const r = await runDualPath(
      async () => {
        throw new Error("a");
      },
      async () => {
        throw new Error("b");
      },
    );
    assert.equal(r.personalized, false);
    assert.equal(r.caveats.length, 2);
  });

  it("RAG 返回空结果不算个性化，但话术与「检索失败」区分开", async () => {
    const empty = await runDualPath(async () => [], async () => ({ summary }));
    assert.equal(empty.personalized, false);
    assert.ok(empty.caveats.some((c) => c.includes("没有检索到")));
    assert.ok(!empty.caveats.some((c) => c.includes("失败")), "零命中不是失败");

    const failed = await runDualPath(
      async () => { throw new Error("timeout"); },
      async () => ({ summary }),
    );
    assert.ok(failed.caveats.some((c) => c.includes("失败")));
    assert.ok(
      !failed.caveats.some((c) => c.includes("没有检索到")),
      "取不到不等于知识库里没有——说反了会让人去补文档而不是修系统",
    );
  });

  it("样本量出现在上下文里——3 条和 300 条的可信度不同", async () => {
    const r = await runDualPath(async () => chunks, async () => ({ summary }));
    assert.match(r.context, /样本 18 条/);
  });
});


/*
 * 手册警告单列（M62-03，§14 M-W1）：2026-09-01 评测警告召回 3/8，漏说的五条都是手册通行的警告句——
 * 片段整段塞进【通用原理】，警告淹在步骤里。这组用例守「抽得出、抽得准、抽不到就没有这一段」。
 */
describe("手册警告单列（M62-03）", () => {
  const manual = (content: string) => [{ content, source: { document: "车主手册.pdf", location: "第 88 页" } }];

  it("片段含警告句 → 上下文有【手册警告】段，且带出处", async () => {
    const r = await runDualPath(
      async () => manual("定时预热可在车机「空调」页设置。⚠ 请勿在密闭车库内使用预热功能，需保持通风。设置后指示灯亮起。"),
      async () => ({ summary }),
    );
    assert.match(r.context, /【手册警告（必须/);
    assert.match(r.context, /请勿在密闭车库内使用预热功能，需保持通风。（出处：车主手册\.pdf 第 88 页）/);
    // 段序：通用原理 → 手册警告 → 这辆车的真实数据
    assert.ok(r.context.indexOf("【手册警告（必须") > r.context.indexOf("【通用原理"));
    assert.ok(r.context.indexOf("【手册警告（必须") < r.context.indexOf("【这辆车的真实数据】"));
  });

  it("片段没有警告词 → 没有这一段（不从常识里补）", async () => {
    const r = await runDualPath(async () => manual("按住方向盘左侧按钮 3 秒可切换仪表主题。"), async () => ({ summary }));
    // 指令句里也提到「【手册警告】段」，所以只认段标题本身
    assert.doesNotMatch(r.context, /【手册警告（必须/);
  });

  it("「注意力辅助系统」「不得不」不是警告；「显示一条警告」是在描述界面，也不是", () => {
    const w = extractWarnings(manual("注意力辅助系统会在检测到疲劳时提示。有时不得不手动关闭它。实施转向时触摸屏将显示一条警告并以红色标示车道线。"));
    assert.deepEqual(w, []);
  });

  it("祈使式警告排在描述句前（探针实测 o-31：「不能代替审慎驾驶」该压过「显示一条警告」）", () => {
    const chunk = manual(
      "警告：紧急车道偏离防避不能代替审慎驾驶和准确判断。当紧急车道偏离防避实施转向时，您将听到蜂鸣声，触摸屏将显示一条警告。驾驶时务必观察路况，切勿依赖紧急车道偏离防避防止碰撞。",
    );
    const w = extractWarnings(chunk, "车道保持功能在什么情况下会自动退出");
    assert.match(w[0].text, /不能代替审慎驾驶|切勿依赖/);
    assert.ok(w.every((x) => !/显示一条警告/.test(x.text)));
  });

  it("超过 120 字的长句是功能说明，不是警告；最多留 4 条；去重", () => {
    const long = "注意" + "这是一段很长的功能说明".repeat(15) + "。";
    const many = ["切勿涉水超过 30cm。", "不得在行驶中调节座椅。", "请勿遮挡雷达。", "避免长时间怠速。", "禁止拆卸电池。", "切勿涉水超过 30cm。"].join("");
    const w = extractWarnings(manual(long + many));
    assert.equal(w.length, 4);
    assert.ok(w.every((x) => x.text.length <= 120));
    assert.equal(new Set(w.map((x) => x.text)).size, 4);
  });

  it("给了原话就按相关度排：问涉水时涉水限值排第一，起火那句退后（2026-09-02 子集实测的答非所问）", () => {
    const chunk = manual(
      "如果发现车辆起火、冒烟，请勿靠近，马上离开并联系救援。涉水行驶时切勿超过 30 厘米水深，否则可能损坏动力系统。行驶中不要操作触摸屏。",
    );
    const ranked = extractWarnings(chunk, "说明书上写的涉水深度是多少，暴雨天能过多深的积水");
    assert.match(ranked[0].text, /涉水/);
    // 有相关的就只留相关的：起火与触摸屏那两句与问题零重叠，不进段
    assert.equal(ranked.length, 1);
    // 没给原话 → 按出现顺序
    assert.match(extractWarnings(chunk)[0].text, /起火/);
  });

  it("给了原话但一条都不相关 → 没有这一段（子集实测「帮我预约一下」被复述了「制动液别加满」）", () => {
    const w = extractWarnings(manual("请勿在密闭车库使用预热。"), "帮我预约一下");
    assert.equal(w.length, 0);
    // 没给原话时无从判相关，按出现顺序给
    assert.equal(extractWarnings(manual("请勿在密闭车库使用预热。")).length, 1);
  });

  it("指令里要求先复述警告——两条指令都带这句", async () => {
    const withUsage = await runDualPath(async () => manual("⚠ 低温下续航会明显下降。"), async () => ({ summary }));
    const withoutUsage = await runDualPath(async () => manual("⚠ 低温下续航会明显下降。"), async () => ({ unusableReason: "样本不足" }));
    assert.match(withUsage.context, /先复述其中至少一条/);
    assert.match(withoutUsage.context, /先复述其中至少一条/);
    // solved_must 依赖的两句原话不能被改掉
    assert.match(withUsage.context, /给出判定（正常\/偏高\/需关注）/);
    assert.match(withoutUsage.context, /本次不具备个性化依据/);
  });
});
