# 编码一致率 2026-09-13

codebook `v0.1.0` · 候选 200 条 · 库里已编码 200 条 · 参照集 `reference-model.jsonl`

> ⚠️ **人工参照集还没有**。下面的「Coder vs 模型参照」只是诊断：
> 它比的是两个模型，而不是模型与人。**它不写进 `research_codebooks.agreement.humanPercent`**，
> 因此测量门不会因为它变绿。要真正的一致率，见 [`gold/README.md`](../research-coding/gold/README.md)。

## Coder vs 模型参照（诊断，不是 gold）

来源：`reference-model.jsonl × research_codings@0.1.0`

| 轴 | percent | α | n |
|---|---|---|---|
| `scene` | 0.845 | 0.804 | 200 |
| `need_pain` | 0.860 | 0.805 | 200 |
| `job` | 0.780 | 0.717 | 200 |
| `emotion` | 0.920 | 0.847 | 200 |
| `deliverability` | 0.955 | 0.292 | 200 |
| `polarity` | 0.945 | 0.718 | 200 |
| **合计（按 n 加权）** | **0.884** | 0.697 | 200 |

## 分层

- 参照集 **200** 条；场景分布 {"cabin":36,"charging":45,"commute":45,"long-trip":34,"maintenance":40}；persona 分布 {"cold-sensitive":36,"commute-city":35,"family-shared":44,"new-owner":35,"long-haul":25,"maintenance-outsourced":25}
- 罕见码：`shared-ownership` 2 · `dtc-unclear` 20（各需 ≥ 10）
- `counter-example` 5 条（需 ≥ 10）；困难边界（`mixed` / `uncertain`）0 条（需 ≥ 10）
- ⚠️ 分层未达标：罕见码 shared-ownership 只有 2 条 < 10；counter-example 只有 5 条 < 10；困难边界（mixed / uncertain）只有 0 条 < 10

## `uncertain` 使用率

0.0%。**太高说明语料太碎，太低说明编码者在硬猜**——两头都要看一眼。

## 混淆最多的码对

读作「参照集说是 A，被编成了 B」。

- `scene`：`commute` → `charging` ×15；`commute` → `long-trip` ×4；`maintenance` → `cabin` ×3
- `need_pain`：`feature-discovery` → `other` ×13；`other` → `dtc-unclear` ×3；`other` → `cold-range-loss` ×2
- `job`：`other` → `understand-car` ×11；`plan-ahead` → `get-there` ×6；`plan-ahead` → `keep-charged` ×6
- `emotion`：`neutral` → `confusion` ×4；`neutral` → `frustration` ×3；`anxiety` → `neutral` ×3
- `deliverability`：`deliverable` → `unknown` ×6；`undeliverable-hard-ban` → `deliverable` ×2；`deliverable` → `undeliverable-hard-ban` ×1
- `polarity`：`complaint` → `question` ×5；`counter-example` → `praise` ×3；`praise` → `counter-example` ×2

## 分组

**按场景**

| 分组 | percent | n |
|---|---|---|
| cabin | 0.903 | 36 |
| charging | 0.848 | 45 |
| commute | 0.870 | 45 |
| long-trip | 0.897 | 34 |
| maintenance | 0.912 | 40 |

**按 persona**

| 分组 | percent | n |
|---|---|---|
| cold-sensitive | 0.856 | 36 |
| commute-city | 0.895 | 35 |
| family-shared | 0.909 | 44 |
| long-haul | 0.907 | 25 |
| maintenance-outsourced | 0.867 | 25 |
| new-owner | 0.867 | 35 |

## 口径

- **percent**：多标签轴（`need_pain`）按 Jaccard ≥ 0.5 算一致，单选轴按相等；合计按各轴 n 加权。
- **α**：Krippendorff 名义尺度。多标签轴上把整个集合折成一个类别，**比 Jaccard 严得多**——
  percent 高而 α 低说明分歧集中在「多标了一个」，不是看错了事。α 同时报出但**不设门槛**。
- **分母**：只算两边都有编码的单元。一边缺的是「没编」，不是「编错」。

