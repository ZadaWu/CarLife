/**
 * 阿里云 AI 安全护栏 → `ContentGuard` 适配（施工单 TD-04，§8.2）。
 *
 * # 分类体系换了，策略开关必须跟着换
 *
 * 原先的六类（Violent / Sexual / …）是 Qwen3Guard-Gen 的输出空间。
 * 阿里云给的是**防护维度**（`Type`：contentModeration / promptAttack / sensitiveData /
 * modelHallucination / …）加细粒度标签（`Label`：political_entity、sexual_Cleavage …）。
 *
 * `applyPolicy` 是按 `verdict.categories` 去查 `policy.categories[c]` 的。
 * 如果这里回的是阿里云标签、而 `CategoryPolicy` 还是那六类，查出来全是 `undefined`
 * ——`undefined !== false` 恒成立，于是**没有任何一类会被抑制**，
 * 运营的开关变成摆设且毫无症状。所以 `CategoryPolicy` 已同步换成防护维度
 * （见 `runtime-config.ts`），本文件回的 `categories` 就是维度名。
 *
 * 用**维度**而不是细粒度标签做策略单位，是因为标签有几百个且会随模型迭代增删，
 * 而维度是产品面的八个，稳定且可解释。标签仍随 `labels` 带出去进审计。
 *
 * # 阿里云的敏感内容检测**只管输入侧**——这条实测出来的边界很要紧
 *
 * 实测（2026-08-10，同一段含姓名/手机号/身份证/地址的文本）：
 *
 * | Service | sensitiveData |
 * |---|---|
 * | `query_security_check_pro` | ✔ 返回（watch/S0，认出姓名、省份、城市） |
 * | `response_security_check_pro` | **完全不返回该维度** |
 * | `response_security_check` | **完全不返回该维度** |
 *
 * 也就是说：**助手回复的脱敏拿不到阿里云的能力**。`output/pii.ts` 那一层
 * 不是"多一道保险"，它是输出侧**唯一**的 PII 防线（§8.3 第 4 条"脱敏永远跑"
 * 因此不是冗余要求，是必需）。流式输出的跨 chunk 脱敏（F-26-05）也仍然要自己解，
 * 不能指望阿里云的 sessionId 拼接——那个只在输入侧有 sensitiveData 可拼。
 *
 * 输入侧拿到的 `Ext.Desensitization`（已打好码的正文）与 `Ext.SensitiveData`
 * （命中样本）仍然带出来：它对"用户把身份证号贴进对话框"这类场景有用。
 */

import type { ContentGuard, GuardVerdict } from "./content-guard";
import {
  AliyunGuardError,
  type AliyunGuardClient,
  type AliyunGuardDetail,
  type AliyunGuardParams,
  type AliyunGuardService,
  type AliyunSuggestion,
} from "./aliyun-client";

/** doc：单次最大 2000 字符。 */
export const ALIYUN_MAX_CHARS = 2000;

/** 合并优先级（doc 表 2 Suggestion 说明）：block > mask > watch > pass。 */
const SUGGESTION_RANK: Record<AliyunSuggestion, number> = {
  pass: 0,
  watch: 1,
  mask: 2,
  block: 3,
};

export function worseSuggestion(a: AliyunSuggestion, b: AliyunSuggestion): AliyunSuggestion {
  return SUGGESTION_RANK[a] >= SUGGESTION_RANK[b] ? a : b;
}

