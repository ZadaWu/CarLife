/**
 * 座舱指令的规则解析（施工单 M24-04；M24 收口改为**兜底**）。
 *
 * # 现在它是兜底，不是主路
 *
 * 主路是 A 型：`cabinNode` 发一次 `cabin-task`，**模型自己决定调哪个工具、填什么参数**
 * （见 内部开发指引「新增一个业务 Agent」）。本模块只在两种情况下还起作用：
 *   · `mentionsCabinDevice()`——宽召回，判断要不要惊动模型（纯词表，零成本）；
 *   · `parseCabinCommands()`——ACP 不可用 / `CARLIFE_LLM=fake` 时的确定性兜底。
 * 与 M19-08「时段理解交给 LLM，正则退成兜底」同一形态。
 *
 * # 当初为什么写成规则，以及它为什么不够
 *
 * 当初的理由是延迟：座舱是最敏感的场景，多一跳 LLM 就多一秒；而"语汇封闭"看着
 * 覆盖得住。**"封闭"这个前提是错的**——真跑 turn-85f920d4 打脸：「帮我启动座椅按摩」
 * 整句一个动词都不命中（动词表没有"启动"），设置指令静默落进陪聊；补完动词表，
 * 「座椅加热怎么开」又被当成指令要去真开加热。这是打地鼠，M19-08 已经打过一轮。
 * `-task` 会话不思考，那一跳其实只有一两秒——延迟这个理由本来也不够硬。
 *
 * # 解析产物按敏感级分两组
 *
 * comfort（cabin_control）与 child（cabin_child_mode）分开返回——
 * 混合单必须**确认在前、下发在后**（M24-03），分组是子图排序的前提。
 */

import type { CabinApplyOp } from "@carlife/tools";

export interface ParsedCabinCommands {
  comfort: CabinApplyOp[];
  child: CabinApplyOp[];
  /** 像设置但没解析出具体值的子句——转述层要追问，不要瞎猜。 */
  unparsed: string[];
}

/**
 * 设置类词汇（判断"这句话像不像在指挥座舱"）。
 *
 * ⚠️ **这张表是安全边界的一部分，加词要克制**：`mentionsCabinDevice()` 除了宽召回，
 * 还被 supervisor 用来给误判成 `vehicle-control` 的句子平反（只能把"拒"改成"放"）。
 * 加进来的每个词都在扩大那次撤销的适用面。所以只收**无歧义的**座舱词——
 * 「曲」（弯曲/曲折）、「暂停」（停车）这种一词两义的一律不要，
 * 它们的召回交给 route.ts 的证据表与 intent 的候选说明，那两处不碰安全判定。
 */
const SETTINGISH =
  /空调|温度|座椅|加热|通风|按摩|氛围灯|灯光|亮度|音量|音乐|儿歌|播客|电台|广播|戏曲|香氛|儿童锁|屏幕|风量|歌|下一首|上一首|换一首/;
/**
 * 动作类词汇。名词单独出现（"空调怎么用"）是咨询，不是指令。
 *
 * **多字动词要显式列**（M24 收口修）：单字表覆盖不到"启动/启用/发动"——
 * turn-85f920d4 真跑踩到："帮我启动座椅按摩"整句一个动词都不命中，
 * 于是设置指令静默落进陪聊，助手答"操作不了"还顺带念了两条无关偏好。
 * 讽刺的是这正是 M24-01 为之收窄硬禁的那一句：**闸门开了，车没开过去**。
 */
const VERBISH = /启动|启用|发动|换成|调|开|关|设|放|锁|降|升|暗|亮|停/;

/**
 * 判动作词前先把名词剥掉——"空调"自带"调"、"儿童锁"自带"锁"，
 * 不剥的话"空调怎么用"会被当成指令。
 */
const hasVerb = (text: string): boolean =>
  VERBISH.test(text.replace(/空调|儿童锁|屏幕锁|氛围灯/g, "")) ||
  // 带数值的名词短语（"空调 23 度""音量 40"）没有动词也是指令
  /\d+(?:\.\d)?\s*(?:度|档)|音量\s*\d|亮度\s*\d/.test(text);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface ClauseZone {
  seat: string[];
  climate?: string;
  media?: string;
  ambient?: string;
}

