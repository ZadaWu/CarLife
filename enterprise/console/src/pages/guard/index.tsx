/**
 * Guard 策略与止血开关（施工单 TD-03，FL-30 F-30-01/02/03）。
 *
 * # 与「系统配置」页的分权正好相反
 *
 * `/config` 是 admin 独有（模型端点、API key）——让运营持有"把审核指向任意端点"
 * 的能力等于给内容安全开后门。
 *
 * 本页**运营可写**：出事时要能立刻按下止血开关，而"运营找不到管理员就按不下去"
 * 是比越权更现实的风险。红线区块只对 admin 显示，且**没有任何写入控件**——
 * 它不在库里，压根没有落点。
 *
 * 菜单裁剪与本页的 admin 分支都只是体验；**权限判定在服务端**，
 * 直接敲 URL 一样会被 403 挡住。
 */

import { useCallback, useEffect, useState } from "react";

import { api } from "../../api";
import { useIdentity } from "../../app/identity";
import "./guard.css";

type FailMode = "open" | "closed";

interface GuardPolicy {
  categories: Record<string, boolean>;
  inputFailMode: FailMode;
  outputFailMode: FailMode;
}

interface KillSwitch {
  agents: string[];
  capabilities: string[];
}

interface Revision {
  id: string;
  actor: string;
  actorRole: string;
  at: number;
  prevValue: GuardPolicy | null;
  nextValue: GuardPolicy;
}

interface PolicyResponse {
  policy: GuardPolicy;
  /** `default` 意味着这套策略**从没被人确认过**，与"运营设过同样的值"不是一回事。 */
  policySource: "db" | "default";
  policyUpdatedBy?: string;
  policyUpdatedAt?: number;
  killSwitch: KillSwitch;
  killUpdatedBy?: string;
  history: Revision[];
}

const AGENTS = ["supervisor", "buying", "ownership", "trip", "cabin", "service"] as const;

interface Disclaimer {
  label: string;
  text: string;
  nextStep: string;
}
interface DisclaimerText {
  service: Record<"low" | "medium" | "high", Disclaimer>;
  finance: Disclaimer;
}
interface DisclaimerResponse {
  policy: { serviceEnabled: boolean; financeEnabled: boolean };
  policySource: "db" | "default";
  text: DisclaimerText;
  textSource: "db" | "default";
  updatedBy?: string;
  maxChars: number;
}

const RISK_LABEL: Record<string, string> = { low: "风险：低", medium: "风险：中", high: "风险：高" };

/**
 * 防护维度（TD-04 起对齐阿里云 AI 安全护栏的 `Type`）。
 *
 * 顺序按运营关注度排：内容合规与提示词攻击是日常会调的，
 * 恶意文件/URL 目前用不上但留着——控制台开了它就会回。
 */
const CATEGORY_LABEL: Record<string, string> = {
  contentModeration: "内容合规（涉政 / 色情 / 广告法…）",
  promptAttack: "提示词攻击（越狱 / 拒绝抑制）",
  sensitiveData: "敏感内容（手机号 / 证件 / 银行卡）",
  modelHallucination: "模型幻觉",
  maliciousUrl: "恶意 URL",
  maliciousFile: "恶意文件",
  customLabel: "自定义检测",
};

