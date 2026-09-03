/**
 * domain/user — 用户与角色领域模型（FL-34 F-34-02）。
 *
 * # 两套身份，不能混
 *
 *  - **车主**（`UserId` / `UserProfile`）：使用产品的人，记忆与车辆档案都按他隔离；
 *  - **后台身份**（`ConsoleRole`）：管理员与运营，操作的是配置与他人的数据。
 *
 * 合成一套会立刻出问题：后台身份**没有**"自己的车"与"自己的记忆"，
 * 而车主**永远不该**拿到配置写权限。类型分开是第一道闸。
 */

/**
 * 车主标识。
 *
 * 所有记忆读写与⑥流水查询都必须带它——`@carlife/memory` 的客户端在无用户维度时
 * **直接拒绝**而不是读全量（M7-01 边界）。这不是防御性编程：读全量的后果是
 * 把别人的偏好当成这位车主的。
 */
export type UserId = string;

/** 提醒频率偏好。默认值偏保守（宁可少提醒），高频用户可以调密。 */
export interface ReminderPreference {
  enabled: boolean;
  /** 去重窗口天数：同一辆车同一类到期，窗口内已提过就不再提（F-17-07）。 */
  dedupeDays: number;
}

/**
 * 车主档案。
 *
 * **刻意很薄**：偏好属于③记忆（Mem0，带衰减与访问强化），不进这里。
 * 把偏好塞进结构化档案会让它们失去衰减语义——"三年前说过喜欢安静的餐厅"
 * 和"上周刚确认过"会被一视同仁。
 */
export interface UserProfile {
  id: UserId;
  /** 称呼。用于话术，不是全名。 */
  displayName?: string;
  /** 名下车辆的 VIN 列表，默认车排最前（F-23-09）。 */
  vehicleVins: string[];
  /** 提醒设置。落 PG **不落 Mem0**——这是配置而非记忆，不该参与衰减与 re-rank。 */
  reminder?: ReminderPreference;
}

/**
 * 后台角色（M3-01 角色矩阵）。
 *
 * 与 `@carlife/db` 的 `AuditRole` 同一套取值：**同一动作由谁做出必须可区分**，
 * 因此审计表记的是这个值，不是"某个管理员"。
 */
export type ConsoleRole = "admin" | "ops";

/**
 * 审计结果三态。
 *
 * `denied` 单独成一态而不是并进 `error`：**越权尝试比成功操作更值得记录**（AC-28-10），
 * 混进 error 里会被当成系统故障过滤掉。
 */
export type AuditResult = "ok" | "denied" | "error";

/** 后台操作主体。 */
export interface ConsoleActor {
  /** 后台身份 subject。 */
  subject: string;
  role: ConsoleRole;
}

/** 默认提醒设置：开启，7 天去重窗口。 */
export const DEFAULT_REMINDER_PREFERENCE: ReminderPreference = {
  enabled: true,
  dedupeDays: 7,
};
