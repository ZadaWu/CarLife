/**
 * 车机端建档向导（施工单 M14-06，FL-23："车机和 Web 仅支持手动录入"）。
 *
 * 步骤、目录与校验规则**与手机端同一份**（`@carlife/ui` 的 vehicle 逻辑）——
 * 两端各写一份的后果是同一辆车在两处建出不同车型名，检索侧再也对不上。
 * 差的只有 UI：车机单列、48px 热区、17px 起步字号，且不做搜索框
 * （驾驶态下打字不是可行交互，走品牌→车型→年款三级点选）。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  catalogBrands,
  catalogFromResponse,
  catalogYears,
  draftToCreateBody,
  ENERGY_CHOICES,
  knowledgeNote,
  modelsOfBrand,
  offlineCatalog,
  validateStep,
  WIZARD_STEPS,
  type CatalogResponse,
  type CatalogView,
  type WizardDraft,
} from "@carlife/ui";

export interface CockpitWizardProps {
  onDone: () => void;
  onCancel: () => void;
}

export function CockpitWizard({ onDone, onCancel }: CockpitWizardProps) {
  const [step, setStep] = useState(0);
  // 车型目录带关联关系一起来（M14-08）；拉不到不阻塞建档，覆盖状态为 unavailable。
  const [catalog, setCatalog] = useState<CatalogView>(() => offlineCatalog("正在读取知识库覆盖情况"));
  const [draft, setDraft] = useState<WizardDraft>({});
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepError = validateStep(step, draft);
  const patch = (p: Partial<WizardDraft>) => setDraft((d) => ({ ...d, ...p }));

  useEffect(() => {
    void invoke<string>("fetch_vehicle_catalog")
      .then((raw) => setCatalog(catalogFromResponse(JSON.parse(raw) as CatalogResponse)))
      .catch((err: unknown) => setCatalog(offlineCatalog(`网关不可达：${String(err)}`)));
  }, []);

  const next = async () => {
    setTouched(true);
    if (stepError) return;
    if (step < WIZARD_STEPS.length - 1) {
      setStep(step + 1);
      setTouched(false);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await invoke<string>("create_vehicle", { bodyJson: JSON.stringify(draftToCreateBody(draft)) });
      onDone();
    } catch (err) {
      // 失败如实说并保留已填内容——重填一遍是最伤的失败形态。
      setError(`保存失败：${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="cown-page" aria-label="添加车辆">
      <h2 className="cown-title">添加车辆</h2>
      <p className="cown-meta" style={{ marginTop: 0 }}>
        {WIZARD_STEPS.map((s, i) => (
          <span key={s} style={{ marginRight: 14, fontWeight: i === step ? 600 : 400, opacity: i <= step ? 1 : 0.45 }}>
            {i + 1} {s}
          </span>
        ))}
      </p>

      <section className="cown-card">
        {step === 0 && <StepModel draft={draft} patch={patch} catalog={catalog} />}
        {step === 1 && <StepEnergy draft={draft} patch={patch} />}
        {step === 2 && <StepOdometer draft={draft} patch={patch} />}
        {step === 3 && <StepPurchase draft={draft} patch={patch} />}
        {touched && stepError && <p className="cown-meta cown-error">{stepError}</p>}
        {error && <p className="cown-meta cown-error">{error}</p>}
      </section>

      <div className="cown-actions">
        <button
          type="button"
          className="cown-btn"
          onClick={() => (step === 0 ? onCancel() : (setStep(step - 1), setTouched(false)))}
        >
          {step === 0 ? "取消" : "上一步"}
        </button>
        <button type="button" className="cown-btn cown-btn--primary" disabled={submitting} onClick={next}>
          {step === WIZARD_STEPS.length - 1 ? (submitting ? "保存中…" : "完成建档") : "下一步"}
        </button>
      </div>
    </div>
  );
}

type StepProps = { draft: WizardDraft; patch: (p: Partial<WizardDraft>) => void };

function StepModel({ draft, patch, catalog }: StepProps & { catalog: CatalogView }) {
  const [brand, setBrand] = useState<string | undefined>(draft.brand);

  if (!brand) {
    return (
      <>
        <p className="cown-meta" style={{ marginTop: 0 }}>选择品牌：</p>
        <div className="cown-grid">
          {catalogBrands(catalog).map((b) => (
            <button key={b} type="button" className="cown-choice" onClick={() => setBrand(b)}>
              {b}
            </button>
          ))}
        </div>
        {/* 目录不收录的车不伪造匹配（Brief §4）：车机端引导去手机端补，
            那里有搜索与"找不到我的车"兜底，驾驶位不适合做这件事。 */}
        <p className="cown-meta">目录里没有你的车？在手机端建档，那里可以搜索并手动填写车型。</p>
      </>
    );
  }

  const models = modelsOfBrand(catalog, brand);
  // 通用年份表，不按车型编上市年表（M14-07，见 catalog.ts 文件头）。
  const years = catalogYears();

  return (
    <>
      <button type="button" className="cown-btn" onClick={() => setBrand(undefined)}>
        ← {brand}（换品牌）
      </button>
      <p className="cown-meta">选择车型：</p>
      <div className="cown-grid">
        {models.map((m) => (
          <button
            key={m.model}
            type="button"
            className={`cown-choice${draft.model === m.model ? " is-active" : ""}`}
            onClick={() => patch({ brand, model: m.model, modelYear: undefined, offCatalog: false })}
          >
            {m.model}
            {/* 覆盖读不到时 links 一律为空 → 不显示角标，而不是给所有车打"无资料"。 */}
            {m.links.length > 0 && <span className="cown-choice-note">有知识库</span>}
          </button>
        ))}
      </div>
      {draft.model && (
        <>
          <p className="cown-meta">选择年款：</p>
          <div className="cown-grid">
            {years.map((y) => (
              <button
                key={y}
                type="button"
                className={`cown-choice${draft.modelYear === y ? " is-active" : ""}`}
                onClick={() => patch({ modelYear: y })}
              >
                {y} 款
              </button>
            ))}
          </div>
          {/* 关联关系在建档时就说清楚（M14-07/M14-08）。三态：
              有资料列出关联、没资料明说、读不到说读不到。 */}
          <p className="cown-meta">{knowledgeNote(catalog, draft.model)}</p>
        </>
      )}
    </>
  );
}

