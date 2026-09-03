/**
 * 购车顾问与座舱陪伴（US-15 / US-19）。
 *
 * 走查时这两个子图是 3 行空文件（`TODO: implement`），五个 Agent 里有两个不存在。
 *
 * 这份测试盯的不是"能不能返回结果"，而是**能不能不编**：
 * 这两条路上都没有可核对的事实（购车没有这辆车的数据，座舱连知识库都没有），
 * 编出来的话看起来和真的完全一样。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  setRagClient,
  setPreferenceStore,
  setToolObserver,
  type PreferenceStore,
} from "@carlife/tools";

import {
  runCatalogRetrieval,
  runCostEstimate,
  scopeCaveats,
  extractConstraints,
  extractAssumptionOverrides,
  resolveModel,
  narrowCandidates,
  COST_INTENT,
  type Candidate,
} from "../src/graph/subgraphs/buying";
import type { CostPlanState } from "../src/graph/state";
import { runCabinContext } from "../src/graph/subgraphs/cabin";

const BUYING = { sessionId: "s1", agent: "buying" as const, mode: "real" as const };
const CABIN = { sessionId: "s1", agent: "cabin" as const, mode: "real" as const };

const chunk = (content: string, document: string, score = 0.9) => ({
  content,
  source: { document },
  score,
});

/** 与真实语料同形的几条：参数规格 + 选配表（含厂商指导价表格行）。 */
const M3_SPEC = chunk("Model 3 长续航后轮驱动版 CLTC 753 km，5 座，百公里加速 5.2 秒。", "Model3_参数规格.md");
const M3_PRICE = chunk(
  "代码 | 名称 | 价格 (CNY)\n$MT373 | Model 3 后轮驱动版 | 235,500\n$MT374 | Model 3 长续航后轮驱动版 | 259,500",
  "tesla_m3_选配.md",
);
const MY_SPEC = chunk("Model Y 长续航全轮驱动版 CLTC 719 km，5 座。", "ModelY_参数规格.md");
const MY_PRICE = chunk(
  "代码 | 名称 | 价格 (CNY)\n$MTY79 | Model Y 后轮驱动版 | 263,500\n$MTY69 | Model Y L | 339,000",
  "tesla_my_选配.md",
);
const MALIBU = chunk("迈锐宝 XL 535T 自动锐尊版，5 座，1.5T 发动机。", "2017雪佛兰迈锐宝车型手册与配置参数.md");
const CT_SPEC = chunk("Cybertruck EPA 320 mi range, 5 座。", "Cybertruck_Specifications.md");

describe("购车：单路检索，且说清为什么只有一路", () => {
  it("**不传 vehicleModel**——购车对比必须跨车型看", async () => {
    let sawModel: unknown = "未捕获";
    setRagClient({
      async retrieve(a: Record<string, unknown>) {
        sawModel = a.vehicleModel;
        return [chunk("Model Y 长续航版 CLTC 688km", "ModelY_参数规格.pdf")];
      },
    });
    await runCatalogRetrieval({ query: "Model Y 和 Model 3 怎么选", ctx: BUYING });
    // 传了车型就把对比问题变成单车型问答，而那个错误带着正确的出处。
    assert.equal(sawModel, undefined);
  });

  it("上下文里写明「没有第二路」——否则模型会顺着用车助手的语气编个性化", async () => {
    setRagClient({ async retrieve() { return [chunk("参数", "ModelY_参数规格.pdf")]; } });
    const r = await runCatalogRetrieval({ query: "Model Y 值得买吗", ctx: BUYING });
    assert.match(r.context, /购车阶段没有这辆车的用车数据/);
    assert.equal(r.context.includes("未能读取你的用车数据"), false);
  });

  it("价格与优惠不在车型库里——要如实说答不了，不拿参数表凑一个价格", () => {
    const c = scopeCaveats("Model Y 落地价大概多少，有优惠吗");
    assert.equal(c.length, 1);
    assert.match(c[0], /实时价格与优惠行情/);
  });

  it("库存与提车周期同样答不了", () => {
    assert.match(scopeCaveats("现车还要等多久提车")[0], /库存与交付周期/);
  });

  it("**零结果与查询失败分开说**——一个是知识库没写，一个是我们坏了", async () => {
    setRagClient({ async retrieve() { return []; } });
    const empty = await runCatalogRetrieval({ query: "某款车", ctx: BUYING });
    assert.equal(empty.ok, true);
    assert.match(empty.caveats.join(), /这个问题手册里没写/);

    setRagClient({ async retrieve(): Promise<never> { throw new Error("upstream 502"); } });
    const failed = await runCatalogRetrieval({ query: "某款车", ctx: BUYING });
    assert.equal(failed.ok, false);
    assert.match(failed.caveats.join(), /没查通/);
  });

  it("检索挂了也要作答，不让整轮失败", async () => {
    setRagClient({ async retrieve(): Promise<never> { throw new Error("boom"); } });
    const r = await runCatalogRetrieval({ query: "买哪款", ctx: BUYING });
    assert.ok(r.context.length > 0);
  });
});

