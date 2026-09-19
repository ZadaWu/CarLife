/**
 * 证据矩阵 `/research/evidence-matrix`（施工单 M82-08，Brief `evidence-matrix.brief.md`）。
 *
 * # 它是表格，不是图表
 *
 * 每格五项：`n/N`、百分比、强度条、方向字形、反例 `✗k`。五项缺一都不是这一页
 * ——尤其是反例：参考稿没有它，而"只有正向例句的 evidence gallery 会制造确认偏误"
 * （方法本体 §05）。缺这一项是方法缺陷，不是密度取舍（Brief P2）。
 *
 * # 选中的主角是**格**，不是行
 *
 * 这张表存在的理由是场景差异。整行选中时抽屉只能说"这一行在 5 个场景下共 N 条
 * 证据"——那恰恰是把场景差异抹平之后的数，是矩阵里最没有信息量的一个。
 * 所以默认点击目标是交叉格；整行 / 整列仍可选，但要显式点行名或列头，
 * 因为"看边缘分布"与"看这一格"是两件事，不该共用一个点击目标。
 *
 * # 方向不着色
 *
 * 本页的行**全是痛点**。"语音识别错"的提及率下降是好事，染成红色会被读成变坏
 * （Brief P3）。灰色字形，且视图模型里连颜色字段都没有。
 *
 * # 页面不算任何比率
 *
 * `pct` / `direction` / 抑制态全部来自快照。这里只渲染。
 */

import { useEffect, useMemo, useState } from "react";

import { ResearchFrame } from "../shell/ResearchFrame";
import { Unavailable } from "../shell/Unavailable";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { MatrixToolbar, type MatrixDensity, type MatrixDisplay } from "./MatrixToolbar";
import {
  matrixCsv,
  matrixDetail,
  matrixView,
  selectionScope,
  type EvidenceMatrixData,
  type MatrixCell,
  type MatrixRow,
  type MatrixSelection,
  type MatrixSortDir,
} from "../shell/model";
import { useSnapshot } from "../shell/useSnapshot";
import { fetchInsights, type ResearchInsight } from "../../../api/research-insight";
import { cardsForCode } from "./insight-model";

function CellBox({
  cell,
  display,
  selected,
  dimmed,
  onSelect,
}: {
  cell: MatrixCell;
  display: MatrixDisplay;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
}): JSX.Element {
  const cls = [
    "rm-cell",
    cell.kind === "suppressed" ? "rm-cell--suppressed" : "",
    selected ? "is-cell-selected" : "",
    dimmed ? "is-dimmed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (cell.kind === "suppressed") {
    return (
      <td className={cls} title={cell.reason} onClick={onSelect}>
        <span className="rm-suppressed">样本不足</span>
      </td>
    );
  }
  /*
   * 「显示」分段器换的是**哪个数占主位**，不是"要不要分母"：
   * 两档都出 `n/N` 与 `%`，只交换字号与颜色（Brief 原则 1，MatrixToolbar 文件头）。
   */
  const lead = display === "percent" ? "rm-pct" : "rm-nn";
  return (
    <td className={cls} onClick={onSelect}>
      <div className="rm-cell-grid">
        <span className="rm-cell-top">
          <span className={`rm-nn${lead === "rm-nn" ? " is-lead" : ""}`}>
            {cell.n}/{cell.N}
          </span>
          <span className={`rm-pct${lead === "rm-pct" ? " is-lead" : ""}`}>
            {Math.round(cell.pct * 100)}%
          </span>
        </span>
        {/* 方向：灰色字形，刻意不着色 */}
        <span className="rm-dir">{cell.glyph}</span>
        {/* 条形占满左栏宽度，与上一行的 `n/N 23%` 对齐；方向与反例各自守右栏一行 */}
        <span className="uz-bar rm-bar">
          <i style={{ width: `${Math.round(cell.bar * 100)}%` }} />
        </span>
        <span className={`rm-counter${cell.counterDim ? " is-zero" : ""}`}>✗{cell.counter}</span>
      </div>
    </td>
  );
}

/** 行名格的内容：名字 + 两个可能的徽章。 */
function RowName({ row }: { row: MatrixRow }): JSX.Element {
  return (
    <>
      {row.label}
      {row.catchAll ? (
        <span className="rm-catchall-tag" title="归不上现有需求码的合计，不是一件具体的事">
          兜底桶
        </span>
      ) : null}
      {row.undeliverable ? (
        <span className="uz-chip uz-chip--warn rm-undeliverable">不可交付</span>
      ) : null}
    </>
  );
}

