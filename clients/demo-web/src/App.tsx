/**
 * 演示页：一个会话、一条流、一个确认框，外加"这一轮它在干什么"。
 *
 * 它不是车机端也不是手机端的网页版——那两端的体验长在语音、HUD 与车辆信号上，
 * 浏览器里一样都没有，硬仿只会得到一个"长得像但不能用"的东西。
 * 这个页面只回答一个问题："它跟普通聊天机器人差在哪"，而三个差别都能在这条链上看见：
 * 回答里带着这辆车自己的数据；要动真格之前停下来等确认，并单列要外发的个人信息；
 * 一句话里的几件事分成几条 lane 同时办。真机长什么样，用页面下方的实拍图说。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { config } from "./config.ts";
import { GatewayError, login, openSession, openStream, relogin, resume, sendMessage } from "./api.ts";
import { paragraphs } from "./rich.ts";
import {
  assistantState,
  branchProgress,
  deltaText,
  fillerText,
  isTurnEnd,
  permissionRequest,
  toolProgress,
  type BranchProgress,
  type PermissionView,
  type ToolProgress,
} from "./sse.ts";

interface Turn {
  role: "user" | "assistant";
  text: string;
}

type Phase = "connecting" | "ready" | "busy" | "failed";

/** 三个差异点各配一句能触发它的话。第三条走行程规划，慢是真实的，所以把耗时写在明面上。 */
const SCENARIOS = [
  {
    title: "它认识你这辆车",
    hint: "回答里会出现这辆车的里程、实测续航、日均行驶——不是任何人问都一样的通用答案",
    prompt: "我这车续航掉得快正常吗",
    cost: "约 15 秒",
  },
  {
    title: "动手之前先问你",
    hint: "会弹出确认卡：要做什么、影响哪里，点同意才执行",
    prompt: "把车里的儿童模式打开",
    cost: "约 10 秒",
  },
  {
    title: "一句话办三件事",
    hint: "行程、保养、试驾被拆成三条线同时推进，进展会逐条显示",
    prompt: "下周末带父母去杭州自驾，顺路把保养做了，再去 4S 店给家里人挑辆新车试驾。",
    cost: "约 2 分钟",
  },
];

/*
 * lane 的显示名。取值照着线上 trace 里 branch 事件的 agent 字段实际出现过的写
 * （本机库按出现次数查过），不是照着 Agent 清单猜的：复合意图的 lane 带
 * `primary:` / `side:` 前缀，行程 fan-out 的四条腿是 `*-task`。
 * 表里没有的原样显示——宁可露出一个内部名，也不要把它吞掉让人少看到一条线。
 */
const LANE_BASE: Record<string, string> = {
  itinerary: "出行规划",
  service: "售后保养",
  testDrive: "试驾预约",
  buying: "购车顾问",
  ownership: "用车问诊",
  cabin: "座舱",
  "drive-task": "自驾路线",
  "hotel-task": "住宿",
  "tour-task": "游玩安排",
  "transit-task": "接驳",
  "cabin-task": "座舱",
  "ownership-task": "用车问诊",
  // 多天行程的 Plan 层：先把景点按天×片区聚好，四条腿再读这份骨架
  "tour-plan-task": "行程骨架",
  "trip-review-task": "行程体检",
  "service-task": "售后保养",
  "buying-task": "购车试驾",
};

