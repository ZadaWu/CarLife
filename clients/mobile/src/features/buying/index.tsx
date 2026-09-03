/**
 * features/buying —— 购车功能页与对比矩阵（施工单 M15-05，F-15-14）。
 *
 * # 它存在的理由写在 prompt 里
 *
 * `prompts/buying.md` 的硬约束是「默认 150 字以内，**不要摆大表格**——
 * 车主在车里，念不完。他真要细看，让他到手机端看」。**这里就是那个"手机端"。**
 *
 * 同时它是 AC-15-3「出处可点开查看来源」与 AC-15-4「全部假设可见」的落地面：
 * 语音里念不完 8 项假设，页面上必须一条不少。
 *
 * # 四条红线
 *
 *  1. **不做综合评分/星级/推荐徽章**。"哪款更好"是价值判断，取决于他的取舍
 *     （`car-catalog.ts` 文件头已定）。页面的职责是把同名参数并排放好并带出处。
 *  2. **被淘汰的车要能看见**，折叠但不隐藏——全隐藏就回到了黑盒排序。
 *  3. **不在页面上做假设编辑表单**。改假设重算已经在对话里（M15-02），
 *     再做一套表单会出现第二条重算路径，两条路径的状态迟早不一致。
 *  4. **页面不直接调任何敏感工具**。预约一律经对话 → 权限门 → HITL，
 *     在这里直接下单等于绕过 §8.4。
 */
import { useCallback, useEffect, useState } from "react";

import { loadBuying } from "./api";
import {
  ALIGNMENT_LABELS,
  ASSUMPTION_LABELS,
  DIMENSION_LABELS,
  ITEM_LABELS,
  rangeText,
  specRows,
  type BuyingState,
  type Candidate,
  type InsurancePlan,
  type LoanPlan,
  type SourceRef,
  type TrimPlan,
} from "./types";
import "./buying.css";

const money = (n: number) => `${Math.round(n).toLocaleString("zh-CN")} 元`;

/** 出处角标。点开看到的是**原文片段**，不是我们写的摘要（AC-15-3）。 */
function SourceBadge({ source }: { source: SourceRef }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="buy-src" onClick={() => setOpen((v) => !v)}>
        出处
      </button>
      {open && (
        <div className="buy-src-pop">
          <p className="buy-src-doc">{source.document}</p>
          <p className="buy-src-text">{source.snippet}</p>
        </div>
      )}
    </>
  );
}

