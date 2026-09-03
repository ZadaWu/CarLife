/**
 * 操作审计页（施工单 M3-01 的查询侧；筛选与导出在 M3-06 扩展）。
 *
 * 界面上**没有删除按钮**，因为接口层就不存在删除路径（AC-28-10）。
 */

import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../../api";
import { Hint } from "../../components/Hint";

interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  actorRole: "admin" | "ops";
  action: string;
  result: "ok" | "denied" | "error";
  target: string | null;
  detail: Record<string, unknown> | null;
}

interface AuditPage {
  entries: AuditRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * 动作词表：机器名 → 人话 + 它属于哪一类。
 *
 * **表里没有的动作照常显示**（显示机器名本身），不隐藏——审计页最不能做的事
 * 就是"我不认识所以我不显示"。这张表只负责把认识的翻译得好读一点。
 */
const ACTION_META: Record<string, { label: string; group: string }> = {
  "config.update": { label: "修改配置", group: "配置变更" },
  "config.rollback": { label: "回滚配置", group: "配置变更" },
  "guard.policy.update": { label: "修改内容安全策略", group: "配置变更" },
  "message.reveal": { label: "提权查看对话原文", group: "提权查看" },
  "memory.reveal": { label: "提权查看记忆原文", group: "提权查看" },
  "memory.preference.delete": { label: "删除一条偏好记忆", group: "数据变更" },
  "vehicle.upsert": { label: "新建/更新车辆档案", group: "数据变更" },
  "vehicle.set_default": { label: "设为默认车", group: "数据变更" },
  "vehicle.odometer": { label: "更新里程", group: "数据变更" },
  "vehicle.maintenance.append": { label: "追加保养记录", group: "数据变更" },
  "vehicle.vin.backfill": { label: "回填 VIN", group: "数据变更" },
  // 用户体系（M48-02 的两条一直没进词表；M68-02 加两条撤销）
  "user.create": { label: "新建账号", group: "数据变更" },
  "user.password.reset": { label: "重置口令", group: "数据变更" },
  "device.revoke": { label: "撤销设备 / 解绑车机", group: "数据变更" },
  "grant.revoke": { label: "撤销车辆授权", group: "数据变更" },
  "cabin.view": { label: "查看客户座舱", group: "查看" },
  "finance.read": { label: "查看财务概览", group: "查看" },
  "finance.bills": { label: "查看账单", group: "查看" },
  "probe.llm": { label: "探活 LLM", group: "探活" },
  "probe.asr": { label: "探活 ASR", group: "探活" },
  "probe.tts": { label: "探活 TTS", group: "探活" },
  "console.post": { label: "后台写操作", group: "其它后台请求" },
  "console.put": { label: "后台写操作", group: "其它后台请求" },
  "console.delete": { label: "后台删除操作", group: "其它后台请求" },
};

/** 筛选下拉的取值域。空串 = 全部。 */
const ACTIONS = ["", ...Object.keys(ACTION_META)];

/** 这一条值不值得盯：提权与变更类要显眼，探活与查看是背景噪音。 */
function isSensitive(action: string): boolean {
  const g = ACTION_META[action]?.group;
  return g === "配置变更" || g === "提权查看" || g === "数据变更";
}

export function AuditPage(): JSX.Element {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [action, setAction] = useState("");
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams({ limit: "100" });
    if (action) q.set("action", action);
    if (role) q.set("role", role);
    setPage(null);
    api
      .get<AuditPage>(`/console/audit?${q}`)
      .then(setPage)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }, [action, role]);

  useEffect(load, [load]);

  /*
   * 概览是**当前这一页**（最近 100 条 / 已应用筛选）的合计，不是全库统计。
   * 标签上写明了"最近 100 条"——不写的话读者会把它当成全量，
   * 而"被拒绝 0 次"在两种口径下的含义天差地别。
   */
  const summary = page
    ? {
        total: page.entries.length,
        sensitive: page.entries.filter((e) => isSensitive(e.action)).length,
        denied: page.entries.filter((e) => e.result === "denied").length,
        error: page.entries.filter((e) => e.result === "error").length,
        actors: new Set(page.entries.map((e) => e.actor)).size,
      }
    : null;

  return (
    <div className="page">
      <h1>
        操作审计
        <Hint label="本页说明">
          <p>
            <strong>追加式记录，无删除入口</strong>——接口层就不存在删除路径，
            所以"有没有被人抹掉过"这个问题在结构上就不成立。
          </p>
          <p>
            A 类（密钥）变更<strong>只记项名不记值</strong>：审计本身不能变成
            一个读密钥的后门。
          </p>
          <p>
            记的是<strong>治理动作</strong>，不是业务流量。车主的对话、语音转写
            不进这里——它们在「会话与对话」与「轨迹回放」。
          </p>
        </Hint>
      </h1>
      <p className="muted">
        回答一个问题：<strong>谁、在什么时候、动过系统的什么</strong>。
      </p>

      {summary && (
        <div className="audit-summary">
          <div className="audit-stat">
            <span className="audit-stat-num">{summary.total}</span>
            <span className="audit-stat-label">条记录（最近 100 条）</span>
          </div>
          <div className={summary.sensitive > 0 ? "audit-stat audit-stat--hot" : "audit-stat"}>
            <span className="audit-stat-num">{summary.sensitive}</span>
            <span className="audit-stat-label">
              变更与提权
              <Hint label="变更与提权说明">
                <p>
                  配置变更、提权查看原文、数据变更三类。<strong>这是这一页真正要看的东西</strong>——
                  探活与查看是背景噪音，它们不改变任何状态。
                </p>
              </Hint>
            </span>
          </div>
          <div className={summary.denied > 0 ? "audit-stat audit-stat--warn" : "audit-stat"}>
            <span className="audit-stat-num">{summary.denied}</span>
            <span className="audit-stat-label">被拒绝</span>
          </div>
          <div className={summary.error > 0 ? "audit-stat audit-stat--err" : "audit-stat"}>
            <span className="audit-stat-num">{summary.error}</span>
            <span className="audit-stat-label">出错</span>
          </div>
          <div className="audit-stat">
            <span className="audit-stat-num">{summary.actors}</span>
            <span className="audit-stat-label">个操作者</span>
          </div>
        </div>
      )}

      <div className="filters">
        <label className="field">
          <span>动作</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a ? `${ACTION_META[a]?.label ?? a}（${a}）` : "全部动作"}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>角色</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">全部</option>
            <option value="admin">admin</option>
            <option value="ops">ops</option>
          </select>
        </label>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {!page ? (
        <p className="muted">载入中…</p>
      ) : page.entries.length === 0 ? (
        <p className="muted">暂无记录。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>主体</th>
              <th>角色</th>
              <th>动作</th>
              <th>结果</th>
              <th>
                目标
                <Hint label="目标列说明">
                  <p>
                    这次操作**作用在谁身上**：配置项名、会话 id、车辆 VIN，
                    或后台请求的路径。<strong>密钥变更只到项名为止</strong>，不含值。
                  </p>
                </Hint>
              </th>
            </tr>
          </thead>
          <tbody>
            {page.entries.map((e) => (
              <tr key={e.id} className={isSensitive(e.action) ? "audit-row--hot" : undefined}>
                <td className="mono">{new Date(e.at).toLocaleString()}</td>
                <td>{e.actor}</td>
                <td>
                  <span className={`role-badge role-${e.actorRole}`}>{e.actorRole}</span>
                </td>
                {/* 人话在前、机器名在后：机器名是查代码与提工单要用的，不能省。 */}
                <td>
                  <span className="audit-action">{ACTION_META[e.action]?.label ?? e.action}</span>
                  <span className="audit-action-raw mono">{e.action}</span>
                </td>
                <td>
                  <span className={`result-badge result-${e.result}`}>{e.result}</span>
                </td>
                <td className="mono ellipsis" title={e.target ?? undefined}>{e.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