function StepEnergy({ draft, patch }: StepProps) {
  return (
    <>
      <p className="cown-meta" style={{ marginTop: 0 }}>这辆车的动力形式：</p>
      <div className="cown-grid">
        {ENERGY_CHOICES.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`cown-choice${draft.energy === c.key ? " is-active" : ""}`}
            onClick={() => patch({ energy: c.key })}
          >
            {c.label}
            {c.note && <span className="cown-choice-note">{c.note}</span>}
          </button>
        ))}
      </div>
    </>
  );
}

function StepOdometer({ draft, patch }: StepProps) {
  return (
    <>
      <p className="cown-meta" style={{ marginTop: 0 }}>仪表盘上的总里程读数：</p>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          className="cown-input"
          type="number"
          inputMode="numeric"
          min={0}
          placeholder="如 18500"
          value={draft.odometerKm ?? ""}
          onChange={(e) => patch({ odometerKm: e.target.value === "" ? undefined : Number(e.target.value) })}
        />
        <span>km</span>
      </div>
    </>
  );
}

function StepPurchase({ draft, patch }: StepProps) {
  const cur = new Date().getFullYear();
  return (
    <>
      <p className="cown-meta" style={{ marginTop: 0 }}>提车年月（只到月份）：</p>
      <div style={{ display: "flex", gap: 10 }}>
        <select
          className="cown-input"
          value={draft.purchaseYear ?? ""}
          onChange={(e) => patch({ purchaseYear: Number(e.target.value) || undefined })}
        >
          <option value="">年</option>
          {Array.from({ length: 15 }, (_, i) => cur - i).map((y) => (
            <option key={y} value={y}>{y} 年</option>
          ))}
        </select>
        <select
          className="cown-input"
          value={draft.purchaseMonth ?? ""}
          onChange={(e) => patch({ purchaseMonth: Number(e.target.value) || undefined })}
        >
          <option value="">月</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>{m} 月</option>
          ))}
        </select>
      </div>
    </>
  );
}