/** 对比矩阵：行=参数，列=候选（≤3）。缺项显示"—"并注明，**不留空、不猜**。 */
function Matrix({ candidates }: { candidates: readonly Candidate[] }) {
  const rows = specRows(candidates);
  return (
    <div className="buy-matrix-wrap">
      <table className="buy-matrix">
        <thead>
          <tr>
            <th />
            {candidates.map((c) => (
              <th key={c.model}>{c.model}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">厂商指导价</th>
            {candidates.map((c) => (
              <td key={c.model}>
                {c.guidePrice ? (
                  <>
                    <span className="buy-val">{money(c.guidePrice.amount)}</span>
                    <span className="buy-trim">{c.guidePrice.trim}</span>
                    <SourceBadge source={c.guidePrice.source} />
                  </>
                ) : (
                  <span className="buy-missing">—<em>资料中未提及</em></span>
                )}
              </td>
            ))}
          </tr>
          {rows.map((label) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {candidates.map((c) => {
                const s = c.specs.find((x) => x.label === label);
                return (
                  <td key={c.model}>
                    {s ? (
                      <>
                        <span className="buy-val">{s.value}</span>
                        <SourceBadge source={s.source} />
                      </>
                    ) : (
                      <span className="buy-missing">—<em>资料中未提及</em></span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* 指导价 ≠ 落地价，这句话在语音里说过，页面上也要有——他会拿着页面去谈。 */}
      <p className="buy-note">以上为厂商指导价与手册参数，**不是落地价**；实际成交价问经销商。</p>
    </div>
  );
}

/**
 * 配置矩阵：列 = **配置**，不是列 = 车型（M21-06，F-47-10）。
 *
 * M15-05 那版按车型分列，于是 Model Y 的"六座"看起来像整款车的属性——
 * 而它只属于贵 7.55 万的 `Model Y L`（该单 §6-4 记的就是这条债）。
 */
function TrimMatrix({ trim }: { trim: TrimPlan }) {
  const rows: Array<{ key: "priceCny" | "rangeKm" | "seats"; label: string; unit?: string }> = [
    { key: "priceCny", label: "厂商指导价", unit: "元" },
    { key: "rangeKm", label: "续航", unit: "km" },
    { key: "seats", label: "座位数", unit: "座" },
  ];
  const unpriced = new Set(trim.unpricedModels.map((u) => u.model));

  return (
    <div className="buy-matrix-wrap">
      {/* 对齐口径写在表头上——不写清楚，会被读成"拿顶配比入门"。 */}
      <p className="buy-align">
        <b>{ALIGNMENT_LABELS[trim.alignment] ?? trim.alignment}</b>
        {trim.alignmentNote}
      </p>
      <table className="buy-matrix">
        <thead>
          <tr>
            <th />
            {trim.rows.map((r) => (
              <th key={`${r.model}/${r.trim}`}>
                <span className="buy-trim-model">{r.model}</span>
                {r.trim}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              {trim.rows.map((r) => {
                const v = r[row.key];
                return (
                  <td key={`${r.model}/${r.trim}`}>
                    {typeof v === "number" ? (
                      <span className="buy-val">
                        {row.key === "priceCny" ? money(v) : `${v} ${row.unit ?? ""}`}
                      </span>
                    ) : row.key === "priceCny" && unpriced.has(r.model) ? (
                      // 无人民币报价与"资料里没有"是两件事，说法不能混。
                      <span className="buy-missing">—<em>本系统无人民币报价</em></span>
                    ) : (
                      <span className="buy-missing">—<em>资料中未提及</em></span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {trim.pairs.length > 0 && (
        <ul className="buy-diffs">
          {trim.pairs.map((p, i) => (
            <li key={i}>
              <b>
                {p.left.trim} → {p.right.trim}
              </b>
              {p.diffs.map((d) => (
                <span key={d.field} className="buy-diff">
                  {d.label}：
                  {d.delta === undefined
                    ? (d.note ?? "资料中未提及")
                    : d.delta === 0
                      ? "一样"
                      : `${d.delta > 0 ? "+" : ""}${d.delta}`}
                </span>
              ))}
              {p.marginalPricePerKm !== undefined && (
                <span className="buy-diff buy-diff--calc">
                  每公里续航 {p.marginalPricePerKm} 元（价差 ÷ 续航差）
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {trim.unpricedModels.map((u) => (
        <p key={u.model} className="buy-note">
          {u.note}
        </p>
      ))}
      {trim.droppedRows.length > 0 && (
        <p className="buy-note">
          已排除的非整车行：
          {trim.droppedRows.map((d) => `${d.trim}（${d.reason}）`).join("；")}
        </p>
      )}
      {/* 差值是算出来的，不是模型说的——这句话让车主知道该不该信这几个数。 */}
      <p className="buy-note">配置与差值来自门店报价系统，**差值由系统计算**；指导价不是落地价。</p>
    </div>
  );
}

/** 贷款分区。**利率是假设时必须标出来**，且月供照区间显示，不取中点。 */
function LoanBlock({ loan, onAsk }: { loan: LoanPlan; onAsk: (t: string) => void }) {
  const b = loan.breakdown;
  const assumed = b.annualRate.source === "assumed";
  return (
    <>
      <p className="buy-meta">
        {loan.model} · 车价 {money(b.vehiclePrice)} · 首付 {money(b.downPayment)}（
        {(b.downPaymentRatio * 100).toFixed(1)}%）· 本金 {money(b.principal)} · {b.months} 期
      </p>
      <ul className="buy-items">
        <li>
          <span>年利率</span>
          <b>
            {b.annualRate.low === b.annualRate.high
              ? `${b.annualRate.low}%`
              : `${b.annualRate.low}% ~ ${b.annualRate.high}%`}
            <em className={assumed ? "buy-src-default" : "buy-src-user"}>
              {assumed ? "假设档位" : "你指定"}
            </em>
          </b>
        </li>
        <li>
          <span>等额本息月供</span>
          <b>{rangeText(b.equalInstallment.monthlyPayment)}</b>
        </li>
        <li>
          <span>等额本息总利息</span>
          <b>{rangeText(b.equalInstallment.totalInterest)}</b>
        </li>
        <li>
          <span>等额本金首月 / 末月</span>
          <b>
            {rangeText(b.equalPrincipal.firstMonthPayment)} / {rangeText(b.equalPrincipal.lastMonthPayment)}
          </b>
        </li>
        <li>
          <span>等额本金总利息</span>
          <b>{rangeText(b.equalPrincipal.totalInterest)}</b>
        </li>
        <li className="buy-total">
          <span>贷款比全款多付</span>
          <b>{rangeText(b.cashVsLoan.extraInterest)}</b>
        </li>
      </ul>
      {assumed && (
        <p className="buy-hint buy-hint--warn">
          利率是**假设的示例档位，不是报价**——真实利率以银行/金融方案为准。
          <button type="button" onClick={() => onAsk("利率按 ")}>
            给个确切利率重算
          </button>
        </p>
      )}
      <p className="buy-note">{b.cashVsLoan.note}</p>
      <p className="buy-note">{b.notes.join("；")}</p>
    </>
  );
}

/** 保费分区。`usable: false` 时**一个合计金额都不显示**。 */
function InsuranceBlock({ insurance }: { insurance: InsurancePlan }) {
  const q = insurance.quote;
  return (
    <>
      <ul className="buy-items">
        {q.items.map((i) => (
          <li key={i.key}>
            <span>{i.label}</span>
            <b>{rangeText(i.amount)}</b>
          </li>
        ))}
        {q.usable && q.total ? (
          <li className="buy-total">
            <span>首年合计（区间）</span>
            <b>{rangeText(q.total)}</b>
          </li>
        ) : (
          <li className="buy-total">
            <span>首年合计</span>
            <b>给不了有用的估算</b>
          </li>
        )}
      </ul>
      <h3>系数与口径</h3>
      <ul className="buy-assumptions">
        {(
          [
            ["compulsory", "交强险（元）"],
            ["damageRate", "车损险费率"],
            ["passengerPerSeat", "座位险（元/座）"],
          ] as const
        ).map(([key, label]) => {
          const a = q.assumptions[key];
          return (
            <li key={key}>
              <span>{label}</span>
              <b>{a.low === a.high ? a.low : `${a.low} ~ ${a.high}`}</b>
              <em className={a.source === "user" ? "buy-src-user" : "buy-src-default"}>
                {a.source === "user" ? "你指定" : "假设档位"}
              </em>
            </li>
          );
        })}
        <li>
          <span>系数生效日</span>
          <b>{q.assumptions.coefficientsEffectiveFrom}</b>
        </li>
      </ul>
      <p className="buy-note">{q.notes.join("；")}</p>
    </>
  );
}

export interface MobileBuyingProps {
  sessionId: string | null;
  /** 把一句话发回对话层（改假设、约试驾都走这条路，不在页面上直接动手）。 */
  onAsk: (text: string) => void;
  onClose: () => void;
}

export function MobileBuying({ sessionId, onAsk, onClose }: MobileBuyingProps) {
  const [state, setState] = useState<BuyingState>({ kind: "loading" });
  const [showEliminated, setShowEliminated] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadBuying(sessionId).then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const ask = useCallback(
    (text: string) => {
      onAsk(text);
      onClose();
    },
    [onAsk, onClose],
  );

  return (
    <div className="buy-page">
      <header className="buy-head">
        <h1>购车对比</h1>
        <button type="button" className="buy-close" onClick={onClose}>
          关闭
        </button>
      </header>

      {state.kind === "loading" && <p className="buy-hint">正在读取…</p>}

      {/* offline ≠ empty：读不到就说读不到，不拿"还没比过车"盖住故障。 */}
      {state.kind === "offline" && (
        <p className="buy-hint buy-hint--warn">读不到购车数据：{state.reason}</p>
      )}

      {state.kind === "empty" && (
        <p className="buy-hint">
          还没有比较过车型。去对话里问一句「帮我选车，预算 25 万的纯电」试试。
        </p>
      )}

      {state.kind === "ready" && (
        <>
          <p className="buy-universe">
            本次车型库里可比的共 {state.plan.universe.length} 款：
            {state.plan.universe.map((u) => u.model).join("、")}
            {state.plan.unclassifiedDocs > 0 &&
              `（另有 ${state.plan.unclassifiedDocs} 条资料判不出属于哪款车，已排除）`}
          </p>

          <section className="buy-section">
            <h2>候选对比（按车型）</h2>
            <Matrix candidates={state.plan.candidates} />
          </section>

          <section className="buy-section">
            <h2>配置对比</h2>
            {!state.trim ? (
              <p className="buy-hint">
                还没比过配置。去对话里问一句「这几个配置差在哪」，我把配置摊开给你。
              </p>
            ) : (
              <TrimMatrix trim={state.trim} />
            )}
          </section>

          {state.plan.eliminated.length > 0 && (
            <section className="buy-section">
              <button
                type="button"
                className="buy-fold"
                onClick={() => setShowEliminated((v) => !v)}
              >
                {showEliminated ? "收起" : "展开"}被排除的 {state.plan.eliminated.length} 款
              </button>
              {showEliminated && (
                <ul className="buy-elim">
                  {state.plan.eliminated.map((c) => (
                    <li key={c.model}>
                      <b>{c.model}</b>
                      {(c.eliminatedBy ?? []).map((e, i) => (
                        <p key={i}>
                          <span className="buy-dim">{DIMENSION_LABELS[e.dimension] ?? e.dimension}</span>
                          {e.reason}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="buy-section">
            <h2>五年使用成本</h2>
            {!state.cost ? (
              <p className="buy-hint">
                还没算过成本。去对话里问「五年下来大概多少钱」，我按指导价算给你。
              </p>
            ) : (
              <>
                <p className="buy-meta">
                  {state.cost.model} · {state.cost.breakdown.years} 年 · 车价来源：
                  {state.cost.priceSource.kind === "user" ? "你自己给的" : "厂商指导价"}
                  （{state.cost.priceSource.trim}，{state.cost.priceSource.document}）
                </p>
                <ul className="buy-items">
                  {Object.entries(state.cost.breakdown.items).map(([k, v]) => (
                    <li key={k}>
                      <span>{ITEM_LABELS[k] ?? k}</span>
                      <b>{money(v)}</b>
                    </li>
                  ))}
                  <li className="buy-total">
                    <span>合计</span>
                    <b>
                      {money(state.cost.breakdown.total)}
                      <em>每公里 {state.cost.breakdown.perKm} 元</em>
                    </b>
                  </li>
                </ul>

                <h3>计算假设</h3>
                {/* **8 项一条不少**（AC-15-4）：语音里念不完，页面上必须全在。 */}
                <ul className="buy-assumptions">
                  {Object.entries(ASSUMPTION_LABELS).map(([key, label]) => {
                    const v = state.cost!.breakdown.assumptions[key];
                    const fromUser = state.cost!.changed.includes(key);
                    return (
                      <li key={key}>
                        <span>{label}</span>
                        <b>{v}</b>
                        <em className={fromUser ? "buy-src-user" : "buy-src-default"}>
                          {fromUser ? "你指定" : "系统默认"}
                        </em>
                        {/* 改假设走对话，不在这里做表单——第二条重算路径迟早与第一条不一致。 */}
                        <button type="button" onClick={() => ask(`把${label}改成 `)}>
                          改这项
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="buy-note">{state.cost.breakdown.notes.join("；")}</p>
              </>
            )}
          </section>

          <section className="buy-section">
            <h2>贷款测算</h2>
            {!state.loan ? (
              <p className="buy-hint">
                还没算过月供。去对话里问「首付八万分 36 期月供多少」，我按规则算给你。
              </p>
            ) : (
              <LoanBlock loan={state.loan} onAsk={ask} />
            )}
          </section>

          <section className="buy-section">
            <h2>车险估算</h2>
            {!state.insurance ? (
              <p className="buy-hint">
                还没估过保费。去对话里问「保险一年多少、都包含什么」。
              </p>
            ) : (
              <InsuranceBlock insurance={state.insurance} />
            )}
          </section>

          {/* 金融免责在分区底部显示一次——**只一次**（FL-20 F-20-14：免责淹没实质回答比不加更危险）。 */}
          {(state.loan || state.insurance || state.cost) && (
            <p className="buy-note buy-note--legal">
              【测算说明】以上为规则估算，实际受地区、车型、金融与保险方案影响；
              本系统**只做测算与信息呈现，不代理、不代办任何金融或保险产品**。
            </p>
          )}

          {/* 预约走对话 → 权限门 → HITL。页面直接下单等于绕过 §8.4。 */}
          <button
            type="button"
            className="buy-cta"
            onClick={() => ask(`帮我约 ${state.plan.candidates[0]?.model ?? ""} 试驾`)}
          >
            约个试驾
          </button>
        </>
      )}
    </div>
  );
}

export default MobileBuying;