export function EvidenceMatrixPage(): JSX.Element {
  const state = useSnapshot<EvidenceMatrixData>("evidence-matrix");
  /** 默认选左上角那一格，不是第一行——理由见文件头。 */
  const [sel, setSel] = useState<MatrixSelection | null>({ kind: "cell", row: 0, col: 0 });
  const [display, setDisplay] = useState<MatrixDisplay>("count");
  const [density, setDensity] = useState<MatrixDensity>("comfortable");
  const [hiddenScenes, setHiddenScenes] = useState<string[]>([]);
  const [sortDir, setSortDir] = useState<MatrixSortDir>("desc");

  const view = useMemo(
    () =>
      state.kind === "ready"
        ? matrixView(state.snapshot.data, { hiddenScenes, sortDir })
        : null,
    [state, hiddenScenes, sortDir],
  );

  /*
   * 表的形状一变，旧的行列下标指的就是别的格了。
   * 静默指向别处比清空更糟——抽屉里会出现一组看起来正常、其实不是刚才那一格的数。
   */
  useEffect(() => {
    setSel({ kind: "cell", row: 0, col: 0 });
  }, [hiddenScenes, sortDir]);

  const detail = useMemo(() => (view && sel ? matrixDetail(view, sel) : null), [view, sel]);
  /*
   * 下标 → 码。能力条与能力端点都只认码：行序会随人群筛选变，
   * 把下标发出去等于发一个会过期的引用，而它过期之后照样解析得出某一行。
   */
  const scope = useMemo(() => (view && sel ? selectionScope(view, sel) : null), [view, sel]);

  /*
   * 洞察卡（M85-06）。**整个合同的卡一次取回**，在页面这一层按码切给抽屉——
   * 抽屉随选中格反复挂载卸载，放在它里面取的话每换一格就重查一次全量。
   *
   * `currentInputsHash` 与卡片**同一跳**取回（G5）：分两跳的话两个值来自两个时刻，
   * 中间恰好重算一次快照，页面上就会出现一批被误判成过期的卡，而它不报错。
   */
  const contractId = state.kind === "ready" ? state.snapshot.contractId : null;
  const [cards, setCards] = useState<{ all: ResearchInsight[]; currentInputsHash: string | null }>({
    all: [],
    currentInputsHash: null,
  });
  const [cardsTick, setCardsTick] = useState(0);
  useEffect(() => {
    if (!contractId) return;
    let alive = true;
    void fetchInsights(contractId)
      .then((p) => {
        if (alive) setCards({ all: p.insights, currentInputsHash: p.currentInputsHash });
      })
      .catch(() => {
        /*
         * 取卡失败就当作没有卡——**页面主体是矩阵，不该因为卡片查不到而整页不可用**。
         * 抽屉那几节会照旧显示"这一格还没有洞察卡"，那句话此刻不准确，
         * 但它与"真的没有卡"造成的下一步动作相同（去点「归纳这一格」），
         * 而点下去会拿到真正的错误码。
         */
        if (alive) setCards({ all: [], currentInputsHash: null });
      });
    return () => {
      alive = false;
    };
  }, [contractId, cardsTick]);

  /** 这一格（这个需求码）下的卡。整行 / 整列选中时按那一行的码取；整列没有码 → 空。 */
  const cellCards = useMemo(
    () =>
      cardsForCode(
        cards.all,
        scope && (scope.kind === "cell" || scope.kind === "row") ? scope.needPainCode : null,
      ),
    [cards.all, scope],
  );

  if (state.kind === "unavailable") return <Unavailable code={state.code} />;
  if (state.kind === "loading") return <div className="page"><h1>证据矩阵</h1><p className="page-sub">读取中…</p></div>;
  if (state.kind === "computing")
    return (
      <div className="page">
        <h1>证据矩阵</h1>
        <p className="page-sub">快照还在算——这一窗的证据刚变过。稍后刷新即可。</p>
      </div>
    );
  if (state.kind === "error")
    return <div className="page"><h1>证据矩阵</h1><p className="page-sub">读取失败：{state.message}</p></div>;
  if (!view) return <div className="page" />;

  const snap = state.snapshot;

  const exportCsv = (): void => {
    const blob = new Blob([matrixCsv(view)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `evidence-matrix-${snap.inputsHash.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** 整行 / 整列高亮：选中格时它所在的行列也淡亮一层，交叉关系才看得出来。 */
  const rowActive = (ri: number): boolean =>
    sel?.kind === "row" ? sel.row === ri : sel?.kind === "cell" ? sel.row === ri : false;
  const colActive = (ci: number): boolean =>
    sel?.kind === "col" ? sel.col === ci : sel?.kind === "cell" ? sel.col === ci : false;

  return (
    <ResearchFrame
      title="证据矩阵"
      subtitle="需求 / 痛点在各用车场景下的证据分布；每格给样本、方向与反例"
      population={snap.population}
      window={snap.window}
      codebookVersion={snap.codebookVersion}
      codebookLocked={snap.gates.measurement.status === "pass"}
      gates={snap.gates}
      toolbar={
        <MatrixToolbar
          display={display}
          onDisplay={setDisplay}
          density={density}
          onDensity={setDensity}
          scenes={snap.data.scenes}
          hiddenScenes={hiddenScenes}
          onHiddenScenes={setHiddenScenes}
          onExportCsv={exportCsv}
        />
      }
      legend={
        <>
          <span><b>N</b>：该场景去重后的证据总数。一轮可同时归入多个场景，<b>列和大于 {view.turns.toLocaleString("zh-CN")} 轮</b></span>
          <span><b>n/N</b>：该需求在该场景的证据数 / 该场景证据总数</span>
          <span><b>条形</b>：按列内最大值归一化，是刻度不是数字</span>
          <span><b>方向</b>：近 90 天 vs 前 90 天的提及率变化。<b>刻意不着色</b>——痛点提及率下降是好事</span>
          <span><b>✗k</b>：反例数。<b>0 条压暗不是好消息</b>，可能只是没去找</span>
          <span><b>样本不足</b>：低于 10 台车的格不显示明细（小单元抑制，在快照里就已清空）</span>
          <span><b>点格看交叉</b>：点行名选整行、点列头选整列——那是看边缘分布，与看这一格是两件事</span>
          <span><b>兜底桶</b>：末行「其它」是归不上现有码的合计，<b>不占名次</b>——它恒为最大，排进榜首只会挤掉一个真实需求码</span>
        </>
      }
      drawer={
        detail ? (
          <EvidenceDrawer
            detail={detail}
            onClose={() => setSel(null)}
            scope={scope}
            contractId={snap.contractId}
            insights={cellCards}
            currentInputsHash={cards.currentInputsHash}
            // C1 跑完之后重取一次，新卡当场就在「相关洞察」里。
            onInsightsChanged={() => setCardsTick((n) => n + 1)}
          />
        ) : null
      }
    >
      <table className={`rm-table${density === "compact" ? " is-compact" : ""}`}>
        <thead>
          <tr>
            <th className="rm-idx">#</th>
            <th
              className="rm-name rm-pick"
              onClick={() => setSortDir(sortDir === "desc" ? "asc" : "desc")}
              title="按证据总量排序（兜底桶恒在末行）"
            >
              需求 / 痛点 <span className="rm-sort">{sortDir === "desc" ? "↓" : "↑"}</span>
            </th>
            {view.scenes.map((s, ci) => (
              <th
                key={s.code}
                className={`rm-scene rm-pick${colActive(ci) ? " is-axis-selected" : ""}`}
                onClick={() => setSel({ kind: "col", col: ci })}
                title="选中整列"
              >
                <span className="rm-scene-name">{s.label}</span>
                <span className="rm-scene-n">N={s.N.toLocaleString("zh-CN")}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r, ri) => (
            <tr
              key={r.code}
              className={[rowActive(ri) ? "is-selected" : "", r.catchAll ? "is-catchall" : ""]
                .filter(Boolean)
                .join(" ")}
            >
              <td className="rm-idx">{r.index ?? "—"}</td>
              <td
                className={`rm-name rm-pick${sel?.kind === "row" && sel.row === ri ? " is-axis-selected" : ""}`}
                onClick={() => setSel({ kind: "row", row: ri })}
                title="选中整行"
              >
                <RowName row={r} />
              </td>
              {r.cells.map((c, ci) => (
                <CellBox
                  key={view.scenes[ci]?.code ?? ci}
                  cell={c}
                  display={display}
                  selected={sel?.kind === "cell" && sel.row === ri && sel.col === ci}
                  // 选了整行 / 整列时，不在其中的格压暗——让被选的那条带自己浮出来
                  dimmed={
                    (sel?.kind === "row" && sel.row !== ri) || (sel?.kind === "col" && sel.col !== ci)
                  }
                  onSelect={() => setSel({ kind: "cell", row: ri, col: ci })}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ResearchFrame>
  );
}
