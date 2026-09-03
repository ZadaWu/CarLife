/**
 * 档案页的「常用人员」区（施工单 M17-04，F-46-11）。
 *
 * 位置在「用车画像」与「保养与维修记录」之间：它属于"这辆车的注册信息"，
 * 比记录更靠上；只在默认车下展开（同屏一辆车的信息密度已经够了）。
 *
 * 三条与档案页一致的纪律：
 *  - **offline ≠ empty**：读不到就说读不到，绝不显示"还没有常用人员"。
 *    把 offline 显示成 empty，用户会以为数据没了然后再录一遍——
 *    于是名单里出现两个"妈妈"，而第一份其实一直在。
 *  - 删除弹本地确认，且**文案说清后果**（画像一并删除、行程保留）。
 *    只写"确定删除吗"等于没说。
 *  - 不显示任何评分/评级（AC-46-10），也没有"邀请成员登录"的入口
 *    （登记一个人不发放任何权限）。
 */
import { useCallback, useEffect, useState } from "react";

import { deleteMember, loadMembers, saveMember } from "./api";
import {
  AGE_BAND_LABEL,
  MEMBER_NEEDS,
  MEMBER_ROLE_LABEL,
  NEED_LABEL,
  type MemberListState,
  type MemberView,
} from "./types";

type Draft = {
  id?: string;
  displayName: string;
  relation: string;
  roles: string[];
  ageBand: string;
  needs: string[];
  note: string;
};

const EMPTY_DRAFT: Draft = {
  displayName: "",
  relation: "",
  roles: ["passenger"],
  ageBand: "",
  needs: [],
  note: "",
};

function toDraft(m: MemberView): Draft {
  return {
    id: m.id,
    displayName: m.displayName,
    relation: m.relation ?? "",
    roles: [...m.roles],
    ageBand: m.ageBand ?? "",
    needs: [...m.needs],
    note: m.note ?? "",
  };
}

/**
 * 关系候选（M54-01）。按**代际**排，不按拼音——车主脑子里就是这个顺序。
 *
 * 只是候选，不是枚举：输入框允许自己打。词表覆盖不到的叫法比覆盖得到的多，
 * 逼人从别人的词表里挑一个不像自己家的说法，结果是干脆不填。
 */
const RELATION_SUGGESTIONS = [
  // 长辈
  "父亲", "母亲", "公公", "婆婆", "岳父", "岳母", "爷爷", "奶奶", "外公", "外婆",
  // 同辈
  "配偶", "丈夫", "妻子", "哥哥", "姐姐", "弟弟", "妹妹",
  // 晚辈
  "儿子", "女儿", "孙子", "孙女", "外孙", "外孙女",
  // 非亲属：车会借出去，这一栏不写就只能空着
  "朋友", "同事", "邻居", "保姆", "司机",
] as const;

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function MemberCard({
  m,
  onEdit,
  onDelete,
}: {
  m: MemberView;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="own-member">
      <p className="own-member-name">
        {m.displayName}
        {m.relation && <span className="own-meta"> · {m.relation}</span>}
      </p>
      <p className="own-meta">
        {m.roles.map((r) => MEMBER_ROLE_LABEL[r]).join(" · ")}
        {m.ageBand && ` · ${AGE_BAND_LABEL[m.ageBand]}`}
      </p>
      {m.needs.length > 0 && (
        <p className="own-meta">
          {m.needs.map((n) => (
            <span key={n} className="own-source-badge">
              {NEED_LABEL.get(n) ?? n}
            </span>
          ))}
        </p>
      )}
      {m.note && <p className="own-meta">{m.note}</p>}
      <p>
        <button type="button" className="own-secondary" onClick={onEdit}>
          修改
        </button>{" "}
        <button type="button" className="own-secondary" onClick={onDelete}>
          删除
        </button>
      </p>
    </div>
  );
}

function MemberForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  error,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error?: string;
}) {
  return (
    <div className="own-member own-member--form">
      <label className="own-meta">
        称呼（你自己的叫法就行）
        <input
          className="own-input"
          value={draft.displayName}
          maxLength={20}
          onChange={(e) => onChange({ ...draft, displayName: e.target.value })}
        />
      </label>
      <label className="own-meta">
        与你的关系（可不填）
        {/*
          用 `datalist` 而不是 `<select>`（M54-01）：常见称呼给候选，
          但**必须允许自定义**——家庭里的叫法千差万别（"丈母娘"/"岳母"/"妈"
          指同一个人），下拉框逼人从别人的词表里挑一个不像自己家的说法，
          结果是干脆不填。给候选省事，能自己打字才是底线。
        */}
        <input
          className="own-input"
          list="own-relation-options"
          placeholder="选一个或自己打"
          value={draft.relation}
          onChange={(e) => onChange({ ...draft, relation: e.target.value })}
        />
        <datalist id="own-relation-options">
          {RELATION_SUGGESTIONS.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </label>
      <p className="own-meta">TA 在车上通常是</p>
      <p>
        {(["driver", "passenger"] as const).map((r) => (
          <button
            key={r}
            type="button"
            className={`own-chip${draft.roles.includes(r) ? " own-chip--on" : ""}`}
            onClick={() => onChange({ ...draft, roles: toggle(draft.roles, r) })}
          >
            {MEMBER_ROLE_LABEL[r]}
          </button>
        ))}
      </p>
      <p className="own-meta">年龄段（影响行程节奏，可不填）</p>
      <p>
        {(["adult", "senior", "child"] as const).map((a) => (
          <button
            key={a}
            type="button"
            className={`own-chip${draft.ageBand === a ? " own-chip--on" : ""}`}
            onClick={() => onChange({ ...draft, ageBand: draft.ageBand === a ? "" : a })}
          >
            {AGE_BAND_LABEL[a]}
          </button>
        ))}
      </p>
      <p className="own-meta">出行上需要照顾的（规划行程时会自动带上）</p>
      <p>
        {MEMBER_NEEDS.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`own-chip${draft.needs.includes(n.key) ? " own-chip--on" : ""}`}
            onClick={() => onChange({ ...draft, needs: toggle(draft.needs, n.key) })}
          >
            {n.label}
          </button>
        ))}
      </p>
      <label className="own-meta">
        还有什么想让助手知道的（一句话）
        <input
          className="own-input"
          value={draft.note}
          maxLength={100}
          onChange={(e) => onChange({ ...draft, note: e.target.value })}
        />
      </label>
      {error && <p className="own-error">{error}</p>}
      <p>
        <button type="button" className="own-cta" onClick={onSubmit}>
          保存
        </button>{" "}
        <button type="button" className="own-secondary" onClick={onCancel}>
          取消
        </button>
      </p>
    </div>
  );
}

/**
 * 删除确认。**文案必须说清后果**——删掉一个人会连带删掉她的画像。
 * 只问"确定吗"，用户无从判断这一步有多不可逆。
 */
function ConfirmDelete({
  name,
  onYes,
  onNo,
}: {
  name: string;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <div className="own-member own-member--danger">
      <p>删除「{name}」？</p>
      <p className="own-meta">
        TA 的用车画像会一并删除；已经发生的行程记录会保留，但不再归属于 TA。此操作不可撤销。
      </p>
      <p>
        <button type="button" className="own-cta" onClick={onYes}>
          确认删除
        </button>{" "}
        <button type="button" className="own-secondary" onClick={onNo}>
          再想想
        </button>
      </p>
    </div>
  );
}

export function MembersSection({ vin }: { vin: string }) {
  const [state, setState] = useState<MemberListState>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemberView | null>(null);
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    void loadMembers(vin).then(setState);
  }, [vin]);

  useEffect(reload, [reload]);

  const submit = async () => {
    if (!draft) return;
    setError(undefined);
    try {
      await saveMember(vin, {
        id: draft.id,
        displayName: draft.displayName.trim(),
        relation: draft.relation.trim() || undefined,
        roles: draft.roles,
        ageBand: draft.ageBand || undefined,
        needs: draft.needs,
        note: draft.note.trim() || undefined,
      });
      setDraft(null);
      reload();
    } catch (err) {
      // 网关的 400 带着"哪一项不合法"，原样给用户看——"保存失败"让人无从修起。
      setError(String(err));
    }
  };

  return (
    <section className="own-card">
      <p className="own-meta" style={{ margin: 0 }}>
        常用人员
      </p>

      {state.kind === "loading" && <p className="own-meta">正在读取…</p>}

      {state.kind === "offline" && (
        <>
          {/* offline 不是 empty：说清是读不到，而不是"还没有" */}
          <p className="own-meta">暂时读不到这辆车的常用人员。</p>
          <p className="own-meta">{state.reason}</p>
          <button type="button" className="own-secondary" onClick={reload}>
            重试
          </button>
        </>
      )}

      {state.kind === "empty" && !draft && (
        <>
          <p className="own-meta">
            还没有登记常用人员。登记后，规划行程时会自动带上 TA 的出行需要，你不用每次重说一遍。
          </p>
          <button type="button" className="own-secondary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            添加常用人员
          </button>
        </>
      )}

      {state.kind === "ready" &&
        state.members.map((m) =>
          pendingDelete?.id === m.id ? (
            <ConfirmDelete
              key={m.id}
              name={m.displayName}
              onYes={async () => {
                try {
                  await deleteMember(vin, m.id);
                } finally {
                  setPendingDelete(null);
                  reload();
                }
              }}
              onNo={() => setPendingDelete(null)}
            />
          ) : (
            <MemberCard
              key={m.id}
              m={m}
              onEdit={() => setDraft(toDraft(m))}
              onDelete={() => setPendingDelete(m)}
            />
          ),
        )}

      {draft && (
        <MemberForm
          draft={draft}
          onChange={setDraft}
          onSubmit={submit}
          onCancel={() => {
            setDraft(null);
            setError(undefined);
          }}
          error={error}
        />
      )}

      {state.kind === "ready" && !draft && (
        <button type="button" className="own-secondary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          添加常用人员
        </button>
      )}
    </section>
  );
}

export default MembersSection;
