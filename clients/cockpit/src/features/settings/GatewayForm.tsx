/**
 * 网关连接表单（ACR-004 第 3 步的表单部分，M33-05 从 `SettingsSheet` 抽出）。
 *
 * # 为什么抽出来
 *
 * 同一份表单现在有**两个壳**：iOS 首启的引导弹层（`SettingsSheet`）与
 * 底部导航的设置页（`SettingsScreen`）。首启引导保留弹层形态是刻意的——
 * 那时候不该先教用户认底部导航。
 * 两处各写一遍的话，改一处忘一处是迟早的事，而症状是"某一条路上改地址不生效"。
 *
 * # 保存后整页刷新（原样保留）
 *
 * SSE 流、会话、轮询源都是按旧地址建的；逐个通知它们重连的复杂度不值得——
 * 设置网关是低频动作，刷新是最诚实的"从头来"。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface GatewaySettingsView {
  effectiveUrl: string;
  storedUrl: string | null;
  /** 生效地址来自哪一层（Rust 侧 `UrlSource`）。端上配过就恒是 `stored`。 */
  source: "stored" | "env" | "default";
  /** 环境变量里的那份（开发机 `.env`），可能为 null。 */
  envUrl: string | null;
  platform: string;
}

export interface GatewayFormProps {
  /** 首启引导语境（iOS 第一次打开）：文案从"设置"换成"先连上你的服务器"。 */
  firstRun?: boolean;
  /** 取消/跳过。整页形态下不给这个回调，就不渲染那个按钮。 */
  onCancel?: () => void;
  /** 表单何时该重新读一次当前值（弹层是"打开时"，整页是"挂载时"）。 */
  active: boolean;
}

export function GatewayForm({ firstRun = false, onCancel, active }: GatewayFormProps) {
  const [view, setView] = useState<GatewaySettingsView | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    setError(null);
    void invoke<GatewaySettingsView>("get_gateway_settings")
      .then((v) => {
        setView(v);
        setUrl(v.storedUrl ?? "");
      })
      .catch((e) => setError(String(e)));
  }, [active]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke<GatewaySettingsView>("set_gateway_settings", {
        gatewayUrl: url.trim() || null,
        // token 由登录产生（M48-02），设置页不再碰它：null = 保持现状。
        demoToken: null,
      });
      /*
       * 刷新前不做连通性验证不是偷懒：地址错了刷新后满屏"连不上"，
       * 用户再打开本页改——失败形态诚实且可恢复。在这里加探活反而要处理
       * "网关暂时没起但地址是对的"这种误杀。
       */
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [url]);

  return (
    <>
      {firstRun && (
        <p className="settings-hint">
          这台设备第一次运行 CarLife。请填入运行服务的那台电脑的局域网地址
          （形如 <code>http://192.168.x.x:8790</code>），两台设备需在同一 Wi-Fi。
        </p>
      )}
      {/*
        * 地址来源要摆在脸上（2026-09-01）。
        *
        * 上一版这里写的是"此处保存的值只在没有环境变量的设备上生效"——那句话
        * 描述的是一个能填能存却不生效的输入框。现在端上配置最优先，这一段
        * 因此从"警告你白填了"改成"如实说此刻走的是哪一份"。
        */}
      {view?.source === "stored" && (
        <p className="settings-hint">
          当前生效：<code>{view.effectiveUrl}</code>（本机设置）
          {view.envUrl && view.envUrl !== view.effectiveUrl && (
            <>；环境变量里的 <code>{view.envUrl}</code> 已被它覆盖，清空下方地址栏并保存可回到环境变量</>
          )}
        </p>
      )}
      {view?.source === "env" && (
        <p className="settings-hint">
          当前地址来自环境变量 <code>{view.envUrl}</code>（开发机 <code>.env</code>）。
          在这里保存后，以你填的为准。
        </p>
      )}
      <label>
        网关地址
        <input
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={view ? `当前：${view.effectiveUrl}` : "http://192.168.x.x:8790"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {/*
        * 这里原来有一个「访问令牌」输入框。它自 M48-02 起就是死的：
        * token 改由登录流程产生（`carlife_core::auth` 持有），
        * `settings.rs` 的 `gateway()` 根本不读持久化里那个字段。
        * 一个能填能存却对鉴权毫无影响、placeholder 还写着「默认 demo-token」
        * 的凭证输入框，比没有这个框更坏——删掉，别让人以为在这儿能配鉴权。
        */}
      {error && <p className="settings-error">{error}</p>}
      <div className="settings-actions">
        {/* 首启引导也允许跳过：mock 数据下看界面是合法用法，不锁死用户 */}
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}>
            {firstRun ? "先跳过" : "取消"}
          </button>
        )}
        <button type="button" className="is-primary" onClick={() => void save()} disabled={busy}>
          {busy ? "保存中…" : "保存并重新连接"}
        </button>
      </div>
    </>
  );
}