function zonesOf(clause: string): ClauseZone {
  const rear = /后排|后座|孩子|小朋友/.test(clause);
  const passenger = /副驾/.test(clause);
  const driver = /主驾|我这边|驾驶/.test(clause);
  return {
    // 座椅按人坐的位置：后排展开成左右两个座（车机没有"后排"这个座位 zone）。
    seat: rear ? ["rearLeft", "rearRight"] : passenger ? ["passenger"] : driver ? ["driver"] : ["driver"],
    climate: rear ? "rear" : passenger ? "passenger" : driver ? "driver" : undefined,
    media: rear ? "rear" : undefined,
    ambient: rear ? "rear" : undefined,
  };
}

/** 找子句里的数值（"23 度" / "2 档" / "音量 40"）。 */
const num = (clause: string, re: RegExp): number | undefined => {
  const m = clause.match(re);
  return m ? Number(m[1]) : undefined;
};

/**
 * **宽召回**：这句话沾不沾座舱设备（M24 改 A 型后的新用法）。
 *
 * 它只回答"要不要让座舱 Agent 看一眼"，不回答"要设什么"——后者是模型的活。
 * 判据故意只看设备名词、不看动词也不看疑问句：**宁滥勿缺**。多发一次
 * `cabin-task` 的代价是一跳无思考的 LLM；漏掉的代价是整句话静默落进陪聊
 * （turn-85f920d4 就是这么丢的）。
 *
 * "空调怎么用"也会被召回——那没关系，模型有 `cabin_status`，据实回答"这车有/没有"
 * 比路由给用车助手翻手册更直接。
 */
export function mentionsCabinDevice(text: string): boolean {
  return SETTINGISH.test(text ?? "");
}

/**
 * 解析一句话里的座舱指令。**返回 null = 这不是设置话术**（走陪聊）；
 * 返回值里三组都可能为空组合出现。
 */
/**
 * 疑问句式：**问怎么做 ≠ 让你做**。
 *
 * 动词表放宽后"座椅加热怎么开"会命中动词而被当成指令——那会真的把加热打开，
 * 而车主只是在问方法。按本文件的纪律（拿不准落陪聊，说错不动手比动错手安全）
 * 一律交给陪聊/用车助手；代价是"能不能帮我把空调调到 23 度"也会落陪聊，
 * 用户再说一遍即可，比擅自动手轻。
 */
const ASKING = /怎么|如何|在哪|哪里|能不能|可不可以|支持吗|有没有|是不是|吗[？?]?$/;

