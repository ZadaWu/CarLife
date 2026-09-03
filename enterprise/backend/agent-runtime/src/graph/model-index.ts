/**
 * 车型索引 —— **子图之外的共享事实表**（M19-03 从 `subgraphs/buying.ts` 提出来）。
 *
 * # 为什么不放在子图里
 *
 * 购车与试驾都要用它，而 `check:arch` 的 crosstalk 规则禁止子图互相 import
 * （§11：子 Agent 协作永远经过编排层）。放在这里两边都能引，且不违反那条不变量。
 * 复制成两份的后果是漂移——语料加了新车型只改了一处，另一条路就认不出它。
 */

/**
 * 车型索引。
 *
 * # 为什么需要它
 *
 * `car_catalog` 返回的 chunk 只有原文与文档名。把哪条挂到哪款车上，
 * 是**只有知道当前语料里有哪几款车**才判得了的事——这个知识属于子图，不属于工具。
 *
 * # `energy` / `bodyType` 为什么写在索引里而不是从原文抽
 *
 * 它们是这几款车稳定不变的分类事实（Model 3 不会哪天变成插混），
 * 而从 chunk 里抽会踩到"Model Y 手册里提了一句燃油车对比"这种坑——
 * 抽错的后果是按能源类型淘汰错车，且理由看起来言之凿凿。
 * 语料增加新车型时**这张表要同步扩**，扩不动就意味着那款车不进候选（而不是被瞎猜）。
 */
/**
 * 一个配置（trim）。
 *
 * # 这里**没有价格、没有续航、没有座位**（施工单 M21-01）
 *
 * 那三样跟着 `dealer_pricing` 走（结构化、随语料更新、M19-05 起是价格的权威源）。
 * 在这里再存一份的后果是漂移，而漂移的表现是"顾问报的价和店里报的不一样"——
 * 用户拿着我们的数字去店里对账，对不上的是我们。
 *
 * 所以本表只回答**命名**问题：这个语料里有哪几个配置、用户嘴里那个词指的是哪一个。
 */
export interface TrimEntry {
  /** 规范配置名，**与 `mocks/dealer/data/models.json` 的 `trim` 逐字一致**。 */
  trim: string;
  /** 用户与文档里可能的写法。归一时取**匹配到的最长别名**，见 `resolveTrim`。 */
  aliases: string[];
}

interface ModelEntry {
  model: string;
  aliases: string[];
  docPatterns: RegExp[];
  energy: "bev" | "phev" | "icev";
  bodyType: "suv" | "sedan" | "pickup";
  /** 指导价所用币种。**非 CNY 时不参与预算淘汰**——换算汇率就是编数字。 */
  priceCurrency: "CNY" | "USD";
  /**
   * 该车型在当前语料里的配置。
   *
   * **空数组是有意义的**：它表示"这款车我们没有配置级的资料"，
   * 于是它不进配置比较——而不是被猜一个出来。迈锐宝就是这种情况
   * （报价系统的种子里根本没有它）。
   */
  trims: readonly TrimEntry[];
}

