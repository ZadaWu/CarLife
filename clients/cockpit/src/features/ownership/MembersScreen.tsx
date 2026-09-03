/**
 * 车机端「人员档案」页（施工单 M14-10，定稿 `内部文档`）。
 *
 * 契约与红线沿用 M17 那一批，本页不重新发明：名单端点是 M17-04 的、
 * 按人画像是 M17-02 的、称呼不进日志是 M17-03 的。
 *
 * # 增删改都在车机端（M17-04 边界的两次修订，2026-08-27）
 *
 * M17-04 原来定的是"车机驾驶态不适合填表"，本页据此做成了纯只读。同日用户决策分两次
 * 推翻它：先「添加」（M29-06，与建档向导 / 记一笔 / VIN 补录同一条"驻车短表单"先例），
 * 再「修改 + 删除」（M29-07，与手机端对齐）。
 *
 * ⚠️ **删除禁令的原理由并没有失效**，是被产品决策覆盖：它是不可逆的级联（连带删画像），
 * 确认文案必须说清后果，而驾驶态读长文案本身不安全。本可以用"仅驻车可删"缓解，
 * 但 `vehicle_signal.rs` 至今是空壳、端上拿不到驻车态——所以补偿只有两条：
 * 确认文案照抄手机端（说清后果，不是"确定吗"）+ 二次点击。驻车门控记在收口技术债里。
 *
 * **偏好（③"我希望助手记住"）仍然只读**，修改走对话（M24-09），这一条没有变。
 *
 * # 不作人员评分
 *
 * 顶部那枚 chip 是产品承诺。真正的保证在 M17-03 已经做了（返回结构里
 * 根本没有可打分的字段）。**本页也不得自行由里程/频次派生出任何等级、
 * 星级、排名或进度条式对比**——那等于把守住的东西又从前端做回来。
 */
import { useEffect, useState } from "react";
import { characterInitial, personCharacter, type CharacterTheme } from "@carlife/ui";
import {
  MEMBER_AGE_BAND_LABEL,
  MEMBER_NEEDS,
  MEMBER_ROLE_LABEL as SHARED_ROLE_LABEL,
  type MemberAgeBand,
  type MemberRole,
} from "@carlife/shared";

import {
  DEMO_MEMBERS,
  DEMO_PREFERENCES,
  isProfileDemo,
} from "../../data/demoVehicleProfile";
import { deleteMember, deletePreference, loadMemberUsage, loadMembers, loadPreferences, saveMember } from "./api";
import {
  emptyMemberDraft,
  memberDraftToBody,
  memberToDraft,
  MEMBER_NAME_MAX,
  MEMBER_NOTE_MAX,
  toggle,
  validateMemberDraft,
  type MemberDraft,
} from "./member-logic";
import {
  chargeHoursLabel,
  MEMBER_ROLE_LABEL,
  NEED_LABEL,
  type MemberListState,
  type MemberUsageState,
  type MemberView,
  type PreferenceState,
  type VehicleView,
} from "./types";
import "./ownership.css";

export interface MembersScreenProps {
  theme: CharacterTheme;
  /** 关联车辆。没有车就没有名单——名单是挂在车上的（M17-01）。 */
  vehicle?: VehicleView;
  onBack: () => void;
}

