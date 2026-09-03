/**
 * 手机端「人员档案」二级页（施工单 M14-12，定稿 `.../vertical/*-person.png`）。
 *
 * 契约与红线沿用 M17 那一批：名单端点是 M17-04 的、按人画像是 M17-02 的、
 * 称呼不进日志是 M17-03 的。增删改直接复用 `MembersSection`——**搬页不改逻辑**，
 * 那份删除确认的"说清后果"文案是它最值钱的部分。
 *
 * # 这一页零车辆信息
 *
 * Brief §2 原则 1 的反向：不出现 VIN、里程、保养预测、维修时间线或整车统计。
 * 顶部只有一行「关联车辆」作上下文。
 *
 * # 顺序：偏好在前，人员在后
 *
 * 定稿与 Brief §3.B 同序。偏好属于"我"，人员属于"和我一起用车的人"，前者更贴身。
 */
import { useEffect, useState } from "react";
import { characterInitial, personCharacter } from "@carlife/ui";

import { loadMemberUsage, loadMembers, loadPreferences } from "./api";
import { MembersSection } from "./members";
import { GrantsSection } from "./grants";
import { PairingSection } from "./pairing";
import { CombinationsCard, MemberCabinPrefCard } from "./cabin-prefs";
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

export interface PeopleProfileProps {
  vehicle: VehicleView;
  theme: "light" | "dark";
  onBack: () => void;
}

export function PeopleProfilePage({ vehicle, theme, onBack }: PeopleProfileProps) {
  const [prefs, setPrefs] = useState<PreferenceState>({ kind: "loading" });
  /** 只用来渲染画像卡与头像；增删改仍在 `MembersSection` 里，两处不共享状态。 */
  const [roster, setRoster] = useState<MemberListState>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [usage, setUsage] = useState<MemberUsageState>({ kind: "loading" });

  useEffect(() => {
    void loadPreferences().then(setPrefs);
  }, []);

  useEffect(() => {
    void loadMembers(vehicle.vin).then(setRoster);
  }, [vehicle.vin]);

  const members = roster.kind === "ready" ? roster.members : [];
  const active = members.find((m) => m.id === selected) ?? members[0];

  useEffect(() => {
    if (!active) return;
    setUsage({ kind: "loading" });
    void loadMemberUsage(vehicle.vin, active.id).then(setUsage);
  }, [vehicle.vin, active?.id]);

  return (
    <div className={`own-page own-page--${theme}`} aria-label="人员档案">
      <header className="own-head own-head--sub">
        <button type="button" className="own-back" onClick={onBack}>
          ‹ 车辆档案
        </button>
        <h2 className="own-title">人员档案</h2>
      </header>
      {/* 车辆只作上下文，不展开任何车辆字段 */}
      <p className="own-subline">
        <span className="own-chip">关联车辆：{vehicle.model}</span>
      </p>
      <p className="own-meta own-center">记录出行需要与个人偏好，不作人员评分</p>

      <PreferenceCard state={prefs} />

      {/* 头像与角色标签是本页新增的呈现；增删改逻辑原样复用 M17-04 的实现 */}
      <MemberGallery members={members} state={roster} active={active} theme={theme} onSelect={setSelected} />

      <MembersSection vin={vehicle.vin} />

      {/* 成员与授权（M48-03）：与上面的常用人员并列但独立——那边是"车上常有谁"
          （可无账号），这边是"谁能登录用这辆车"。删档案不撤授权，反之亦然。 */}
      <GrantsSection vin={vehicle.vin} myRole={vehicle.myRole ?? "owner"} />

      {/* 车机终端绑定（M51-01）：紧挨着授权区——两者都是"谁/什么能用这辆车"，
          而且都只有车主能做。注意它与档案页那个「车机」区不是一回事：
          那个是舒适域能力（空调/座椅/香氛），这个是车上那块屏这台设备。 */}
      <PairingSection vin={vehicle.vin} myRole={vehicle.myRole ?? "owner"} />

      {active && <MemberUsageCard name={active.displayName} state={usage} />}

      {/* 座舱偏好（M24-09）：这个人上车时设备怎么调；保存后刷新名单让数据同源 */}
      {active && (
        <MemberCabinPrefCard
          vin={vehicle.vin}
          member={active}
          onSaved={() => void loadMembers(vehicle.vin).then(setRoster)}
        />
      )}
      <CombinationsCard vin={vehicle.vin} members={members} />

      <section className="own-card own-row">
        <span className="own-navrow-icon" aria-hidden>
          <LockIcon />
        </span>
        <div className="own-navrow-main">
          <b>管理个人信息</b>
          {/* M17-03 的 PII 边界，做成用户可见的一句话 */}
          <small>称呼不会写入日志或对外工具；删除人员会一并删掉 TA 的画像，行程记录保留但不再归属。</small>
        </div>
      </section>
    </div>
  );
}

/**
 * 常用人员的形象与标签视图。**只读**——增删改在下面的 `MembersSection`。
 * 拆成两块是为了不改 M17-04 那份逻辑，同时又能按定稿把人像做出来。
 */