export const KNOWN_MODELS: readonly ModelEntry[] = [
  {
    model: "Model 3",
    aliases: ["Model 3", "Model3", "model 3", "特斯拉 Model 3"],
    docPatterns: [/model_?3/i, /tesla_m3/i],
    energy: "bev",
    bodyType: "sedan",
    priceCurrency: "CNY",
    trims: [
      { trim: "后轮驱动版", aliases: ["后轮驱动版", "后驱版", "后驱", "标准版", "RWD"] },
      {
        trim: "长续航后轮驱动版",
        aliases: ["长续航后轮驱动版", "长续航后驱版", "长续航后驱", "Long Range RWD"],
      },
      {
        trim: "长续航全轮驱动版",
        aliases: [
          "长续航全轮驱动版",
          "长续航全驱版",
          "长续航全驱",
          "长续航四驱",
          "Long Range AWD",
        ],
      },
    ],
  },
  {
    model: "Model Y",
    aliases: ["Model Y", "ModelY", "model y", "特斯拉 Model Y"],
    docPatterns: [/model_?y/i, /tesla_my/i],
    energy: "bev",
    bodyType: "suv",
    priceCurrency: "CNY",
    trims: [
      { trim: "后轮驱动版", aliases: ["后轮驱动版", "后驱版", "后驱", "标准版", "RWD"] },
      {
        trim: "长续航后轮驱动版",
        aliases: ["长续航后轮驱动版", "长续航后驱版", "长续航后驱", "Long Range RWD"],
      },
      {
        trim: "长续航全轮驱动版",
        aliases: [
          "长续航全轮驱动版",
          "长续航全驱版",
          "长续航全驱",
          "长续航四驱",
          "Long Range AWD",
        ],
      },
      // 「六座」是这一个配置的属性，不是 Model Y 的属性（F-47-07）。
      // 把它放进别名，是为了让"Model Y 六座多少钱"能落到**具体配置**上，
      // 而不是变成一句"Model Y 有六座版"——后者会让用户拿着后驱版的价格去问六座车。
      { trim: "Model Y L", aliases: ["Model Y L", "ModelY L", "六座版", "六座"] },
    ],
  },
  {
    model: "Cybertruck",
    aliases: ["Cybertruck", "赛博皮卡"],
    docPatterns: [/cybertruck/i, /tesla_ct/i],
    energy: "bev",
    bodyType: "pickup",
    // 选配表是美元价。**不换算**——汇率一变数字就错，而它带着正确的出处。
    priceCurrency: "USD",
    trims: [
      { trim: "全轮驱动版", aliases: ["全轮驱动版", "全驱版", "全驱", "AWD"] },
      { trim: "Cyberbeast", aliases: ["Cyberbeast", "赛博兽", "野兽版"] },
    ],
  },
  {
    model: "迈锐宝",
    aliases: ["迈锐宝", "Malibu"],
    docPatterns: [/迈锐宝/, /malibu/i],
    energy: "icev",
    bodyType: "sedan",
    priceCurrency: "CNY",
    // 报价系统的种子里没有迈锐宝，所以**它没有配置级资料**。
    // 空数组让它安静地不进配置比较；编几个配置出来才是错的那条路。
    trims: [],
  },
];

export function entryOf(model: string): ModelEntry | undefined {
  return KNOWN_MODELS.find((m) => m.model === model);
}

/** 该车型在当前语料里的配置。车型不认识、或它没有配置级资料，都返回空数组。 */
export function trimsOf(model: string): readonly TrimEntry[] {
  return entryOf(model)?.trims ?? [];
}

/**
 * 把一段文字里的配置说法归一到事实表里的配置名。
 *
 * # 取**匹配到的最长别名**，不是第一个命中的
 *
 * 「长续航后轮驱动版」里包含「后轮驱动版」，先命中哪个取决于数组顺序——
 * 那种依赖会在有人重排别名时静默出错，而错的表现是把长续航版的问题
 * 按标准版回答，价格差 2.4 万，全程没有任何报错。
 *
 * # 两个配置以同样长度命中就是**归不了**
 *
 * 归不了返回 `undefined`，**不猜**——与 `resolveModel` 的原文兜底"只有恰好命中一款才算"
 * 是同一条纪律。猜错的代价是拿着 A 配置的参数回答 B 配置的问题，且带着正确的出处。
 */
export function resolveTrim(model: string, text: string): string | undefined {
  const haystack = text.toLowerCase();
  let best: { trim: string; length: number } | undefined;
  let ambiguous = false;

  for (const t of trimsOf(model)) {
    for (const alias of t.aliases) {
      if (!haystack.includes(alias.toLowerCase())) continue;
      if (best === undefined || alias.length > best.length) {
        best = { trim: t.trim, length: alias.length };
        ambiguous = false;
      } else if (alias.length === best.length && t.trim !== best.trim) {
        ambiguous = true;
      }
    }
  }

  return ambiguous ? undefined : best?.trim;
}

