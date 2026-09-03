/**
 * 座舱偏好编辑与组合管理（施工单 M24-09，F-50-12）。
 *
 * 表单字段 = `MemberCabinPreference` 契约逐字段映射，**端上不另造表单模型**；
 * 校验在网关（shared 的同一个函数），端上只拦"单人组合"这种能提前说清的。
 * 组合失效时展示原因与"重新保存即恢复"的入口（AC-50-10）。
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { MemberView } from "./types";

export interface CabinPrefView {
  tempC?: number;
  tempMaxC?: number;
  seatHeating?: number;
  seatVentilation?: number;
  ambientBrightness?: number;
  mediaContentTag?: string;
  mediaVolumeLimit?: number;
}

interface CombinationView {
  id: string;
  label: string;
  memberIds: string[];
  override: CabinPrefView;
  invalidReason?: string;
}

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const FIELD_DEFS: Array<{ key: keyof CabinPrefView; label: string; kind: "number" | "text"; hint?: string }> = [
  { key: "tempC", label: "温度（℃）", kind: "number" },
  { key: "tempMaxC", label: "温度上限（℃）", kind: "number", hint: "晕车的\"别太高\"" },
  { key: "seatHeating", label: "座椅加热（0~3）", kind: "number" },
  { key: "seatVentilation", label: "座椅通风（0~3）", kind: "number" },
  { key: "ambientBrightness", label: "氛围灯亮度（0~100）", kind: "number" },
  { key: "mediaContentTag", label: "上车放什么", kind: "text", hint: "儿歌 / 播客 / 戏曲…" },
  { key: "mediaVolumeLimit", label: "音量上限（0~100）", kind: "number" },
];

/** 单人偏好卡：读自名单（M24-06 后名单项带 cabinPreference），编辑走 PUT。 */
export function MemberCabinPrefCard({ vin, member, onSaved }: { vin: string; member: MemberView; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pref = (member as MemberView & { cabinPreference?: CabinPrefView }).cabinPreference ?? {};
  const entries = FIELD_DEFS.filter((f) => pref[f.key] !== undefined);

  const beginEdit = () => {
    const d: Record<string, string> = {};
    for (const f of FIELD_DEFS) if (pref[f.key] !== undefined) d[f.key] = String(pref[f.key]);
    setDraft(d);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const body: Record<string, unknown> = {};
    for (const f of FIELD_DEFS) {
      const raw = draft[f.key]?.trim();
      if (!raw) continue;
      body[f.key] = f.kind === "number" ? Number(raw) : raw;
    }
    setBusy(true);
    setError(null);
    try {
      await invoke<string>("save_member_preference", { vin, id: member.id, bodyJson: JSON.stringify({ preference: body }) });
      setEditing(false);
      onSaved();
    } catch (err) {
      // 400 的错误体带"哪一项不合法"（校验同源 shared），原样给用户
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="own-card" aria-label={`${member.displayName}的座舱偏好`}>
      <header className="own-card-head">
        <b>{member.displayName} 的座舱偏好</b>
        {!editing && (
          <button type="button" className="own-secondary" onClick={beginEdit}>
            {entries.length > 0 ? "编辑" : "登记"}
          </button>
        )}
      </header>

      {!editing && entries.length === 0 && (
        <p className="own-meta">还没登记。也可以直接对助手说："{member.displayName}坐车容易晕，温度别超 24 度"。</p>
      )}

      {!editing && entries.length > 0 && (
        <ul className="own-kv">
          {entries.map((f) => (
            <li key={f.key}>
              <span>{f.label}</span>
              <b>{String(pref[f.key])}</b>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="own-form">
          {FIELD_DEFS.map((f) => (
            <label key={f.key} className="own-field">
              <span>
                {f.label}
                {f.hint && <small className="own-meta">（{f.hint}）</small>}
              </span>
              <input
                type={f.kind === "number" ? "number" : "text"}
                value={draft[f.key] ?? ""}
                placeholder="留空 = 无偏好"
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            </label>
          ))}
          {error && <p className="own-offline">{error}</p>}
          <div className="own-form-actions">
            <button type="button" className="own-cta" disabled={busy} onClick={() => void save()}>
              {busy ? "保存中…" : "保存"}
            </button>
            <button type="button" className="own-secondary" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** 组合管理：谁一起坐车时的覆盖项。精确匹配、失效可见、重存即恢复。 */
export function CombinationsCard({ vin, members }: { vin: string; members: MemberView[] }) {
  const [list, setList] = useState<CombinationView[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [overrideDraft, setOverrideDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!isTauriEnv()) {
      setList([]);
      return;
    }
    void invoke<string>("list_combinations", { vin })
      .then((raw) => setList((JSON.parse(raw) as { combinations: CombinationView[] }).combinations))
      .catch(() => setList([]));
  }, [vin]);
  useEffect(reload, [reload]);

  const nameOf = (id: string) => members.find((m) => m.id === id)?.displayName ?? "（已删除）";

  const save = async (existing?: CombinationView) => {
    // 端上只拦能提前说清的：组合至少两个人（其余校验在网关，同源 shared）
    const ids = existing?.memberIds ?? picked;
    if (ids.length < 2) {
      setError("组合至少要两个人——一个人的偏好写在他自己身上");
      return;
    }
    const override: Record<string, unknown> = { ...(existing?.override ?? {}) };
    if (!existing) {
      for (const f of FIELD_DEFS) {
        const raw = overrideDraft[f.key]?.trim();
        if (!raw) continue;
        override[f.key] = f.kind === "number" ? Number(raw) : raw;
      }
    }
    setError(null);
    try {
      await invoke<string>("save_combination", {
        vin,
        bodyJson: JSON.stringify({ label: existing?.label ?? label, memberIds: ids, override }),
      });
      setCreating(false);
      setLabel("");
      setPicked([]);
      setOverrideDraft({});
      reload();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (id: string) => {
    await invoke<string>("delete_combination", { vin, id }).catch(() => undefined);
    reload();
  };

  return (
    <section className="own-card" aria-label="组合偏好">
      <header className="own-card-head">
        <b>一起坐车时</b>
        {!creating && (
          <button type="button" className="own-secondary" onClick={() => setCreating(true)}>
            新建组合
          </button>
        )}
      </header>
      <p className="own-meta">这几个人一起上车时的安排（如"孩子和妈妈：放儿歌、音量上限 40"）。按组合精确匹配。</p>

      {list === null && <p className="own-meta">正在读取…</p>}
      {list?.length === 0 && !creating && <p className="own-meta">还没有组合。</p>}

      {list?.map((c) => (
        <div key={c.id} className={`own-combo${c.invalidReason ? " own-combo--dead" : ""}`}>
          <div className="own-navrow-main">
            <b>{c.label}</b>
            <small>
              {c.memberIds.map(nameOf).join(" + ")}
              {c.invalidReason && <em className="own-offline">（已失效：{c.invalidReason}——重新保存即恢复）</em>}
            </small>
          </div>
          {c.invalidReason && (
            <button type="button" className="own-secondary" onClick={() => void save(c)}>
              重新保存
            </button>
          )}
          <button type="button" className="own-secondary" onClick={() => void remove(c.id)}>
            删除
          </button>
        </div>
      ))}

      {creating && (
        <div className="own-form">
          <label className="own-field">
            <span>组合名字</span>
            <input value={label} placeholder="孩子和妈妈" onChange={(e) => setLabel(e.target.value)} />
          </label>
          <div className="own-field">
            <span>谁在这组（选两人以上）</span>
            <div className="own-chips">
              {members.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`own-chip${picked.includes(m.id) ? " is-on" : ""}`}
                  onClick={() => setPicked(picked.includes(m.id) ? picked.filter((x) => x !== m.id) : [...picked, m.id])}
                >
                  {m.displayName}
                </button>
              ))}
            </div>
          </div>
          {FIELD_DEFS.map((f) => (
            <label key={f.key} className="own-field">
              <span>{f.label}</span>
              <input
                type={f.kind === "number" ? "number" : "text"}
                value={overrideDraft[f.key] ?? ""}
                placeholder="留空 = 不覆盖"
                onChange={(e) => setOverrideDraft({ ...overrideDraft, [f.key]: e.target.value })}
              />
            </label>
          ))}
          {error && <p className="own-offline">{error}</p>}
          <div className="own-form-actions">
            <button type="button" className="own-cta" onClick={() => void save()}>
              保存组合
            </button>
            <button type="button" className="own-secondary" onClick={() => setCreating(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