function MemberGallery({
  members,
  state,
  active,
  theme,
  onSelect,
}: {
  members: MemberView[];
  state: MemberListState;
  active?: MemberView;
  theme: "light" | "dark";
  onSelect: (id: string) => void;
}) {
  if (state.kind === "loading") return null;
  // offline 由下面的 MembersSection 负责说，这里不重复报一遍同一件事。
  if (state.kind !== "ready" || members.length === 0) return null;
  return (
    <section className="own-card">
      <div className="own-card-head">
        <span className="own-head-icon own-head-icon--sm own-head-icon--warn" aria-hidden>
          <PeopleIcon />
        </span>
        <b>常用人员</b>
      </div>
      <ul className="own-people">
        {members.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className={`own-person${m.id === active?.id ? " is-active" : ""}`}
              onClick={() => onSelect(m.id)}
            >
              <span className="own-dot" aria-hidden />
              <Avatar member={m} theme={theme} />
              <span className="own-person-main">
                <b>
                  {m.displayName}
                  {m.roles.length > 0 && (
                    <span className="own-role">{" · "}{m.roles.map((r) => MEMBER_ROLE_LABEL[r]).join(" / ")}</span>
                  )}
                </b>
                {m.needs.length > 0 && (
                  <span className="own-needs">
                    {m.needs.map((n) => (
                      <em key={n}>{NEED_LABEL.get(n) ?? n}</em>
                    ))}
                  </span>
                )}
                {m.relation && <small>{m.relation}</small>}
              </span>
              <span className="own-navrow-arrow" aria-hidden>
                ›
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Avatar({ member, theme }: { member: MemberView; theme: "light" | "dark" }) {
  // 匹配不到画首字，**不随便派一张脸**——那是给一个真实的人安一张不是他的面孔。
  const art = personCharacter(member, theme);
  return (
    <span className="own-avatar">
      {art ? <img src={art} alt="" /> : <em>{characterInitial(member.displayName)}</em>}
    </span>
  );
}

function MemberUsageCard({ name, state }: { name: string; state: MemberUsageState }) {
  return (
    <section className="own-card">
      <div className="own-card-head">
        <b>{name}的出行画像</b>
      </div>
      {state.kind === "loading" && <p className="own-meta">正在读取…</p>}
      {state.kind === "offline" && <p className="own-meta">暂时读不到画像（{state.reason}）。</p>}
      {state.kind === "unconfigured" && (
        <p className="own-meta">用车数据还没有接入（{state.reason}），所以这里没有画像。</p>
      )}
      {state.kind === "unusable" && (
        <p className="own-meta">
          样本不足：{state.reason}
          {state.sampleSize > 0 ? `（仅 ${state.sampleSize} 条）` : ""}，暂不生成画像。
        </p>
      )}
      {state.kind === "ready" && <MemberUsageFacts usage={state.usage} />}
      <p className="own-meta own-tiny">画像仅陈述事实，不作评分。</p>
    </section>
  );
}

function MemberUsageFacts({ usage }: { usage: Extract<MemberUsageState, { kind: "ready" }>["usage"] }) {
  const s = usage.summary;
  const hours = chargeHoursLabel(s.commonHours ?? s.commonChargeHours ?? []);
  return (
    <>
      {/* 回落整车口径必须显式（M17-02）：隐式回落＝用整车数字冒充个人结论 */}
      {usage.scope === "vehicle" && (
        <p className="own-meta own-tiny">
          这是<strong>整车</strong>数据，不是 TA 一个人的——按人拆分后样本还不够。
        </p>
      )}
      <p className="own-facts-inline">
        {usage.kind === "companion" ? "同行" : "驾驶"} {s.sampleSize} 次
        {/* staleDays 会是 null（一条流水都没有时服务端如实给 null）——
            `Math.round(null)` 是 0，会渲染成"最近 0 天内"，那是个凭空的结论 */}
        {typeof s.staleDays === "number"
          ? ` · ${s.staleDays < 1 ? "今天还有记录" : `最近 ${Math.round(s.staleDays)} 天内`}`
          : ""}
        {hours ? ` · 常在 ${hours}` : ""}
      </p>
      {usage.kind === "driver" && typeof s.avgDailyKm === "number" && (
        <p className="own-facts-inline">日均 {s.avgDailyKm.toFixed(s.avgDailyKm < 10 ? 1 : 0)} km</p>
      )}
    </>
  );
}

function PreferenceCard({ state }: { state: PreferenceState }) {
  return (
    <section className="own-card">
      <div className="own-card-head">
        <span className="own-head-icon own-head-icon--sm own-head-icon--warn" aria-hidden>
          <BookmarkIcon />
        </span>
        <b>我希望助手记住</b>
      </div>
      {/*
        定稿有编辑铅笔与「+ 添加」。③的写入侧目前只有对话路径（M11-02 的抽取），
        没有面向端上的写端点——**不放一个点了没反应的铅笔**，说清怎么改。
      */}
      <p className="own-meta own-tiny">仅用于更贴合你的建议；要改或删，在对话里说一句就行。</p>

      {state.kind === "loading" && <p className="own-meta">正在读取…</p>}
      {/* degraded 也走这一支：这次没查到不代表没有 */}
      {state.kind === "offline" && <p className="own-meta">暂时读不到记忆库（{state.reason}）。</p>}
      {state.kind === "unconfigured" && <p className="own-meta">记忆库还没有接入（{state.reason}）。</p>}
      {state.kind === "empty" && (
        <p className="own-meta">还没有记下任何偏好。在对话里说"记住我不喜欢走高速"，就会出现在这里。</p>
      )}
      {state.kind === "ready" && (
        <ul className="own-prefs">
          {state.preferences.map((p, i) => (
            <li key={p.id ?? i}>
              <span className="own-navrow-icon" aria-hidden>
                <PinIcon />
              </span>
              <span>{p.content}</span>
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

function BookmarkIcon() {
  return (
    <svg {...S} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M6.5 3.5h11v17l-5.5-4-5.5 4z" />
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

export default PeopleProfilePage;
