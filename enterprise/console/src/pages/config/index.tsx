/**
 * 系统配置页（施工单 M3-03）—— admin 独有。
 *
 * 三件事决定它有没有用：
 *   1. **来源标注**：当前值来自 DB / 环境变量 / 代码默认值——出事时第一个要看的
 *   2. **保存前探活**：填错的 key 要在这里红，不是在演示当天红
 *   3. **生效时间提示**：告诉人"约 30s 生效"，否则会反复点保存
 *
 * 密钥永远是掩码；编辑是"写入新值"而不是"回显后修改"。
 */

import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../../api";
import "./config.css";

interface ConfigItem {
  key: string;
  scope: "llm" | "asr" | "tts" | "runtime" | "bootstrap";
  isSecret: boolean;
  writable: boolean;
  required: boolean;
  value: string | null;
  source: "db" | "env" | "default" | "unset";
  description: string;
  howToObtain?: string;
  /** 闭集取值：有它就渲染下拉而不是文本框。 */
  options?: string[];
  updatedBy: string | null;
  updatedAt: string | null;
  verifiedAt: string | null;
}

interface Revision {
  id: string;
  changedAt: string;
  changedBy: string;
  isSecret: boolean;
  restorable: boolean;
}

interface ProbeCheck {
  name: string;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  errorKind?: string;
  message?: string;
}

interface ProbeReport {
  target: string;
  mode: "real" | "fake";
  provider: string;
  model: string;
  checks: ProbeCheck[];
  ok: boolean;
}

const SCOPES: Array<{ id: ConfigItem["scope"]; label: string; probe?: string }> = [
  { id: "llm", label: "LLM（对话模型）", probe: "llm" },
  { id: "asr", label: "ASR（语音识别）", probe: "asr" },
  { id: "tts", label: "TTS（语音合成）", probe: "tts" },
  { id: "runtime", label: "运行时开关" },
  { id: "bootstrap", label: "引导层（由部署环境注入）" },
];

/**
 * 闭集取值的人话。**计费与否要写进选项本身**——只在 description 里提一句的话，
 * 下拉展开的那一刻它不在视线里，而那正是做决定的一刻。
 *
 * ⚠️ **按配置键分组，不能只按取值**。原来是一张全局的 `值 → 文案` 表，于是
 * `ASR_ENGINE=mock` 和 `TTS_ENGINE=mock` 共用同一句"本机 say"——而它们是
 * 两个完全不同的服务：ASR 的 mock 是 local-asr 容器（llama.cpp + Qwen3-ASR，
 * 跑**真模型**，只是在本机），TTS 的 mock 才是 mocks/tts 的 say 包装。
 * 同名不同物在这张表里必然撞车，2026-09-01 走查抓到（当时下拉里 ASR 的 mock
 * 写着"本机 say"）。新增闭集项时按键加一组，不要往公共表里塞。
 */
const OPTION_LABEL: Record<string, Record<string, string>> = {
  ASR_ENGINE: {
    ark: "ark —— 火山方舟豆包 omni（按 token 计费）",
    aliyun: "aliyun —— 百炼 qwen3-asr-flash（按秒计费）",
    mock: "mock —— 本机 local-asr 容器（真模型，不计费）",
  },
  TTS_ENGINE: {
    mock: "mock —— 本机 mock-tts（say 包装，不计费）",
    doubao: "doubao —— 豆包 seed-tts-2.0（按合成字数计费）",
    aliyun: "aliyun —— 百炼 qwen3-tts-flash（按字符计费）",
  },
};

const SOURCE_LABEL: Record<ConfigItem["source"], string> = {
  db: "DB",
  env: "环境变量",
  default: "代码默认值",
  unset: "未配置",
};

