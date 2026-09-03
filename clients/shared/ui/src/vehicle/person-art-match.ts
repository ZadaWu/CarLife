/**
 * 人员关系 → 该用哪张卡通形象（纯逻辑，不 import 任何 png）。
 *
 * # 为什么单独一个文件
 *
 * `profile-characters.ts` 里是 `import x from "*.png"`——那是 Vite 的能力，
 * `node --test` 跑不起来（同一条理由见 `assets-hud` 的 `sprites.ts` 与
 * `item-sprites.test.ts`）。选形象的规则是这批素材里**唯一会出错还没人报错**的部分，
 * 必须能单测，所以规则留在这里，贴图表留在那边。
 *
 * # 性别是**否决项**，不是派脸的依据
 *
 * 2026-09-02 走查：车机人员档案里"玉米 · 儿子"顶着一张女孩的脸——
 * 因为当时"儿子"和"女儿"共用一条关键词，而素材只有女儿那一张。
 * 单看代码像是"孩子就用孩子的图"，落到屏幕上就是给一个真实的男孩安了张女孩的面孔。
 *
 * 所以规则是两段：先按关系词找**角色**（车主 / 配偶 / 长辈 / 孩子），
 * 再用关系词与称呼里的性别线索**否决**性别对不上的素材。性别判断不出来、
 * 而候选又跨性别（"孩子"既可能是儿子也可能是女儿）时**不给图**——
 * 由调用方画称呼首字。宁可没有脸，也不能是别人的脸。
 */

export type CharacterGender = "male" | "female";

/** 有素材的角色。新增素材时这里加一个 key，贴图表在 `profile-characters.ts`。 */
export type PersonArtKey = "owner" | "spouse" | "mother" | "daughter" | "son";

/**
 * 性别词表。**只用来否决**，不参与"该用哪张图"的选择。
 *
 * 判性别用**最长匹配**：`外孙女` 同时含 `外孙`（男）与 `外孙女`（女），
 * 短词优先会把孙女判成男孩。同类的还有 `儿媳`/`女婿`——字面性别与实际相反。
 */
const GENDER_WORDS: ReadonlyArray<readonly [string, CharacterGender]> = [
  // 男
  ["爸爸", "male"], ["父亲", "male"], ["老爸", "male"], ["爹", "male"],
  ["丈夫", "male"], ["老公", "male"], ["先生", "male"],
  ["儿子", "male"], ["孙子", "male"], ["外孙", "male"], ["女婿", "male"],
  ["爷爷", "male"], ["外公", "male"], ["公公", "male"], ["岳父", "male"],
  ["哥哥", "male"], ["弟弟", "male"], ["舅舅", "male"], ["叔叔", "male"],
  ["伯伯", "male"], ["姑父", "male"], ["姨父", "male"], ["男朋友", "male"], ["男友", "male"],
  // 女
  ["妈妈", "female"], ["母亲", "female"], ["老妈", "female"], ["妈", "female"],
  ["妻子", "female"], ["老婆", "female"], ["太太", "female"], ["女士", "female"],
  ["女儿", "female"], ["孙女", "female"], ["外孙女", "female"], ["儿媳", "female"],
  ["奶奶", "female"], ["外婆", "female"], ["婆婆", "female"], ["岳母", "female"],
  ["姐姐", "female"], ["妹妹", "female"], ["舅妈", "female"], ["阿姨", "female"],
  ["姑姑", "female"], ["嫂子", "female"], ["女朋友", "female"], ["女友", "female"],
];

/**
 * 角色词表。左边是**匹配用的关键词**，用户写"老婆"或"妻子"都要能命中。
 * 顺序有意义：先具体后笼统，避免"母亲"被更短的词抢走。
 *
 * 关键词里**保留性别对不上的叫法**（配偶那条留着"丈夫/老公"）：留着才能被性别闸
 * 拦成"没有素材"，删掉则会掉进下一条不相干的规则里。
 */
const ROLE_KEYWORDS: ReadonlyArray<{ key: PersonArtKey; gender: CharacterGender; keywords: readonly string[] }> = [
  { key: "owner", gender: "male", keywords: ["本人", "车主", "自己"] },
  { key: "spouse", gender: "female", keywords: ["配偶", "妻子", "老婆", "太太", "爱人", "丈夫", "老公"] },
  { key: "mother", gender: "female", keywords: ["母亲", "妈妈", "妈", "婆婆", "岳母"] },
  { key: "daughter", gender: "female", keywords: ["女儿", "孩子", "小孩"] },
  { key: "son", gender: "male", keywords: ["儿子", "孩子", "小孩"] },
];

/**
 * 从关系与称呼里判性别。判不出来返回 undefined——**判不出来不等于可以随便挑一个**。
 */
export function inferPersonGender(text: string): CharacterGender | undefined {
  let best: CharacterGender | undefined;
  let bestLen = 0;
  let tie = false;
  for (const [word, gender] of GENDER_WORDS) {
    if (!text.includes(word)) continue;
    if (word.length > bestLen) {
      best = gender;
      bestLen = word.length;
      tie = false;
    } else if (word.length === bestLen && gender !== best) {
      tie = true;
    }
  }
  // 同样长的两个词指向不同性别（"儿子" + "女儿" 同时出现这种）：当作判不出来。
  return tie ? undefined : best;
}

/**
 * 按关系取形象的 key。`relation` 缺席时**退到 displayName**——很多人把关系直接
 * 写进称呼里（成员就叫"妈妈"）。
 */
export function personArtKey(person: { relation?: string; displayName?: string }): PersonArtKey | undefined {
  const hay = `${person.relation ?? ""} ${person.displayName ?? ""}`;
  const hits = ROLE_KEYWORDS.filter((r) => r.keywords.some((k) => hay.includes(k)));
  if (hits.length === 0) return undefined;

  const gender = inferPersonGender(hay);
  if (gender) {
    const usable = hits.find((r) => r.gender === gender);
    // 性别明确但没有对应性别的素材（"丈夫"——本批只有妻子那一张）：不给图。
    return usable?.key;
  }
  // 性别判不出来（"孩子"/"配偶"这类），而候选跨性别：不给图。
  return hits.every((r) => r.gender === hits[0]!.gender) ? hits[0]!.key : undefined;
}
