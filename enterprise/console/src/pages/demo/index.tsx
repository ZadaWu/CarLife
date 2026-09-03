/**
 * 演示大屏（施工单 M9-07，FL-30 F-30-08；
 * 2026-08-26 收敛为两个区块：现在流到哪了 + 最近 30 分钟 KPI）。
 *
 * # 只有两个区块，且都围着"当前会话"转
 *
 * 健康卡、四问表、审计表都撤了——它们各自的页面还在，大屏不替它们复述。
 * 留下的两块共享一个"当前会话"概念：流向图画谁，KPI 就圈到谁
 * （跟随实时时是最近活动的会话；锁定后是锁定的那个）。
 *
 * # fake 警示不算"区块"，它是红线
 *
 * 运行形态不是全真实时那条高亮横幅仍然排最前（M3 的教训：处于 Fake 模式
 * 而没注意到，讲了半天"这是真实调用"）。全真实时它整条消失——
 * 它是警报，不是常驻摆设。
 *
 * # 每个数字都能追到来源
 *
 * 大屏不算任何新指标：四问的数字与回放页是同一个 `summarize` 算出来的，
 * 用量来自用量页的同一个仓储，按会话圈定也只是 where 里多了 sessionId。
 *
 * # 自动刷新
 *
 * 演示时没人会去点刷新按钮。10 秒一次，够跟上一次对话的节奏，
 * 也不至于让大屏一直在闪。"现在流到哪了"不走这条轮询，单走 SSE（见 LiveFlow）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NumberFlow, { type Format } from "@number-flow/react";
import { MeshGradient } from "@paper-design/shaders-react";

import { api, ApiError } from "../../api";
import { LiveFlow } from "./LiveFlow";

interface ToolCallStats {
  total: number;
  real: number;
  mock: number;
  /** 三分类（按工具注册表的 provider 判）：RAG 检索 / 模拟服务或模拟数据 / 自有工具。 */
  rag: number;
  mockService: number;
  own: number;
}

interface Answers {
  agentCount: number;
  hasParallelOverlap: boolean;
  longestInterruptMs: number | null;
  toolCalls: ToolCallStats;
  turns: number;
  answerChars: number;
}

interface UsageTotal {
  total?: {
    calls: number;
    costEstimate: number;
    promptTokens: number;
    completionTokens: number;
    /** 命中上下文缓存的输入 token；只有直连 DeepSeek 那条路给得出（见服务端注释）。 */
    cacheHitTokens: number;
    /** 未命中、因而写入缓存的输入 token。 */
    cacheMissTokens: number;
  };
}

/** LLM + 语音合成两笔的拆分。计费量与单价都来自服务端，前端不算价。 */
interface Cost {
  llm: number;
  ttsChars: number;
  ttsRequests: number;
  tts: number;
  total: number;
}

interface Overview {
  mode: { llm: string; asr: string; tools: string };
  window: { minutes: number; sessions: number };
  toolCalls: ToolCallStats;
  turns: number;
  usage: UsageTotal | null;
  cost: Cost;
  /** 传了 sessionId 才有：圈到那个会话的同一组数。 */
  scoped: { sessionId: string; answers: Answers; usage: UsageTotal | null; cost: Cost } | null;
}

const REFRESH_MS = 10_000;

/**
 * 背景氛围层（ACR-001，参数的真相源在 ./design-spec.md）。
 *
 * WebGL 起不来（远程桌面、老会议室机器）或用户要求减少动效时，
 * 这里**整层不挂 canvas**，只剩 CSS 渐变兜底——氛围层失效不许拖垮数据层，
 * 也不值得为它弹任何错误。
 */
function Backdrop(): JSX.Element {
  const canShader = useMemo(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    try {
      const probe = document.createElement("canvas");
      return probe.getContext("webgl2") !== null || probe.getContext("webgl") !== null;
    } catch {
      return false;
    }
  }, []);
  return (
    <div className="demo-backdrop" aria-hidden>
      {canShader && (
        <MeshGradient
          colors={["#0b1020", "#0969da", "#6e40c9", "#101828"]}
          distortion={0.8}
          swirl={0.6}
          speed={0.15}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
      )}
    </div>
  );
}

