/**
 * 能力条的**决策逻辑**（施工单 M85-04）。纯函数，没有 React。
 *
 * # 为什么把它从组件里拆出来
 *
 * 这里有一条要被逐条断言的规则（G1 的界面落点：被抑制的格上零按钮），
 * 以及一条会被反复改的规则（露几个、谁进 `⋯`）。混在 JSX 里的话，
 * 验证它们只能靠渲染快照——而快照对着改一行样式就会红，于是很快被改成"更新快照"。
 */

import {
  capabilitiesFor,
  type Capability,
  type SelectionKind,
  type SelectionScope,
} from "@carlife/research/capabilities";

/**
 * 主区最多露几个主动词，其余进 `⋯`。
 *
 * 产品决策是"一次只露 2–3 个"。取 3：取 2 的话普通格上只露得下
 * 「归纳这一格」「找反例」，而「换个阈值还成立吗」是读这一页时第三常用的动作。
 */
export const RAIL_PRIMARY_MAX = 3;

/** 三层的图标与耗时预期。**图标在按钮内**，不另起一列。 */
export const TIER_ICON: Record<Capability["tier"], string> = {
  lookup: "🔍",
  write: "✎",
  dialog: "💬",
};

export const TIER_HINT: Record<Capability["tier"], string> = {
  lookup: "即点即出，不调模型",
  write: "要跑 10–60 秒，会烧 token",
  dialog: "多轮对话",
};

/**
 * 哪几条能力**已经实现**。
 *
 * ⚠️ 这是一张**前端常量表**，而它本该由后端给。
 *
 * 后端的能力目录（`@carlife/research` 的 `CAPABILITIES`）此刻没有 `status` 字段，
 * 而本单的红线是不改任何后端文件。于是只能在这里维护一份，
 * **每张能力单落地时要回来改这里**（M85-05 加 c2–c5、M85-06 加 c1、
 * M85-07 加 c6/c7、M85-08 加 c8、M89-04 加 c10–c12）。
 *
 * 不靠注释提醒：`console/test/capability-rail.test.ts` 有一条用例，
 * 它读 `research-runtime` 的 `WORKORDER_OF` 与分发分支，与本表对不上就红。
 * 忘了改这里的表现本来是"后端已经实现了，界面上那个按钮还是灰的"——
 * 一个不报错、只是让人觉得"这功能还没做"的故障。
 */
export const IMPLEMENTED: ReadonlySet<string> = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"]);

/**
 * 这条能力在这个范围上**做不到**——注意与"还没做"是两回事。
 *
 * C4 的能力目录把它开在整列上，而分群切分是按主题做的、主题只按需求码切、
 * 不带场景维度；一整列横跨全部需求码，用现有工具答不了。服务端对这种请求
 * 回 400 `scope_not_supported`（M85-05），所以界面上这个按钮必须**按不下去**：
 * 留着它可点，点了就是一个技术错误码，而按钮看起来完全正常。
 *
 * 不从 `capabilitiesFor` 里把 `col` 删掉，是因为那会让整列上一个能力都没有、
 * 落进"什么都不渲染"的分支——读的人于是不知道这一列本该有这条能力，
 * 也不知道它为什么没有。写在这里，那句原因就出现在按钮的 title 上。
 */
const UNSUPPORTED: Readonly<Record<string, Partial<Record<SelectionKind, string>>>> = {
  c4: { col: "整列答不了：分群切分按主题做，而主题只按需求码切、不带场景——请点具体的格或整行" },
};

/** 未实现的能力归哪张单。与 `research-runtime` 的 `WORKORDER_OF` 是同一张表（同上，由测试对账）。 */
export const WORKORDER_OF: Readonly<Record<string, string>> = {
  c1: "M85-06",
  c2: "M85-05",
  c3: "M85-05",
  c4: "M85-05",
  c5: "M85-05",
  c6: "M85-07",
  c7: "M85-07",
  c8: "M85-08",
  c9: "M85-03",
};

export interface RailButton {
  id: string;
  key: string;
  label: string;
  icon: string;
  tier: Capability["tier"];
  disabled: boolean;
  /** 鼠标悬停说明。禁用时点名工单号，启用时说耗时预期。 */
  title: string;
}

export type RailModel =
  | {
      /**
       * G1 的界面落点：被抑制的格与行上**一个按钮都不渲染**。
       *
       * 判据是 `suppressedReason !== null`，**不是"能力列表为空"**。
       * 两者今天恰好等价，但语义不同：列表为空还可能是"这个范围恰好没有适用的能力"，
       * 那种时候该出的是别的话。借用同一句文案会让两种情况在页面上看起来一样。
       */
      kind: "suppressed";
      note: string;
    }
  | { kind: "empty" }
  | { kind: "rail"; primary: RailButton[]; overflow: RailButton[] };

/** 抑制态那句文案。逐字写在这里，组件只渲染。 */
export const SUPPRESSED_NOTE = "样本不足的格没有可用能力";

const buttonOf = (c: Capability, kind: SelectionKind): RailButton => {
  const unsupported = UNSUPPORTED[c.id]?.[kind];
  const done = IMPLEMENTED.has(c.id);
  const title = unsupported ?? (done ? TIER_HINT[c.tier] : `还没做：由施工单 ${WORKORDER_OF[c.id] ?? "待定"} 落地`);
  return {
    id: c.id,
    key: c.key,
    label: c.title,
    icon: TIER_ICON[c.tier],
    tier: c.tier,
    disabled: !done || unsupported !== undefined,
    title,
  };
};

/**
 * 这一刻的能力条长什么样。
 *
 * 未实现的能力**照样渲染，只是按不下去**。三个候选里这是代价最小的：
 * 不渲染的话读的人不知道这一页本该有这些能力；渲染且可点的话，
 * 点完看到的是一个 501 技术错误码。
 */
export function railModel(scope: SelectionScope | null, suppressedReason: string | null): RailModel {
  if (suppressedReason !== null) return { kind: "suppressed", note: SUPPRESSED_NOTE };
  if (!scope) return { kind: "empty" };

  const all = capabilitiesFor(scope);
  if (all.length === 0) return { kind: "empty" };

  /*
   * 排序：能点的排前面。
   *
   * 按目录顺序直出的话，普通格上前三个是 c1 / c2 / c4，**全是禁用的**，
   * 而唯一能点的 c9 还在 `⋯` 里——界面看起来像整条能力条都没做。
   * 这个排序随 `IMPLEMENTED` 自动变：每张单合入后，新实现的那条自己浮上来。
   */
  const buttons = all.map((c) => buttonOf(c, scope.kind));
  const usable = buttons.filter((b) => !b.disabled);
  const rest = buttons.filter((b) => b.disabled);
  const ordered = [...usable, ...rest];

  return {
    kind: "rail",
    primary: ordered.slice(0, RAIL_PRIMARY_MAX),
    overflow: ordered.slice(RAIL_PRIMARY_MAX),
  };
}
