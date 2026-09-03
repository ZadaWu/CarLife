/**
 * 登录页上的「网关地址」一栏。
 *
 * # 为什么它必须在登录页上，而不是设置页里
 *
 * 装到手机上时，`localhost` 指向手机自己，默认地址必然连不上；而 `LoginGate`
 * 是硬门——登录不成就进不去设置页。把改地址的入口放在设置页里，等于
 * **要求用户先登录才能配置"登录去哪儿"**，是个死锁。
 * 第一次拿到设备的人看到的症状会是"登录一直失败"，而地址从来就没对过。
 *
 * # 默认折叠
 *
 * 开发机上有 `.env`，地址恒定正确，这一栏是噪音；只有连不上的人才需要它。
 * 所以默认只显示一行「当前连接：…」，点开才是输入框。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface GatewaySettingsView {
  effectiveUrl: string;
  storedUrl: string | null;
  /** 生效地址来自哪一层（Rust 侧 `UrlSource`）。端上配过就恒是 `stored`。 */
  source: "stored" | "env" | "default";
  /** 环境变量里的那份（开发机 `.env`），可能为 null。 */
  envUrl: string | null;
  platform: string;
}

export function GatewayField() {
  const [view, setView] = useState<GatewaySettingsView | null>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<GatewaySettingsView>("get_gateway_settings")
      .then((v) => {
        setView(v);
        setUrl(v.storedUrl ?? "");
      })
      // 拿不到就整栏不渲染：浏览器走查里没有这个命令，不该在那儿显示一个死按钮。
      .catch(() => setView(null));
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke<GatewaySettingsView>("set_gateway_settings", {
        gatewayUrl: url.trim() || null,
        demoToken: null, // token 由登录产生，这里不碰（见 settings.rs 的 None 语义）
      });
      /*
       * 整页刷新而不是只更新状态：`auth_status`、缓存、后续所有请求都是按旧地址
       * 建的。设置网关是低频动作，刷新是最诚实的"从头来"（与车机端同一处理）。
       */
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [url]);

  if (!view) return null;

  return (
    <div className="login-gateway">
      <button type="button" className="login-gateway__summary" onClick={() => setOpen((v) => !v)}>
        <span>连接到 {view.effectiveUrl}</span>
        <span aria-hidden="true">{open ? "收起" : "更改"}</span>
      </button>
      {open && (
        <div className="login-gateway__body">
          {/* 来源如实显示（2026-09-01，与车机端同一处理）：端上配的最优先，
              上一版那句"这里保存的值只在没有环境变量的设备上生效"已不成立。 */}
          {view.source === "stored" && view.envUrl && view.envUrl !== view.effectiveUrl && (
            <p className="login-gateway__hint">
              环境变量里的 <code>{view.envUrl}</code> 已被本机设置覆盖；清空下方地址并保存可回到它。
            </p>
          )}
          {view.source === "env" && (
            <p className="login-gateway__hint">
              当前地址来自环境变量（开发机 <code>.env</code>）。在这里保存后，以你填的为准。
            </p>
          )}
          <p className="login-gateway__hint">
            填运行服务的那台电脑的局域网地址，形如 <code>http://192.168.x.x:8790</code>；
            两台设备要在同一 Wi-Fi 下。
          </p>
          <input
            className="login-gateway__input"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={view.effectiveUrl}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {error ? <p className="login-error">{error}</p> : null}
          <button
            type="button"
            className="login-gateway__save"
            onClick={() => void save()}
            disabled={busy}
          >
            {busy ? "保存中…" : "保存并重连"}
          </button>
        </div>
      )}
    </div>
  );
}