export function DemoPage(): JSX.Element {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 当前会话：锁定优先，否则跟随 LiveFlow 正在画的那个。KPI 圈定跟着它走。
  const [pinned, setPinned] = useState<string | null>(null);
  const [autoSid, setAutoSid] = useState<string | undefined>(undefined);
  const activeSid = pinned ?? autoSid;
  // 投屏模式 = 原生 fullscreen：只放大排版、藏掉控制台 chrome，不增删任何内容区块。
  const sectionRef = useRef<HTMLElement | null>(null);
  const [cast, setCast] = useState(false);

  useEffect(() => {
    const onChange = () => setCast(document.fullscreenElement === sectionRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const load = useCallback(() => {
    const q = activeSid ? `?sessionId=${encodeURIComponent(activeSid)}` : "";
    api
      .get<Overview>(`/console/demo/overview${q}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }, [activeSid]);

  // 会话切换立即重取，不等下一个 10 秒——观众刚选完就该看到属于它的数。
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const onAutoSession = useCallback((sid: string | undefined) => setAutoSid(sid), []);

  if (error) return <p className="error">加载失败：{error}</p>;
  if (!data) return <p className="muted">加载中…</p>;

  // unknown 也算"不是全真实"——**取不到就不能说是真的**，
  // 这与"审核层未接入时显式标注"是同一条原则。
  const fake =
    data.mode.llm !== "real" || data.mode.asr !== "real" || data.mode.tools !== "real";
  const scoped = activeSid && data.scoped?.sessionId === activeSid ? data.scoped : null;

  return (
    <section className="page demo" ref={sectionRef}>
      <Backdrop />
      <button
        type="button"
        className="demo-cast-btn"
        onClick={() => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void sectionRef.current?.requestFullscreen();
        }}
      >
        {cast ? "退出投屏" : "⛶ 投屏模式"}
      </button>
      <div className={fake ? "demo-main demo-main--fake" : "demo-main"}>
        {/* 标题并进 LiveFlow 的第一行（区块标题、副标题、统计范围说明都已撤）：
            "每 10 秒刷新 / 数字来自已有来源 / KPI 跟着图上的会话"这些事实没变，
            只是不再各占一行说出来——大屏的高度优先给图和数字。 */}

        {/* fake 警示是红线不是区块：不全真实才出现，出现就必须扎眼（设计原则 3） */}
        {fake && (
          <div className="demo-mode demo-mode--fake">
            <span>LLM：{data.mode.llm}</span>
            <span>ASR：{data.mode.asr}</span>
            <span>工具：{data.mode.tools}</span>
            <strong>⚠️ 当前不是全真实链路，讲解时不要说“这是真实调用”</strong>
          </div>
        )}

        <div className="demo-flow-region">
          <LiveFlow title="演示大屏" pinned={pinned} onPinChange={setPinned} onAutoSession={onAutoSession} />
        </div>

        {/* KPI 直接跟在图下（统计范围 = 图上正在画的会话，topbar 里已写明是谁）。
            KPI 是前景层主角（ACR-002）：数位滚动只跟着真实数据变。
            工具按注册表 provider 分三类，模拟一类单列——合在一起就答不了
            "这个数是真的还是编的"。 */}
        <div className="demo-kpi-row">
          <Kpi
            label="轮次"
            value={scoped ? scoped.answers.turns : data.turns}
            note={scoped ? "本会话的对话轮数" : "窗口内各会话轮次合计"}
          />
          <Kpi
            label="RAG 检索"
            value={(scoped ? scoped.answers.toolCalls : data.toolCalls).rag}
            note="RAGFlow 知识库检索次数"
          />
          <Kpi
            label="模拟服务调用"
            value={(scoped ? scoped.answers.toolCalls : data.toolCalls).mockService}
            note={
              (scoped ? scoped.answers.toolCalls : data.toolCalls).mockService > 0
                ? "打到模拟系统（经销商/车机）或模拟数据，讲解时须点明"
                : "为 0 才能说全真实"
            }
            warn={(scoped ? scoped.answers.toolCalls : data.toolCalls).mockService > 0}
          />
          <Kpi
            label="自有工具调用"
            value={(scoped ? scoped.answers.toolCalls : data.toolCalls).own}
            note="地图 / 天气 / 记忆等自有能力"
          />
          {/* LLM 卡片自带 token 明细：调用次数是主数，输入/输出与缓存是它的补充，
              拆成几张卡会让"次数"和"token"看起来像并列的两件事。 */}
          <Kpi
            label="LLM 调用"
            value={(scoped ? scoped.usage : data.usage)?.total?.calls ?? 0}
            note="经网关计量的次数"
            detail={<LlmTokenDetail total={(scoped ? scoped.usage : data.usage)?.total} />}
          />
          {/* 语音与 LLM 的计费口径不同：它按字数算钱，次数只是补充 */}
          <Kpi
            label="语音合成"
            value={(scoped ? scoped.cost : data.cost).ttsRequests}
            note={`${(scoped ? scoped.cost : data.cost).ttsChars} 字 · 按字数计费`}
          />
          {/* 大屏只到分位——拆分与精确值看下面那行小字与用量页 */}
          <Kpi
            label="成本估算"
            value={(scoped ? scoped.cost : data.cost).total}
            prefix="¥"
            format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }}
            note={costNote(scoped ? scoped.cost : data.cost)}
          />
        </div>
      </div>
    </section>
  );
}

/** 成本拆分一句话：两笔各多少、TTS 按多少字折的。单价与折算都在服务端（配置热改）。 */
function costNote(c: Cost): string {
  return `LLM ¥${c.llm.toFixed(4)} + 语音合成 ¥${c.tts.toFixed(4)}（按 ${c.ttsChars} 字折算）`;
}

/**
 * LLM 卡片的 token 明细。
 *
 * 缓存命中率的分母是**有缓存数据的那部分输入**（命中 + 未命中），不是 promptTokens：
 * 经 pi-acp 的调用拿不到缓存信息（token 本身也是估的），把它们算进分母
 * 会让命中率随"跑了几次子 Agent"上下飘，而那与缓存好不好毫无关系。
 * 两者都为 0 时整行不显示——**没有数据不等于命中率 0%**。
 */
function LlmTokenDetail({ total }: { total?: UsageTotal["total"] }): JSX.Element | null {
  if (!total) return null;
  const cacheable = total.cacheHitTokens + total.cacheMissTokens;
  return (
    <dl className="demo-kpi-detail">
      <div>
        <dt>输入</dt>
        <dd>{total.promptTokens.toLocaleString()}</dd>
      </div>
      <div>
        <dt>输出</dt>
        <dd>{total.completionTokens.toLocaleString()}</dd>
      </div>
      {cacheable > 0 ? (
        <>
          <div>
            <dt>缓存命中</dt>
            <dd>{total.cacheHitTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>缓存写入</dt>
            <dd>{total.cacheMissTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>命中率</dt>
            <dd>{((total.cacheHitTokens / cacheable) * 100).toFixed(1)}%</dd>
          </div>
        </>
      ) : (
        <div className="demo-kpi-detail-note">
          <dt>缓存</dt>
          <dd title="经 pi-acp 的调用拿不到缓存信息，不是「没命中」">无数据</dd>
        </div>
      )}
    </dl>
  );
}

/** 大 KPI（ACR-002）：数字走 NumberFlow 数位滚动；它自己会尊重 prefers-reduced-motion。 */
function Kpi({
  label,
  value,
  note,
  warn,
  prefix,
  format,
  detail,
}: {
  label: string;
  value: number;
  note?: string;
  warn?: boolean;
  prefix?: string;
  format?: Format;
  /** 卡内补充数据（如 LLM 的 token 明细）。跟着主数走，不另开一张卡。 */
  detail?: JSX.Element | null;
}): JSX.Element {
  return (
    <div className={warn ? "demo-kpi demo-kpi--warn" : "demo-kpi"}>
      <h3>{label}</h3>
      <strong>
        <NumberFlow value={value} prefix={prefix} format={format} />
      </strong>
      {note && <p className="muted">{note}</p>}
      {detail}
    </div>
  );
}