/**
 * 候选收敛与淘汰理由（施工单 M15-01，AC-15-1 / AC-15-2）。
 *
 * 这一组盯的是**"为什么把 XX 排除了"答得上**。答不上，郑明就默认背后有广告；
 * 而答得像模像样却没有依据，比答不上更糟——他会自己去核对。
 */
describe("购车：候选收敛与淘汰理由", () => {
  const withChunks = (...cs: ReturnType<typeof chunk>[]) =>
    setRagClient({ async retrieve() { return cs; } });

  it("数量尊重用户指定——说「看两款」就不给第三台（AC-15-1）", async () => {
    withChunks(M3_SPEC, M3_PRICE, MY_SPEC, MY_PRICE, CT_SPEC);
    const two = await runCatalogRetrieval({ query: "给我看两款纯电的", ctx: BUYING });
    assert.equal(two.constraints.limit, 2);
    assert.ok(two.candidates.length <= 2, `实际 ${two.candidates.length} 台`);

    const dft = await runCatalogRetrieval({ query: "纯电的推荐一下", ctx: BUYING });
    assert.equal(dft.constraints.limit, undefined);
    assert.ok(dft.candidates.length <= 3, `实际 ${dft.candidates.length} 台`);
  });

  it("**不凑满名额**——库里只有两款可比就给两款，并把这件事说出来", async () => {
    withChunks(M3_SPEC, M3_PRICE, MY_SPEC, MY_PRICE);
    const r = await runCatalogRetrieval({ query: "纯电的怎么选", ctx: BUYING });
    assert.equal(r.candidates.length, 2);
    assert.match(r.context, /本次车型库里可比的共 2 款/);
    // "从 38 台里筛出 3 台"是编的；候选宇宙必须能被说出来。
    assert.equal(r.universe.length, 2);
  });

  it("淘汰理由可核对——两个数字都在，不是一句「超预算」（AC-15-2）", async () => {
    withChunks(M3_SPEC, M3_PRICE, MY_SPEC, MY_PRICE);
    // "20多万" 读作上界 30 万：Model Y 最低配 263,500 留下，
    // 若把预算写成 25 万则 Model Y 出局——这里用后者，理由要带两个数字。
    const r = await runCatalogRetrieval({ query: "预算25万的纯电车", ctx: BUYING });
    const out = r.eliminated.find((c) => c.model === "Model Y");
    assert.ok(out, "Model Y 最低配 263,500 高于 25 万，应被淘汰");
    assert.equal(out!.eliminatedBy![0].dimension, "budget");
    assert.match(out!.eliminatedBy![0].reason, /263500/);
    assert.match(out!.eliminatedBy![0].reason, /250000/);
    // 淘汰的车要主动说出来，不能等用户问。
    assert.match(r.context, /被淘汰的候选/);
  });

  it("淘汰维度最多两条——全说是噪音", () => {
    const c: Candidate = {
      model: "迈锐宝",
      specs: [{ label: "座位数", value: "5 座", source: { document: "d", snippet: "s", score: 1 } }],
      guidePrice: { amount: 300_000, trim: "顶配", source: { document: "d", snippet: "s", score: 1 } },
    };
    const { eliminated } = narrowCandidates([c], { budgetMax: 100_000, energy: "bev", bodyType: "suv", seats: 7 }, 3);
    assert.equal(eliminated.length, 1);
    assert.equal(eliminated[0].eliminatedBy!.length, 2);
  });

  it("座位判定落到**配置**上——六座是 Model Y L 的事，不是 Model Y 的事（M21-02，F-47-07）", () => {
    const c: Candidate = {
      model: "Model Y",
      // 车型级资料里抽到的是 5 座：只看这一层的话，要六座的车主会看到 Model Y 被淘汰。
      specs: [{ label: "座位数", value: "5 座", source: { document: "d", snippet: "s", score: 1 } }],
      trimSpecs: [
        { trim: "后轮驱动版", priceCny: 263_500, seats: 5 },
        { trim: "Model Y L", priceCny: 339_000, seats: 6 },
      ],
    };
    const { candidates, eliminated } = narrowCandidates([c], { seats: 6 }, 3);
    assert.equal(eliminated.length, 0, "有一个配置是六座，就不该整款车被淘汰");
    // **必须记下是哪个配置**：否则回答层只能说"Model Y 有六座"，
    // 而车主会拿着后驱版的价格去问六座车（M15-05 §6-4 那条债）。
    assert.deepEqual(candidates[0].matchedTrims, ["Model Y L"]);
  });

  it("一个配置都坐不下时才淘汰，理由说的是「最多的配置」", () => {
    const c: Candidate = {
      model: "Model 3",
      specs: [],
      trimSpecs: [
        { trim: "后轮驱动版", seats: 5 },
        { trim: "长续航后轮驱动版", seats: 5 },
      ],
    };
    const { eliminated } = narrowCandidates([c], { seats: 7 }, 3);
    assert.equal(eliminated.length, 1);
    assert.equal(eliminated[0].eliminatedBy![0].dimension, "seats");
    assert.match(eliminated[0].eliminatedBy![0].reason, /最多的配置也只有 5 座/);
  });

  it("拿不到配置级事实时回落到车型级判定，行为与 M21 之前逐字相同", () => {
    const c: Candidate = {
      model: "迈锐宝",
      specs: [{ label: "座位数", value: "5 座", source: { document: "d", snippet: "s", score: 1 } }],
    };
    const { eliminated } = narrowCandidates([c], { seats: 7 }, 3);
    assert.equal(eliminated.length, 1);
    assert.match(eliminated[0].eliminatedBy![0].reason, /资料里是 5 座/);
    // 回落路径不产生 matchedTrims——没有配置级事实就没有可点名的配置。
    assert.equal(eliminated[0].matchedTrims, undefined);
  });

  it("检索到了但一条参数都没抽到 → **要出声**（2026-08-14 走查）", async () => {
    // 真库实测的形态：chunk 有内容（车主手册的规格章节：整车质量、悬架、轮胎标签），
    // 选配表也能抽到指导价，但 SPEC_PATTERNS 一条都匹配不上。
    // 此前这种情况下 caveats 为空——助手拿着一份没有任何参数的候选去回答"哪款好"。
    withChunks(
      chunk("整车质量 1992 千克；TPMLM 2503 千克；牵引力：不可牵引。", "ModelY_参数规格.md"),
      chunk("代码 | 名称 | 价格 (CNY)\n$MTY79 | Model Y 后轮驱动版 | 263,500", "tesla_my_选配.md"),
    );
    const r = await runCatalogRetrieval({ query: "Model Y 怎么样", ctx: BUYING });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].specs.length, 0, "这组语料本来就抽不到参数");
    const caveat = r.caveats.find((c) => /一条可对比的配置参数都没抽到/.test(c));
    assert.ok(caveat, `应当出声，实际 caveats=${JSON.stringify(r.caveats)}`);
    // **两句话不能混**：资料里没有 ≠ 这些车没有。
    assert.match(caveat!, /不是它们没有这些参数/);
  });

  it("抽到了参数就不出这条声——不误报", async () => {
    withChunks(MY_SPEC, MY_PRICE);
    const r = await runCatalogRetrieval({ query: "Model Y 怎么样", ctx: BUYING });
    assert.ok(r.candidates[0].specs.length > 0);
    assert.equal(r.caveats.some((c) => /一条可对比的配置参数都没抽到/.test(c)), false);
  });

  it("**判不了就不淘汰**——抽不到指导价不等于它太贵", () => {
    const noPrice: Candidate = { model: "Cybertruck", specs: [] };
    const { candidates, eliminated } = narrowCandidates([noPrice], { budgetMax: 100_000 }, 3);
    assert.equal(eliminated.length, 0);
    assert.equal(candidates.length, 1);
  });

  it("美元标价不参与预算淘汰——换算汇率就是编数字", async () => {
    withChunks(
      CT_SPEC,
      chunk("代码 | 名称 | 价格 (USD)\n$CT1 | Cybertruck AWD | 79,990", "tesla_ct_选配.md"),
    );
    const r = await runCatalogRetrieval({ query: "预算20万的纯电", ctx: BUYING });
    assert.equal(r.eliminated.length, 0, "币种不是人民币时不该按预算判它超没超");
  });

  it("无硬约束就不淘汰，且不说成「筛过了」", async () => {
    withChunks(M3_SPEC, M3_PRICE, MY_SPEC, MY_PRICE, MALIBU);
    const r = await runCatalogRetrieval({ query: "有什么车推荐", ctx: BUYING });
    assert.equal(r.eliminated.length, 0);
    assert.match(r.context, /没有给出可判定的硬约束/);
  });

  it("能源不符要淘汰，且理由说人话", async () => {
    withChunks(M3_SPEC, M3_PRICE, MALIBU);
    const r = await runCatalogRetrieval({ query: "想买纯电的", ctx: BUYING });
    const out = r.eliminated.find((c) => c.model === "迈锐宝");
    assert.ok(out);
    assert.equal(out!.eliminatedBy![0].dimension, "energy");
    assert.match(out!.eliminatedBy![0].reason, /燃油/);
  });

  it("**零命中的车型不吞**——只返回一边的对比看起来完整、实则单边", async () => {
    setRagClient({ async retrieve() { return [MY_SPEC]; } });
    const r = await runCatalogRetrieval({ query: "Model Y 和 Model 3 比一比", ctx: BUYING });
    assert.match(r.caveats.join(), /Model 3/);
  });

  it("**手里正拿着它的参数，就不能说「车型库里没有资料」**（真库实测踩到）", async () => {
    // `car_catalog` 的 missingModels 靠 chunk 的 model 字段算，而注入式后端不填它，
    // 于是每个被点名的车型都会被算成零命中——回答里同时出现"没有资料"和它的指导价。
    withChunks(M3_SPEC, M3_PRICE, MY_SPEC, MY_PRICE);
    const r = await runCatalogRetrieval({ query: "Model 3 和 Model Y 比一比", ctx: BUYING });
    assert.equal(r.universe.length, 2);
    assert.equal(r.caveats.join().includes("车型库里没有资料"), false, r.caveats.join());
  });

  it("点名了车型就**只在这几款里比**——没问的那台不该冒出来", async () => {
    withChunks(M3_SPEC, M3_PRICE, MY_SPEC, MY_PRICE, MALIBU);
    const r = await runCatalogRetrieval({ query: "Model Y 的续航是多少", ctx: BUYING });
    assert.deepEqual(r.candidates.map((c) => c.model), ["Model Y"]);
    assert.deepEqual(r.universe.map((u) => u.model), ["Model Y"]);
  });

  it("**车型解析不猜**——判不出归属的资料计数并排除，不挂到别的车头上", async () => {
    withChunks(chunk("本车配备全景天窗与座椅通风。", "某厂商宣传页.md"));
    const r = await runCatalogRetrieval({ query: "有什么车推荐", ctx: BUYING });
    assert.equal(r.unclassifiedDocs, 1);
    assert.equal(r.candidates.length, 0);
    assert.match(r.caveats.join(), /判不出属于哪款车/);
  });

  it("对比中的段落不归属任何一款——命中两款说明它在做对比", () => {
    assert.equal(resolveModel("对比.md", "Model 3 与 Model Y 的差别在于"), undefined);
    assert.equal(resolveModel("ModelY_参数规格.md", "对比 Model 3 更大"), "Model Y", "文档名优先");
  });

  it("出处同源——`sources` 里的每一条都能在 context 的出处行里找到", async () => {
    withChunks(M3_SPEC, M3_PRICE, MY_SPEC, MY_PRICE);
    const r = await runCatalogRetrieval({ query: "纯电怎么选", ctx: BUYING });
    assert.ok(r.sources.length > 0);
    for (const s of r.sources) {
      assert.ok(r.context.includes(s.document), `context 里找不到出处 ${s.document}`);
      assert.ok(s.snippet.length > 0, "出处必须带原文片段，光有文档名点开是空的");
    }
  });

  it("**选装包不是车价**——FSD 6.4 万比整车便宜，取最低价会把它当成车价（真库实测踩到）", async () => {
    withChunks(
      M3_SPEC,
      chunk(
        "代码 | 名称 | 价格 (CNY)\n$MT373 | Model 3 后轮驱动版 | 235,500\n" +
          "代码 | 名称 | 价格 (CNY)\n$APF2 | 特斯拉辅助驾驶 | 64,000\n$APPB | 增强辅助驾驶 | 32,000",
        "tesla_m3_选配.md",
      ),
    );
    const r = await runCatalogRetrieval({ query: "Model 3 多少钱", ctx: BUYING });
    const c = r.candidates.find((x) => x.model === "Model 3");
    assert.equal(c?.guidePrice?.amount, 235_500, "配置名里必须出现车型名，否则不是一台车");
    assert.match(c!.guidePrice!.trim, /Model 3/);
  });

  it("指导价说清是指导价，且同一条里就否掉落地价", async () => {
    withChunks(M3_SPEC, M3_PRICE);
    const r = await runCatalogRetrieval({ query: "Model 3 多少钱", ctx: BUYING });
    const c = r.candidates.find((x) => x.model === "Model 3");
    assert.equal(c?.guidePrice?.amount, 235_500, "取最低配，不是表格第一行");
    assert.match(r.context, /这是指导价不是落地价/);
  });
});

