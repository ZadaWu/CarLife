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
 * 会同时成立。**没有「播报」组**：手机端不出声（F-02-12「车机播报 / 手机静默」；
 * M65-04 加过开关、2026-09-17 连音量一起撤掉，理由见 `src-tauri/src/events.rs` 文件头）。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GatewayField } from "../auth/GatewayField";
import { LocationSettings, onDeviceVisionAvailable, onDeviceVisionEnabled, setOnDeviceVisionEnabled } from "@carlife/ui";
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
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  /**
   * 哨兵监听（语音唤醒）总开关。**默认关**——常驻麦克风不该是开箱状态，
   * 手机比车机更甚（它在口袋里、在会议室里）。理由写在 Rust 侧
   * `SENTINEL_ENABLED` 的文档里。null = 读不到，整组不渲染。
   */
  const [sentinel, setSentinel] = useState<boolean | null>(null);
  /** 端上框灯（ACR-044）：值在 localStorage，对话页选文件时现读；这里只负责改它。 */
  const [onDeviceVision, setOnDeviceVision] = useState<boolean>(() => onDeviceVisionEnabled());
  /** 上一次打开失败的原因；只有"没给麦克风权限"这一种值得说。 */
  const [sentinelError, setSentinelError] = useState<string | null>(null);

  useEffect(() => {
    if (!tauri) return;
    // 读不到就**整组不渲染**（状态停在 null），不显示一个恒为假的开关
    // ——与车机设置页同一条纪律。
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

  return (
    <div className="mset">
      <header className="mset-head">
        <h1>设置</h1>
      </header>

      <div className="mset-body">
        {/* 账号放最前：走查要反复换人，而"现在登录的是谁"也该一眼看得到。
            读不到状态就整组不渲染（浏览器走查没有 invoke），同本页其它组。 */}
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

        {/*
          端上框灯（ACR-044）：M104 之后从对话页输入条挪到这里。
          输入条按定稿只放「相机 + 输入框 + 发送」三件，而这枚开关占掉近 90pt 宽、把输入框挤成一条缝；
          它又必须在**选照片之前**定（`onPickFiles` 里读它决定跑不跑检测），放待发条上已经晚了。
          开关值在 localStorage（`carlife.vision.onDevice`），对话页选文件时现读。
          缺省开（ACR-050）。没有端上检测的环境（网页演示版）整组不显示——那里它是一枚拨了没用的开关。
        */}
        {onDeviceVisionAvailable() && (
        <section className="mset-group">
          <h2>端上框灯</h2>
          <button
            type="button"
            className={`cloc-toggle${onDeviceVision ? " is-on" : ""}`}
            role="switch"
            aria-checked={onDeviceVision}
            onClick={() => {
              const next = !onDeviceVision;
              setOnDeviceVision(next);
              setOnDeviceVisionEnabled(next);
            }}
          >
            <span className="cloc-toggle__text">
              <span className="cloc-toggle__label">选完照片先在手机上框一遍指示灯</span>
              <span className="cloc-toggle__hint">
                {onDeviceVision
                  ? "选照片时会先在手机本地跑一次识别，把认出的灯标出来再上传；照片不会因此多传一份。"
                  : "关着的时候照片直接上传，由服务端识别。打开后手机会先自己框一遍，识别更快也更准。"}
              </span>
            </span>
            <span className="cloc-toggle__knob" aria-hidden="true" />
          </button>
        </section>
        )}

        {/*
          日历账号绑定（M92-01，FL-31）。**只在手机端有**：FL-31 铁律规定
          行车态不呈现任何凭证输入界面，所以车机设置页不放这一组。
          读不到绑定状态时组件自己返回 null，同本页其它组的纪律。
        */}

        <section className="mset-group">
          <h2>网关连接</h2>
          <GatewayField />
        </section>

        <section className="mset-group">
          <h2>定位</h2>
          <LocationSettings onLocated={onLocated} />
        </section>
      </div>
    </div>
  );
}
