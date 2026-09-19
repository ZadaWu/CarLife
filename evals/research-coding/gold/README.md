# 编码参照集（gold set）——编码指南

> 施工单 M82-10。
> 本目录回答一个问题：**Coder 编得准不准**。没有参照集，这个问题只有感觉。

## 0. 目录里各文件是什么

| 文件 | 谁产出 | 说明 |
|---|---|---|
| `candidates.jsonl` | M82-03 `seed.ts --gold 200` | 200 条待编码单元（分层：场景 × persona），**已冻结** |
| `worksheet.jsonl` | `pnpm eval:research-coding --worksheet` | 空白工作表，两人各复制一份来填 |
| `coder-a.jsonl` / `coder-b.jsonl` | **两名研究者，各自独立** | 独立编码结果 |
| `disputes.jsonl` | 仲裁人 | 分歧逐条 + 仲裁理由 |
| `gold.jsonl` | 仲裁后 | 参照集本体 |
| `reference-model.jsonl` | 二次模型编码（**不是 gold**） | 见 §5，只作诊断 |
| `strata.json` | runner | 分层计数，供分层断言 |

## 1. 一条规矩先说在前面：独立

两人**各自独立**编完 200 条再见面。中途对答案会让一致率变成"我们后来聊得挺一致"，
而这个数字要回答的是"这套码表说得清吗"——它只有在两人都没看过对方的答案时才有意义。

一致率会被写进 `research_codebooks.agreement`，控制台五页顶部的
**测量 Measurement 门读它**。编出一个好看的数，代价是后面每一页的数字都建立在一句
没被验证的话上。

## 2. 编码本体：`codebooks/v0.1.0.yaml` 是唯一依据

六条轴，逐条给：

| 轴 | 基数 | 说明 |
|---|---|---|
| `scene` | 单选 | `commute` / `long-trip` / `charging` / `cabin` / `maintenance` |
| `need_pain` | **多选，≤3** | 十一个码 + `none` |
| `job` | 单选 | `get-there` / `keep-charged` / `understand-car` / `fix-it` / `plan-ahead` / `other` |
| `emotion` | 单选 | 六类 + `mixed` + `uncertain` |
| `deliverability` | 单选 | `deliverable` / `undeliverable-hard-ban` / `unknown` |
| `polarity` | 单选 | `complaint` / `praise` / `question` / `counter-example` |

**只看 codebook 里那一条的 `definition` / `include` / `exclude`。**
不要用"我觉得他大概想说"补齐——判不出就是判不出，那正是 `uncertain` 存在的理由。

`candidates.jsonl` 里的 `scene_hint` 是**造数时的标签，不是答案**。
它形如 `场景|persona`，给的是这条语料是照哪个模板生成的。
照它填等于把生成器的假设抄回来，一致率就测不出任何东西——**编码时请忽略它**。

## 3. 三个最容易分歧的地方

### `need_pain` 是多选，但不是"能沾边就选"

上限 3 个。判据是**这句话本身**在说什么，不是它可能牵连到什么。
「天冷续航掉得快」是 `cold-range-loss` 一个码，不要顺手把 `range-anxiety` 也加上——
后者的定义是"没提温度的普通续航担心"，两者 `exclude` 互相点了名。

一句话里确实说了两件事时才给两个码，例如
「导航绕路害我多跑二十公里，现在电不够了」= `nav-detour` + `range-anxiety`。

### `emotion = uncertain` 什么时候用

**话太短或只有指令，看不出情绪时用它**，不是"我拿不准是焦虑还是烦躁"时用它。
后者用 `mixed`（两种情绪都成立）或按主导情绪选一个。

- `uncertain`：「儿童锁在哪里设置」——一句功能询问，情绪无从判断。
- `mixed`：「这车其实挺好开的，就是这破车机每次都听错」——praise 与 frustration 同时成立。

判不出是一个**真实的观察结果**：它说的是"这批语料里有一成的话短到看不出情绪"。
把它们摊进六类会让情绪分布看着比实际干净。

### `polarity = counter-example` 是"与主流叙事相反的证据"

不是"负面"，也不是"正面"。它指**与我们正在形成的结论相抵触的那一条**：

- 大家都在说低温掉电严重，这一条说「其实入冬以后掉的比我想象中少一些」→ `counter-example`。
- 单纯夸一句「这套车机用久了其实挺顺手的」→ `praise`。

区别在于**有没有一个被它顶回去的说法**。反例是要拿去做证伪的，夸奖不是。

## 4. 分歧走仲裁，不走"再看一眼"

编完各自提交 `coder-a.jsonl` / `coder-b.jsonl`，然后：

1. runner 逐条比对，把不一致的写进 `disputes.jsonl`；
2. 两人（或第三人）逐条讨论，每条落一行 `arbitration`：**选了哪个、依据 codebook 的哪一句**；
3. 仲裁结果写进 `gold.jsonl`，`arbitrated: true`。

**不为了让一致率过线改 gold。** 仲裁理由必须落盘——
一条"讨论后统一为 X"没有依据的记录，等于把分歧藏起来。
真发现码表说不清，那是 codebook 下一版的输入，不是改这一条的理由。

⚠️ **参与定义修订的样本不能再充当独立测试**（方法本体 §12）。
本期不修 codebook，所以这 200 条全部是锁定集；哪天用它们改了码表，它们就退休了。

## 5. `reference-model.jsonl` 不是 gold，不要当 gold 用

它是**另一个模型**（不是 Coder 用的那个）独立编的一遍，用途只有一个：
在人工参照集就绪之前，让 runner 与报告这条链路能在真数据上跑通，
并给"Coder 大概偏在哪些码上"一个方向。

它**不写进 `research_codebooks.agreement.humanPercent`**，
因此测量门不会因为它而变绿——模型之间对得上不等于口径说得清。

## 6. 文件格式

`coder-*.jsonl` / `gold.jsonl` 每行：

```json
{
  "unitId": "cmtz…",
  "fingerprint": "3bec716e…",
  "codes": {
    "scene": ["cabin"],
    "need_pain": ["feature-discovery"],
    "job": ["understand-car"],
    "emotion": ["uncertain"],
    "deliverability": ["deliverable"],
    "polarity": ["question"]
  },
  "coder": "a",
  "arbitrated": false
}
```

**每一轴都是数组**，单选轴放一个元素。统一形状省掉一层"这轴是不是多选"的判断。

`disputes.jsonl` 每行：

```json
{
  "fingerprint": "3bec716e…",
  "axis": "need_pain",
  "a": ["feature-discovery"],
  "b": ["feature-discovery", "asr-error"],
  "resolved": ["feature-discovery"],
  "rationale": "codebook 里 asr-error 的 exclude 写明「只是让助手说短一点」不算；本句没有识别错"
}
```
