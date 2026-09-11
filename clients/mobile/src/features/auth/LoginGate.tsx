/**
 * 登录门（施工单 M48-02，F-07-01/03）。
 *
 * # 为什么是"门"而不是一个页面
 *
 * 未登录时整个应用没有任何能用的东西——所有网关调用都会 401。
 * 与其让 HUD 先渲染出来再一个个报错（那看起来像"服务挂了"），
 * 不如在最外层把它挡住，并明说是**还没登录**。
 *
 * # 口令只在这个组件里存在一瞬
 *
 * 它进 `invoke("auth_login")` 之后就被清空，不进任何状态容器、不进 localStorage。
 * token 从头到尾没到过 WebView：Rust 侧登录成功只回"你是谁"（见 commands/auth.rs）。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { MapBackdrop, SPRITES } from "@carlife/ui";
import { GatewayField } from "./GatewayField";
import "./login.css";

interface AuthStatus {
  authenticated: boolean;
  userId: string | null;
  displayName: string | null;
}

export interface LoginGateProps {
  children: React.ReactNode;
}

export function LoginGate({ children }: LoginGateProps): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 网络诊断结果（M65-03）：只在登录失败后可用，App 自己连几个目标把 errno 带回来。 */
  const [diag, setDiag] = useState<string[] | null>(null);
  const runDiag = useCallback(async () => {
    setDiag(["诊断中…"]);
    try {
      setDiag(await invoke<string[]>("net_diag"));
    } catch (err) {
      setDiag([`诊断命令不可用：${String(err)}`]);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setStatus(await invoke<AuthStatus>("auth_status"));
      } catch {
        // 不在 Tauri 里（浏览器走查）：当作已登录放行，否则 UI 走查全被挡住。
        setStatus({ authenticated: true, userId: null, displayName: null });
      }
    })();
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const next = await invoke<AuthStatus>("auth_login", { username, password });
        setStatus(next);
        // 口令用完即弃：它不该在任何状态里多活一秒。
        setPassword("");
        /*
         * 注册本设备（M53-02 补）。`register_device` 的注释自己写着「登录后调一次；幂等」，
         * 而在此之前**端上没有任何地方调它**——于是这台手机从不出现在 `GET /v1/devices` 里，
         * F-56-02 的设备列表与撤销在手机侧等于不存在。这是同一形状的第四次，
         * 由本单新加的 `check:orphan-commands` 查出来的。
         *
         * 失败不打断登录：设备注册是**附带**动作，登录本身已经成了。
         * 让它把人挡在门外是更差的交易。
         */
        void invoke("register_device", { modelName: "手机" }).catch(() => undefined);
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, username, password],
  );

  // 还没问出结果时不闪登录页——闪一下再进主界面比慢一点更像出错了。
  if (status === null) return <div className="login-gate login-gate--loading" />;
  /*
   * `?login=demo`：即使已登录也把这道门画出来——**版式截图入口**，与车机端同名 query 同一类。
   * 浏览器走查里这道门进不去（拿不到网关时按 fail-open 放行，见上面的 catch），
   * 新版式因此没有地方可验。真实运行不带 query，行为一字不变。
   */
  if (status.authenticated && !isLoginDemo()) return <>{children}</>;

  return (
    <div className="login-gate">
      {/*
       * 舞台：程序化灰白地图 + 暖暖（定稿 `内部文档`）。
       * 用 `MapBackdrop` 而不是真实底图——这道门在**拿到网关之前**就要画出来，那时既没有
       * 地图 key 也没有网络；程序化底图零依赖、离线也在。配色由 `.login-gate` 局部改写
       * `--hud-map-*` 压成灰白（见 login.css），与车机端那道门同一条做法。
       */}
      <div className="login-gate__stage" aria-hidden="true">
        <MapBackdrop />
      </div>
      <img className="login-gate__mascot" src={SPRITES.light.assistant} alt="" aria-hidden="true" draggable={false} />
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">CarLife</h1>
        <p className="login-hint">请登录后使用</p>
        <label className="login-field">
          <span>账号</span>
          <input
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="login-field">
          <span>口令</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {/* 错误原文来自 Rust 侧：401 是"账号或口令不正确"，网络故障是另一句。
            前端不再加工——加工会把两种完全不同的处置合并成一句无用的话。 */}
        {error ? <p className="login-error">{error}</p> : null}
        {error ? (
          <div className="login-diag">
            <button type="button" className="login-diag__btn" onClick={() => void runDiag()}>
              网络诊断
            </button>
            {diag ? (
              <ul className="login-diag__list">
                {diag.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <button className="login-submit" type="submit" disabled={busy || !username || !password}>
          {busy ? "登录中…" : "登录"}
        </button>
        {/* 连不上时唯一能自救的地方——设置页在登录门后面，够不着（见 GatewayField 文件头）。 */}
        <GatewayField />
      </form>
    </div>
  );
}

/** `?login=demo`：版式截图入口，见上面的使用处。 */
function isLoginDemo(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("login") === "demo";
}