describe("购车：约束抽取不替用户做主", () => {
  it("「20多万」读作上界 30 万，不擅自取一个居中的数", () => {
    assert.equal(extractConstraints("20多万的纯电").budgetMax, 300_000);
  });

  it("「不超过25万」「25万以内」都读成 25 万", () => {
    assert.equal(extractConstraints("不超过25万").budgetMax, 250_000);
    assert.equal(extractConstraints("25万以内的车").budgetMax, 250_000);
  });

  it("**抽不到就是 undefined**——凭空的默认预算会静默淘汰本该在列的车", () => {
    const c = extractConstraints("想换台车");
    assert.equal(c.budgetMax, undefined);
    assert.equal(c.energy, undefined);
    assert.equal(c.seats, undefined);
    assert.equal(c.limit, undefined);
  });

  it("「家里三口人」读成座位数下限 3，不是精确 3 座", () => {
    assert.equal(extractConstraints("家里三口人，买什么车").seats, 3);
    assert.equal(extractConstraints("要7座的").seats, 7);
  });

  it("能源类型三档", () => {
    assert.equal(extractConstraints("纯电的").energy, "bev");
    assert.equal(extractConstraints("插混怎么样").energy, "phev");
    assert.equal(extractConstraints("还是买燃油车吧").energy, "icev");
  });
});

