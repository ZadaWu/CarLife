/**
 * agent 路由目标与拦截层的中文名表（施工单 M56-01）。
 *
 * 一处维护，两处消费：scenarios runner 的失败串（「期望 ownership（用车助手），
 * 实际 cabin（座舱陪伴）」）与题库文档生成器。中文名抄自架构文档 §4 的 Agent 命名；
 * 表外值原样返回不报错——路由目标将来会增，评测不该因为一个新目标先红在标注上。
 */

export const AGENT_LABELS: Readonly<Record<string, string>> = {
  ownership: "用车助手",
  service: "售后服务",
  buying: "购车顾问",
  testDrive: "试驾预约",
  cabin: "座舱陪伴",
  trip: "出行规划",
  itinerary: "行程规划",
  general: "通用对话",
};

export const LAYER_LABELS: Readonly<Record<string, string>> = {
  input: "输入规则筛",
  moderation: "内容审核",
  answer: "对话风险门/模型拒绝",
  action_gate: "动作权限门",
  output_pii: "出口脱敏（已退役）",
};

/** `ownership` → `ownership（用车助手）`；表外值原样返回。 */
export function agentLabel(name: string | undefined): string {
  if (!name) return String(name);
  const zh = AGENT_LABELS[name];
  return zh ? `${name}（${zh}）` : name;
}

/** `answer` → `answer（对话风险门/模型拒绝）`；表外值原样返回。 */
export function layerLabel(name: string | undefined): string {
  if (!name) return String(name);
  const zh = LAYER_LABELS[name];
  return zh ? `${name}（${zh}）` : name;
}
