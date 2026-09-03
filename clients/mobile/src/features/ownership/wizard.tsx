/**
 * 建档向导（施工单 M14-05，Brief §2）。四步：车型 → 动力 → 里程 → 购车时间。
 *
 * 可信设计的三条落点（Brief §1 核心原则）：
 *  - 车型走目录不自由录入；目录无结果时展示检索词与明确结论，不伪造近似匹配；
 *  - "不确定"是动力形式的合法选择，默认不选；
 *  - 完成页只展示刚建立的数据，并说清"当前能做什么、还差什么"。
 */
import { useEffect, useMemo, useState } from "react";

import {
  catalogBrands,
  catalogYears,
  draftToCreateBody,
  ENERGY_CHOICES,
  knowledgeNote,
  modelsOfBrand,
  offlineCatalog,
  searchCatalog,
  validateStep,
  WIZARD_STEPS,
  type CatalogView,
  type VehicleCatalogEntry,
  type WizardDraft,
} from "@carlife/ui";
import { createVehicle, loadCatalog } from "./api";
import type { VehicleView } from "./types";

export interface WizardProps {
  onDone: (created: VehicleView) => void;
  onCancel: () => void;
}

export function VehicleWizard({ onDone, onCancel }: WizardProps) {
  const [step, setStep] = useState(0);
  // 车型目录带着"这一款关联到哪些资料"一起来（M14-08）。拉不到不阻塞建档——
  // 目录清单是静态兜底，覆盖状态是 unavailable，文案说"读不到"。
  const [catalog, setCatalog] = useState<CatalogView>(() => offlineCatalog("正在读取知识库覆盖情况"));
  const [draft, setDraft] = useState<WizardDraft>({});
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const error = validateStep(step, draft);
  const patch = (p: Partial<WizardDraft>) => setDraft((d) => ({ ...d, ...p }));

  useEffect(() => {
    void loadCatalog().then(setCatalog);
  }, []);

  const next = async () => {
    setTouched(true);
    if (error) return;
    if (step < WIZARD_STEPS.length - 1) {
      setStep(step + 1);
      setTouched(false);
      return;
    }
    // 最后一步：提交
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createVehicle(draftToCreateBody(draft));
      onDone(created);
    } catch (err) {
      // 提交失败如实报错并保留全部已填内容——重填一遍是最伤的失败形态。
      setSubmitError(`保存失败：${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="own-page" aria-label="创建车辆档案">
      <h2 className="own-title">创建车辆档案</h2>

      {/* 步骤进度（每步显示进度与返回，Brief §2） */}
      <p className="own-meta" aria-label="进度">
        {WIZARD_STEPS.map((s, i) => (
          <span key={s} style={{ marginRight: 12, fontWeight: i === step ? 600 : 400, opacity: i <= step ? 1 : 0.45 }}>
            {i + 1} {s}
          </span>
        ))}
      </p>

      <div className="own-card">
        {step === 0 && <StepModel draft={draft} patch={patch} catalog={catalog} />}
        {step === 1 && <StepEnergy draft={draft} patch={patch} />}
        {step === 2 && <StepOdometer draft={draft} patch={patch} />}
        {step === 3 && <StepPurchase draft={draft} patch={patch} />}

        {touched && error && <p className="own-meta" style={{ color: "#b91c1c" }}>{error}</p>}
        {submitError && <p className="own-meta" style={{ color: "#b91c1c" }}>{submitError}</p>}
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <button
          type="button"
          className="own-secondary"
          onClick={() => (step === 0 ? onCancel() : setStep(step - 1))}
        >
          {step === 0 ? "取消" : "上一步"}
        </button>
        <button type="button" className="own-cta" disabled={submitting} onClick={next}>
          {step === WIZARD_STEPS.length - 1 ? (submitting ? "保存中…" : "完成建档") : "下一步"}
        </button>
      </div>
    </div>
  );
}

function StepModel({
  draft,
  patch,
  catalog,
}: {
  draft: WizardDraft;
  patch: (p: Partial<WizardDraft>) => void;
  catalog: CatalogView;
}) {
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState<string | undefined>(draft.brand);
  const [offCatalogMode, setOffCatalogMode] = useState(draft.offCatalog ?? false);

  const results = useMemo(() => (query ? searchCatalog(catalog, query) : []), [catalog, query]);
  const pick = (e: VehicleCatalogEntry) =>
    patch({ brand: e.brand, model: e.model, modelYear: undefined, offCatalog: false });

  if (offCatalogMode) {
    return (
      <div>
        <p className="own-meta">
          目录暂未收录你的车。可以先用你填写的名称建档——档案会标注「目录外」，
          说明书检索可能无法精确限定到这一车型。
        </p>
        <input
          className="own-input"
          placeholder="车型名称（如：某品牌 某车型）"
          value={draft.model ?? ""}
          onChange={(e) => patch({ model: e.target.value, brand: undefined, offCatalog: true })}
        />
        <YearPicker draft={draft} patch={patch} />
        <button type="button" className="own-secondary" onClick={() => setOffCatalogMode(false)}>
          返回目录选择
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        className="own-input"
        placeholder="搜索品牌或车型…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {query ? (
        results.length > 0 ? (
          <div className="own-choice-list">
            {results.map((e) => (
              <button
                key={`${e.brand}${e.model}`}
                type="button"
                className={`own-choice${draft.model === e.model ? " is-active" : ""}`}
                onClick={() => pick(e)}
              >
                {e.brand} {e.model}
              </button>
            ))}
          </div>
        ) : (
          /* 无结果：检索词 + 明确结论，不伪造近似匹配（Brief §4） */
          <p className="own-meta">目录里没有与「{query}」匹配的车型。</p>
        )
      ) : (
        <div className="own-choice-list">
          {(brand ? modelsOfBrand(catalog, brand) : []).map((e) => (
            <button
              key={e.model}
              type="button"
              className={`own-choice${draft.model === e.model ? " is-active" : ""}`}
              onClick={() => pick(e)}
            >
              {e.model}
              {/* 关联到资料的车型在列表里就能看出来（M14-08）。
                  覆盖读不到时 links 一律为空 → 不显示任何角标，
                  而不是给所有车都打上"无资料"。 */}
              {e.links.length > 0 && <span className="own-choice-note">有知识库</span>}
            </button>
          ))}
          {!brand &&
            catalogBrands(catalog).map((b) => (
              <button key={b} type="button" className="own-choice" onClick={() => setBrand(b)}>
                {b}
              </button>
            ))}
          {brand && (
            <button type="button" className="own-secondary" onClick={() => setBrand(undefined)}>
              ← 换个品牌
            </button>
          )}
        </div>
      )}

      {draft.model && !draft.offCatalog && (
        <>
          <p className="own-meta">已选：{draft.brand} {draft.model}，请选年款：</p>
          <YearPicker draft={draft} patch={patch} />
          {/* 关联关系在建档时就说清楚（M14-07/M14-08），不等用户问了才发现。
              三态：有资料列出关联、没资料明说、读不到说读不到。 */}
          <p className="own-meta">{knowledgeNote(catalog, draft.model)}</p>
        </>
      )}

      <button type="button" className="own-secondary" onClick={() => setOffCatalogMode(true)}>
        找不到我的车
      </button>
    </div>
  );
}

function YearPicker({ draft, patch }: { draft: WizardDraft; patch: (p: Partial<WizardDraft>) => void }) {
  // 通用年份表，不按车型编上市年表（M14-07，见 catalog.ts 文件头）。
  const years = useMemo(() => catalogYears(), []);

  return (
    <div className="own-choice-list own-choice-list--wrap">
      {years.map((y) => (
        <button
          key={y}
          type="button"
          className={`own-choice own-choice--compact${draft.modelYear === y ? " is-active" : ""}`}
          onClick={() => patch({ modelYear: y })}
        >
          {y} 款
        </button>
      ))}
    </div>
  );
}

function StepEnergy({ draft, patch }: { draft: WizardDraft; patch: (p: Partial<WizardDraft>) => void }) {
  return (
    <div className="own-choice-list">
      {ENERGY_CHOICES.map((c) => (
        <button
          key={c.key}
          type="button"
          className={`own-choice${draft.energy === c.key ? " is-active" : ""}`}
          onClick={() => patch({ energy: c.key })}
        >
          {c.label}
          {c.note && <span className="own-choice-note">{c.note}</span>}
        </button>
      ))}
    </div>
  );
}

function StepOdometer({ draft, patch }: { draft: WizardDraft; patch: (p: Partial<WizardDraft>) => void }) {
  return (
    <div>
      <p className="own-meta">仪表盘上的总里程读数（可以稍后再校准）：</p>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          className="own-input"
          type="number"
          inputMode="numeric"
          min={0}
          placeholder="如 18500"
          value={draft.odometerKm ?? ""}
          onChange={(e) =>
            patch({ odometerKm: e.target.value === "" ? undefined : Number(e.target.value) })
          }
        />
        <span>km</span>
      </div>
    </div>
  );
}

function StepPurchase({ draft, patch }: { draft: WizardDraft; patch: (p: Partial<WizardDraft>) => void }) {
  const cur = new Date().getFullYear();
  const years = Array.from({ length: 15 }, (_, i) => cur - i);
  return (
    <div>
      <p className="own-meta">提车的年月（只到月份，不需要具体日期）：</p>
      <div style={{ display: "flex", gap: 8 }}>
        <select
          className="own-input"
          value={draft.purchaseYear ?? ""}
          onChange={(e) => patch({ purchaseYear: Number(e.target.value) || undefined })}
        >
          <option value="">年</option>
          {years.map((y) => (
            <option key={y} value={y}>{y} 年</option>
          ))}
        </select>
        <select
          className="own-input"
          value={draft.purchaseMonth ?? ""}
          onChange={(e) => patch({ purchaseMonth: Number(e.target.value) || undefined })}
        >
          <option value="">月</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>{m} 月</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** 完成页（Brief §2）：只展示刚建立的数据 + 能做什么/还差什么 + VIN 后补说明。 */
export function WizardDonePage({ created, onBack }: { created: VehicleView; onBack: () => void }) {
  return (
    <div className="own-page" aria-label="建档完成">
      <h2 className="own-title">档案已建立</h2>
      <div className="own-card">
        <h3 className="own-model">{created.model}</h3>
        <p className="own-meta">
          {created.modelYear} 款 · 表显里程 {Math.round(created.odometerKm).toLocaleString()} km
        </p>
      </div>
      <div className="own-card">
        <p className="own-meta">
          <strong>现在可以：</strong>问"这辆车"的用车问题、记录保养与问诊。
          <br />
          <strong>还差什么：</strong>补充 VIN 后可关联召回、保修与门店工单；
          积累用车数据后能给出贴合你用车强度的保养到期推算。
        </p>
      </div>
      <button type="button" className="own-cta" onClick={onBack}>
        查看档案
      </button>
    </div>
  );
}