/**
 * 五年成本测算与「改一个假设重算」（施工单 M15-02，AC-15-4）。
 *
 * 盯的是两件事：**车价不能是猜的**，以及**重算只改被点名的那一项**。
 * 后者错了的表现极隐蔽——总额变了，看起来"重算过了"，
 * 而实际上车价被顺手换成了另一款车的。
 */
describe("购车：五年成本测算与假设重算", () => {
  const withChunks = (...cs: ReturnType<typeof chunk>[]) =>
    setRagClient({ async retrieve() { return cs; } });

  /** 跑一次检索拿候选，再跑成本——与 buyingNode 的顺序一致。 */
  const estimate = async (query: string, prior?: CostPlanState, ...cs: ReturnType<typeof chunk>[]) => {
    withChunks(...(cs.length ? cs : [M3_SPEC, M3_PRICE]));
    const r = await runCatalogRetrieval({ query, ctx: BUYING });
    return runCostEstimate({ query, candidates: r.candidates, prior, ctx: BUYING });
  };

  it("**车价没有来源就不算**——不给一个猜测的总额", async () => {
    const e = await estimate("Model 3 五年用车成本多少", undefined, M3_SPEC);
    assert.equal(e.plan, undefined);
    assert.ok(e.ask, "应该转而去问车价");
    // 这一段绝不能出现总额：给了他就记住了。
    assert.equal(/\d{5,}\s*元/.test(e.context), false, e.context);
  });

  it("多台候选都有指导价时**不替他选**，把选项列出来问", async () => {
    const e = await estimate("五年用车成本多少", undefined, M3_SPEC, M3_PRICE, MY_SPEC, MY_PRICE);
    assert.equal(e.plan, undefined);
    assert.match(e.ask!, /235500/);
    assert.match(e.ask!, /263500/);
  });

  it("车价取自厂商指导价并留住出处", async () => {
    const e = await estimate("Model 3 五年用车成本多少");
    assert.equal(e.plan?.breakdown.items.vehiclePrice, 235_500);
    assert.equal(e.plan?.priceSource.kind, "catalog");
    assert.match(e.plan!.priceSource.document, /tesla_m3_选配/);
  });

  it("用户自己给的车价优先于指导价", async () => {
    const e = await estimate("Model 3 就按22万算，五年用车成本多少");
    assert.equal(e.plan?.breakdown.items.vehiclePrice, 220_000);
    assert.equal(e.plan?.priceSource.kind, "user");
  });

  it("**全部 8 项假设都在**，且系统补的那些标着「系统默认」", async () => {
    const e = await estimate("Model 3 五年用车成本多少");
    for (const label of [
      "年行驶里程", "电价", "油价", "百公里电耗", "百公里油耗",
      "商业险费率", "年均保养费", "年残值率",
    ]) {
      assert.ok(e.context.includes(label), `假设「${label}」没出现在上下文里`);
    }
    assert.match(e.context, /系统默认/);
  });

  it("**只改一项**——车价与其余七项与上一轮逐字相等", async () => {
    const first = await estimate("Model 3 五年用车成本多少");
    const prior = first.plan!;
    const again = await estimate("我一年跑3万公里", prior);
    const p = again.plan!;

    assert.deepEqual(p.changed, ["annualKm"]);
    assert.equal(p.breakdown.assumptions.annualKm, 30_000);
    assert.equal(p.breakdown.items.vehiclePrice, prior.breakdown.items.vehiclePrice);
    for (const k of Object.keys(prior.breakdown.assumptions)) {
      if (k === "annualKm") continue;
      assert.equal(p.breakdown.assumptions[k], prior.breakdown.assumptions[k], `假设 ${k} 不该变`);
    }
    // 跑得多，能耗上去，总额必然变大。
    assert.ok(p.breakdown.total > prior.breakdown.total);
    assert.match(again.context, /本次只改了/);
  });

  it("重算不重新问车价——哪怕这一轮候选里一台带价的都没有", async () => {
    const first = await estimate("Model 3 五年用车成本多少");
    const again = await estimate("我一年跑3万公里", first.plan!, M3_SPEC); // 无选配表
    assert.equal(again.ask, undefined);
    assert.equal(again.plan!.breakdown.items.vehiclePrice, 235_500);
  });

  it("持有年限也能改，且与假设分开记", async () => {
    const first = await estimate("Model 3 五年用车成本多少");
    const again = await estimate("我就开三年", first.plan!);
    assert.equal(again.plan!.breakdown.years, 3);
    assert.ok(again.plan!.changed.includes("years"));
  });

  it("**走注册表**——绕过 invokeTool 这次调用在轨迹里就不存在", async () => {
    const seen: string[] = [];
    setToolObserver((e) => seen.push(e.name));
    try {
      await estimate("Model 3 五年用车成本多少");
    } finally {
      setToolObserver(undefined);
    }
    assert.ok(seen.includes("cost_calc"), `实际观测到：${seen.join(",")}`);
  });
});

