/**
 * 设置页的「当前身份」区（施工单 M49-04，F-56-04）。
 *
 * # 为什么这一区必须存在
 *
 * `switch_device_role` 这个 Tauri 命令 M48-04 就写好了，但**端上调用它的地方一个都没有**
 * ——命令有、入口没有，等于这个能力不存在。而设计裁决 R12 要的是
 * "同一台 pad 能在私人终端与车机之间切，且当前身份常驻可见"。
 *
 * # 三条纪律
 *
 *  1. **切换必须显式手动**，不做环境自动检测（FL-56 负向验收）。
 *     "插上车充就自动变车机"猜错的代价是别人的车用了你的身份。
 *  2. **当前身份常驻可见**：不是点进某个二级页才看得到。
 *  3. 存不住登录状态时**如实说**（M49-02 的 `storage_degraded`），
 *     不等用户下次上车才发现要重新输密码。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Role = "personal" | "cockpit";

interface State {
  role: Role;
  vin: string;
  degraded: boolean;
}

export interface IdentitySectionProps {
  /** 切换完成后通知外层（车机身份要重新走绑定/声明）。 */
  onRoleChanged?: (role: Role) => void;
}

export function IdentitySection({ onRoleChanged }: IdentitySectionProps) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [role, vin, degraded] = await Promise.all([
        invoke<string>("device_role"),
        invoke<string>("bound_vin").catch(() => ""),
        invoke<boolean>("credential_storage_degraded").catch(() => false),
      ]);
      setState({ role: role === "cockpit" ? "cockpit" : "personal", vin, degraded });
    } catch {
      // 浏览器走查：整区不渲染，而不是渲染一个点了报错的开关
      setState(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchTo = useCallback(
    async (next: Role) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await invoke<string>("switch_device_role", { role: next });
        await load();
        onRoleChanged?.(next);
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, load, onRoleChanged],
  );

  if (!state) return null;

  const isCockpit = state.role === "cockpit";
  return (
    <section className="cset-group">
      <h2>当前身份</h2>
      <p className="cset-identity">
        {isCockpit ? (
          <>
            <strong>车机</strong>
            {state.vin ? `（车辆 ${state.vin.slice(-4)}）` : "（尚未绑定车辆）"}
          </>
        ) : (
          <strong>私人终端</strong>
        )}
      </p>
      <p className="cset-note">
        {isCockpit
          ? "这台设备正作为这辆车的共享车机，上车时需要选择使用人。"
          : "这台设备是你个人的终端，会话与记忆都记在你名下。"}
      </p>
      <button
        type="button"
        className="cset-identity-switch"
        disabled={busy}
        onClick={() => void switchTo(isCockpit ? "personal" : "cockpit")}
      >
        {busy ? "切换中…" : isCockpit ? "退出车机模式" : "用作车机"}
      </button>
      <p className="cset-note">
        {/* 两个身份各存各的凭证（M49-02），所以切回来不用重新登录。 */}
        两种身份的登录状态各自保存，切回来不需要重新登录。
      </p>
      {state.degraded ? (
        <p className="cset-warn">
          本机无法安全保存登录状态，重启后需要重新登录。
        </p>
      ) : null}
      {error ? <p className="cset-warn">切换失败：{error}</p> : null}
    </section>
  );
}