export function laneLabel(agent: string): string {
  const m = /^(primary|side):(.+)$/.exec(agent);
  if (!m) return LANE_BASE[agent] ?? agent;
  const name = LANE_BASE[m[2]] ?? m[2];
  return m[1] === "primary" ? name + "（主任务）" : name;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string>("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [state, setState] = useState<string>("idle");
  const [pending, setPending] = useState<PermissionView | null>(null);
  const [draft, setDraft] = useState("");
  const [tools, setTools] = useState<ToolProgress[]>([]);
  const [lanes, setLanes] = useState<BranchProgress[]>([]);
  const [filler, setFiller] = useState("");

  const session = useRef<{ id: string; token: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void (async () => {
      try {
        const token = await login(config.demoUser, config.demoPassword);
        const id = await openSession(token);
        session.current = { id, token };
        stop = openStream(
          id,
          token,
          (env) => {
            const text = deltaText(env);
            if (text) {
              setFiller("");
              setTurns((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant") {
                  return [...prev.slice(0, -1), { role: "assistant", text: last.text + text }];
                }
                return [...prev, { role: "assistant", text }];
              });
              return;
            }
            const s = assistantState(env);
            if (s) setState(s);
            const perm = permissionRequest(env);
            if (perm) setPending(perm);
            const tool = toolProgress(env);
            if (tool) setTools((prev) => [...prev.filter((t) => t.id !== tool.id), tool]);
            const lane = branchProgress(env);
            if (lane) setLanes((prev) => [...prev.filter((l) => l.agent !== lane.agent), lane]);
            const fill = fillerText(env);
            if (fill) setFiller(fill);
            if (isTurnEnd(env)) {
              setPhase("ready");
              /*
               * 一轮结束时后端**不发** state:idle——整条流里 state 事件只有一个
               * （进入 thinking 那次）。不自己收尾的话，状态灯会一直停在「在想」，
               * 而回答早就说完了：看起来像卡住，实际只是没人把灯关掉。
               */
              setState("idle");
              setTools([]);
              setFiller("");
              // lanes 留着：它是这一轮"同时办了几件事"的收据，下一轮开始时再清
            }
          },
          (err) => {
            setError("事件流断开：" + err.message);
            setPhase("failed");
          },
        );
        setPhase("ready");
      } catch (err) {
        /*
         * 报错必须说清**是哪一步**。上一版把整个 try 里的 401 一律写成"登录失败"，
         * 而这个 try 同时罩着登录、建会话、开流三步——线上真出问题时，
         * 建会话的 401 被显示成"口令不对"，把排查引向了完全错误的方向。
         * GatewayError.message 里本来就有 `路径 → 状态码`，别丢掉它。
         */
        const e = err as GatewayError;
        const hint =
          e.status === 401 && e.message.includes("/v1/auth/login")
            ? "（演示账号口令与站点配置对不上）"
            : e.status === 401
              ? "（鉴权没到网关：token 在中途被丢了）"
              : e.status === 503
                ? "（访问太频繁，稍等一会儿再试）"
                : "";
        setError("连不上服务端：" + e.message + hint);
        setPhase("failed");
      }
    })();
    return () => stop?.();
  }, []);

  useEffect(() => {
    /*
     * 只在真有内容时才滚。加了下方的真机展示区之后，挂载时这个 effect 也会跑一次，
     * 把"滚到底"理解成滚到展示区——访客一进来就错过了引导，页面看起来像空白。
     */
    if (turns.length === 0 && !pending) return;
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns, pending, tools, lanes]);

  const submit = useCallback(
    async (raw: string) => {
      const s = session.current;
      const content = raw.trim();
      if (!s || !content || phase !== "ready") return;
      setDraft("");
      setError("");
      setLanes([]);
      setTurns((prev) => [...prev, { role: "user", text: content }]);
      setPhase("busy");
      try {
        await sendMessage(s.id, content, s.token);
      } catch (err) {
        const e = err as GatewayError;
        if (e.status === 401) {
          // token 过期了（15 分钟）。换一把重发，别让访客看到一句"发送失败"就走人。
          try {
            const fresh = await relogin();
            session.current = { id: s.id, token: fresh };
            await sendMessage(s.id, content, fresh);
            return;
          } catch {
            setError("登录态过期了，刷新一下页面就好。");
            setPhase("ready");
            return;
          }
        }
        setError(e.status === 503 ? "发得太快了，稍等几秒再试。" : "发送失败：" + e.message);
        setPhase("ready");
      }
    },
    [phase],
  );

  const decide = useCallback(
    async (approved: boolean) => {
      const s = session.current;
      const perm = pending;
      if (!s || !perm) return;
      setPending(null);
      try {
        await resume(s.id, perm.interruptId, approved, s.token);
      } catch (err) {
        setError("确认回执失败：" + (err as Error).message);
      }
    },
    [pending],
  );

  const busy = phase === "busy";
  const showWorking = busy && !pending;

  return (
    <div className="app">
      {config.notice ? <div className="notice">{config.notice}</div> : null}

      <header>
        <span className={"orb orb-" + state} aria-hidden="true" />
        <h1>CarLife</h1>
        <span className={"state state-" + state}>{stateLabel(state)}</span>
        <span className="build" title="镜像构建时间">{config.buildId}</span>
      </header>

      <main>
        {turns.length === 0 && phase !== "failed" ? (
          <section className="intro">
            <p className="lead">
              面向车主的用车智能体。这是它的网页试用版——真机是车机与手机上的语音助手，样子见页面下方。
            </p>
            <p className="sub">三件值得试的事：</p>
            <div className="scenarios">
              {SCENARIOS.map((sc) => (
                <button
                  key={sc.title}
                  type="button"
                  className="scenario"
                  disabled={phase !== "ready"}
                  onClick={() => void submit(sc.prompt)}
                >
                  <strong>{sc.title}</strong>
                  <span className="prompt">「{sc.prompt}」</span>
                  <span className="hint">{sc.hint}</span>
                  <span className="cost">{sc.cost}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {turns.map((t, i) => (
          <article key={i} className={"turn turn-" + t.role}>
            {t.role === "assistant" ? <Rich text={t.text} /> : t.text}
          </article>
        ))}

        {lanes.length > 0 ? (
          <section className="lanes" aria-label="并行任务">
            <h2>同时在办 {lanes.length} 件事</h2>
            <ul>
              {lanes.map((l) => (
                <li key={l.agent} className={"lane lane-" + l.status}>
                  <span className="lane-name">{laneLabel(l.agent)}</span>
                  <span className="lane-note">{laneNote(l)}</span>
                  {l.durationMs !== null ? <span className="lane-time">{(l.durationMs / 1000).toFixed(1)}s</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {showWorking ? (
          <section className="working" aria-live="polite">
            {filler ? <p className="filler">{filler}</p> : null}
            {tools.length > 0 ? (
              <ul>
                {tools.map((t) => (
                  <li key={t.id} className={"tool tool-" + t.status}>
                    {t.label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dots">正在处理…</p>
            )}
          </section>
        ) : null}

        {pending ? (
          <section className="permission">
            <h2>{permissionTitle(pending)}</h2>
            <dl>
              {pending.details.map((d, i) => (
                <div key={i}>
                  <dt>{d.label}</dt>
                  <dd>{d.value}</dd>
                </div>
              ))}
            </dl>
            {pending.scope ? <p className="scope">影响范围：{pending.scope}</p> : null}
            {pending.disclosure.length > 0 ? (
              <div className="disclosure">
                <h3>将提供给第三方的个人信息</h3>
                <dl>
                  {pending.disclosure.map((d, i) => (
                    <div key={i}>
                      <dt>{d.label}</dt>
                      <dd>{d.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
            <div className="actions">
              <button type="button" className="approve" onClick={() => void decide(true)}>同意</button>
              <button type="button" onClick={() => void decide(false)}>不用了</button>
            </div>
          </section>
        ) : null}

        {error ? <p className="error">{error}</p> : null}
        <div ref={bottom} />
      </main>

      <footer>
        <textarea
          value={draft}
          placeholder={phase === "failed" ? "服务端连不上" : busy ? "它还在办上一件事…" : "说点什么…"}
          disabled={phase === "failed"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit(draft);
            }
          }}
        />
        <button type="button" onClick={() => void submit(draft)} disabled={phase !== "ready" || !draft.trim()}>
          发送
        </button>
      </footer>

      <section className="showcase">
        <h2>真机长这样</h2>
        <p>
          上面是网页试用版。真正的产品是车机端与手机端的原生应用：常驻语音、HUD 与助手形象、车辆信号都在端上，
          浏览器里没有这些。源码与文档见本页上方的「文件」。
        </p>
        <div className="shots">
          <figure>
            <img src="/showcase/screenshot-cockpit.jpg" alt="车机端界面" loading="lazy" />
            <figcaption>车机端 · HUD 与语音助手</figcaption>
          </figure>
          <figure>
            <img src="/showcase/screenshot-mobile.jpg" alt="手机端界面" loading="lazy" />
            <figcaption>手机端</figcaption>
          </figure>
        </div>
        <figure className="wide">
          <img src="/showcase/compound-intent-lanes.png" alt="复合意图的分叉与汇合示意" loading="lazy" />
          <figcaption>「一句话办三件事」背后：意图拆成主任务与副任务，分叉成几条 lane 并行求解，再汇合成一段回答</figcaption>
        </figure>
      </section>
    </div>
  );
}

function Rich({ text }: { text: string }) {
  return (
    <>
      {paragraphs(text).map((lines, pi) => (
        <p key={pi}>
          {lines.map((spans, li) => (
            <span key={li}>
              {li > 0 ? <br /> : null}
              {spans.map((sp, si) => (sp.bold ? <strong key={si}>{sp.text}</strong> : <span key={si}>{sp.text}</span>))}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

function stateLabel(state: string): string {
  switch (state) {
    case "listening":
      return "在听";
    case "thinking":
      return "在想";
    case "speaking":
      return "在说";
    case "alert":
      return "提醒";
    default:
      return "待命";
  }
}

/**
 * 确认卡标题。服务端目前给的是 `需要你确认：cabin_child_mode` 这种带函数名的串——
 * 内部名对开发者有用，对访客只是噪音。有对照就换人话，没有就把函数名那截去掉。
 * **不改服务端**：这是展示层的措辞，`action` 字段本身还得保持机器可读。
 */
const ACTION_TITLES: Record<string, string> = {
  cabin_child_mode: "要为你打开儿童模式",
  appointment: "要为你预约",
  calendar: "要写入你的日历",
  trip_plan_commit: "要把这份行程定下来",
  test_drive: "要为你预约试驾",
};

export function permissionTitle(p: PermissionView): string {
  const known = ACTION_TITLES[p.action];
  if (known) return known;
  // 退路：把 "需要你确认：xxx_yyy" 里的函数名去掉，留下前半句
  const stripped = p.title.replace(/[:：]\s*[a-z0-9_]+\s*$/i, "");
  return stripped || p.title;
}

/**
 * lane 这一行右边显示什么。
 *
 * 服务端给的 `note` 已经是一句人话（"酒店安排开始"），再拼一个状态词就成了
 * "酒店安排开始已完成"——真跑时就是这个样子。所以有 note 用 note，
 * 只有失败/超时才必须额外说明，因为那两种情况 note 不会自己说出来。
 */
function laneNote(l: BranchProgress): string {
  if (l.status === "failed") return l.note ? l.note + "（没办成）" : "这一项没办成";
  if (l.status === "timeout") return l.note ? l.note + "（超时）" : "超时了";
  if (l.note) return l.note;
  return l.status === "ok" ? "完成" : "进行中…";
}
