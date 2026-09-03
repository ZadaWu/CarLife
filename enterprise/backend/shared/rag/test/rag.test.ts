/**
 * RAG 客户端单测（施工单 M8-01）。零依赖、不打真实 RAGFlow。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DATASETS, datasetsForAgent } from "../src/datasets";
import {
  createRagClient,
  DatasetAccessError,
  documentMatchesModel,
  chunkMethodFor,
  suspiciousChunks,
  longestUnterminatedRun,
  looksTabular,
  looksLikeToc,
  UNTERMINATED_RUN_THRESHOLD,
  tableDataRowCount,
  hasTableHeader,
  looksFlattenedTable,
  tableDataRowCount,
  summarizeRetrievalTest,
} from "../src/client";
import { prepareMarkdownForChunking, splitLongText, estimateTokens, tableToText } from "../src/chunk-prep";
import { cleanMineruMarkdown } from "../src/mineru";

describe("三数据集隔离（AC-24-8）", () => {
  it("按 §6 划分，各有明确消费方", () => {
    assert.equal(DATASETS.length, 3);
    assert.deepEqual(datasetsForAgent("ownership").map((d) => d.key), ["vehicle-manuals"]);
    assert.deepEqual(datasetsForAgent("service").map((d) => d.key), ["repair-kb"]);
    assert.deepEqual(datasetsForAgent("buying").map((d) => d.key), ["car-catalog"]);
  });

  it("**跨集检索在调用层被拒**，不靠 prompt 约束", async () => {
    const client = createRagClient({ baseUrl: "http://x", apiKey: "k", datasetIds: { "repair-kb": "1" } });
    await assert.rejects(
      () => client.retrieve({ dataset: "repair-kb", query: "冬天续航", agent: "ownership" }),
      (e: unknown) => e instanceof DatasetAccessError,
    );
  });

  it("**每个数据集都必须显式声明来源**（F-24-11）", () => {
    // 原来这条断言的是 `repair-kb === "simulated"`——当时那个集准备放编造的维修案例。
    // 后来真实的厂商保修保养手册进了这个集，标记就改成了 public：
    // **给真实资料打上「模拟」的标签，与拿假数据冒充真实同样是不实表述**，只是方向相反。
    //
    // 所以现在断言的不是某个具体取值，而是**不允许缺省**：
    // 一个没有 provenance 的数据集在页面上会默认渲染成真实资料，
    // 那才是这条不变量真正要防的。
    for (const d of DATASETS) {
      assert.ok(
        d.provenance === "public" || d.provenance === "simulated",
        `${d.key} 的 provenance 缺失或非法——展示时会被当成真实资料`,
      );
    }
  });

  it("未配置 dataset id 时明确报错，不静默查空", async () => {
    const client = createRagClient({ baseUrl: "http://x", apiKey: "k", datasetIds: {} });
    await assert.rejects(() => client.retrieve({ dataset: "vehicle-manuals", query: "q", agent: "ownership" }));
  });
});

describe("出处是结果的一部分（F-16-09）", () => {
  const withResponse = (chunks: unknown[]) => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { chunks } }), { status: 200 })) as typeof fetch;
    return () => {
      globalThis.fetch = orig;
    };
  };

  it("**丢弃没有出处的 chunk**——带不出处的引用等于编造", async () => {
    const restore = withResponse([
      { content: "有出处的内容", document_keyword: "说明书.pdf", similarity: 0.9 },
      { content: "没出处的内容", similarity: 0.95 },
    ]);
    try {
      const client = createRagClient({
        baseUrl: "http://x",
        apiKey: "k",
        datasetIds: { "vehicle-manuals": "d1" },
      });
      const r = await client.retrieve({ dataset: "vehicle-manuals", query: "q", agent: "ownership" });
      assert.equal(r.length, 1);
      assert.equal(r[0].source.document, "说明书.pdf");
    } finally {
      restore();
    }
  });

  it("空内容的 chunk 也被丢弃", async () => {
    const restore = withResponse([{ content: "   ", document_keyword: "x.pdf", similarity: 0.9 }]);
    try {
      const client = createRagClient({ baseUrl: "http://x", apiKey: "k", datasetIds: { "repair-kb": "d" } });
      assert.equal((await client.retrieve({ dataset: "repair-kb", query: "q", agent: "service" })).length, 0);
    } finally {
      restore();
    }
  });
});

describe("切分质量检查（M8-06，托管式 RAG 的必要对冲）", () => {
  it("**表格被拦腰截断会被挑出来**——说明书里最有价值的内容最容易被切坏", () => {
    const s = suspiciousChunks([
      { index: 0, content: "| 里程 | 项目 |\n| 1万 | 机油 |", looksTabular: true },
      { index: 1, content: "| 2万 | 机油+滤芯 |", looksTabular: true },
    ]);
    assert.ok(s.some((x) => x.index === 1 && x.why.includes("拦腰截断")));
  });

  it("过短的 chunk 被挑出——命中后也支撑不了回答", () => {
    const s = suspiciousChunks([{ index: 0, content: "见下表", looksTabular: false }]);
    assert.ok(s.some((x) => x.why.includes("过短")));
  });

  it("正常段落不被误报", () => {
    const s = suspiciousChunks([
      {
        index: 0,
        content: "锂离子电池在低温环境下，电解液粘度上升导致离子迁移速率下降，可用容量因此降低。这是可逆的物理现象。",
        looksTabular: false,
      },
    ]);
    assert.deepEqual(s, []);
  });
});

describe("检索测试（苏未判定「传成功了」的真正标准）", () => {
  it("零命中不是错误，是信息——说明这个问题当前知识库答不了", () => {
    const r = summarizeRetrievalTest("冬天续航", []);
    assert.equal(r.empty, true);
    assert.deepEqual(r.hits, []);
  });

  it("命中带出处与摘要，能直接判断切得对不对", () => {
    const r = summarizeRetrievalTest("保养周期", [
      { content: "每 1 万公里更换机油".repeat(20), source: { document: "手册.pdf", location: "第 12 页" }, score: 0.88 },
    ]);
    assert.equal(r.empty, false);
    assert.equal(r.hits[0].document, "手册.pdf");
    assert.equal(r.hits[0].location, "第 12 页");
    assert.ok(r.hits[0].excerpt.length <= 120);
  });
});

describe("车型限定（F-23-07）——多车型同库时的必需品", () => {
  it("认得出各种写法的同一款车", () => {
    // 文档名的写法五花八门，两边都归一化后再比。
    assert.ok(documentMatchesModel("Model3_车主手册.pdf", "Model 3"));
    assert.ok(documentMatchesModel("Model3_保养.pdf", "model3"));
    assert.ok(documentMatchesModel("tesla_m3_选配.md", "Model 3"));
    assert.ok(documentMatchesModel("ModelY_车主手册.pdf", "Model Y"));
    assert.ok(documentMatchesModel("tesla_my_选配.md", "ModelY"));
    assert.ok(documentMatchesModel("Cybertruck_Owners_Manual.pdf", "Cybertruck"));
    assert.ok(documentMatchesModel("tesla_ct_选配.md", "cybertruck"));
    assert.ok(documentMatchesModel("2017雪佛兰全新迈锐宝用户手册.pdf", "迈锐宝"));
  });

  it("**不把别的车型算进来**——这是整条限定存在的理由", () => {
    // 特斯拉车主问续航却拿到迈锐宝的手册，且带着出处，
    // 是这个项目最要防的形态：看起来对、有引用、说的是另一辆车。
    assert.ok(!documentMatchesModel("2017雪佛兰全新迈锐宝用户手册.pdf", "Model 3"));
    assert.ok(!documentMatchesModel("Model3_车主手册.pdf", "Model Y"));
    assert.ok(!documentMatchesModel("ModelY_保养.pdf", "Cybertruck"));
    assert.ok(!documentMatchesModel("ModelS_车主手册.pdf", "Model 3"));
    assert.ok(!documentMatchesModel("ModelX_保养.pdf", "Model Y"));
  });

  it("两字符简写不误伤——`m3` 不该命中 `OM000G542`", () => {
    // 短简写太容易在无关文件名里撞上，所以要求前后不是字母数字。
    assert.ok(!documentMatchesModel("OM000G542_manual.pdf", "Model 3"));
    assert.ok(!documentMatchesModel("m30_spec.pdf", "Model 3"));
  });

  it("**限定不到任何文档时抛错，绝不退回全库**", async () => {
    const client = createRagClient({
      baseUrl: "http://x",
      apiKey: "k",
      datasetIds: { "vehicle-manuals": "1" },
    });
    // listDocuments 会失败（假 baseUrl），但重点是它**不会**变成一次无限定检索。
    await assert.rejects(() =>
      client.retrieve({
        dataset: "vehicle-manuals",
        query: "续航",
        agent: "ownership",
        vehicleModel: "不存在的车型",
      }),
    );
  });
});

describe("切分方法按文件类型选（踩过两次的坑）", () => {
  it("PDF/docx 用 manual，其余用 naive", () => {
    // manual 只吃 pdf/docx，table 只吃 excel/text/csv——选错解析必然失败，
    // 且要等几分钟才在文档状态里显示出来。
    // 两次都是先失败再补救才发现的：PDF 撞上 table、markdown 撞上 manual。
    assert.equal(chunkMethodFor("Model3_车主手册.pdf"), "manual");
    assert.equal(chunkMethodFor("A.DOCX"), "manual");
    assert.equal(chunkMethodFor("tesla_m3_选配.md"), "naive");
    assert.equal(chunkMethodFor("notes.txt"), "naive");
    assert.equal(chunkMethodFor("无扩展名"), "naive");
  });
});

describe("多列版面被逐行串读（真实踩到的切坏形态）", () => {
  // 迈锐宝用户手册 0-2 页是三列排版。RAGFlow 未开版面识别时按行抽取，
  // 三列的半句交替出现——**每行本身通顺、关键词也在**，
  // 所以检索照样命中、照样给出处，只是拼起来讲的不是一件事。
  const interleaved = [
    "引言",
    "的自录供您查找具体信息的位置",
    "操作车辆时应该注意的事项。忽视",
    "本车集先进技术、安全性、环保及",
    "该信息可能会导致错误的操作",
    "方向性数据，如左右前后，均以",
    "经济性于一体",
    "行驶方向为准",
    "本手册中所描述的某些功能配置",
    "要的信息，让您安全有效地驾驶您的",
    "车辆上有一些零部件和标签会使用符",
    "并不是所有车型都配备，根据车",
  ].join("\n");

  const normal = [
    "本车集先进技术、安全性、环保及经济性于一体。",
    "本《用户手册》为您提供了所有必要的信息，让您安全有效地驾驶您的爱车。",
    "本手册包括截止至该手册印刷时的最新信息。",
    "请通读本手册，了解车辆的特点和操控方法。",
    "请确保您的乘客了解对车辆的不恰当操作可能带来事故和伤害的风险。",
    "除在本手册中有明确说明拆装步骤的零部件外，用户不得自行对车辆进行改装、调整和拆卸。",
    "请将本手册放置在您的汽车内，以便您无论何时需要均能找到。",
    "如果您要转卖汽车，请将本手册随车交给新买主，以便新买主需要时使用。",
  ].join("\n");

  it("**抓得出串读**——这一条原来一条都没抓到", () => {
    assert.ok(longestUnterminatedRun(interleaved) >= 8, `实际 ${longestUnterminatedRun(interleaved)}`);
    const flags = suspiciousChunks([{ index: 0, content: interleaved, looksTabular: false }]);
    assert.ok(flags.some((f) => f.why.includes("逐行串读")));
  });

  it("**正常正文不误报**——刷屏的检查等于没有检查", () => {
    assert.ok(longestUnterminatedRun(normal) < 8, `实际 ${longestUnterminatedRun(normal)}`);
    assert.equal(
      suspiciousChunks([{ index: 0, content: normal, looksTabular: false }]).filter((f) =>
        f.why.includes("逐行串读"),
      ).length,
      0,
    );
  });

  it("目录与短行不误报——它们本来就不该有句末标点", () => {
    const toc = ["引言..", "0-1", "座椅和保护装置.", "2-1", "储物....", "3-1", "仪表和控制装置", "4-1"].join("\n");
    // 断"低于阈值"而不是"恰好 0"：函数的契约是"最长连续未收尾行数"，
    // 目录里出现一两行无标点条目是正常的。断成 0 是在给实现细节上锁。
    assert.ok(longestUnterminatedRun(toc) < 8, `实际 ${longestUnterminatedRun(toc)}`);
  });

  it("表格不走这条检查——`looksTabular` 的另有专门判据", () => {
    const table = Array.from({ length: 12 }, (_, i) => `| 维护操作 ${i} | 6 | 12 | 18 |`).join("\n");
    assert.equal(
      suspiciousChunks([{ index: 0, content: table, looksTabular: true }]).filter((f) =>
        f.why.includes("逐行串读"),
      ).length,
      0,
    );
  });
});

describe("表格识别必须认 HTML 标记（误报是实实在在的代价）", () => {
  it("RAGFlow 的 `<table>` 产物算表格", () => {
    // RAGFlow 把识别出的表格转成 HTML，不保留 markdown 的竖线。
    // 只认竖线的话，一份 markdown 表格文档进了 RAGFlow 就变成"不是表格"。
    const html = "<table><thead><tr><th>代码</th><th>名称</th></tr></thead><tbody><tr><td>$MDL3</td><td>Model 3</td></tr></tbody></table>";
    assert.ok(looksTabular(html));
  });

  it("**表格不触发串读检查**——实测三份选配数据曾 20/20 块全被标红", () => {
    // 表格每行本来就不带句末标点。在表格上跑串读检查必然大面积误报，
    // 而一屏红字里没人找得到真正该看的那一条。
    const rows = Array.from({ length: 15 }, (_, i) =>
      `<tr><td>$OPT${i}</td><td>选装项目 ${i}</td><td>12000</td></tr>`,
    ).join("\n");
    // 即使调用方把 looksTabular 传成 false（旧数据算的），也不该误报。
    const flags = suspiciousChunks([{ index: 0, content: rows, looksTabular: false }]);
    assert.equal(flags.filter((f) => f.why.includes("逐行串读")).length, 0);
  });

  it("普通正文仍判为非表格", () => {
    assert.ok(!looksTabular("本车集先进技术、安全性、环保及经济性于一体。\n请通读本手册。"));
  });
});

describe("MinerU 产物清洗（清噪声不改内容）", () => {
  it("剥掉上下标标签但保留文字", () => {
    // MinerU 把小字号标点识别成上下标：本车集先进技术<sub>、</sub>安全性
    assert.equal(
      cleanMineruMarkdown("本车集先进技术<sub>、</sub>安全性<sub>。</sub>"),
      "本车集先进技术、安全性。",
    );
    assert.equal(cleanMineruMarkdown("<sup>•</sup> 方向性数据"), "• 方向性数据");
  });

  it("去掉图片引用——只喂文本给 RAGFlow，留着就是死链", () => {
    // 图片换成换行而不是删空：直接删会让"看图"和"说明"粘成"看图说明"，
    // 凭空造出一个原文没有的词。
    assert.equal(cleanMineruMarkdown("看图 ![](images/a1b2.jpg) 说明"), "看图\n说明");
  });

  it("**只压缩中文之间的空格**——英文数字之间的空格是有意义的", () => {
    // MinerU 会在词内插空格（"用 户手册"）。一律去掉会把 Model 3 变成 Model3，
    // 而车型名正好是车型限定检索要匹配的东西。
    assert.equal(cleanMineruMarkdown("本 《用 户手册》"), "本《用户手册》");
    assert.equal(cleanMineruMarkdown("Model 3 的续航"), "Model 3 的续航");
    assert.equal(cleanMineruMarkdown("充电 80 % 需要"), "充电 80 % 需要");
  });

  it("合并多余空行，但保留段落分隔", () => {
    assert.equal(cleanMineruMarkdown("段一\n\n\n\n段二"), "段一\n\n段二");
  });
});

describe("目录不参与串读检查（转换后剩下的 10 段全是它）", () => {
  const toc = [
    "引言 . 0- 1", "钥匙车门和车窗 1 - 1", "座椅和保护装置 2- 1",
    "储物 . . 3- 1", "仪表和控制装置 4- 1", "照明 5- 1",
    "信息娱乐系统 6- 1", "温度控制 . 7- 1", "驾驶和操作 8-1",
  ].join("\n");

  it("认得出目录", () => {
    assert.ok(looksLikeToc(toc));
  });

  it("目录不触发串读告警——它天然没有句末标点", () => {
    assert.equal(
      suspiciousChunks([{ index: 0, content: toc, looksTabular: false }]).filter((f) =>
        f.why.includes("逐行串读"),
      ).length,
      0,
    );
  });

  it("**正文不被误判成目录**——否则真串读会被放过", () => {
    const body = [
      "本车集先进技术、安全性、环保及经济性于一体。",
      "本《用户手册》为您提供了所有必要的信息。",
      "请通读本手册，了解车辆的特点和操控方法。",
      "请将本手册放置在您的汽车内，以便随时取用。",
    ].join("\n");
    assert.ok(!looksLikeToc(body));
  });
});

describe("列表与标题不算「未收尾」（转换后误报的真实来源）", () => {
  it("保养手册的项目符号列表不触发串读告警", () => {
    // 取自 repair-kb/保修及保养手册 块 #39 的真实内容。
    // `z` 是项目符号被 OCR 成的字形；每一项都是完整的一项，只是没有句号。
    const bullets = [
      "z 往复短距离行驶z 经常在交通拥堵的市内道路上行驶",
      "z 过度空转或长期低速长途行驶",
      "z 持续高速行驶时间过长",
      "z 在多沙或多尘的路面上行驶",
      "z 经常在丘陵或多山地带行驶",
      "z 经常在低温条件下行驶",
      "z 经常在气温高于 32°C 的条件下行驶",
      "z 经常牵引挂车或负载行驶",
      "z 经常在扬尘或多沙地区行驶",
    ].join("\n");
    assert.equal(longestUnterminatedRun(bullets), 0);
  });

  it("规格表的标题串不触发（Cybertruck_Specifications 块 #12）", () => {
    const spec = ["## Motor Type", "Cyberbeast", "## Long Range", "## Transmission", "## Drivetrain"].join("\n");
    assert.ok(longestUnterminatedRun(spec) < UNTERMINATED_RUN_THRESHOLD);
  });

  it("**混进小标题的真串读仍然要报**——跳过不等于重置", () => {
    // 若把标题当成"收尾"去重置计数，下面这段会被切成 4+4 两半而双双低于阈值。
    const lines = [
      ...Array.from({ length: 4 }, (_, i) => `本车集先进技术安全性环保及经济性于一体第${i}片`),
      "## 使用本手册",
      ...Array.from({ length: 4 }, (_, i) => `请通读本手册因为其中的信息可让您了解如何操控第${i}片`),
    ].join("\n");
    assert.ok(longestUnterminatedRun(lines) >= UNTERMINATED_RUN_THRESHOLD);
  });
});

describe("表格看数据行与表头，不看换行数（MinerU 把整张表挤成一行）", () => {
  const bigTable =
    "<table>" +
    Array.from({ length: 12 }, (_, i) => `<tr><td>项目${i}</td><td>数值${i}</td></tr>`).join("") +
    "</table>";

  it("整张表挤在一行 → 行数按 <tr> 算", () => {
    assert.equal(bigTable.split("\n").length, 1);
    assert.equal(tableDataRowCount(bigTable), 12);
  });

  it("**完好的单行表不再报「拦腰截断」**——这条曾造成 36/38 误报", () => {
    assert.deepEqual(
      suspiciousChunks([{ index: 0, content: bigTable, looksTabular: true }]).filter((f) =>
        f.why.includes("拦腰截断"),
      ),
      [],
    );
  });

  it("**表头 + 一行数据是正常分块**——RAGFlow 切大表时会给每块补表头", () => {
    // 取自 car-catalog/tesla_ct_选配.md 块 #2 的真实形状。
    // 按行数判会把 9/20 块正常分块判成截断。
    const withHeader =
      "<table>\n<thead>\n<tr>\n<th>代码</th>\n<th>名称</th>\n<th>价格 (USD)</th>\n</tr>\n</thead>\n" +
      "<tbody>\n<tr>\n<td>$MTY02</td>\n<td>后轮驱动</td>\n<td>0</td>\n</tr>\n</tbody>\n</table>";
    assert.ok(hasTableHeader(withHeader));
    assert.equal(tableDataRowCount(withHeader), 1);
    assert.deepEqual(
      suspiciousChunks([{ index: 0, content: withHeader, looksTabular: true }]).filter((f) =>
        f.why.includes("拦腰截断"),
      ),
      [],
    );
  });

  it("**没有表头的单行仍然要报**——读不出这个数是什么", () => {
    const fragment = "<table><tr><td>整备质量</td><td>1752 kg</td></tr>";
    assert.ok(
      suspiciousChunks([{ index: 0, content: fragment, looksTabular: true }]).some((f) =>
        f.why.includes("拦腰截断"),
      ),
    );
  });

  it("**只剩表头也要报**——一行数据都没有的块检索命中了也没用", () => {
    const headerOnly = "<table><thead><tr><th>代码</th><th>名称</th></tr></thead></table>";
    assert.equal(tableDataRowCount(headerOnly), 0);
    assert.ok(
      suspiciousChunks([{ index: 0, content: headerOnly, looksTabular: true }]).some((f) =>
        f.why.includes("没有数据行"),
      ),
    );
  });

  it("markdown 管道表：表头行与分隔行都不算数据", () => {
    const md = ["| 项目 | 值 |", "| --- | --- |", "| 轴距 | 2875 |", "| 电池 | 75 kWh |"].join("\n");
    assert.equal(tableDataRowCount(md), 2);
    assert.ok(hasTableHeader(md));
  });
});

describe("图例编号的各种写法都不算「未收尾」", () => {
  it("全角句号与无空格编号（Model3_车主手册 块 #33 的真实形状）", () => {
    const legend = [
      "1．开门按钮(从车内打开车门页码24)",
      "2.盲点警报灯 (盲点警报灯页码109)",
      "3.转向控制杆（如果配备）） (车灯页码66)",
      "4.车窗控制按钮 (车窗页码28)",
      "5.后视镜调节 (后视镜页码30)",
      "6.座椅加热开关 (前排座椅页码34)",
      "7.方向盘调节杆 (方向盘页码58)",
      "8.驻车制动开关 (驻车制动页码72)",
      "9.充电口开启 (充电页码160)",
    ].join("\n");
    assert.equal(longestUnterminatedRun(legend), 0);
  });

  it("**小数开头的正文行不会被当成列表放过**——那才是真该报的", () => {
    // `2.5 米` 若被当成编号跳过，一整段真串读就会被静默吞掉。
    const body = Array.from({ length: 10 }, (_, i) => `${i}.5 米的车身长度带来更从容的后排腿部空间与`).join("\n");
    assert.ok(longestUnterminatedRun(body) >= UNTERMINATED_RUN_THRESHOLD);
  });
});

describe("切片预处理：让块自己说清「我在哪一节」", () => {
  const md = [
    "# 座椅和保护装置",
    "## 前排座椅",
    "### 座椅调节",
    "按住按钮 3 秒，直到指示灯闪烁。",
    "调节完成后松开按钮即可。",
  ].join("\n\n");

  it("**每个单元都带面包屑**——`按住按钮 3 秒` 单看是废话", () => {
    const out = prepareMarkdownForChunking(md, { title: "迈锐宝用户手册" });
    assert.match(out, /> 迈锐宝用户手册 › 座椅和保护装置 › 前排座椅 › 座椅调节/);
    assert.match(out, /按住按钮 3 秒/);
  });

  it("**一串小标题不会切出一堆只有标题的块**——那种块命中率高而信息量为零", () => {
    const headings = Array.from({ length: 8 }, (_, i) => `## 第 ${i} 节`).join("\n\n");
    const units = prepareMarkdownForChunking(headings, { title: "手册" }).split(/\n\n(?=> )/);
    assert.equal(units.length, 1, "攒不够 minTokens 不该断开");
  });

  it("过长的段落按句末标点切开，**不从句子中间截断**", () => {
    const long = Array.from({ length: 60 }, (_, i) => `这是第${i}句话，讲的是一件完整的事情。`).join("");
    const pieces = splitLongText(long, 200, 30);
    assert.ok(pieces.length > 1);
    for (const p of pieces) assert.match(p, /。$/, "每一片都该停在句号上");
  });

  it("**切开处留重叠**——边界上那句话两侧各留一份", () => {
    const long = Array.from({ length: 60 }, (_, i) => `这是第${i}句话，讲的是一件完整的事情。`).join("");
    const pieces = splitLongText(long, 200, 60);
    const tail = pieces[0].slice(-14);
    assert.ok(pieces[1].includes(tail), "第二片开头应含第一片结尾的句子");
  });

  it("**表格整块不切**——半张表检索命中就是误导，因为它看起来是完整答案", () => {
    const table =
      "<table>" +
      Array.from({ length: 40 }, (_, i) => `<tr><td>项目${i}</td><td>数值${i}</td></tr>`).join("") +
      "</table>";
    const out = prepareMarkdownForChunking(`## 参数\n\n${table}`, { title: "参数规格", targetTokens: 100 });
    assert.equal((out.match(/<table>/g) ?? []).length, 1);
    assert.equal((out.match(/<\/table>/g) ?? []).length, 1);
    // 整张表连续出现，中间没被塞进面包屑。
    assert.ok(/<table>[\s\S]*?<\/table>/.test(out));
    assert.ok(!/<table>[\s\S]*?› [\s\S]*?<\/table>/.test(out), "面包屑不该出现在表格内部");
  });

  it("整段超长又切不动的单句原样保留，不硬切", () => {
    const oneSentence = "这是一句没有任何标点的超长内容".repeat(40);
    const pieces = splitLongText(oneSentence, 100, 15);
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0], oneSentence);
  });

  it("token 估计对中英文都在量级上（只用来判合并/切开，不追求准）", () => {
    assert.ok(Math.abs(estimateTokens("一二三四五六七八九十") - 10) <= 1);
    assert.ok(estimateTokens("one two three four five") >= 5);
  });
});

describe("MinerU 的页眉会变成重复标题", () => {
  it("**相邻重复标题只留一个**——两行标题会把空单元撑过 minTokens", () => {
    const out = prepareMarkdownForChunking("## 引言\n\n## 引言\n\n正文内容在这里。", { title: "手册" });
    assert.equal((out.match(/## 引言/g) ?? []).length, 1);
  });

  it("不相邻的同名标题各自保留——那是文档里真的出现了两次", () => {
    const out = prepareMarkdownForChunking(
      "## 警告\n\n第一处正文。\n\n## 操作\n\n第二处正文。\n\n## 警告\n\n第三处正文。",
      { title: "手册", minTokens: 1 },
    );
    assert.equal((out.match(/## 警告/g) ?? []).length, 2);
  });
});

describe("小表摊成文本（RAGFlow 在 <table> 边界切块，面包屑落在表外被丢掉）", () => {
  it("两列表摊成 `键：值`，逐格搬运不推断", () => {
    const t = "<table><tr><td>GVWR</td><td>3,948 kg</td></tr><tr><td>Wheelbase</td><td>3,124 mm</td></tr></table>";
    assert.equal(tableToText(t), "GVWR：3,948 kg\nWheelbase：3,124 mm");
  });

  it("三列以上保留分隔，不硬塞成键值", () => {
    const t = "<table><tr><th>代码</th><th>名称</th><th>价格</th></tr><tr><td>$MT</td><td>后驱</td><td>0</td></tr></table>";
    assert.equal(tableToText(t), "代码 | 名称 | 价格\n$MT | 后驱 | 0");
  });

  it("**空表被丢掉**——MinerU 把版面分隔框识别成表格，一个字都没有", () => {
    const empty = "<table><tr><td></td><td></td></tr><tr><td></td><td></td></tr></table>";
    assert.equal(tableToText(empty), "");
    const out = prepareMarkdownForChunking(`## 参数\n\n${empty}\n\n正常的一段正文。`, { title: "手册" });
    assert.ok(!out.includes("<table"));
    assert.match(out, /正常的一段正文/);
  });

  it("**摊平后的小表带上了面包屑**——这正是它此前缺的", () => {
    const t = "<table><tr><td>GVWR</td><td>3,948 kg</td></tr></table>";
    const out = prepareMarkdownForChunking(`## 整车参数\n\n${t}`, { title: "Cybertruck 参数规格" });
    assert.match(out, /> Cybertruck 参数规格 › 整车参数/);
    assert.match(out, /GVWR：3,948 kg/);
  });

  it("**大表仍保持表格形态**——行列对齐本身是信息，摊平会丢", () => {
    const big =
      "<table>" +
      Array.from({ length: 40 }, (_, i) => `<tr><td>项目名称${i}</td><td>数值${i}</td><td>单位${i}</td></tr>`).join("") +
      "</table>";
    const out = prepareMarkdownForChunking(`## 参数\n\n${big}`, { title: "参数规格" });
    assert.ok(out.includes("<table"));
  });
});

describe("摊平的表格块不报串读（修表格上下文的动作造出的新误报）", () => {
  const spec = [
    "GVWR：3,948 kg", "Wheelbase：3,124 mm", "Curb Weight：3,104 kg",
    "Length：5,682 mm", "Width：2,413 mm", "Height：1,791 mm",
    "Ground Clearance：437 mm", "Payload：1,133 kg", "Towing：4,990 kg",
  ].join("\n");

  it("`键：值` 整块被认出来", () => {
    assert.ok(looksFlattenedTable(spec));
    assert.equal(
      suspiciousChunks([{ index: 0, content: spec, looksTabular: false }])
        .filter((f) => f.why.includes("逐行串读")).length,
      0,
    );
  });

  it("`A | B | C` 整块同样", () => {
    const rows = Array.from({ length: 9 }, (_, i) => `$MT0${i} | 选装项目${i} | ${i}000`).join("\n");
    assert.ok(looksFlattenedTable(rows));
  });

  it("**判断在块级不在行级**：正文里少数冒号行不能让整块免检", () => {
    // 逐行判断会把 `注意：请勿…` 当成键值行放过——而那是串读里最常见的一类。
    // 真实的串读块里冒号行只是少数，摊平的表格则是整块都长那样。
    const mixed = [
      "注意：请勿在车辆行驶过程中调节座椅位置",
      "本车集先进技术安全性环保及经济性于一体而其中",
      "请通读本手册因为其中的信息可让您了解如何正确",
      "操控汽车并从中获得最大程度的驾乘享受另外还有",
      "警告：安全带必须正确佩戴否则在碰撞中无法提供",
      "保护本车配备的主动安全系统包括车道保持辅助与",
      "自适应巡航控制两者在特定条件下会自动介入但不",
      "能替代驾驶员对车辆的持续注意与控制请务必保持",
      "双手握住方向盘并随时准备接管车辆的横向与纵向",
    ].join("\n");
    assert.ok(!looksFlattenedTable(mixed), "冒号行只有 2/9，不该当成表格");
    assert.ok(longestUnterminatedRun(mixed) >= UNTERMINATED_RUN_THRESHOLD);
  });

  it("行数太少不下结论——两三行看不出是不是表格", () => {
    assert.ok(!looksFlattenedTable("GVWR：3,948 kg\nWheelbase：3,124 mm"));
  });
});

describe("摊平后的表格不是碎片（tableDataRowCount 的回退分支）", () => {
  it("**没有 <tr> 也没有 `|` 起头的行时按行数算**，不是 0", () => {
    // 取自 car-catalog/tesla_ct_选配.md 块 #1 的真实形状：306 token、内容完好。
    // 回退分支写错时它被判成"只剩表头，没有数据行"。
    const flat = [
      "代码 | 名称 | 价格 (USD)",
      "$DV2W | Rear-Wheel Drive | 标配/含",
      "$DV4W | Dual Motor All-Wheel Drive | 标配/含",
      "$FS00 | Foundation Series | 标配/含",
    ].join("\n");
    assert.equal(tableDataRowCount(flat), 4);
    assert.equal(
      suspiciousChunks([{ index: 0, content: flat, looksTabular: true }])
        .filter((f) => f.why.includes("拦腰截断")).length,
      0,
    );
  });
});