/** 把长文本切成 ≤2000 字符的片段。不截断——被丢掉的那截就是没审过的那截。 */
export function sliceContent(text: string, max = ALIYUN_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

export interface AliyunVerdict extends GuardVerdict {
  /** 阿里云的合并建议：block / mask / watch / pass。 */
  suggestion: AliyunSuggestion;
  /** 细粒度标签（`Label`），审计用。策略不按它过滤——它会随模型迭代增删。 */
  labels: string[];
  /** `sensitiveData` 维度给出的脱敏后正文；未命中时 undefined。 */
  desensitized?: string;
}

/** 把一次响应的 Detail 折成我们的裁决。 */
export function foldDetail(details: AliyunGuardDetail[]): {
  suggestion: AliyunSuggestion;
  blockedDimensions: string[];
  labels: string[];
  desensitized?: string;
} {
  let suggestion: AliyunSuggestion = "pass";
  const blockedDimensions: string[] = [];
  const labels: string[] = [];
  let desensitized: string | undefined;

  for (const d of details) {
    const s = d.Suggestion ?? "pass";
    suggestion = worseSuggestion(suggestion, s);

    // 只有**该维度自己判 block** 才进 categories：applyPolicy 要按维度抑制，
    // 把 watch/mask 也算进去会让"关掉某维度"顺带关掉了观察态的记录。
    if (s === "block" && d.Type) blockedDimensions.push(d.Type);

    for (const r of d.Result ?? []) {
      if (r.Label && r.Label !== "nonLabel") labels.push(r.Label);
      // 取第一份脱敏正文。多个 Result 都带时它们是同一段文本的不同轮次，取谁都一样
      desensitized ??= r.Ext?.Desensitization;
    }
  }
  return { suggestion, blockedDimensions, labels, desensitized };
}

export interface AliyunGuardOptions {
  /**
   * 用 `_pro` 版服务。**默认 true**，因为非 pro 版有一处静默缺失。
   *
   * 实测（2026-08-10）：`sensitiveData`（敏感内容检测）**只在 `_pro` 上返回**。
   * 用非 pro 时，即使阿里云控制台已开启该维度，接口也一条都不会回——
   * 表现就是"控制台开了但没用"，而没有任何报错。
   *
   * 代价是 pro 版计费更高（doc：本接口为收费接口）。要省钱可以关，
   * 但要**同时接受输入侧的个人信息检测消失**，别只看到省钱那一半。
   */
  pro?: boolean;
  /** 生成流式/会话关联 id。默认按调用即时生成，仅用于把 query 与 response 串起来看。 */
  chatId?: () => string;
}

export function createAliyunContentGuard(
  client: AliyunGuardClient,
  opts: AliyunGuardOptions = {},
): ContentGuard {
  const pro = opts.pro ?? true;
  const serviceFor = (role: "input" | "output"): AliyunGuardService => {
    if (role === "input") return pro ? "query_security_check_pro" : "query_security_check";
    return pro ? "response_security_check_pro" : "response_security_check";
  };

  return {
    async check(text, role, stream): Promise<AliyunVerdict> {
      const service = serviceFor(role);
      const slices = sliceContent(text);
      /*
       * 同一 sessionId 让审核引擎把切片**拼起来判**（doc 表 1 sessionId 说明）。
       *
       * 两种来源：
       *  · 传了 `stream` —— 流式送审，整轮共用一个键，`done` 由调用方控制。
       *    这是输出侧边流边审的依据：第 3 片的判定包含前两片的内容。
       *  · 没传 —— 一次性文本，本次调用自成一个会话，末片即 done。
       */
      const sessionId = stream
        ? `${stream.sessionKey}-${role}`
        : (opts.chatId?.() ?? cryptoRandom()) + `-${role}`;

      let suggestion: AliyunSuggestion = "pass";
      const dims = new Set<string>();
      const labels = new Set<string>();
      let desensitized: string | undefined;
      const raws: string[] = [];

      for (let i = 0; i < slices.length; i += 1) {
        const isLastSlice = i === slices.length - 1;
        const params: AliyunGuardParams = {
          content: slices[i],
          sessionId,
          // 流式时只有调用方说"这是最后一片"才置 done——
          // 每次调用都置 done 会把会话提前关掉，后续切片就拼不上前面了
          done: stream ? stream.done && isLastSlice : isLastSlice,
        };
        const res = await client.moderate(service, params);
        raws.push(JSON.stringify(res.Data ?? {}));

        const folded = foldDetail(res.Data?.Detail ?? []);
        // 顶层 Suggestion 与 Detail 折出来的取更严的那个：两者理论上一致，
        // 不一致时按更严处理，**不去猜哪个是对的**
        suggestion = worseSuggestion(worseSuggestion(suggestion, folded.suggestion), res.Data?.Suggestion ?? "pass");
        folded.blockedDimensions.forEach((d) => dims.add(d));
        folded.labels.forEach((l) => labels.add(l));
        desensitized ??= folded.desensitized;
      }

      return {
        // mask/watch 不算不安全：前者是"该脱敏"，后者是"该观察"，
        // 都不该把回答整段拦掉。只有 block 才是拦。
        safe: suggestion !== "block",
        categories: [...dims],
        labels: [...labels],
        desensitized,
        suggestion,
        raw: raws.join("\n"),
      };
    },
  };
}

/** 无依赖的短随机串——只用于关联 id，不用于安全用途。 */
function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}

export { AliyunGuardError };
