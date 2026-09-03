/**
 * 硬禁清单（施工单 M5-02，§8.4 表首行 / FL-27 F-27-02）。
 *
 * # 三条硬要求
 *
 * 1. **确定性规则，不依赖 LLM**。内容审核可以用模型（§8.2），动作权限不行——
 *    安全底线不能是概率性的。
 * 2. **必须覆盖否定性保证方向**。"你的刹车没问题"比"你的刹车有问题"更危险，
 *    也更容易被漏掉：写规则的人本能地去拦"确诊"，不会想到拦"打包票"。
 * 3. **判定快且不依赖外部服务**。安全底线不能因为网络问题失效。
 *
 * # 红线：**绝不进热配置**
 *
 * 做成可配置就等于给红线加了个开关（FL-30 F-30-01 边界）。
 * 本文件是代码，改它要走发版与评审——这正是我们要的摩擦。
 */

export type HardBlockCategory =
  | "autonomous-driving"
  | "vehicle-control"
  | "repair-verdict"
  | "safety-assurance";

export interface HardBlockRule {
  category: HardBlockCategory;
  /** 命中即拒。 */
  pattern: RegExp;
  /** 为什么禁——出现在审计里，便于事后判断规则是否过宽。 */
  why: string;
}

/**
 * 三类硬禁来自 §8.4 表首行："自动驾驶决策、车辆安全控制指令、替代专业维修的确定性结论"。
 * 第四类 `safety-assurance` 是**实现时补的**：它是第三类的否定形态，
 * 原文没有单列，但漏掉它等于漏掉一半。
 */
export const HARD_BLOCK_RULES: readonly HardBlockRule[] = [
  {
    category: "autonomous-driving",
    pattern: /(自动驾驶|自动泊车|辅助驾驶).{0,8}(打开|开启|启用|接管|激活)|(打开|开启|启用|激活).{0,8}(自动驾驶|自动泊车|自动辅助)/,
    why: "自动驾驶决策属硬禁（§8.4）",
  },
  /*
   * ── vehicle-control：安全域拆四条（M24-01，§8.4 边界 2026-08-25 回填）──
   *
   * 此前"空调"整词在安全域正则里、"(帮我).{0,4}(启动)"一律拦——舒适域没打通时
   * 边界画粗无伤大雅；US-49 之后必须按语义收窄：**温度/座椅/灯光/媒体/香氛是
   * 舒适域**，走 cabin 工具与权限门；下面四条只拦行驶与安全。
   * 实测过的误杀（收窄的直接动因）："帮我启动座椅按摩"命中旧第二分支。
   */
  {
    category: "vehicle-control",
    pattern: /(刹车|制动|油门|方向盘|转向|电门).{0,6}(控制|下发|执行|操作|锁定|解锁)/,
    why: "行驶机构控制指令属硬禁（§8.4 安全域）",
  },
  {
    category: "vehicle-control",
    // 门窗开闭涉及乘员安全（行驶中尤甚），整域留在安全侧——遮阳帘等舒适件不在此列。
    pattern: /(车门|车窗|天窗).{0,6}(打开|开启|控制|下发|执行|操作|锁定|解锁|摇下|降下)|(打开|摇下|降下).{0,4}(车门|车窗|天窗)/,
    why: "门窗控制属硬禁（§8.4 安全域）",
  },
  {
    category: "vehicle-control",
    // 整车远程操作。启动/解锁带否定预查：对象是舒适件（座椅按摩/加热/香氛/屏幕…）时
    // 不属安全域——"帮我启动座椅按摩"放行、"帮我启动车子"仍拦；无对象按整车理解，拦。
    pattern: /(远程|帮我).{0,4}(熄火|锁车)|(远程|帮我).{0,4}(启动|发动)(?!.{0,6}(座椅|按摩|加热|通风|香氛|氛围|音乐|空调|儿歌))|(远程|帮我).{0,4}解锁(?!.{0,6}屏)/,
    why: "整车远程操作（启动/熄火/锁车/解锁）属硬禁（§8.4 安全域）",
  },
  {
    category: "vehicle-control",
    // 上锁可远程（childMode 走权限门确认），解锁只能车内物理操作——设备层（mock-cabin
    // 的 safety_domain）与本层双重保证，两头都到不了。
    pattern: /(儿童锁|童锁).{0,6}(解除|解开|解锁|关闭|关掉)|(解除|解开|解锁|关闭|关掉).{0,4}(儿童锁|童锁)/,
    why: "解除儿童锁属硬禁（§8.4 安全域）——上锁可远程，解锁需车内物理操作",
  },
  {
    category: "repair-verdict",
    pattern: /(确诊|一定是|肯定是|就是).{0,10}(故障|坏了|损坏|需要更换)|不用去(店里|修理厂|4S)/,
    why: "替代专业维修的确定性结论属硬禁（§8.4）",
  },
  {
    category: "safety-assurance",
    // 否定性保证：比"确诊"更危险，因为它让用户继续开一辆可能有问题的车。
    pattern: /(没问题|没事|安全的?|不用担心|放心开|可以继续开).{0,6}(放心|开吧|上路|行驶)|(保证|敢说|绝对).{0,8}(没问题|安全)/,
    why: "否定性安全保证属硬禁——它比确诊更危险（§8.4 的实现补充）",
  },
];

export interface HardBlockVerdict {
  blocked: boolean;
  category?: HardBlockCategory;
  why?: string;
}

/**
 * 判定一段文本（工具入参摘要或动作描述）是否命中硬禁。
 *
 * 命中即拒，**不经用户、不进 HITL**（§8.4 表首行）——弹窗问用户"要不要打开自动驾驶"
 * 本身就是错的，那不是用户能授权的事。
 */
export function checkHardBlock(text: string): HardBlockVerdict {
  for (const rule of HARD_BLOCK_RULES) {
    if (rule.pattern.test(text)) {
      return { blocked: true, category: rule.category, why: rule.why };
    }
  }
  return { blocked: false };
}

/**
 * 硬禁被拒时给用户的话术（§8.4 表首行原文："AI 辅助建议 + 引导线下专业处理"）。
 *
 * **拒绝的是结论，不是帮助**（FL-20 的核心设计矛盾）——
 * 每条都给出可执行的下一步，否则用户用两次就不用了。
 */
export function hardBlockReply(category: HardBlockCategory): string {
  switch (category) {
    case "autonomous-driving":
    case "vehicle-control":
      return "这类车辆控制我不能执行——出于安全考虑，本系统在设计上就不具备下发控制指令的能力。你可以在车机原生界面操作。";
    case "repair-verdict":
      return "我不能给出确定性的维修结论。我可以帮你判断风险等级、列出自查清单和向修理厂追问的关键问题，你要哪一个？";
    case "safety-assurance":
      return "我不能替你打包票说「没问题」——这类判断需要专业检测。我可以告诉你哪些迹象意味着应当立即停车，以及现在这个情况的风险区间。";
  }
}