describe("购车：成本意图与假设覆盖的抽取", () => {
  it("抽得出「一年3万公里」", () => {
    assert.equal(extractAssumptionOverrides("我一年跑3万公里").annualKm, 30_000);
    assert.equal(extractAssumptionOverrides("每年开15000公里").annualKm, 15_000);
  });

  it("**不是在改假设的话，抽出来就是空的**", () => {
    assert.deepEqual(extractAssumptionOverrides("那 Model Y 呢"), {});
    assert.deepEqual(extractAssumptionOverrides("续航多少"), {});
  });

  it("成本意图判得窄——一个没人要的总额比不给更糟", () => {
    assert.equal(COST_INTENT.test("五年下来大概多少钱养"), true);
    assert.equal(COST_INTENT.test("算算用车成本"), true);
    assert.equal(COST_INTENT.test("Model 3 多少钱"), false, "问车价不是问用车成本");
    assert.equal(COST_INTENT.test("续航多少"), false);
  });
});

describe("座舱：唯一的真实性抓手是「只说记忆里真有的」", () => {
  const storeWith = (prefs: Array<{ content: string; confidence?: number }>, degraded = false): PreferenceStore => ({
    async recall() {
      return { preferences: prefs, degraded };
    },
  });

  it("有偏好时可以说，personalized=true", async () => {
    setPreferenceStore(storeWith([{ content: "习惯夜间充电", confidence: 0.8 }]));
    const r = await runCabinContext({ query: "陪我聊聊", userId: "u1", ctx: CABIN });
    assert.equal(r.personalized, true);
    assert.match(r.context, /习惯夜间充电/);
  });

  it("**低置信度偏好不进上下文**——一条 0.3 的猜测被念出来，听起来和事实一样确定", async () => {
    setPreferenceStore(storeWith([{ content: "好像喜欢听相声", confidence: 0.3 }]));
    const r = await runCabinContext({ query: "无聊", userId: "u1", ctx: CABIN });
    assert.equal(r.personalized, false);
    assert.equal(r.context.includes("好像喜欢听相声"), false);
  });

  it("**降级不能说成「我还不太了解你」**——那是拿谎话盖故障", async () => {
    setPreferenceStore(storeWith([], true));
    const r = await runCabinContext({ query: "无聊", userId: "u1", ctx: CABIN });
    assert.equal(r.personalized, false);
    assert.match(r.context, /不要说「我还不太了解你」/);
    assert.match(r.caveats.join(), /降级/);
  });

  it("读不到（未接入/异常）与真的没有，说法不同", async () => {
    setPreferenceStore(undefined);
    const broken = await runCabinContext({ query: "无聊", userId: "u1", ctx: CABIN });
    assert.match(broken.caveats.join(), /不是你没有偏好/);

    setPreferenceStore(storeWith([]));
    const fresh = await runCabinContext({ query: "无聊", userId: "u1", ctx: CABIN });
    assert.equal(fresh.caveats.length, 0);
    assert.match(fresh.context, /确实还没有沉淀偏好/);
  });

  it("没有用户身份时按初次见面处理，不许用「我记得你」起头", async () => {
    setPreferenceStore(storeWith([{ content: "习惯夜间充电", confidence: 0.9 }]));
    const r = await runCabinContext({ query: "陪我聊聊", ctx: CABIN });
    assert.equal(r.personalized, false);
    assert.equal(r.preferences.length, 0, "没有用户维度就不该拿到任何人的偏好");
    assert.match(r.context, /我记得你/);
  });

  it("有偏好时明令不许外推——从「常走市区」推出「不喜欢长途」是最常见的编法", async () => {
    setPreferenceStore(storeWith([{ content: "通勤以市区为主", confidence: 0.9 }]));
    const r = await runCabinContext({ query: "聊聊天", userId: "u1", ctx: CABIN });
    assert.match(r.context, /不要推断没写的/);
  });
});
