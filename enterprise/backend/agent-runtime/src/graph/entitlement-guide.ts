/**
 * 车主权益的查询指引（施工单 M96-03，设计定稿 D7 第二段）。
 *
 * # 「你可能有什么」在知识库，「去哪查」在这里，**险企那一类直接读保单**
 *
 * 原来这三类（主机厂 / 险企 / 门店）一律按"车主自报"处理，理由是"本仓没有余额账"。
 * 对险企那一类是错的（ACR-043）：**次数就写在保单的特约条款里，而保单在我们手里**——
 * `insurance_policy` 一直在售后的 ACL 内，只是权益这条路从没去调过它。
 * 向拿着权威源的那一方要数，是 ADR-010 的同一条纪律。
 *
 * 所以现在分两段：险企权益走 `renderInsurerEntitlementsContext`（数全部来自工具返回，
 * 渲染层只做 `剩 = total − used` 这一步算术）；主机厂与门店本仓确实没有接口，
 * 仍只回答**去哪查、要带什么、常见坑**，做成代码内词条而不是让模型自由发挥——
 * 五个入口是在线核实过的确定事实，模型发挥只会把它们混成"去 App 看看"。
 *
 * 词条内容与语料整理稿 `data/kb-src/insurance/[整理]车主权益的来源与失效规则.md`（M96-04）
 * **逐字一致**——语料是内容真相源，这里从它抄；验收时 diff 为空。
 */

export interface EntitlementEntry {
  /** 权益来源。 */
  source: string;
  /** 去哪查。 */
  where: string;
  /** 要准备什么。 */
  prepare: string;
  /** 常见坑。 */
  pitfall: string;
}

export const ENTITLEMENT_ENTRIES: readonly EntitlementEntry[] = [
  {
    source: "主机厂赠送（质保期救援、充电额度、保养券）",
    where: "品牌 App 的「我的权益」或「服务」页",
    prepare: "购车时登记的手机号登录",
    pitfall: "多为首任车主限定，过户后失效；充电额度按月清零、不累计到下月",
  },
  {
    source: "购车协议附件",
    where: "购车合同与附件（纸质或电子版）",
    prepare: "合同编号",
    pitfall: "这是权威依据——首任车主认定、过户后是否失效以它为准",
  },
  {
    source: "保险赠送（免费救援次数、代驾、洗车）",
    where: "电子保单的「增值服务」或「特约条款」栏",
    prepare: "保单号",
    pitfall: "随保单年度失效、不跨年累计；「免费」通常不含过路过桥费与物料费",
  },
  {
    source: "保险公司 App 或小程序",
    where: "救援 / 服务页，输车牌与投保手机号",
    prepare: "车牌、投保时的手机号",
    pitfall: "只显示本公司赠送的，换过保险公司要分别查",
  },
  {
    source: "400 客服热线（品牌或保险公司）",
    where: "客服电话，报车牌或 VIN",
    prepare: "车牌或 VIN",
    pitfall: "问清剩余次数与到期日，记下来告诉我，我按你说的记进档案",
  },
];

/** 上下文段行数上限（M96-03 约束 5 的降级）：权益指引不能把应答挤过 300 字。 */
export const ENTITLEMENT_GUIDE_MAX_LINES = 12;

/**
 * 渲染成交给 narrator 的上下文段。这段回答的是"去哪查"，不是"你有什么"——
 * 主机厂与门店的账本仓确实没有，模型不能把入口说成余额。
 *
 * 险企那一类**不在这一段**：有 VIN 时它由上面的保单段给出真实次数（ACR-043）。
 */