export function MembersScreen({ theme, vehicle, onBack }: MembersScreenProps) {
  const [state, setState] = useState<MemberListState>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  /** 添加表单的草稿（M29-06）。null = 没在添加。 */
  const [draft, setDraft] = useState<MemberDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** 待确认删除的成员（M29-07）。null = 没在删。 */
  const [pendingDelete, setPendingDelete] = useState<MemberView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [usage, setUsage] = useState<MemberUsageState>({ kind: "loading" });
  const [prefs, setPrefs] = useState<PreferenceState>({ kind: "loading" });

  useEffect(() => {
    if (!vehicle) {
      setState({ kind: "empty" });
      return;
    }
    // 版式走查夹具（M14-14，同车辆页）。Tauri 不带 query，真实名单照常拉。
    if (isProfileDemo()) {
      setState(DEMO_MEMBERS);
      return;
    }
    setState({ kind: "loading" });
    void loadMembers(vehicle.vin).then(setState);
  }, [vehicle?.vin]);

  useEffect(() => {
    if (isProfileDemo()) {
      setPrefs(DEMO_PREFERENCES);
      return;
    }
    void loadPreferences().then(setPrefs);
  }, []);

  const members = state.kind === "ready" ? state.members : [];
  const active = members.find((m) => m.id === selected) ?? members[0];

  useEffect(() => {
    if (!vehicle || !active) return;
    setUsage({ kind: "loading" });
    void loadMemberUsage(vehicle.vin, active.id).then(setUsage);
  }, [vehicle?.vin, active?.id]);

  const submitDraft = async () => {
    if (!vehicle || !draft) return;
    const problem = validateMemberDraft(draft);
    if (problem) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    setFormError(null);
    const r = await saveMember(vehicle.vin, memberDraftToBody(draft));
    setSaving(false);
    if (r.kind === "ok") {
      setDraft(null);
      // 新增时选中刚添加的人（画像卡立刻出现，多半是"样本不足"，那也是实话）；
      // 编辑时选中的本来就是他，不动。
      setSelected(r.member.id);
      setState({ kind: "loading" });
      void loadMembers(vehicle.vin).then(setState);
      return;
    }
    // 失败保留已填内容（向导同款纪律：重填一遍是最伤的失败形态）。
    setFormError(r.reason);
  };

  const confirmDelete = async () => {
    if (!vehicle || !pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    const r = await deleteMember(vehicle.vin, pendingDelete.id);
    setDeleting(false);
    if (r.kind !== "ok") {
      setDeleteError(r.reason);
      return;
    }
    /*
     * 选中态必须跟着变（M29-07 约束 5）：留着一张指向已删成员的画像卡，
     * 读出来会是"读不到画像"——那是把"人已经删了"说成了系统故障。
     */
    if (selected === pendingDelete.id) setSelected(null);
    setPendingDelete(null);
    setState({ kind: "loading" });
    void loadMembers(vehicle.vin).then(setState);
  };

  return (
    <div className={`cown cown--${theme}`} aria-label="人员档案">
      <div className="cown-sheet">
        <header className="cown-head">
          <span className="cown-head-icon" aria-hidden>
            <PeopleIcon />
          </span>
          <h2 className="cown-title">人员档案</h2>
          <span className="cown-chip">关联车辆 · {vehicle?.model ?? "未选择"}</span>
          {/* 产品承诺，不是装饰（AC-46-10） */}
          <span className="cown-chip">不作人员评分</span>
          <span className="cown-head-spacer" />
          <button type="button" className="cown-btn cown-btn--ghost" onClick={onBack}>
            返回车辆档案
          </button>
        </header>

        <div className="cown-grid2">
          <div className="cown-col">
            <section className="cown-card">
              <div className="cown-card-head">
                <span className="cown-head-icon cown-head-icon--sm cown-head-icon--warn" aria-hidden>
                  <PeopleIcon />
                </span>
                <b>常用人员</b>
                <span className="cown-head-spacer" />
                {/* 定稿这里就是「＋ 添加」，M29-06 起它是真的（见文件头的边界修订）。
                    没有车就没有名单，所以无车时不给这个按钮。 */}
                {vehicle && !draft && (
                  <button
                    type="button"
                    className="cown-btn cown-btn--sm"
                    onClick={() => {
                      setDraft(emptyMemberDraft());
                      setFormError(null);
                    }}
                  >
                    ＋ 添加
                  </button>
                )}
              </div>

              {/*
                编辑/新增态下，**下面的名单整块让位**（下面四个分支都带 `!draft`）。
                同时摆着的话，正在改的那个人会在名单里再出现一次，还带着自己的
                「修改 / 删除」按钮——点它等于在改一个已经在改的人，而"删除"
                更是能把正在编辑的对象直接抽走。表单与名单是同一块地方的两种状态，
                不是可以并存的两块内容。
              */}
              {draft && (
                <MemberForm
                  draft={draft}
                  onChange={setDraft}
                  onSubmit={() => void submitDraft()}
                  onCancel={() => {
                    setDraft(null);
                    setFormError(null);
                  }}
                  saving={saving}
                  error={formError}
                />
              )}

              {!draft && state.kind === "loading" && <p className="cown-dim">正在读取…</p>}

              {/* offline ≠ empty（M17-04 约束 2）：把读不到显示成"没有登记"，
                  用户会以为数据没了，然后再录一遍——名单里就有了两个"妈妈"。 */}
              {!draft && state.kind === "offline" && (
                <p className="cown-dim">暂时读不到人员名单（{state.reason}）。</p>
              )}

              {!draft && state.kind === "empty" && (
                <p className="cown-dim">
                  {vehicle
                    ? "这辆车还没有登记常用人员。在手机端添加后，出行规划会自动带上他们的约束。"
                    : "还没有车辆档案，人员名单是挂在车上的。"}
                </p>
              )}

              {!draft && state.kind === "ready" && (
                <ul className="cown-people">
                  {members.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className={`cown-person${m.id === active?.id ? " is-active" : ""}`}
                        onClick={() => setSelected(m.id)}
                      >
                        <span className="cown-dot" aria-hidden />
                        <Avatar member={m} theme={theme} />
                        <span className="cown-person-main">
                          <b>
                            {m.displayName}
                            {m.roles.length > 0 && (
                              <span className="cown-role">
                                {" · "}
                                {m.roles.map((r) => MEMBER_ROLE_LABEL[r] ?? r).join(" / ")}
                              </span>
                            )}
                          </b>
                          {m.needs.length > 0 && (
                            <span className="cown-needs">
                              {m.needs.map((n) => (
                                <em key={n}>{NEED_LABEL[n] ?? n}</em>
                              ))}
                            </span>
                          )}
                          {m.relation && <small>{m.relation}</small>}
                        </span>
                        <span className="cown-row-arrow" aria-hidden>
                          ›
                        </span>
                      </button>
                      {/*
                        两个动作是行的**兄弟节点**不是子节点——按钮不能嵌套在按钮里
                        （HTML 非法，且点子按钮会连带触发外层的选中）。
                      */}
                      <div className="cown-person-actions">
                        <button
                          type="button"
                          className="cown-btn cown-btn--sm"
                          onClick={() => {
                            setDraft(memberToDraft(m));
                            setFormError(null);
                            setPendingDelete(null);
                          }}
                        >
                          修改
                        </button>
                        <button
                          type="button"
                          className="cown-btn cown-btn--sm"
                          onClick={() => {
                            setPendingDelete(m);
                            setDeleteError(null);
                            setDraft(null);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {pendingDelete && (
                <ConfirmDelete
                  name={pendingDelete.displayName}
                  busy={deleting}
                  error={deleteError}
                  onYes={() => void confirmDelete()}
                  onNo={() => {
                    setPendingDelete(null);
                    setDeleteError(null);
                  }}
                />
              )}
            </section>

            {active && <MemberUsageCard name={active.displayName} state={usage} />}
          </div>

          <div className="cown-col">
            <PreferenceCard
              state={prefs}
              onDelete={async (id) => {
                const r = await deletePreference(id);
                if (r.kind !== "ok") return r.reason;
                /*
                 * 删成功后**从本地列表摘掉，不整表重拉**：重拉要再走一次
                 * Mem0 检索（几百毫秒起步），这期间被删的那条还在屏幕上，
                 * 看起来像没删掉。摘掉是即时的，且与服务端结果一致。
                 */
                setPrefs((cur) =>
                  cur.kind === "ready"
                    ? ((rest) => (rest.length === 0 ? { kind: "empty" } : { kind: "ready", preferences: rest }))(
                        cur.preferences.filter((p) => p.id !== id),
                      )
                    : cur,
                );
                return null;
              }}
            />

            <section className="cown-card cown-card--row">
              <span className="cown-row-icon cown-row-icon--blue" aria-hidden>
                <LockIcon />
              </span>
              <span className="cown-row-main">
                <b>管理个人信息</b>
                {/* M17-03 的 PII 边界，做成用户可见的一句话 */}
                <small>
                  称呼不会写入日志或对外工具；添加、修改、删除都可以在这里完成。
                  删除会一并删掉 TA 的画像，行程记录保留但不再归属——这一步不可撤销。
                </small>
              </span>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 添加常用人员的短表单（M29-06）。
 *
 * 六个字段一屏放完，不做多步——驻车场景，与建档向导（M14-06）同一形态。
 * 标签一律取 `@carlife/shared` 的词表：本地再抄一份，端上显示"晕车"、
 * 提示词里却是别的意思，用户会看到一条对不上的约束（词表文件头原文）。
 *
 * **没有删除、没有编辑**：这张表只用于新增（见文件头的边界修订）。
 */
function MemberForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  saving,
  error,
}: {
  draft: MemberDraft;
  onChange: (d: MemberDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const editing = Boolean(draft.id);
  return (
    <div className="cown-memberform">
      <p className="cown-meta" style={{ marginTop: 0 }}>
        {editing ? "修改这位成员的信息" : "添加一位常用人员"}
      </p>
      <label className="cown-field">
        <span>称呼（你自己的叫法就行）</span>
        <input
          className="cown-input"
          value={draft.displayName}
          maxLength={MEMBER_NAME_MAX}
          onChange={(e) => onChange({ ...draft, displayName: e.target.value })}
        />
      </label>

      <label className="cown-field">
        <span>与你的关系（可不填）</span>
        <input
          className="cown-input"
          value={draft.relation}
          onChange={(e) => onChange({ ...draft, relation: e.target.value })}
        />
      </label>

      <div className="cown-field">
        <span>TA 在车上通常是</span>
        <div className="cown-chips">
          {(["driver", "passenger"] as MemberRole[]).map((r) => (
            <button
              key={r}
              type="button"
              className={`cown-btn cown-btn--chip${draft.roles.includes(r) ? " is-on" : ""}`}
              onClick={() => onChange({ ...draft, roles: toggle(draft.roles, r) })}
            >
              {SHARED_ROLE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <div className="cown-field">
        <span>年龄段（影响行程节奏，可不填）</span>
        <div className="cown-chips">
          {(["adult", "senior", "child"] as MemberAgeBand[]).map((a) => (
            <button
              key={a}
              type="button"
              className={`cown-btn cown-btn--chip${draft.ageBand === a ? " is-on" : ""}`}
              // 再点一次取消：不给"选了就撤不掉"的单选组（年龄段本来就可以不填）
              onClick={() => onChange({ ...draft, ageBand: draft.ageBand === a ? "" : a })}
            >
              {MEMBER_AGE_BAND_LABEL[a]}
            </button>
          ))}
        </div>
      </div>

      <div className="cown-field">
        <span>出行上需要照顾的（规划行程时会自动带上）</span>
        <div className="cown-chips">
          {MEMBER_NEEDS.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`cown-btn cown-btn--chip${draft.needs.includes(n.key) ? " is-on" : ""}`}
              onClick={() => onChange({ ...draft, needs: toggle(draft.needs, n.key) })}
            >
              {n.label}
            </button>
          ))}
        </div>
      </div>

      <label className="cown-field">
        <span>还有什么想让助手知道的（一句话，可不填）</span>
        <input
          className="cown-input"
          value={draft.note}
          maxLength={MEMBER_NOTE_MAX}
          onChange={(e) => onChange({ ...draft, note: e.target.value })}
        />
      </label>

      {error && <p className="cown-meta cown-error">{error}</p>}

      <div className="cown-actions">
        <button type="button" className="cown-btn" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="cown-btn cown-btn--primary" disabled={saving} onClick={onSubmit}>
          {saving ? "保存中…" : editing ? "保存修改" : "保存"}
        </button>
      </div>
      <p className="cown-dim cown-tiny">登记一个人不会给 TA 任何权限，也不会通知 TA。</p>
    </div>
  );
}

/**
 * 删除确认（M29-07）。**文案必须说清后果**——删掉一个人会连带删掉 TA 的画像。
 * 只问"确定吗"，用户无从判断这一步有多不可逆（文案与手机端逐字同源）。
 *
 * 这是 M17-04 删除禁令被产品决策覆盖后**仅有的两条补偿之一**（另一条是二次点击）：
 * 端上拿不到驻车态，做不了"仅驻车可删"的门控（见文件头）。
 */
function ConfirmDelete({
  name,
  busy,
  error,
  onYes,
  onNo,
}: {
  name: string;
  busy: boolean;
  error: string | null;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <div className="cown-confirm">
      <b>删除「{name}」？</b>
      <p className="cown-dim">
        TA 的用车画像会一并删除；已经发生的行程记录会保留，但不再归属于 TA。此操作不可撤销。
      </p>
      {error && <p className="cown-meta cown-error">{error}</p>}
      <div className="cown-actions">
        <button type="button" className="cown-btn" onClick={onNo}>
          再想想
        </button>
        <button type="button" className="cown-btn cown-btn--warn" disabled={busy} onClick={onYes}>
          {busy ? "删除中…" : "确认删除"}
        </button>
      </div>
    </div>
  );
}

function Avatar({ member, theme }: { member: MemberView; theme: CharacterTheme }) {
  // 匹配不到就画首字，**不随便派一张脸**——那是给一个真实的人安一张不是他的面孔。
  const art = personCharacter(member, theme);
  return (
    <span className="cown-avatar">
      {art ? <img src={art} alt="" /> : <em>{characterInitial(member.displayName)}</em>}
    </span>
  );
}

function MemberUsageCard({ name, state }: { name: string; state: MemberUsageState }) {
  return (
    <section className="cown-card">
      <div className="cown-card-head">
        <b>{name}的出行画像</b>
      </div>

      {state.kind === "loading" && <p className="cown-dim">正在读取…</p>}
      {state.kind === "offline" && <p className="cown-dim">暂时读不到画像（{state.reason}）。</p>}
      {state.kind === "unconfigured" && (
        <p className="cown-dim">用车数据还没有接入（{state.reason}），所以这里没有画像。</p>
      )}
      {state.kind === "unusable" && (
        <p className="cown-dim">
          {state.reason}
          {state.sampleSize > 0 ? `（目前 ${state.sampleSize} 条）` : ""}。
          行程记录里标上是谁在车上之后，这里才会有内容。
        </p>
      )}

      {state.kind === "ready" && <MemberUsageFacts usage={state.usage} />}

      <p className="cown-dim cown-tiny">画像仅陈述事实，不作评分。</p>
    </section>
  );
}

function MemberUsageFacts({ usage }: { usage: Extract<MemberUsageState, { kind: "ready" }>["usage"] }) {
  const s = usage.summary;
  const hours = chargeHoursLabel(s.commonHours ?? s.commonChargeHours ?? []);
  return (
    <>
      {/* 回落到整车口径必须显式说出来（M17-02）：隐式回落等于用整车数字冒充个人结论 */}
      {usage.scope === "vehicle" && (
        <p className="cown-dim cown-tiny">
          这是<strong>整车</strong>数据，不是他一个人的——按人拆分后样本还不够。
        </p>
      )}
      <p className="cown-facts-inline">
        {usage.kind === "companion" ? "同行" : "驾驶"} {s.sampleSize} 次
        {/* staleDays 会是 null（一条流水都没有时服务端如实给 null）——
            `Math.round(null)` 是 0，会渲染成"最近 0 天内"，那是个凭空的结论 */}
        {typeof s.staleDays === "number"
          ? ` · ${s.staleDays < 1 ? "今天还有记录" : `最近 ${Math.round(s.staleDays)} 天内`}`
          : ""}
        {hours ? ` · 常在 ${hours}` : ""}
      </p>
      {usage.kind === "driver" && typeof s.avgDailyKm === "number" && (
        <p className="cown-facts-inline">日均 {s.avgDailyKm.toFixed(s.avgDailyKm < 10 ? 1 : 0)} km</p>
      )}
      {s.derivation && s.derivation.length > 0 && (
        <details className="cown-derivation">
          <summary>这些数字怎么来的</summary>
          <ul>
            {s.derivation.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * ③偏好卡。
 *
 * `onDelete` 返回 `null` 表示删掉了，返回字符串是**没删掉的原因**——
 * 记忆库降级时东西还在，这时把行去掉就是在骗人（刷新后它会回来）。
 * 不给这个回调（如浏览器走查快照）就不渲染删除按钮：组件不造一个点了没反应的按钮。
 */
function PreferenceCard({
  state,
  onDelete,
}: {
  state: PreferenceState;
  onDelete?: (id: string) => Promise<string | null>;
}) {
  // 正在删的那一条：按钮转成"删除中…"并禁用，防连点删两次。
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="cown-card">
      <div className="cown-card-head">
        <span className="cown-head-icon cown-head-icon--sm cown-head-icon--warn" aria-hidden>
          <HeartIcon />
        </span>
        <b>我希望助手记住</b>
      </div>
      {/* 有删除按钮之后，"删除在对话里说一句"就不再是唯一路径了——
          文案跟着改，否则它在教用户走一条更慢的路。 */}
      <p className="cown-dim cown-tiny">仅用于更贴合你的建议；在对话里说一句也能改。</p>
      {error && <p className="cown-tiny cown-error">{error}</p>}

      {state.kind === "loading" && <p className="cown-dim">正在读取…</p>}
      {/* degraded 也走这一支：**这次没查到不代表没有**，
          当成空列表会让用户以为助手忘了他说过的话，然后再说一遍。 */}
      {state.kind === "offline" && <p className="cown-dim">暂时读不到记忆库（{state.reason}）。</p>}
      {state.kind === "unconfigured" && <p className="cown-dim">记忆库还没有接入（{state.reason}）。</p>}
      {state.kind === "empty" && (
        <p className="cown-dim">还没有记下任何偏好。在对话里说"记住我不喜欢走高速"这样的话，就会出现在这里。</p>
      )}

      {state.kind === "ready" && (
        <ul className="cown-prefs">
          {state.preferences.map((p, i) => (
            <li key={p.id ?? i}>
              <span className="cown-row-icon cown-row-icon--blue" aria-hidden>
                <PinIcon />
              </span>
              <span className="cown-pref-text">{p.content}</span>
              {/* 没有 id 的条目删不了（Mem0 没给 id），那就不给按钮——
                  给一个点了必然失败的按钮比没有更糟。 */}
              {onDelete && p.id && (
                <button
                  type="button"
                  className="cown-btn cown-btn--sm cown-btn--ghost"
                  disabled={busyId === p.id}
                  aria-label={`删除这条偏好：${p.content}`}
                  onClick={() => {
                    const id = p.id!;
                    setBusyId(id);
                    setError(null);
                    void onDelete(id)
                      .then((reason) => reason && setError(reason))
                      .finally(() => setBusyId(null));
                  }}
                >
                  {busyId === p.id ? "删除中…" : "删除"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const S = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none" } as const;

function PeopleIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7">
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.5 20c0-3.4 2.9-5.7 6.5-5.7s6.5 2.3 6.5 5.7" strokeLinecap="round" />
      <path d="M16 5.2a3.4 3.4 0 0 1 0 5.6M17.5 14.8c2.4.6 4 2.5 4 5.2" strokeLinecap="round" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M12 20s-7.5-4.4-7.5-9.4A4.1 4.1 0 0 1 12 8a4.1 4.1 0 0 1 7.5 2.6c0 5-7.5 9.4-7.5 9.4z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M12 3l7 3v5.5c0 4.3-2.9 8-7 9.5-4.1-1.5-7-5.2-7-9.5V6z" />
      <rect x="9.2" y="10.5" width="5.6" height="4.6" rx="1" />
      <path d="M10.4 10.5V9.3a1.6 1.6 0 0 1 3.2 0v1.2" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M12 21s6.5-6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21z" />
      <circle cx="12" cy="10.5" r="2.3" />
    </svg>
  );
}