export function GuardPage(): JSX.Element {
  const identity = useIdentity();
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [draft, setDraft] = useState<GuardPolicy | null>(null);
  const [kill, setKill] = useState<KillSwitch>({ agents: [], capabilities: [] });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [redlines, setRedlines] = useState<{ hardBlocks: string[]; capabilities: string[] } | null>(null);
  const [disc, setDisc] = useState<DisclaimerResponse | null>(null);
  const [discDraft, setDiscDraft] = useState<DisclaimerResponse | null>(null);
  const [discError, setDiscError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<PolicyResponse>("/console/guard/policy");
    setData(r);
    setDraft(r.policy);
    setKill(r.killSwitch);
  }, []);

  const loadDisc = useCallback(async () => {
    const r = await api.get<DisclaimerResponse>("/console/guard/disclaimer");
    setDisc(r);
    setDiscDraft(r);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
    loadDisc().catch((e) => setDiscError(String(e)));
  }, [load, loadDisc]);

  useEffect(() => {
    if (identity.role !== "admin") return;
    api
      .get<{ hardBlocks: string[]; capabilities: string[] }>("/console/guard/redlines")
      .then(setRedlines)
      .catch(() => setRedlines(null));
  }, [identity.role]);

  const savePolicy = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await api.post("/console/guard/policy", draft);
      await load();
    } catch (e) {
      // 服务端的硬校验（两侧不能同时 fail-open、至少一个分类）在这里显形。
      // 前端**不重复实现这条校验**——两处校验必然漂移，而漂移的方向
      // 通常是前端放宽了。
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveKill = async (next: KillSwitch) => {
    setSaving(true);
    setError(null);
    try {
      await api.post("/console/guard/kill", next);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveDisc = async () => {
    if (!discDraft) return;
    setSaving(true);
    setDiscError(null);
    try {
      await api.post("/console/guard/disclaimer", { policy: discDraft.policy, text: discDraft.text });
      await loadDisc();
    } catch (e) {
      // 三条红线（售后免责不可关 / 不能为空 / 不能超长）由服务端判，
      // 前端**不重复实现**——两处校验必然漂移，而漂移通常是前端放宽了
      setDiscError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const editDisclaimer = (where: "finance" | "low" | "medium" | "high", field: keyof Disclaimer, v: string) => {
    if (!discDraft) return;
    const next = structuredClone(discDraft);
    if (where === "finance") next.text.finance[field] = v;
    else next.text.service[where][field] = v;
    setDiscDraft(next);
  };

  if (!data || !draft) return <div className="gd-page">载入中…</div>;

  const enabledCount = Object.values(draft.categories).filter(Boolean).length;

  return (
    <div className="gd-page">
      <h1>内容安全策略</h1>

      {data.policySource === "default" && (
        <p className="gd-banner gd-banner--warn">
          当前跑的是<strong>代码里的默认策略</strong>，这套值从没被人确认过。保存一次即记录为运营决定。
        </p>
      )}
      {data.policyUpdatedBy && (
        <p className="gd-meta">
          最近由 {data.policyUpdatedBy} 于 {new Date(data.policyUpdatedAt ?? 0).toLocaleString()} 修改
        </p>
      )}
      {error && <p className="gd-banner gd-banner--err">{error}</p>}

      <div className="gd-grid">
        <section className="gd-card">
          <h2>分类开关</h2>
          <p className="gd-hint">
            关掉某维度 = 该维度命中时<b>不再拦截</b>，放行会带上「被抑制的维度」进审计，
            便于回答「因为我关了这维度，放过了多少」。
          </p>
          <p className="gd-hint gd-hint--warn">
            ⚠️ 这些开关<b>只能「关」，不能「开」</b>。某维度是否参与检测由
            阿里云控制台（AI 安全护栏 → 防护配置）决定；这里打勾只表示
            「该维度回来的拦截我认」，不代表阿里云在检它。
            用 <code>corepack pnpm probe:aliyun-guard</code> 看本账号实际生效哪几个维度。
          </p>
          {Object.keys(CATEGORY_LABEL).map((key) => {
            const on = draft.categories[key] ?? true;
            return (
              <label key={key} className={`gd-switch ${on ? "gd-switch--on" : "gd-switch--off"}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    setDraft({ ...draft, categories: { ...draft.categories, [key]: e.target.checked } })
                  }
                />
                {CATEGORY_LABEL[key]}
                <span className="gd-switch-state">{on ? "拦截我认" : "已抑制"}</span>
                <code>{key}</code>
              </label>
            );
          })}
          {enabledCount === 0 && (
            <p className="gd-hint gd-hint--err">至少要启用一个维度，否则内容审核不产生任何拦截。</p>
          )}

          <h2 style={{ marginTop: 18 }}>fail 模式</h2>
          <p className="gd-hint">
            审核模型不可用时怎么办。<b>两侧不能同时 open</b>——那等于审核层被关闭，
            且系统照常回答、毫无症状。服务端会硬拒。
          </p>
          <div className="gd-fail">
            <label>
              <span>输入侧</span>
              <select
                value={draft.inputFailMode}
                onChange={(e) => setDraft({ ...draft, inputFailMode: e.target.value as FailMode })}
              >
                <option value="open">open —— 模型挂了不堵死正常对话</option>
                <option value="closed">closed —— 模型挂了即拦截</option>
              </select>
            </label>
            <label>
              <span>输出侧</span>
              <select
                value={draft.outputFailMode}
                onChange={(e) => setDraft({ ...draft, outputFailMode: e.target.value as FailMode })}
              >
                <option value="closed">closed —— 宁可不回复也不放行未审核内容</option>
                <option value="open">open —— 放行未审核输出</option>
              </select>
            </label>
          </div>
          <button className="gd-save" onClick={savePolicy} disabled={saving}>
            保存策略
          </button>
        </section>

        <section className="gd-card gd-card--danger">
          <h2>止血开关</h2>
          <p className="gd-hint">
            出事时立刻关停某个 Agent 或能力。<b>Agent 级关闭在编排层生效</b>（路由不再指向该子图），
            不是去停 pi-acp 进程——那个由它自己管理生命周期。点击即生效，无需另存。
          </p>
          <div className="gd-kills">
            {AGENTS.map((a) => {
              const killed = kill.agents.includes(a);
              return (
                <button
                  type="button"
                  key={a}
                  className={`gd-kill${killed ? " gd-kill--killed" : ""}`}
                  title={killed ? `恢复 ${a}` : `关停 ${a}`}
                  onClick={() => {
                    const next = {
                      ...kill,
                      agents: killed ? kill.agents.filter((x) => x !== a) : [...kill.agents, a],
                    };
                    setKill(next);
                    void saveKill(next);
                  }}
                >
                  <i />
                  {a}
                </button>
              );
            })}
          </div>
          {kill.agents.length > 0 && (
            <p className="gd-hint gd-hint--warn">
              当前已关停：{kill.agents.join("、")}
              {data.killUpdatedBy ? `（由 ${data.killUpdatedBy} 按下）` : ""}
            </p>
          )}

          {identity.role === "admin" && (
            <>
              <h2 style={{ marginTop: 18 }}>红线（只读）</h2>
              <p className="gd-hint">
                <b>不在数据库里，也没有写入接口</b>——它们只存在于代码。
                列在这里是为了能回答"到底哪些是永远不可改的"。
              </p>
              {redlines ? (
                <ul className="gd-redlines">
                  {redlines.hardBlocks.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                  {redlines.capabilities.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              ) : (
                <p className="gd-hint">红线快照拉取失败（agent-runtime 未启动？）</p>
              )}
            </>
          )}
        </section>

        <section className="gd-card gd-card--span">
          <h2>免责话术</h2>
          {discError && <p className="gd-banner gd-banner--err">{discError}</p>}
          {discDraft ? (
            <>
              <p className="gd-hint">
                渲染形如 <code>【风险：高】以下为 AI 辅助判断…建议尽快停车检查。</code>
                单条渲染后不超过 <b>{discDraft.maxChars}</b> 字：
                免责一旦淹没实质回答，用户会连实质回答一起跳过——<b>那比不加免责更危险</b>。
              </p>
              {disc?.textSource === "default" && (
                <p className="gd-banner gd-banner--warn">当前是代码里的默认文案，从没被人确认过。保存一次即记录为运营决定。</p>
              )}

              <div className="gd-disc-toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={discDraft.policy.serviceEnabled}
                    disabled
                    title="售后免责不可关闭——它是安全承诺不是文案偏好（§8.3）"
                  />
                  售后免责
                  <span className="gd-hint">（不可关闭：安全承诺，非文案偏好）</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={discDraft.policy.financeEnabled}
                    onChange={(e) =>
                      setDiscDraft({
                        ...discDraft,
                        policy: { ...discDraft.policy, financeEnabled: e.target.checked },
                      })
                    }
                  />
                  金融/测算免责
                  <span className="gd-hint">（可关：不同地区合规要求不同）</span>
                </label>
              </div>

              <div className="gd-fieldsets">
                {(["low", "medium", "high"] as const).map((r) => (
                  <fieldset key={r} className={`gd-fieldset gd-fieldset--${r}`}>
                    <legend>售后 · {RISK_LABEL[r]}</legend>
                    {(["label", "text", "nextStep"] as const).map((f) => (
                      <label key={f} className="gd-field-row">
                        <span>{f === "label" ? "标签" : f === "text" ? "免责" : "下一步"}</span>
                        <input type="text" value={discDraft.text.service[r][f]} onChange={(e) => editDisclaimer(r, f, e.target.value)} />
                      </label>
                    ))}
                  </fieldset>
                ))}
                <fieldset className="gd-fieldset">
                  <legend>金融 / 测算</legend>
                  {(["label", "text", "nextStep"] as const).map((f) => (
                    <label key={f} className="gd-field-row">
                      <span>{f === "label" ? "标签" : f === "text" ? "免责" : "下一步"}</span>
                      <input type="text" value={discDraft.text.finance[f]} onChange={(e) => editDisclaimer("finance", f, e.target.value)} />
                    </label>
                  ))}
                </fieldset>
              </div>

              <button className="gd-save" onClick={saveDisc} disabled={saving}>
                保存话术
              </button>
              {disc?.updatedBy && <p className="gd-meta" style={{ marginTop: 8 }}>最近由 {disc.updatedBy} 修改</p>}
            </>
          ) : (
            <p className="gd-hint">载入中…</p>
          )}
        </section>

        <section className="gd-card gd-card--span">
          <h2>变更历史</h2>
          {data.history.length === 0 ? (
            <p className="gd-empty">还没有变更记录。</p>
          ) : (
            <table className="gd-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者</th>
                  <th>角色</th>
                  <th>变更</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((r) => (
                  <tr key={r.id}>
                    <td className="gd-td-time">{new Date(r.at).toLocaleString()}</td>
                    <td>{r.actor}</td>
                    <td>
                      <span className="gd-role">{r.actorRole}</span>
                    </td>
                    <td className="gd-diff">
                      {/* 保留旧值才能回答"那次误伤是在哪套策略下发生的" */}
                      {r.prevValue ? (
                        <>
                          {r.prevValue.inputFailMode}/{r.prevValue.outputFailMode} <b>→</b> {r.nextValue.inputFailMode}/{r.nextValue.outputFailMode}
                        </>
                      ) : (
                        "首次写入"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