export function parseCabinCommands(text: string): ParsedCabinCommands | null {
  if (ASKING.test(text)) return null;
  if (!(SETTINGISH.test(text) && hasVerb(text))) return null;

  const comfort: CabinApplyOp[] = [];
  const child: CabinApplyOp[] = [];
  const unparsed: string[] = [];

  const push = (list: CabinApplyOp[], domain: string, zone: string | undefined, set: Record<string, unknown>) => {
    // 同域同区合并进一条 op——mock 按 op 逐条裁决，拆散会让"温度+风量"变成两条流水。
    const hit = list.find((o) => o.domain === domain && o.zone === zone);
    if (hit) Object.assign(hit.set, set);
    else list.push(zone ? { domain, zone, set } : { domain, set });
  };

  for (const clause of text.split(/[，。；,;!！?？\n]/).map((c) => c.trim()).filter(Boolean)) {
    const z = zonesOf(clause);
    let matched = false;

    // ── 空调 ──
    if (/空调|温度/.test(clause)) {
      const t = num(clause, /(\d{2}(?:\.\d)?)\s*度/);
      if (t !== undefined) {
        push(comfort, "climate", z.climate, { tempC: t });
        matched = true;
      }
    }
    const fan = /风量/.test(clause) ? num(clause, /风量.{0,4}?(\d)/) : undefined;
    if (fan !== undefined) {
      push(comfort, "climate", z.climate, { fanLevel: clamp(fan, 0, 5) });
      matched = true;
    }

    // ── 座椅 ──
    if (/加热/.test(clause) && !/别|不要|关/.test(clause)) {
      const level = num(clause, /(\d)\s*档/) ?? 2; // 没说档位按 2——裁决结果会把实际档位念出来
      for (const seat of z.seat) push(comfort, "seat", seat, { heating: clamp(level, 0, 3) });
      matched = true;
    }
    if (/关.{0,3}加热/.test(clause)) {
      for (const seat of z.seat) push(comfort, "seat", seat, { heating: 0 });
      matched = true;
    }
    if (/通风/.test(clause)) {
      const off = /关/.test(clause);
      const level = off ? 0 : (num(clause, /(\d)\s*档/) ?? 2);
      for (const seat of z.seat) push(comfort, "seat", seat, { ventilation: clamp(level, 0, 3) });
      matched = true;
    }
    if (/按摩/.test(clause)) {
      push(comfort, "seat", z.seat[0], { massage: /关|停/.test(clause) ? "off" : "wave" });
      matched = true;
    }

    // ── 氛围灯 ──
    if (/氛围灯|灯光|车内灯/.test(clause)) {
      const explicit = num(clause, /亮度.{0,4}?(\d{1,3})/);
      // 顺序有意义：先看"关"（"关闭"含关），再看明暗，最后才是光秃秃的"开灯"。
      const brightness =
        explicit !== undefined
          ? clamp(explicit, 0, 100)
          : /关/.test(clause)
            ? 0
            : /暗/.test(clause)
              ? 20
              : /亮/.test(clause)
                ? 80
                : /开|启动|启用/.test(clause)
                  ? 50
                  : undefined;
      if (brightness !== undefined) {
        push(comfort, "ambientLight", z.ambient, { brightness });
        matched = true;
      }
    }

    // ── 媒体 ──
    if (/儿歌/.test(clause)) {
      push(comfort, "media", z.media, { source: "kids", contentTag: "儿歌" });
      matched = true;
    } else if (/播客/.test(clause)) {
      push(comfort, "media", z.media, { source: "podcast" });
      matched = true;
    } else if (/电台|广播/.test(clause)) {
      push(comfort, "media", z.media, { source: "radio" });
      matched = true;
    } else if (/戏曲/.test(clause)) {
      push(comfort, "media", z.media, { source: "music", contentTag: "戏曲" });
      matched = true;
    } else if (/(关|停).{0,3}音乐/.test(clause)) {
      push(comfort, "media", z.media, { source: "off" });
      matched = true;
    } else if (/放.{0,4}音乐/.test(clause)) {
      push(comfort, "media", z.media, { source: "music" });
      matched = true;
    }
    const volLimit = /音量上限/.test(clause) ? num(clause, /音量上限.{0,4}?(\d{1,3})/) : undefined;
    if (volLimit !== undefined) {
      push(comfort, "media", z.media, { volumeLimit: clamp(volLimit, 0, 100) });
      matched = true;
    } else {
      const vol = /音量/.test(clause) ? num(clause, /音量.{0,6}?(\d{1,3})/) : undefined;
      if (vol !== undefined) {
        push(comfort, "media", z.media, { volume: clamp(vol, 0, 100) });
        matched = true;
      } else if (/音量.{0,3}(小|低)/.test(clause)) {
        push(comfort, "media", z.media, { volume: 20 });
        matched = true;
      }
    }

    // ── 香氛 ──
    if (/香氛/.test(clause)) {
      push(comfort, "fragrance", undefined, { intensity: /关/.test(clause) ? "off" : /浓/.test(clause) ? "mid" : "low" });
      matched = true;
    }

    // ── 儿童模式（需确认，单独一组）──
    if (/儿童锁/.test(clause)) {
      if (/锁上|上锁|锁定|锁好/.test(clause) || (/锁/.test(clause) && !/解|开/.test(clause))) {
        child.push({ domain: "childMode", set: { childLock: true } });
        matched = true;
      }
      // "解除儿童锁"到不了这里——硬禁在输入层已拒（M24-01）。真漏进来也会被
      // 设备层 safety_domain 拒掉并如实转述，两头都有闸。
    }
    if (/屏幕|后排屏/.test(clause) && /锁/.test(clause)) {
      const unlock = /解锁|解除/.test(clause);
      child.push({ domain: "childMode", set: { screenLock: !unlock } });
      matched = true;
    }

    if (!matched && SETTINGISH.test(clause) && hasVerb(clause)) unparsed.push(clause);
  }

  if (comfort.length === 0 && child.length === 0 && unparsed.length === 0) return null;
  return { comfort, child, unparsed };
}
