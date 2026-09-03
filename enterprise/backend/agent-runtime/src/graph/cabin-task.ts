/**
 * `cabin-task` 分支的提示词与结果整形（M24 收口：座舱全面 A 型）。
 *
 * # 这里**不写工具怎么用，也不判断车主说了什么**
 *
 * 工具表、参数形状、四态转述纪律、安全域红线——全在 `prompts/cabin.md`
 * （经 `--append-system-prompt` 进真正的系统提示词）与各工具的 `promptGuidelines`
 * （经 pi 扩展进 Guidelines 节）。在这里再写一遍就是第二份真相（M23-03 的分工）。
 *
 * 本文件只做两件小事：**把车主原话与已知事实交过去**，以及**给回来的文本套一层
 * 表述纪律**。"是登记还是设置"由模型判断——那正是改 A 型要买的东西。
 */

import type { CabinCapabilities } from "@carlife/tools";
import type { VehicleMember } from "@carlife/memory";

/** 预取来的能力表：拿到了是它，拿不到是错误原因——**两者都要如实进 prompt**。 */
export type PrefetchedCaps =
  | { vin: string; model: string; capabilities: CabinCapabilities }
  | { error: string }
  | undefined;

/**
 * 能力摘要。**只给模型填 ops 用得上的那几项**，不要把整份 `capabilities` 倒进去——
 * 上下文越长模型越容易忽略后半段，而分区名与档位上限才是它真正需要的。
 */
function describeCaps(caps: PrefetchedCaps): string {
  if (!caps) return "车机能力：**这一轮没有用户身份，读不到**。如实说明设置不了，不要假装已设置。";
  if ("error" in caps) {
    return `车机能力：**读不到**（${caps.error}）。如实转达这个原因；**不要说"已经调好了"**。`;
  }
  const c = caps.capabilities;
  const seatLine = Object.entries(c.seats)
    .map(([zone, s]) => {
      const has = [
        s.heatingLevels > 0 ? `加热 0~${s.heatingLevels}` : null,
        s.ventilationLevels > 0 ? `通风 0~${s.ventilationLevels}` : "无通风",
        s.massageModes.length > 1 ? `按摩 ${s.massageModes.filter((m) => m !== "off").join("/")}` : "无按摩",
      ].filter(Boolean);
      return `${zone}（${has.join("、")}）`;
    })
    .join("；");
  return [
    `这辆车是 ${caps.model}，座舱能力如下（**填 zone 与档位就照这个，不必再查**）：`,
    `- 空调分区：${c.climate.zones.join(" / ")}；温度 ${c.climate.tempRangeC[0]}~${c.climate.tempRangeC[1]}℃，步进 ${c.climate.tempStepC}；风量 0~${c.climate.fanLevels}`,
    `- 座椅：${seatLine}`,
    `- 氛围灯分区：${c.ambientLight.zones.join(" / ")}，亮度 ${c.ambientLight.brightnessRange[0]}~${c.ambientLight.brightnessRange[1]}`,
    `- 媒体分区：${c.media.zones.join(" / ")}；可选内容 ${c.media.sources.join("/")}`,
    `- 香氛：${c.fragrance.present ? "有" : "**没有**"}；儿童模式分区：${c.childMode.zones.join(" / ")}`,
  ].join("\n");
}

/** 名单摘要：**带 id**，因为几个工具都只收 memberId（防编）。 */
function describeRoster(roster: readonly VehicleMember[]): string {
  if (roster.length === 0) {
    return "常用人员：这辆车还没登记过任何人。涉及「给某人记偏好」或「按人调好」时，先告诉车主要在档案页登记这个人。";
  }
  const lines = roster.map((m) => {
    const bits = [m.relation, m.ageBand === "child" ? "儿童" : m.ageBand === "senior" ? "老人" : null].filter(Boolean);
    const pref = m.cabinPreference && Object.keys(m.cabinPreference).length > 0 ? "已登记座舱偏好" : "尚无座舱偏好";
    return `- ${m.displayName}${bits.length ? `（${bits.join("、")}）` : ""} id=${m.id} · ${pref}`;
  });
  return ["常用人员名单（**工具只收 id，从这里取，不要编**）：", ...lines].join("\n");
}

export function cabinTaskPrompt(
  userText: string,
  facts: { caps: PrefetchedCaps; roster: readonly VehicleMember[] },
): string {
  return [
    `车主刚说：「${userText}」`,
    "",
    describeCaps(facts.caps),
    "",
    describeRoster(facts.roster),
    "",
    "按你的工具处理这一轮：该查就查、该设就设、该记就记、是闲聊就好好聊。",
    "然后用一段话讲清楚**实际发生了什么**——做到的、被夹到边界的（两个值都要说）、",
    "没做到的及原因。这段话会交给另一个会话说给车主听，所以**只讲事实，不要客套开场白**。",
  ].join("\n");
}

/**
 * 给 `answer` 节点的求解结果。
 *
 * narrator 的系统提示词写着"编排层已完成的求解结果"——它默认收到的是**代码算出来的
 * 结构化事实**（行程那种）。座舱这一份是模型写的自然语言，边界不同：narrator 必须知道
 * "这段话里的动作已经发生了，不要再声明一次去做"，也不能往里添条目。
 */
/** 会改变世界的工具——只查询的不算（`cabin_status` / `vehicle_member` / `preference_recall`）。 */
export const MUTATING_CABIN_TOOLS = new Set([
  "cabin_control",
  "cabin_child_mode",
  "cabin_apply_preferences",
  "member_preference_set",
]);

export function cabinTaskResult(text: string, mutatingTools: readonly string[] = []): string {
  /*
   * **说了做了没有，以工具调用记录为准。**（M24 收口）
   *
   * A 型多出一种 B 型没有的失败：模型不调工具却声称做了。真跑 sess-36f62962-9e4
   * 里它只查了状态就说"已经帮小宝把亮度调到 20 了"，而车机侧 brightness 还是 30。
   * 这里拿事实兜底——不改模型那段话，而是**在它后面加一句更强的指令**让
   * narrator 照事实说。事实与文本冲突时，事实赢。
   */
  const claimsAction = /已经|已帮|帮您|帮你|调好|设好|记好|记下|保存|开好|锁上|生效/.test(text);
  const nothingDone = mutatingTools.length === 0;
  const contradiction =
    nothingDone && claimsAction
      ? [
          "",
          "⚠️ **事实核对：这一轮没有执行任何设置或登记动作**（工具调用记录为空）。",
          "上面那段话如果声称「已经调好 / 已经记住」，**那是错的**。请按「这次没有执行」转述：",
          "说明没做成、可能的原因（没听清具体值、或需要车主确认），并请车主再说一次。",
          "**绝不要复述任何「已经生效」的说法。**",
        ].join("\n")
      : "";
  return [
    "【座舱这一轮的实际结果（动作已经执行完毕，设置来自车机——模拟系统）】",
    text.trim(),
    contradiction,
    "",
    "表述要求：把上面这段说成适合语音播报的短句。**逐条都要说到**——",
    "做到的、被夹到边界的（要的值与实际值都说）、没做到的及原因、共享资源让给了谁，一条都不能吞；",
    "**不要新增上面没有的设置项**，也不要说「我这就去调」（已经调完了）。",
  ].join("\n");
}
