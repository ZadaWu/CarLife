/**
 * 手机端「设置」页。
 *
 * # 为什么它现在才出现
 *
 * 底部导航的第四项一直是车机独有的（`BottomNav` 的 `showSettings` 默认关，
 * 就是为了不让手机端长出一个点进去空白的 tab）。定位授权把这一格填满了：
 * 停用 / 开启定位、模糊还是精确——这些必须让用户在自己手上这块屏里改，
 * 不能只在车机上有。
 *
 * # 与车机设置页的分工
 *
 * **定位那一组是同一个组件**（`@carlife/ui` 的 `LocationSettings`）：同一个用户
 * 对同一件事的授权界面必须逐字一样，否则"我在手机上关过了"与"车机上还开着"
 * 会同时成立。播报开关两端各有一份 Tauri 命令，默认值也不同（车机默认开、
 * 手机默认关，理由见 `commands/profile.rs`），所以那一组不共用。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GatewayField } from "../auth/GatewayField";
import { LocationSettings } from "@carlife/ui";
import type { LocationFix } from "@carlife/shared";

import "./settings.css";

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface MobileSettingsProps {
  /** 定位成功 → 把主页那张地图挪过去。 */
  onLocated?: (fix: LocationFix) => void;
  /**
   * 哨兵监听此刻的总开关状态（`voice:sentinel` 事件的 `switchOn`）。
   *
   * **由 App 层喂进来，本页不自己订阅**：那个事件已经有一个消费者，
   * 再开一个订阅等于同一个事实有两处处置。`undefined` = 事件还没来
   * （哨兵未启动 / 浏览器走查），那时整组不渲染——与播报开关同一条纪律。
   */
  sentinelOn?: boolean;
}

interface AuthStatus {
  authenticated: boolean;
  userId?: string | null;
  displayName?: string | null;
}

