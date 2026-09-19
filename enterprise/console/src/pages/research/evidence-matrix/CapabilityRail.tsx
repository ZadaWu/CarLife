/**
 * 能力条（施工单 M85-04）。
 *
 * 判断都在 `rail-model.ts`，这里只渲染——那一半要被逐条断言，
 * 混进 JSX 之后只能靠渲染快照验，而快照改一行样式就红。
 */

import { useState } from "react";

import type { SelectionScope } from "@carlife/research/capabilities";

import { railModel, type RailButton } from "./rail-model";

/**
 * 一个按钮。**导出是为了让渲染用例能单独打它**——
 * 未实现的能力常常被「能点的排前面」挤进折叠起来的 `⋯` 里（收起时不渲染），
 * 于是"`disabled` 有没有被接到属性上"这条断言会在整条能力条完全正常的情况下
 * 静默变成空断言。打这一个组件，断言就不再随哪条能力恰好还没做而漂移。
 */
export function RailBtn({ b, onRun }: { b: RailButton; onRun: (key: string) => void }): JSX.Element {
  return (
    <button
      type="button"
      className={`btn rm-cap${b.disabled ? " is-off" : ""}`}
      disabled={b.disabled}
      title={b.title}
      onClick={() => onRun(b.key)}
    >
      <span className="rm-cap-icon">{b.icon}</span>
      {b.label}
    </button>
  );
}

export function CapabilityRail({
  scope,
  suppressedReason,
  onRun,
  busy,
}: {
  scope: SelectionScope | null;
  suppressedReason: string | null;
  onRun: (key: string) => void;
  /** 正在跑的那条能力的 key；它自己显示成"跑着呢"，其余照常。 */
  busy?: string | null;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const model = railModel(scope, suppressedReason);

  if (model.kind === "empty") return null;

  /*
   * 抑制态：**位置留着，按钮一个不出**。
   * 整块不渲染的话，读的人会以为这一格和别的格一样、只是还没加载出来。
   */
  if (model.kind === "suppressed") {
    return (
      <div className="rm-cap-rail is-suppressed">
        <p className="rm-dim">{model.note}</p>
      </div>
    );
  }

  return (
    <div className="rm-cap-rail">
      {model.primary.map((b) => (
        <RailBtn key={b.id} b={busy === b.key ? { ...b, label: `${b.label}…`, disabled: true } : b} onRun={onRun} />
      ))}
      {model.overflow.length > 0 ? (
        <div className="rm-cap-more">
          <button
            type="button"
            className="btn-secondary rm-cap"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={`还有 ${model.overflow.length} 条`}
          >
            ⋯
          </button>
          {open ? (
            <div className="rm-cap-menu">
              {model.overflow.map((b) => (
                <RailBtn key={b.id} b={b} onRun={onRun} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