export function renderEntitlementGuideContext(): string {
  const lines: string[] = ["【权益去哪查（主机厂与门店赠送的系统里没有账，以下是查询入口）】"];
  for (const e of ENTITLEMENT_ENTRIES) {
    lines.push(`- ${e.source}：查 ${e.where}，准备 ${e.prepare}；注意：${e.pitfall}`);
  }
  lines.push(
    "表述要求：至少给三个入口；**险企赠送的以上面「险企权益（保单载明）」段为准**；" +
      "主机厂与门店那两类不要报任何次数或额度（系统里没有账）；车主报了数就说\"按你 X 月 X 日告诉我的\"记为自报",
  );
  return lines.slice(0, ENTITLEMENT_GUIDE_MAX_LINES).join("\n");
}

/** `insurance_policy` 回传的保单里我们要用的那几栏。工具层原样透传，这里只读不算。 */
export interface PolicyForEntitlements {
  policyId: string;
  insurer: string;
  status: string;
  validTo: string;
  valueAddedServices?: Array<{
    code: string;
    name: string;
    quotaKind: "count" | "amount" | "unlimited";
    total?: number;
    used?: number;
    unit?: string;
    periodKind: string;
    conditions: string[];
  }>;
}

/**
 * 「险企权益（保单载明）」段——**数字全部来自工具返回**（ACR-043）。
 *
 * 这里唯一的算术是 `剩 = total − used`。多算一步就会出现第二个声称知道"还剩几次"的地方，
 * 而它与保单不一致时没人说得清该信谁。
 *
 * 四种情形分开说，因为它们对车主意味着完全不同的事：
 *   在保 + 有载明  → 给数
 *   在保 + 无载明  → "这张保单没载明增值服务"（不是"查不到"）
 *   已到期        → "随保单到期失效"（不是"你有 3 次"）
 *   没有保单      → 这一段整个不出现，只剩查询入口
 */
export function renderInsurerEntitlementsContext(policies: readonly PolicyForEntitlements[]): string | undefined {
  if (policies.length === 0) return undefined;
  const active = policies.filter((p) => p.status === "active");
  const lines: string[] = ["【险企权益（保单载明）】"];

  if (active.length === 0) {
    const latest = [...policies].sort((a, b) => (a.validTo < b.validTo ? 1 : -1))[0]!;
    lines.push(
      `- 这辆车在本司的保单已于 ${latest.validTo} 到期，随保单赠送的增值服务同时失效（不跨年累计）`,
    );
    lines.push("表述要求：明确说是**上一份保单**的权益且已失效，不要报任何剩余次数");
    return lines.join("\n");
  }

  let any = false;
  for (const p of active) {
    for (const s of p.valueAddedServices ?? []) {
      any = true;
      lines.push(`- ${s.name}：${quotaText(s)}，到 ${p.validTo} 随保单失效；条件：${s.conditions.join("、") || "无"}`);
    }
  }
  if (!any) {
    lines.push(`- ${active[0]!.insurer} 的这张保单没有载明增值服务（不是"查不到"，是保单上确实没有这一栏）`);
    lines.push("表述要求：如实说保单未载明，再给下面的查询入口");
    return lines.join("\n");
  }
  lines.push(
    "表述要求：次数**照抄上面的数**不要自己加减；说清这是保单载明的（模拟保单，实际以保险公司为准）；" +
      "条件要一起说——「免费」通常不含过路过桥费与物料费",
  );
  return lines.join("\n");
}

function quotaText(s: NonNullable<PolicyForEntitlements["valueAddedServices"]>[number]): string {
  if (s.quotaKind === "unlimited") return "不限次";
  const total = s.total ?? 0;
  const used = s.used ?? 0;
  const unit = s.unit ?? (s.quotaKind === "count" ? "次" : "");
  // 核销延迟在真实险企那边可能让 used 超过 total。**不出负数、也不裁成 0**——
  // 两者都是替保险公司下结论，而这正是我们没资格做的那件事。
  if (used > total) return `保单载明 ${total}${unit}、已用 ${used}${unit}（数据异常，以保险公司为准）`;
  return `共 ${total}${unit} / 已用 ${used}${unit} / 剩 ${total - used}${unit}`;
}