export function ConfigPage(): JSX.Element {
  const [items, setItems] = useState<ConfigItem[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [probes, setProbes] = useState<Record<string, ProbeReport | "running">>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Record<string, Revision[]>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ items: ConfigItem[] }>("/console/config")
      .then((r) => setItems(r.items))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? (e.isForbidden ? "没有权限（仅 admin）" : e.code) : String(e)),
      );
  }, []);

  useEffect(load, [load]);

  async function runProbe(target: string): Promise<ProbeReport | null> {
    setProbes((p) => ({ ...p, [target]: "running" }));
    try {
      const report = await api.post<ProbeReport>(`/console/probe/${target}`);
      setProbes((p) => ({ ...p, [target]: report }));
      return report;
    } catch (e) {
      setProbes((p) => {
        const next = { ...p };
        delete next[target];
        return next;
      });
      setError(e instanceof ApiError ? e.code : String(e));
      return null;
    }
  }

  async function save(scope: ConfigItem["scope"], probeTarget?: string): Promise<void> {
    const pending = (items ?? []).filter((i) => i.scope === scope && drafts[i.key] !== undefined);
    if (pending.length === 0) return;

    // 保存前先探活：填错的值要在这里红
    let forced = false;
    if (probeTarget) {
      const report = await runProbe(probeTarget);
      if (report && !report.ok) {
        forced = window.confirm(
          "探活未通过。仍要保存吗？\n\n" +
            "保存后该项会被标记为「未验证」——验证服务挂了不该让你改不了配置，" +
            "但也不能假装它是好的。",
        );
        if (!forced) return;
      }
    }

    const result = await api.post<{
      accepted: string[];
      rejected: Array<{ key: string; reason: string }>;
    }>("/console/config", {
      items: pending.map((i) => ({ key: i.key, value: drafts[i.key] })),
      forced,
    });

    setDrafts((d) => {
      const next = { ...d };
      for (const k of result.accepted) delete next[k];
      return next;
    });
    setNotice(
      result.rejected.length > 0
        ? `已保存 ${result.accepted.length} 项；被拒绝：${result.rejected
            .map((r) => `${r.key}（${r.reason}）`)
            .join("，")}`
        : `已保存 ${result.accepted.length} 项。约 30s 内生效（配置缓存 TTL），无需重启服务；` +
          `TTS 引擎的切换还要再等端上复查一次（同为 30s 量级），无需重启客户端。`,
    );
    load();
  }

  async function showRevisions(key: string): Promise<void> {
    const r = await api.get<{ revisions: Revision[] }>(`/console/config/${key}/revisions`);
    setRevisions((m) => ({ ...m, [key]: r.revisions }));
  }

  async function rollback(key: string): Promise<void> {
    const r = await api.post<{ ok: boolean; reason?: string }>(`/console/config/${key}/rollback`)
      .catch((e: unknown) =>
        e instanceof ApiError ? { ok: false, reason: e.code } : { ok: false, reason: String(e) },
      );
    setNotice(r.ok ? `已回滚 ${key} 到上一版本。` : `回滚失败：${r.reason ?? "未知原因"}`);
    load();
  }

  if (error) return <div className="cf-page"><h1>系统配置</h1><p className="cf-banner cf-banner--warn">{error}</p></div>;
  if (!items) return <div className="cf-page"><h1>系统配置</h1><p className="cf-desc">载入中…</p></div>;

  const fakeModes = items.filter((i) => i.scope === "runtime" && i.value === "fake");
  const ttsEngine = items.find((i) => i.key === "TTS_ENGINE")?.value ?? "mock";
  /*
   * 端侧逃生阀（客户端进程的 CARLIFE_TTS）**优先于**这里的引擎开关。
   * 不把它摆到最上面的话，"后台切了没反应"会被当成开关坏了去查服务端——
   * 而真正的原因在某台车机的 .env 里，隔着一个进程边界，从这里看不见。
   */
  const localOverride = items.find(
    (i) => i.key === "CARLIFE_TTS" && (i.value === "say" || i.value === "off"),
  );

  return (
    <div className="cf-page">
      <h1>系统配置</h1>
      <p className="cf-desc">
        密钥一律掩码显示；编辑框是「写入新值」而不是回显后修改。修改后<b>约 30s 生效，不重启服务</b>。
      </p>

      {fakeModes.length > 0 ? (
        <div className="cf-banner cf-banner--warn">
          当前处于 Fake 模式：{fakeModes.map((i) => i.key).join("、")} —— 对话/识别不会走真实 provider。
          演示前请确认这是你要的状态。
        </div>
      ) : null}
      {ttsEngine === "doubao" ? (
        <div className="cf-banner cf-banner--warn">
          语音合成正接在 <strong>豆包 seed-tts-2.0</strong> 上——按合成字数计费。
          开发与联调期请切回 mock（本机 mock-tts，say 包装成同一套协议，不花钱）。
        </div>
      ) : null}
      {localOverride ? (
        <div className="cf-banner cf-banner--warn">
          检测到端侧逃生阀 <span className="mono">CARLIFE_TTS={localOverride.value}</span>
          （来源：{SOURCE_LABEL[localOverride.source]}）。
          <strong>它优先于上面的 TTS_ENGINE 开关</strong>：装了这个值的客户端不会走
          服务端下发的端点，在这里切引擎对它没有效果。要让开关生效，
          请去掉那台客户端的这项环境变量。
        </div>
      ) : null}
      {notice ? <div className="cf-banner cf-banner--ok">{notice}</div> : null}

      {SCOPES.map((scope) => {
        const scopeItems = items.filter((i) => i.scope === scope.id);
        if (scopeItems.length === 0) return null;
        const probe = scope.probe ? probes[scope.probe] : undefined;
        const dirty = scopeItems.some((i) => drafts[i.key] !== undefined);

        return (
          <section key={scope.id} className="cf-scope">
            <div className="cf-scope-head">
              <h2>{scope.label}</h2>
              {scope.probe ? (
                <>
                  <button
                    type="button"
                    className="cf-btn cf-btn--ghost"
                    onClick={() => void runProbe(scope.probe!)}
                    disabled={probe === "running"}
                  >
                    {probe === "running" ? "探活中…" : "探活"}
                  </button>
                  <button
                    type="button"
                    className="cf-btn"
                    onClick={() => void save(scope.id, scope.probe)}
                    disabled={!dirty}
                  >
                    保存并探活
                  </button>
                </>
              ) : null}
            </div>

            {probe && probe !== "running" ? <ProbeResult report={probe} /> : null}

            <table className="cf-table">
              <thead>
                <tr>
                  <th>配置项</th>
                  <th>当前生效值</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>新值</th>
                  <th>历史</th>
                </tr>
              </thead>
              <tbody>
                {scopeItems.map((item) => (
                  <tr key={item.key}>
                    <td>
                      <div className="cf-key">{item.key}</div>
                      <div className="cf-key-desc">{item.description}</div>
                      {item.howToObtain ? <div className="cf-key-desc">获取：{item.howToObtain}</div> : null}
                    </td>
                    <td>
                      {item.value != null ? (
                        <span className="cf-value">{item.value}</span>
                      ) : (
                        <span className="cf-value cf-value--empty">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`cf-source cf-source--${item.source}`}>
                        <i />
                        {SOURCE_LABEL[item.source]}
                      </span>
                    </td>
                    <td>
                      {item.writable ? (
                        item.verifiedAt ? (
                          <span className="cf-badge cf-badge--ok">已验证</span>
                        ) : item.source === "db" ? (
                          <span className="cf-badge cf-badge--warn">未验证</span>
                        ) : (
                          <span className="cf-value--empty">—</span>
                        )
                      ) : (
                        <span className="cf-badge">只读</span>
                      )}
                      {item.updatedBy ? (
                        <div className="cf-meta">
                          {item.updatedBy} · {new Date(item.updatedAt!).toLocaleString()}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {item.writable ? (
                        item.options ? (
                          // 闭集项给下拉：引擎名打错一个字，要到端上不出声才会被发现
                          <select
                            value={drafts[item.key] ?? item.value ?? ""}
                            onChange={(e) => setDrafts((d) => ({ ...d, [item.key]: e.target.value }))}
                          >
                            {item.options.map((o) => (
                              <option key={o} value={o}>
                                {OPTION_LABEL[item.key]?.[o] ?? o}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={item.isSecret ? "password" : "text"}
                            value={drafts[item.key] ?? ""}
                            placeholder={item.isSecret ? "写入新值" : "留空则不变"}
                            onChange={(e) => setDrafts((d) => ({ ...d, [item.key]: e.target.value }))}
                          />
                        )
                      ) : (
                        <span className="cf-value--empty">不可改</span>
                      )}
                    </td>
                    <td>
                      {item.writable ? (
                        <>
                          <button type="button" className="cf-link" onClick={() => void showRevisions(item.key)}>
                            变更历史
                          </button>
                          <button
                            type="button"
                            className="cf-link"
                            disabled={item.isSecret}
                            title={
                              item.isSecret
                                ? "密钥类不保存旧值（不为回滚而留一份旧密文）——请重新填写新值"
                                : "回滚到上一版本"
                            }
                            onClick={() => void rollback(item.key)}
                          >
                            回滚
                          </button>
                          {revisions[item.key] ? (
                            <ul className="cf-revs">
                              {revisions[item.key].length === 0 ? (
                                <li>无变更记录</li>
                              ) : (
                                revisions[item.key].map((r) => (
                                  <li key={r.id}>
                                    {new Date(r.changedAt).toLocaleString()} · {r.changedBy}
                                    {r.restorable ? "" : "（旧值未保存）"}
                                  </li>
                                ))
                              )}
                            </ul>
                          ) : null}
                        </>
                      ) : (
                        <span className="cf-value--empty">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      <p className="cf-foot">
        这里看不到审核阈值、免责话术（归运营控制台），也看不到硬禁清单与端侧 capability
        白名单（红线，只能走代码 + review）——不是漏了，是设计（§8.2 配置的字段级分权）。
      </p>
    </div>
  );
}

function ProbeResult({ report }: { report: ProbeReport }): JSX.Element {
  return (
    <div className={`cf-probe ${report.ok ? "cf-probe--ok" : "cf-probe--bad"}`}>
      <div className="cf-probe-head">
        {report.mode === "fake" ? "离线 Fake 模式（未做真实请求）" : `${report.provider} · ${report.model}`}
      </div>
      <ul>
        {report.checks.map((c) => (
          <li key={c.name}>
            <span className={`cf-check cf-check--${c.status}`}>
              <i />
              {c.name}
            </span>
            <span className="cf-check-ms">{c.durationMs}ms</span>
            {c.errorKind ? <span className="cf-check-kind">{c.errorKind}</span> : null}
            {c.message ? <span className="cf-check-msg">{c.message}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
