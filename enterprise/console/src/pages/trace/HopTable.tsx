/**
 * 分跳耗时的呈现（施工单 TD-08，F-44-04）。
 *
 * # 为什么单独成文件
 *
 * 两处消费：回放页看**整个会话**，会话详情页看**某一轮**（`scope` 区分）。
 * 复制一份的话，两边的口径迟早分叉——而"同一轮在两个页面上耗时不一样"
 * 是那种没人会怀疑是 bug、只会怀疑数据的错。
 *
 * # 这张表比瀑布图更重要
 *
 * 瀑布图回答"发生的顺序"，这张表回答**"该优化哪一跳"**——后者才是
 * F-44-04 的边界原文："用户说慢时，要能知道该优化哪一跳"。
 *
 * # 两个数分开显示，因为它们的优化方向相反
 *
 * 总时长长 → 缩短生成；**首字延迟**长 → 缩短它前面那些串行的跳
 * （意图理解那次完整 LLM 调用、输入审核、检索）。用户说的"等好久"几乎总是后者。
 */

import type { HopBreakdown } from "./timeline";
import { Hint } from "../../components/Hint";

export function HopTable({
  hops,
  scope = "session",
}: {
  hops: HopBreakdown;
  scope?: "session" | "turn";
}): JSX.Element {
  if (!hops.hasSpans) {
    return (
      <p className="muted">
        {scope === "turn" ? "这一轮" : "本次会话"}没有分跳耗时数据。
        轨迹是从 TD-08 起才开始采集 span 的——更早的会话只有事件、没有耗时，
        <strong>这不是采集失败</strong>。
      </p>
    );
  }

  return (
    <>
      <div className="trace-answers">
        <div className="trace-answer">
          <h3>
            {scope === "turn" ? "本轮总时长" : "总时长"}
            <Hint label="总时长说明">
              <p>时间轴窗口，从最早一跳开始到最后一跳结束。</p>
            </Hint>
          </h3>
          <strong>{hops.totalMs}ms</strong>
        </div>
        <div className={`trace-answer${hops.firstTokenMs === null ? " trace-answer--weak" : ""}`}>
          <h3>
            端上首字延迟
            <Hint label="首字延迟说明">
              <p>
                从本轮开始到应答节点吐出第一个字。<strong>用户等的是这个数</strong>，
                不是总时长——后者包含了用户已经在听回答时还在跑的那些。
              </p>
              <p>AC-08-4 的目标是 P95 &lt; 2s（分位统计在 M9-03，这里只是单次值）。</p>
            </Hint>
          </h3>
          <strong>
            {hops.firstTokenMs === null ? "本轮无应答 token" : `${hops.firstTokenMs}ms`}
          </strong>
        </div>
        <div className="trace-answer">
          <h3>
            编排自身开销
            <Hint label="编排开销说明">
              <p>
                节点耗时减去内部外部调用（按区间并集，并行不重复扣）。
                这部分是<strong>我们自己能改的</strong>，其余要么等模型要么等外部服务。
              </p>
            </Hint>
          </h3>
          <strong>{hops.orchestrationMs}ms</strong>
        </div>
      </div>

      <h3>
        外部调用
        <Hint label="外部调用表说明">
          <p>该优化哪一跳看这张。</p>
          <p>
            占比之和可能超过 100%：并行的跳同时在跑。<strong>不做归一化</strong>——
            归一化会把"这两跳是并行的"抹掉，而那正是优化时最该知道的事。
          </p>
        </Hint>
      </h3>
      <HopRows rows={hops.rows} />

      <h3>
        图节点（容器视角）
        <Hint label="图节点表说明">
          <p>
            节点耗时天然大于它内部任何一跳，所以<strong>与上表分开</strong>——
            混排时第一行永远是某个 <code>node.*</code>，而"应答节点花了 800ms"等于没说。
          </p>
          <p>两表之差就是上面的「编排自身开销」。</p>
        </Hint>
      </h3>
      <HopRows rows={hops.nodeRows} />
    </>
  );
}

export function HopRows({ rows }: { rows: HopBreakdown["rows"] }): JSX.Element {
  if (rows.length === 0) return <p className="muted">无。</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>跳</th>
          <th>耗时</th>
          <th>占比</th>
          <th>次数</th>
          <th>最慢一次</th>
          <th>失败</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>{r.name}</td>
            <td>{r.totalMs}ms</td>
            <td>{r.pct.toFixed(1)}%</td>
            {/* 次数与最慢一次一起看，才分得清"调太多次"与"单次太慢" */}
            <td>{r.count}</td>
            <td>{r.count > 1 ? `${r.maxMs}ms` : "—"}</td>
            <td>{r.failed > 0 ? `⚠️ ${r.failed}` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
