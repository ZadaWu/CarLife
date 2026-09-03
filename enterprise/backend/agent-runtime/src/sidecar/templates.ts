/**
 * L0 轨迹模板 —— 事件到人话的纯查表（施工单 M18-03，F-45-04）。
 *
 * # 零 LLM 是硬要求，不是省钱
 *
 * 垫场话本身若也要等几秒才出声就毫无意义（US-45 非功能约束：触发 → 出声 < 500ms）。
 * 先跑一次模型再说话，等于**用一次等待去填另一次等待**。
 *
 * # 匹配不到就返回空，**没有兜底话术**
 *
 * 这是本模块唯一真正要守住的东西。"正在为您查询"听起来无害，
 * 但在什么都没发生时说出口就是一句假话——而且是用户完全无法证伪、只会照单全收的假话。
 * 所以这里没有 `default`，没有 `fallback`，匹配不到就是 `undefined`。
 *
 * # 与 F-13-07 的 `BRANCH_NOTE` 同源思路，但不复用同一张表
 *
 * 那张表是给**屏幕**看的短标签（"路线规划开始"），这张是给**耳朵**听的整句。
 * 合成一张的话，两种场景迟早互相迁就成四不像。
 */

import { fillerPhraseAt, type FillerPhase } from "@carlife/shared";

/**
 * 第 1 句的**确定性进度前缀**（施工单 M18-09 约束 4，走查第五轮改成多说法）。
 *
 * # 为什么这半句始终不交给模型
 *
 * 它是一句**进度断言**。交给模型，它就有机会把"已经开始处理"说成"已经查到了"——
 * 那正是本单三轮探针一路在挡的东西，而且是用户完全无法证伪的那一类。
 *
 * 还有一条更硬的理由：**第 1 句是最输不起延迟的一句**。它在静默阈值（1.5 秒）
 * 上触发，而一次生成要 1~2 秒——把开场白交给模型，结果不是"更生动"，
 * 是"更晚"，或者干脆超时回落成一句更土的模板话。
 *
 * # 那怎么解决"说多了很乏味"
 *
 * 走查报的是**重复**，不是"这句话必须由模型来写"。所以改的是**说法的条数**：
 * 每个阶段一组说法，配上一组引子，按会话轮次轮换。
 * 5 个阶段 × 4 种说法 × 5 个引子 = 100 种组合，一次驾驶里撞不上重样。
 *
 * ⚠️ **每一条都必须是同一个断言的不同说法**。写"快查完了"就破功了——
 * 旁路不知道还要多久（同 `FILLER_PHRASE` 的那条纪律，有测试逐词挡着）。
 */
const PROGRESS_PREFIX: Readonly<Record<Phase, readonly string[]>> = Object.freeze({
  understanding: Object.freeze([
    "后台已经开始处理您的需求",
    "您这个问题我们已经接上了",
    "后台正在把您说的拆开看",
    "这事儿后台已经在办了",
  ]),
  routing: Object.freeze([
    "后台已经知道该查哪儿了",
    "该找哪一路后台已经定了",
    "方向后台已经找着了",
    "后台已经挑好从哪儿下手",
  ]),
  profile: Object.freeze([
    "后台正在看您这辆车的档案",
    "您这台车的底子后台正在调",
    "后台在翻您这辆车的记录",
    "车的资料后台已经在看了",
  ]),
  retrieval: Object.freeze([
    "后台正在翻您这车的手册",
    "手册那边后台正在查",
    "后台在资料里找对应那一段",
    "该翻的册子后台已经翻上了",
  ]),
  composing: Object.freeze([
    "后台查完了，正在整理",
    "东西齐了，后台正在归拢",
    "后台把查到的正往一块儿凑",
    "材料到齐了，后台在理顺",
  ]),
});

/**
 * 前缀与闲话之间的引子。**只在本轮第 1 句出现**——每句都念一遍会很怪。
 *
 * 与前缀分开轮换（不同的取模），组合数才是乘出来的而不是加出来的。
 */
const PROGRESS_BRIDGE_POOL: readonly string[] = Object.freeze([
  "，要不我先跟您聊会天：",
  "，这空档我陪您说说话：",
  "，趁这会儿咱们随便聊聊：",
  "，等着的工夫说点别的：",
  "，我先跟您唠两句：",
]);

/** 仅供测试与结构性断言。 */
export function progressTables(): {
  prefix: Readonly<Record<Phase, readonly string[]>>;
  bridges: readonly string[];
} {
  return { prefix: PROGRESS_PREFIX, bridges: PROGRESS_BRIDGE_POOL };
}

