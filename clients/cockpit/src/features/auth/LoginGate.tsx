/**
 * 车机端的登录门（施工单 M54-06，缺口 G1/G4/G5a——见登录流程勘察图）。
 *
 * # 为什么此前不存在
 *
 * `auth_login` / `auth_status` / `auth_logout` 三条命令 M48-02 就注册在
 * 装配清单里，但车机前端**一个调用方都没有**（孤儿命令第 5 例）。
 * 于是 personal 模式下打开 app：没有登录界面、所有请求 401、屏幕不解释——
 * 用户既登不进去，也看不出"为什么什么都不对"。
 *
 * # 与手机端 LoginGate 的两处刻意差异
 *
 *  1. **只拦 personal 角色**。车机角色走车辆级凭证（免密，F-07-04），
 *     它的门是 `BoardingGate`，两道门互斥、各管一种凭证。
 *  2. **必须留「把这台设备用作车机」出口**（G4）。一台全新 pad 不该先有
 *     账号才能变成车机——被口令挡死的话，车机绑定路径整个锁死。
 *     这一条是画流程图时暴露的：改 G1 之前它根本不成立（没有门自然没有死门）。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { GatewayForm } from "../settings/GatewayForm";

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
  const [showGateway, setShowGateway] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        /*
         * 判据是**手里有没有车辆凭证**，不只是角色标记（M54-11）。
         *
         * 角色曾经只活在内存里，重启退回 personal——于是一台早就绑好车的车机
         * 被这道门拦下来要账号口令（2026-09-01 走查截图）。角色持久化已在
         * `device.rs` 修好，这里再加一道以凭证为准的判据：绑过车 = 车机，
         * 与角色文件是否健在无关。两条判据都通不过才是真的私人终端。
         */
        const [role, boundVin] = await Promise.all([
          invoke<string>("device_role"),
          invoke<string>("bound_vin").catch(() => ""),
        ]);
        if (role === "cockpit" || boundVin) {
          // 车机不经过本门：它的凭证是车辆级的（免密，F-07-04），门是 BoardingGate。
          setStatus({ authenticated: true, userId: null, displayName: null });
          return;
        }
        setStatus(await invoke<AuthStatus>("auth_status"));
      } catch {
        // 不在 Tauri 里（浏览器走查）：放行，否则 UI 走查全被挡住。
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
        // 口令用完即弃：它不该在任何状态里多活一秒（与手机端同一句话）。
        setPassword("");
        // 注册本设备（幂等；失败不挡登录——设备注册是附带动作）。
        void invoke("register_device", { modelName: "车机屏" }).catch(() => undefined);
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, username, password],
  );

  /** G4：不登录任何账号，直接把这台设备切成车机（免密，走 BoardingGate 绑定）。 */
  const useAsCockpit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke<string>("switch_device_role", { role: "cockpit" });
      // 整页重载：BoardingGate 挂在最外层，局部改状态到不了它（与设置页同一处理）。
      window.location.reload();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }, [busy]);

  if (status === null) return <div className="clogin clogin--loading" />;
  if (status.authenticated) return <>{children}</>;

  return (
    <div className="clogin">
      <form className="clogin-card" onSubmit={submit}>
        <h1>CarLife</h1>
        <p className="clogin-hint">这台设备是私人终端，请登录后使用</p>
        <label className="clogin-field">
          <span>账号</span>
          <input
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="clogin-field">
          <span>口令</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {/* 错误原文来自 Rust 侧（带 source 链）：网络故障与账号错误是两种处置，不合并。 */}
        {error ? <p className="clogin-error">{error}</p> : null}
        <button className="clogin-submit" type="submit" disabled={busy || !username || !password}>
          {busy ? "登录中…" : "登录"}
        </button>
        <div className="clogin-alt">
          {/* G5a：连不上网关时，改地址的入口就在门上，不需要先进得去设置页。 */}
          <button type="button" onClick={() => setShowGateway((v) => !v)} disabled={busy}>
            {showGateway ? "收起网关设置" : "改网关地址"}
          </button>
          {/* G4：车机免密。全新 pad 从这里走绑定，不需要任何账号。 */}
          <button type="button" onClick={() => void useAsCockpit()} disabled={busy}>
            把这台设备用作车机
          </button>
        </div>
        {showGateway ? (
          <div className="clogin-gateway">
            <GatewayForm active={showGateway} />
          </div>
        ) : null}
      </form>
    </div>
  );
}
