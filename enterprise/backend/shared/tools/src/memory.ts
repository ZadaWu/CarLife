/**
 * preference_recall —— ③偏好记忆读取（§7③）。
 *
 * # 只读，且只读③
 *
 * 写入走记忆层自己的路径（衰减、访问强化、metadata 约定都在那边）。
 * 工具层开一个写口子的代价是：模型可以把用户随口一句话固化成"偏好"，
 * 而③是**慢衰减、不硬删**的那一类——写错了会跟着用户很久。
 *
 * 也不读②情景：情景记忆带具体时间地点，混进闲聊上下文里
 * 很容易变成"我记得你上周去了哪儿"，那是另一个产品决定，不该由一个工具顺手做掉。
 *
 * # "没有偏好"与"读不到偏好"必须分开
 *
 * 前者是用户的真实状态（新用户就是没有），后者是我们的故障。
 * 混成一个，系统会把"记忆服务挂了"说成"我还不太了解你"——
 * 听起来无害，实际是在用一句谎话掩盖一次故障。
 * 未接入时抛 `unconfigured`；接入但零结果时正常返回空列表。
 *
 * 与其他工具一样用注入拿存储：`enterprise/backend/shared/tools` 不连数据库、不连 Mem0。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export interface RecalledPreference {
  content: string;
  /** 检索相似度；Mem0 未给时省略——**不补一个假的**。 */
  score?: number;
  domain?: string;
  /** 0–1。低置信度的偏好不该被当成事实陈述给用户。 */
  confidence?: number;
}

export interface PreferenceRecallArgs {
  userId: string;
  /** 检索词；省略则取该用户最近的若干条。 */
  query?: string;
  limit?: number;
}

export interface PreferenceRecallData {
  preferences: RecalledPreference[];
  /**
   * 检索降级：**这次没查到不代表没有**。
   * 调用方不得把降级下的空结果当成"用户没有这个偏好"（F-16-08 同源）。
   */
  degraded: boolean;
}

export interface PreferenceStore {
  recall(userId: string, query: string | undefined, limit: number): Promise<PreferenceRecallData>;
}

let store: PreferenceStore | undefined;

/** 装配层注入。传 undefined 表示③未接入。 */
export function setPreferenceStore(s: PreferenceStore | undefined): void {
  store = s;
}

export function getPreferenceStore(): PreferenceStore | undefined {
  return store;
}

export const preferenceRecallTool: ExternalTool<PreferenceRecallArgs, PreferenceRecallData> =
  defineExternalTool<PreferenceRecallArgs, PreferenceRecallData>({
    name: "preference_recall",
    provider: "carlife-memory",
    timeoutMs: 5_000,
    async real(args) {
      if (!store) {
        throw new ToolError("preference_recall", "unconfigured", "③偏好记忆未接入", false);
      }
      if (!args.userId?.trim()) {
        // 跨用户混读是严重事故；没有用户维度就不该有结果。
        throw new ToolError("preference_recall", "invalid", "缺 userId——偏好必须带用户维度", false);
      }
      return store.recall(args.userId, args.query, args.limit ?? 5);
    },
    /**
     * mock：给两条**明显是模拟**的偏好。
     *
     * 内容刻意写得能被一眼认出是假的（"模拟"二字在内），
     * 因为座舱陪伴最容易犯的错就是"假装认识用户"——
     * 一条看起来真实的 mock 偏好被念出来，没人分得清。
     */
    mock() {
      return {
        preferences: [
          { content: "（模拟）习惯把车内温度设在 24℃", domain: "cabin", confidence: 0.7 },
          { content: "（模拟）长途时喜欢每两小时停一次", domain: "trip", confidence: 0.6 },
        ],
        degraded: false,
      };
    },
  });