/**
 * 取第 `variant` 号说法（0 起，自动回绕）。
 *
 * 回绕在这里是**对的**，与 `FILLER_PHRASE` 的"用完就闭嘴"不一样：
 * 那边循环意味着"转圈说同样的事"，这边每一轮本来就是新的一轮进度断言，
 * 说法回绕只是换了件衣裳。
 */
export function progressPrefix(phase: Phase, variant = 0): string {
  const pool = PROGRESS_PREFIX[phase];
  return pool[Math.abs(variant) % pool.length];
}

export function progressBridge(variant = 0): string {
  // 与前缀错开取模：同为 4 的倍数时两者会同步回绕，组合数塌回 5 种。
  return PROGRESS_BRIDGE_POOL[Math.abs(variant) % PROGRESS_BRIDGE_POOL.length];
}


/**
 * 阶段。同一阶段一轮最多说一次（见 `renderFiller`）。
 *
 * 类型与文案都来自 `@carlife/shared`（M18-07）：控制台要由 `phase` 还原这句话，
 * 两处各写一份的表现是"页面上和耳朵里说法不一样"，而那种不一致没人会当成 bug 报。
 */
export type Phase = FillerPhase;

/**
 * span/trace 名 → 阶段。
 *
 * 每一条都对应 2026-08-13 实测存在的事件（`sess-d91504fc-1b7` / `sess-9c3c3d33-ee8`）：
 * 凭空加一条没人产生的名字，等于给自己留一个永远不触发的分支。
 */
const PHASE_OF: Readonly<Record<string, Phase>> = Object.freeze({
  "acp.session_new": "understanding",
  "llm.supervisor-intent": "understanding",
  "node.understand": "understanding",
  route: "routing",
  "tool.vehicle_profile": "profile",
  "tool.usage_profile": "profile",
  "tool.ragflow_retrieve": "retrieval",
  merge: "composing",
});

/** 仅供测试与 `check:arch` 的结构性断言使用。 */
export function templateTables(): { phases: Readonly<Record<string, Phase>> } {
  return { phases: PHASE_OF };
}

export function phaseOf(name: string | undefined): Phase | undefined {
  if (!name) return undefined;
  return PHASE_OF[name];
}

export interface FillerDraft {
  text: string;
  phase: Phase;
  /** 这是第几句（1 起）。进轨迹 `detail`。 */
  ordinal: number;
  /**
   * 哪一档出的（M18-09）。
   *
   * 控制台只能由 `phase#ordinal` 还原 **L0** 的文本（词表是代码常量）；
   * L1 是模型现生成的，还原不出来——所以这一档必须标出来，
   * 否则页面会拿 L0 的词表去"还原"一句用户从没听过的话，
   * 而排障时会拿着它去对因果。
   */
  source: "l0" | "l1";
}

/**
 * 取最近一条能映射到阶段的信号，渲染出该阶段**还没说过的下一句**。
 *
 * 从后往前找是刻意的：**用户想知道的是"现在"在干什么**，不是这一轮干过什么。
 * 实测那一轮里第 7 秒时最近的信号是 `tool.ragflow_retrieve`——
 * 此刻说"先看看你这辆车的档案"（3 秒前发生的事）就是在描述过去。
 *
 * 同一阶段可以说多句（M18-08）：文案表按阶段给了一组，依次推进。
 * 这不是"重复说同一件事"——第二句描述的仍是同一个阶段，没有引入新断言，
 * 它存在的理由是**最长的那一跳有 3.8 秒，而 span 完成时才落**，
 * 每阶段只有一句时那段空白必然是哑的。
 *
 * 用完这一阶段的全部句子 → `undefined`。调用方据此保持安静。
 * **不循环**：转圈说同样的话比不说更像卡住了。
 */
export function renderFiller(
  signals: ReadonlyArray<{ name?: string }>,
  spoken: ReadonlyMap<Phase, number>,
): FillerDraft | undefined {
  for (let i = signals.length - 1; i >= 0; i -= 1) {
    const phase = phaseOf(signals[i].name);
    if (!phase) continue;
    const used = spoken.get(phase) ?? 0;
    const text = fillerPhraseAt(phase, used);
    // 这一阶段的话说完了：保持安静，**不要回头去找更早的阶段**——
    // 那等于开始描述过去。
    if (!text) return undefined;
    return { text, phase, ordinal: used + 1, source: "l0" };
  }
  return undefined;
}
