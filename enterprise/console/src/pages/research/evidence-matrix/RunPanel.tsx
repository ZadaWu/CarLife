/**
 * 运行态面板（施工单 M85-04）。
 *
 * # 「停止查看」不是「取消」
 *
 * 这个按钮只断开 SSE 订阅，服务端那次运行照跑。所以文案就写「停止查看」——
 * 写成「取消」的话，人点完会以为运行终止了，而 token 还在继续烧。
 * 服务端取消是后续的事（验收 §7 记了去向）。
 */

import { useEffect, useRef, useState } from "react";

import { openRunStream, type RunStreamEvent } from "../../../api/research-capability";
import type { StreamState } from "../../../api/stream";
import { costLine, initialRunState, reduceRun, STEP_GLYPH, type RunPanelState } from "./run-model";

export function RunPanel({
  runId,
  title,
  onDone,
  onSettled,
}: {
  runId: string;
  title: string;
  /**
   * 运行**成功**结束时回调一次（M85-06）。C1 用它让页面重取洞察卡。
   *
   * 只在 `done` 上回调、不在 `failed` 上回调：失败时没有新卡，
   * 重取一次只会把同一批卡再画一遍，而那看起来像"跑成了"。
   *
   * 参数是**归约后的** `state.result`（M89-04）：`done` 帧的产物形状因能力而异
   * （C10–C12 是 `{ note: AgentNote, … }`），面板自己按形状分派的话，
   * 每加一条能力都要回来改这个公共组件。所以它只把值交出去，由上层收窄。
   */
  onDone?: (result: unknown) => void;
  /**
   * 成功或失败**都**回调一次（M85-07）。用来解掉"这张卡正在跑"的锁。
   *
   * 与 `onDone` 分开是因为两者要做的事相反：`onDone` 是"有新东西了，去取"，
   * 而锁必须在失败时也解开——只挂在 `onDone` 上的话，一次失败的挑战会把
   * 那张卡上的两个按钮永久禁用，而页面上没有任何东西说明为什么。
   */
  onSettled?: (ok: boolean) => void;
}): JSX.Element {
  const [state, setState] = useState<RunPanelState>(() => initialRunState(runId));
  /*
   * 归约结果的同步镜像（M89-04）。
   *
   * `setState(prev => …)` 的 updater 是**渲染期**才跑的，所以在同一个事件处理器里
   * 拿不到新状态；而终态回调要交出去的正是新状态里的 `result`。
   * 从帧上再读一次 `e.result` 也能凑合，但那样归约表就有了第二条绕过它的路——
   * 改了归约规则而回调没跟上时，两边说的不是同一件事，且不报错。
   */
  const latest = useRef<RunPanelState>(state);
  const [conn, setConn] = useState<StreamState>("connecting");
  const handleRef = useRef<{ close(): void } | null>(null);
  /** 回调只发一次。重连会重放终态帧，不挡的话页面会重取好几遍。 */
  const notified = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    latest.current = initialRunState(runId);
    setState(latest.current);
    notified.current = false;
    const handle = openRunStream(runId, {
      onEvent: (e: RunStreamEvent) => {
        latest.current = reduceRun(latest.current, e);
        setState(latest.current);
        if ((e.event === "done" || e.event === "failed") && !notified.current) {
          notified.current = true;
          if (e.event === "done") onDoneRef.current?.(latest.current.result);
          onSettledRef.current?.(e.event === "done");
        }
      },
      onState: (s) => setConn(s),
    });
    handleRef.current = handle;
    return () => handle.close();
  }, [runId]);

  const stop = (): void => {
    handleRef.current?.close();
    latest.current = { ...latest.current, watching: false };
    setState(latest.current);
  };

  return (
    <div className="rm-run">
      <div className="rm-run-head">
        <strong>{title}</strong>
        <span className="rm-dim rm-run-stage">{state.stage ? `阶段 ${state.stage}` : "等待第一帧"}</span>
      </div>

      {state.steps.length === 0 ? (
        <p className="rm-dim">还没有进度——图刚起来时第一句话要几秒才到。</p>
      ) : (
        <ul className="rm-run-steps">
          {state.steps.map((s, i) => (
            <li key={`${i}-${s.text}`} className={`is-${s.status}`}>
              <span className="rm-run-glyph">{STEP_GLYPH[s.status]}</span>
              {s.text}
            </li>
          ))}
        </ul>
      )}

      {state.phase === "failed" ? (
        // 原样显示服务端给的原因。换成"运行失败请重试"等于把唯一能排查的线索删掉。
        <p className="rm-run-err">跑失败了：{state.error}</p>
      ) : null}

      <div className="rm-run-foot">
        <span className="rm-dim">{costLine(state.usage)}</span>
        {state.phase === "running" && state.watching ? (
          <button type="button" className="btn-secondary" onClick={stop} title="只断开这条进度流，服务端那次运行照跑">
            停止查看
          </button>
        ) : (
          <span className="rm-dim">
            {state.phase === "done" ? "跑完了" : state.watching ? "" : "已停止查看（运行仍在服务端继续）"}
            {state.phase === "running" && conn === "closed" ? "（连接断了，正在重连）" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