/**
 * 整车价的最低位数门槛。
 *
 * 5 万这个数不是随便取的：选配表里"高级车载娱乐服务 1 年包 118"这种三位数不是车价，
 * 而任何一台在售新车都不会低于它。**它只是第一道筛**，真正拦住 FSD 选装包的是
 * `isVehicleRow` 的第二条判据与 `vehiclePriceFloor` 的第三条。
 */
export const MIN_VEHICLE_PRICE_CNY = 50_000;

/**
 * 这一行是**一台车**，还是一个选装包？（施工单 M21-01 从 `subgraphs/buying.ts` 提出来）
 *
 * # 为什么要有它
 *
 * M15-02 实测踩到：选配表里 `$APF2 | 特斯拉辅助驾驶 | 64,000` 比整车便宜，
 * "取最低价"就把 FSD 选装包当成了车价——于是整份五年成本按 6.4 万算出来，
 * 分项、假设、出处一应俱全，**只有车价是错的**。
 *
 * # 为什么提到这里
 *
 * 配置比较（M21-02）会把"名称 | 价格"的表格行成批摊开，
 * **同一个坑的入口从一个变成几十个**。判据散成两份必然漂移，
 * 而漂移的那一份不会报错，只会安静地把某个选装包当成一台车。
 *
 * 判据一字未改，只是换了个地方放：价格够大 + **配置名里必须出现车型名**。
 */
export function isVehicleRow(model: string, rowName: string, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < MIN_VEHICLE_PRICE_CNY) return false;
  const aliases = entryOf(model)?.aliases ?? [model];
  return aliases.some((a) => rowName.toLowerCase().includes(a.toLowerCase()));
}

/**
 * 整车价的下界：报价系统里该车型最低配的人民币价。
 *
 * **拿不到就没有下界**（返回 `undefined`），不臆造一个——
 * 一个凭空的下界会把本该在列的行判成选装包，而理由写得像模像样。
 */
export function vehiclePriceFloor(
  pricedTrims: readonly { priceCny?: number }[] | undefined,
): number | undefined {
  const prices = (pricedTrims ?? [])
    .map((t) => t.priceCny)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  return prices.length > 0 ? Math.min(...prices) : undefined;
}

/** 第三条判据的可断言形态：低于下界的"整车价"一定不是整车（有下界时才判）。 */
export function isBelowVehiclePriceFloor(amount: number, floor: number | undefined): boolean {
  return floor !== undefined && amount < floor;
}

/** 无人民币报价时对外说的那句话。**措辞集中一处**，免得两个地方各说一版。 */
export const NO_CNY_PRICE_NOTE = "本系统无人民币报价";

/**
 * 这个车型有没有人民币指导价可用。
 *
 * 两种"没有"要分开说，因为它们的下一步不同：
 *  - 币种就不是人民币（Cybertruck 的选配表是美元价）→ 我们**不换算**，这是设计；
 *  - 报价系统里这一款全部缺 `priceCny` → 是数据没有，不是我们不给。
 *
 * `pricedTrims` 不传时只判币种——事实表本身不知道报价系统里有什么。
 */
export function cnyPriceAvailability(
  model: string,
  pricedTrims?: readonly { priceCny?: number }[],
): { available: boolean; note?: string } {
  const entry = entryOf(model);
  if (!entry) {
    return { available: false, note: `${NO_CNY_PRICE_NOTE}——「${model}」不在车型索引里` };
  }
  if (entry.priceCurrency !== "CNY") {
    return {
      available: false,
      note: `${NO_CNY_PRICE_NOTE}——该车型选配表是 ${entry.priceCurrency} 价，本仓不换算汇率`,
    };
  }
  if (pricedTrims !== undefined && vehiclePriceFloor(pricedTrims) === undefined) {
    return { available: false, note: `${NO_CNY_PRICE_NOTE}——报价系统里这一款没有人民币价` };
  }
  return { available: true };
}