export function MobileSettings({ onLocated, sentinelOn }: MobileSettingsProps) {
  const tauri = isTauriEnv();
  const [broadcast, setBroadcast] = useState<boolean | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  /**
   * 哨兵监听（语音唤醒）总开关。**默认关**——常驻麦克风不该是开箱状态，
   * 手机比车机更甚（它在口袋里、在会议室里）。理由写在 Rust 侧
   * `SENTINEL_ENABLED` 的文档里。null = 读不到，整组不渲染。
   */
  const [sentinel, setSentinel] = useState<boolean | null>(null);
  /** 上一次打开失败的原因；只有"没给麦克风权限"这一种值得说。 */
  const [sentinelError, setSentinelError] = useState<string | null>(null);

  useEffect(() => {
    if (!tauri) return;
    // 读不到就**整组不渲染**（`broadcast` 停在 null），不显示一个恒为假的开关
    // ——与车机设置页同一条纪律。
    void invoke<boolean>("get_broadcast_enabled").then(setBroadcast).catch(() => {});
    void invoke<boolean>("get_sentinel_enabled").then(setSentinel).catch(() => {});
    void invoke<AuthStatus>("auth_status").then(setAuth).catch(() => {});
  }, [tauri]);

  /**
   * 退出登录（M52-01）。
   *
   * `auth_logout` 这条命令 M48-02 就注册在 `main.rs:33` 了，但**端上一直没有
   * 任何地方调它**——于是登录进去就出不来，换个账号只能重装。
   * 2026-08-31 走查 W5（"用被授权的 driver 账号登录"）因此直接卡住。
   * 这是第三次撞见同一形状（前两次是 `switch_device_role`、`request_pairing_code`）：
   * 命令有、入口没有，编得过跑得起来，功能不存在且不报错。
   *
   * 退出后**整页重载**：登录门在 `main.tsx` 的最外层，局部改状态到不了它。
   */
  const logout = useCallback(() => {
    void invoke("auth_logout")
      .catch(() => undefined)
      .finally(() => window.location.reload());
  }, []);

  // 哨兵在别处被拨动（HUD、或语音）→ 这里跟着变。不接的后果是同一个开关
  // 有两处真相，用户看到的是"我关了它还亮着"。
  useEffect(() => {
    if (typeof sentinelOn === "boolean") setSentinel(sentinelOn);
  }, [sentinelOn]);

  /**
   * 拨哨兵总开关。
   *
   * 打开时 Rust 侧会先要麦克风授权，**要不到就不打开**并回
   * `permission_denied`——这里把开关回滚并说清楚。不回滚的话，界面停在"开"
   * 而麦克风从没打开过，用户喊「暖暖」毫无反应却看不出哪里不对。
   */
  const toggleSentinel = useCallback(() => {
    const next = !sentinel;
    setSentinel(next); // 乐观：开关必须手感即时
    setSentinelError(null);
    void invoke<boolean>("set_sentinel_enabled", { enabled: next })
      .then((applied) => setSentinel(applied))
      .catch((err: unknown) => {
        setSentinel(!next);
        setSentinelError(String(err) === "permission_denied" ? "permission_denied" : "failed");
      });
  }, [sentinel]);

  const toggleBroadcast = useCallback(() => {
    void invoke<boolean>("set_broadcast_enabled", { enabled: !broadcast }).then(setBroadcast);
  }, [broadcast]);

  return (
    <div className="mset">
      <header className="mset-head">
        <h1>设置</h1>
      </header>

      <div className="mset-body">
        {/* 账号放最前：走查要反复换人，而"现在登录的是谁"也该一眼看得到。
            读不到状态就整组不渲染（浏览器走查没有 invoke），同播报那一组。 */}
        {auth?.authenticated ? (
          <section className="mset-group">
            <h2>账号</h2>
            <p className="mset-account">{auth.displayName ?? auth.userId}</p>
            <button type="button" className="mset-logout" onClick={logout}>
              退出登录
            </button>
          </section>
        ) : null}

        {/*
          网关连接（M54-06，缺口 G6）。此前只有**登录页**有这个入口——
          登录后换了 Wi-Fi，所有请求开始失败，而能改地址的界面在门外，
          唯一路径是退出登录（荒谬但真实）。复用登录页同一个组件，不抄一份：
          抄写的结局是"某一条路上改地址不生效"（GatewayForm 文件头的原话）。
        */}
        {sentinel !== null && (
          <section className="mset-group">
            <h2>语音唤醒</h2>
            <button
              type="button"
              className={`cloc-toggle${sentinel ? " is-on" : ""}`}
              role="switch"
              aria-checked={sentinel}
              onClick={toggleSentinel}
            >
              <span className="cloc-toggle__text">
                <span className="cloc-toggle__label">随时听着，喊名字就能唤醒</span>
                <span className="cloc-toggle__hint">
                  {sentinel
                    ? "不用按住说话，直接说「暖暖你好」就能叫她；喊完名字她会等你几秒。"
                    : "关着的时候麦克风完全不开，只能按住说话。打开后她会一直听着，等你喊「暖暖」。"}
                </span>
              </span>
              <span className="cloc-toggle__knob" aria-hidden="true" />
            </button>
            {sentinelError === "permission_denied" && (
              <p className="mset-note">
                没有麦克风权限，打不开。请在系统设置里允许本应用使用麦克风后再试。
              </p>
            )}
            {sentinelError === "failed" && (
              <p className="mset-note">这次没设置成功，请再试一次。</p>
            )}
          </section>
        )}

        <section className="mset-group">
          <h2>网关连接</h2>
          <GatewayField />
        </section>

        <section className="mset-group">
          <h2>定位</h2>
          <LocationSettings onLocated={onLocated} />
        </section>

        {broadcast !== null && (
          <section className="mset-group">
            <h2>播报</h2>
            <button
              type="button"
              className={`cloc-toggle${broadcast ? " is-on" : ""}`}
              role="switch"
              aria-checked={broadcast}
              onClick={toggleBroadcast}
            >
              <span className="cloc-toggle__text">
                <span className="cloc-toggle__label">出声播报</span>
                <span className="cloc-toggle__hint">
                  关掉之后暖暖只在屏幕上回答，不出声。手机默认不出声——公共场合里
                  突然说话是打扰。
                </span>
              </span>
              <span className="cloc-toggle__knob" aria-hidden="true" />
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
