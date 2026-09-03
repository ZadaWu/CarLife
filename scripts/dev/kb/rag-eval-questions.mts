/**
 * 检索评测集：按 `内部文档` 的画像拟题（施工单 M8-01 补）。
 *
 * # 每题为什么长这样
 *
 * 题目**不是凭想象写的**——先按画像的痛点起草，再回 `data/kb-md/` 逐条验证
 * 语料里确实答得出来，答不出来的换掉（"制动片检查周期"就是这么被换掉的：
 * 迈锐宝保养手册里根本没有"制动片"这个词）。
 *
 * `mustContain` 里的数字全部来自语料原文，不是我记忆里的参数：
 * 迈锐宝机油 `每5,000公里或6个月`、ModelY 换位 `每 10,000 公里`、
 * Cybertruck 拖挂 `11,000 lb(4,990 kg)`。**用记忆里的参数当判据，
 * 等于用一个没验证过的答案去判另一个答案。**
 *
 * # 判据分两层
 *
 * - `expectDoc`：命中的出处**必须是这一款车的这本手册**。跨车型的出处
 *   带着引用出现，比没有出处更危险（F-23-07）。
 * - `mustContain`：召回的内容里要出现这些词，否则"命中了正确文档"也只是
 *   碰巧撞上文件名——**文档对不等于段落对**。
 */

import type { DatasetKey } from "../../../enterprise/backend/shared/rag/src/index";

export interface EvalQuestion {
  id: string;
  /** 出自哪个画像，以及他为什么会这么问。 */
  persona: string;
  scenario: string;
  query: string;
  dataset: DatasetKey;
  agent: string;
  /** 车型限定（F-23-07）。留空表示这一题不限定。 */
  vehicleModel?: string;
  /** 出处必须匹配的文档名。 */
  expectDoc: RegExp;
  /** 召回内容里必须出现的词（任一即可算一次覆盖），取自语料原文。 */
  mustContain: string[];
}

export const QUESTIONS: readonly EvalQuestion[] = [
  // ── vehicle-manuals：「这个功能怎么用」 ──
  {
    id: "Q1",
    persona: "P-01 林向东",
    scenario: "午休刷到「冬天电车续航暴跌」的推送，语音随口问一句。他要的不是原理科普。",
    query: "冬天出发前能不能让车先预热一下，怎么设置？",
    dataset: "vehicle-manuals",
    agent: "ownership",
    vehicleModel: "Model Y",
    expectDoc: /ModelY_车主手册/,
    mustContain: ["预热", "预调节", "出发时间", "空调"],
  },
  {
    id: "Q2",
    persona: "P-02 陈书雅",
    scenario: "双手在方向盘上、眼睛必须在路面上。任何需要看屏幕两秒以上的交互都是设计失败。",
    query: "开车时不用手怎么调空调温度？有哪些语音命令？",
    dataset: "vehicle-manuals",
    agent: "ownership",
    vehicleModel: "Model 3",
    expectDoc: /Model3_车主手册/,
    mustContain: ["语音命令", "空调", "温度"],
  },
  {
    id: "Q3",
    persona: "P-04 高鹏",
    scenario: "高里程务实车主，胎压灯亮了要的是「到底多少算正常、怎么自己量」。",
    query: "胎压警告灯亮了，标准胎压是多少，怎么检查？",
    dataset: "vehicle-manuals",
    agent: "ownership",
    vehicleModel: "迈锐宝",
    expectDoc: /迈锐宝用户手册/,
    mustContain: ["胎压", "冷胎", "轮胎气压"],
  },
  {
    id: "Q4",
    persona: "P-05 周慧珍与林小满",
    scenario: "长途带老人小孩。「顾家」是他判断这产品好不好用的真实标准。",
    query: "儿童安全座椅怎么固定在后排？",
    dataset: "vehicle-manuals",
    agent: "ownership",
    vehicleModel: "迈锐宝",
    expectDoc: /迈锐宝用户手册/,
    mustContain: ["LATCH", "儿童约束", "固定"],
  },

  // ── repair-kb：「出问题了怎么办 / 什么时候该保养」 ──
  {
    id: "Q5",
    persona: "P-04 高鹏",
    scenario: "保养记录散落在微信和纸质单据里，他要一个确定的周期。",
    query: "机油和机油滤清器多久换一次？",
    dataset: "repair-kb",
    agent: "service",
    vehicleModel: "迈锐宝",
    expectDoc: /迈锐宝保修及保养手册/,
    mustContain: ["5,000公里", "6个月", "机油滤清器"],
  },
  {
    id: "Q6",
    persona: "P-01 林向东",
    scenario: "保养到期他不想自己记——「知道这辆车的状况是被人盯着的」。",
    query: "轮胎多久需要换位一次？",
    dataset: "repair-kb",
    agent: "service",
    vehicleModel: "Model Y",
    expectDoc: /ModelY_保养/,
    mustContain: ["10,000 公里", "换位", "胎纹"],
  },
  {
    id: "Q7",
    persona: "P-04 高鹏",
    scenario: "「4S 店说什么就是什么，他没有依据反驳」——保修范围是他要的依据。",
    query: "新车整车保修包括哪些，有什么是不保的？",
    dataset: "repair-kb",
    agent: "service",
    vehicleModel: "迈锐宝",
    expectDoc: /迈锐宝保修及保养手册/,
    mustContain: ["整车有限保证", "不属于", "保证范围"],
  },
  {
    id: "Q8",
    persona: "P-04 高鹏",
    scenario: "「就是有个声音，咔哒咔哒」——他不会描述症状，系统得能接住口语并给检查项。",
    query: "制动系统需要定期检查什么？制动液要换吗？",
    dataset: "repair-kb",
    agent: "service",
    vehicleModel: "迈锐宝",
    expectDoc: /迈锐宝保修及保养手册/,
    mustContain: ["制动液", "制动系统", "检查"],
  },

  // ── car-catalog：「买哪款」 ──
  {
    id: "Q9",
    persona: "P-03 郑明",
    scenario: "首次购车，参数看得懂但连不起来。购车顾问是唯一不能依赖⑥用车数据的 Agent。",
    query: "Cybertruck 最大能拖多重？载重是多少？",
    dataset: "car-catalog",
    agent: "buying",
    vehicleModel: "Cybertruck",
    expectDoc: /Cybertruck_Specifications/,
    mustContain: ["11,000 lb", "4,990 kg", "Payload", "Towing"],
  },
  {
    id: "Q10",
    persona: "P-03 郑明",
    scenario: "「所有 App 都在推荐，没有一个告诉他推荐逻辑」——他要看到可核对的配置差异。",
    query: "这款车有哪些配置版本可以选，各自差在哪？",
    dataset: "car-catalog",
    agent: "buying",
    vehicleModel: "迈锐宝",
    // 这份原名 `2017_车型手册与配置参数.md`，**名字里没有车型**，
    // 于是限定"迈锐宝"时被过滤成零文档，报"数据集里没有迈锐宝的资料"——
    // 而那是假的。已改名，probe:ragflow 也加了一条隐形文档检查。
    expectDoc: /迈锐宝车型手册与配置参数/,
    mustContain: ["LT", "Premier", "配置"],
  },
];
