/**
 * 车机端「设置」页（施工单 M33-05，F-01-06）。
 *
 * # 为什么它值得一个底部导航位
 *
 * 在这一页出现之前，车机上**能改的东西一共只有一个**——档案页右上角那个
 * 网关地址按钮。而 M18-05/06 做出来的两个垫场偏好、M33-03 的打断开关，
 * Tauri 命令都在，**界面一个都没有**：车主想让暖暖少说点，唯一的办法是
 * 用语音口令（M33-04），说错了还找不到地方改回来。
 *
 * # 四组的分法
 *
 * 按"车主脑子里那件事"分，不按代码模块分：
 *  - **闲聊旁路**：她等待时说不说话；
 *  - **打断**：她说话时我能不能让她停；
 *  - **播报**：她到底出不出声；
 *  - **网关连接**：这台车连的是哪台服务器。
 * 前三组都是"声音"这一件事的不同侧面，所以排在一起、网关放最后。
 *
 * # 不可用的开关不渲染
 *
 * 浏览器走查没有 `invoke`，读不到任何偏好。那时**整组不渲染**，
 * 而不是渲染一个点了报错的开关——组件不造一个点了没反应的东西
 * （与 `AssistantDock` 的「退下」按钮同一条纪律）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LocationSettings } from "@carlife/ui";
import type { LocationFix } from "@carlife/shared";

import { GatewayForm } from "./GatewayForm";
import { AccountSection } from "./AccountSection";
import { IdentitySection } from "./IdentitySection";
import { readSoundscapePref, writeSoundscapePref } from "../cabin/soundscape-prefs";
import { readAnnouncePref, writeAnnouncePref } from "../trip/announce-prefs";
import { clampVolume, DEFAULT_VOLUME } from "./volume";
import "./settings.css";
import type { ReminderDensity } from "@carlife/ui";
import { DENSITIES, densityFromRust, densityLabel, describeDensity } from "../trip/en-route-prefs";

/** 是不是在 Tauri 里（浏览器走查没有 invoke）。 */
function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface ToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
}

function Toggle({ label, hint, checked, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      className={`cset-toggle${checked ? " is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      onClick={onChange}
    >
      <span className="cset-toggle__text">
        <span className="cset-toggle__label">{label}</span>
        {hint && <span className="cset-toggle__hint">{hint}</span>}
      </span>
      <span className="cset-toggle__knob" aria-hidden="true" />
    </button>
  );
}

export interface SettingsScreenProps {
  /**
   * 主题。**必须自己接一份**（照档案页 `.cown--light/dark` 的先例）：
   * 整页形态不吃 HUD 那套半透明卡片 token，而写死浅色的后果是
   * 深色主题下整页仍然是白的——浅色下看着完全正常，不打开深色发现不了。
   */
  theme: "light" | "dark";
  /**
   * 语音刚把闲聊旁路拨到了哪一边（M33-04 的 `SidecarSwitched` 事件）。
   *
   * **由 App 层喂进来，本页不自己订阅**：`voice:wake` 已经有一个消费者
   * （`App.tsx` 的 `onWakeStatus`），再开一个订阅等于同一个事件有两处处置，
   * 而那正是"改了一处忘了另一处"的温床。
   *
   * 不接的后果不是"少一个动效"：车主开着这一页说「不要废话了」，
   * 旁路已经关了而这里的开关还亮着——他看到的是"我说了它没听"。
   */
  sidecarOn?: boolean;
  /**
   * 哨兵监听此刻的总开关状态（`voice:sentinel` 事件的 `switchOn`）。
   *
   * 与 `sidecarOn` 同一条纪律：由 App 层喂进来，本页不自己订阅。
   * 不接的后果是**同一个开关有两处真相**——HUD 上那个麦克风图标拨的就是它，
   * 在 HUD 关掉再进设置页，这里还亮着。
   */
  sentinelOn?: boolean;
  /** 途中提醒开关 / 密度档（M77-07）：由 App 层订阅 Rust 事件后喂进来，本页不自己订阅（同 `sidecarOn`）。 */
  enRouteOn?: boolean;
  enRouteDensity?: ReminderDensity;
  /**
   * 定位成功后把主页那张地图挪过去（`useMapViewport().focusOn`）。
   *
   * 不接也能用——只是"在设置里点了定位、回到主页发现地图没动"，
   * 而那看起来像定位没生效。
   */
  onLocated?: (fix: LocationFix) => void;
}

export function SettingsScreen({ theme, sidecarOn, sentinelOn, enRouteOn, enRouteDensity, onLocated }: SettingsScreenProps) {
  const tauri = isTauriEnv();
  const [filler, setFiller] = useState(true);
  const [preempt, setPreempt] = useState<"immediate" | "after_sentence">("after_sentence");
  const [bargeIn, setBargeIn] = useState(true);
  const [broadcast, setBroadcast] = useState(true);
  /**
   * 播报音量（百分比）。与开关是两个量：0 不等于关（Rust 侧 `TtsState::volume`
   * 的说明）。命令不在（升级中间态）就不渲染滑块，与打断开关同一条纪律。
   */
  const [volume, setVolume] = useState(DEFAULT_VOLUME);
  const [volumeAvailable, setVolumeAvailable] = useState(false);
  /**
   * 拖动期间落盘的节流句柄。滑块一次拖动会连发几十个 change：界面与出声
   * 每一下都要跟（否则拖起来是"卡"的），但落盘只在手停下来之后做一次。
   */
  const volumeCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 打断开关的命令在不在（M33-03）。
   *
   * 升级中间态里 Rust 侧可能还没有它——那时**整组不渲染**而不是显示一个
   * 恒为 true 的假开关。这与 `App.tsx` 对 `get_gateway_settings` 的处理同形。
   */
  const [bargeInAvailable, setBargeInAvailable] = useState(false);
  /**
   * 哨兵监听（语音唤醒）总开关（M60-01）。**默认关**——常驻麦克风不该是
   * 开箱状态，理由写在 Rust 侧 `SENTINEL_ENABLED` 的文档里。
   */
  const [sentinel, setSentinel] = useState(false);
  /** 命令在不在（升级中间态里 Rust 侧可能还没有它）。不在就整组不渲染。 */
  const [sentinelAvailable, setSentinelAvailable] = useState(false);
  /** 上一次打开失败的原因；只有"没给麦克风权限"这一种值得单独说。 */
  const [sentinelError, setSentinelError] = useState<string | null>(null);
  /**
   * 界面音效（M64-03）。**默认开**——出发动画本来就该有声音，
   * 不是需要用户主动发现的增强。真相源是 localStorage，不是 Rust。
   */
  const [soundscape, setSoundscape] = useState(readSoundscapePref);
  /**
   * 途中提醒（M77-07，F-62-11 / F-62-12）。**默认开、适中**；真相源在 Rust
   * （`speak_reminder` 要读它，语音口令也改它）。命令不在（升级中间态）就整组不渲染。
   */
  const [enRoute, setEnRoute] = useState(true);
  const [density, setDensity] = useState<ReminderDensity>("normal");
  const [enRouteAvailable, setEnRouteAvailable] = useState(false);
  const [exportResult, setExportResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** 点火播报（M72-05，F-19-07）。**默认开**；真相源是 localStorage，不是 Rust。 */
  const [announce, setAnnounce] = useState(readAnnouncePref);
  const toggleAnnounce = () => {
    const next = !announce;
    setAnnounce(next);
    writeAnnouncePref(next);
  };

  useEffect(() => {
    if (!tauri) return;
    void invoke<boolean>("get_filler_enabled").then(setFiller).catch(() => {});
    void invoke<string>("get_filler_preempt_mode")
      .then((m) => setPreempt(m === "immediate" ? "immediate" : "after_sentence"))
      .catch(() => {});
    void invoke<boolean>("get_broadcast_enabled").then(setBroadcast).catch(() => {});
    void invoke<number>("get_broadcast_volume")
      .then((v) => {
        setVolume(clampVolume(v));
        setVolumeAvailable(true);
      })
      .catch(() => {
        // 旧版 Rust 侧没有这个命令：不渲染滑块，不报错
      });
    void invoke<boolean>("get_sentinel_enabled")
      .then((v) => {
        setSentinel(v);
        setSentinelAvailable(true);
      })
      .catch(() => {
        // 旧版 Rust 侧没有这个命令：不渲染那一组，不报错
      });
    void invoke<boolean>("get_barge_in_enabled")
      .then((v) => {
        setBargeIn(v);
        setBargeInAvailable(true);
      })
      .catch(() => {
        // 旧版 Rust 侧没有这个命令：不渲染那一组，不报错
      });
    void invoke<boolean>("get_en_route_reminders")
      .then((v) => {
        setEnRoute(v);
        setEnRouteAvailable(true);
      })
      .catch(() => {
        // 旧版 Rust 侧没有这个命令：不渲染那一组，不报错
      });
    void invoke<string>("get_en_route_density")
      .then((d) => setDensity(densityFromRust(d)))
      .catch(() => {});
  }, [tauri]);

  // 语音说了「少提醒点」/ 设置页之外拨了开关 → 这里跟着变（同 sidecarOn 的纪律）。
  useEffect(() => {
    if (typeof enRouteOn === "boolean") setEnRoute(enRouteOn);
  }, [enRouteOn]);
  useEffect(() => {
    if (enRouteDensity) setDensity(enRouteDensity);
  }, [enRouteDensity]);

  const toggleEnRoute = useCallback(() => {
    void invoke<boolean>("set_en_route_reminders", { enabled: !enRoute }).then(setEnRoute).catch(() => {});
  }, [enRoute]);
  const chooseDensity = useCallback((d: ReminderDensity) => {
    setDensity(d); // 乐观：三个按钮要即时；Rust 回什么以什么为准
    void invoke<string>("set_en_route_density", { mode: d })
      .then((m) => setDensity(densityFromRust(m)))
      .catch(() => {});
  }, []);
  const exportEnRouteLog = useCallback(() => {
    void invoke<string>("export_en_route_log")
      .then((path) => setExportResult({ ok: true, text: `已导出到 ${path}` }))
      .catch((err: unknown) => setExportResult({ ok: false, text: `导出失败：${String(err)}` }));
  }, []);

  // 语音拨了开关 → 界面跟着变（见 props 的说明）。
  useEffect(() => {
    if (typeof sidecarOn === "boolean") setFiller(sidecarOn);
  }, [sidecarOn]);

  // HUD 的麦克风图标拨了总开关 → 这里跟着变（同上）。
  useEffect(() => {
    if (typeof sentinelOn === "boolean") setSentinel(sentinelOn);
  }, [sentinelOn]);

  /**
   * 拨界面音效。
   *
   * 先落界面再落存储：`writeSoundscapePref` 在隐私模式下写不进去，
   * 那时**当次仍然生效**（下次启动退回默认）——一个开关点了没反应比"重启后忘了"更糟。
   */
  const toggleSoundscape = () => {
    const next = !soundscape;
    setSoundscape(next);
    writeSoundscapePref(next);
  };

  /**
   * 拨哨兵总开关。
   *
   * 打开时 Rust 侧会先要麦克风授权，**要不到就不打开**并回 `permission_denied`
   * ——这里把开关回滚并说清楚。不回滚的话，界面停在"开"而麦克风从没打开过，
   * 车主喊「暖暖」毫无反应却看不出哪里不对。
   */
  const toggleSentinel = useCallback(() => {
    const next = !sentinel;
    setSentinel(next); // 乐观：开关必须手感即时；失败时下面回滚
    setSentinelError(null);
    void invoke<boolean>("set_sentinel_enabled", { enabled: next })
      .then(setSentinel)
      .catch((err: unknown) => {
        setSentinel(!next);
        setSentinelError(String(err) === "permission_denied" ? "permission_denied" : "failed");
      });
  }, [sentinel]);

  const toggleFiller = useCallback(() => {
    void invoke<boolean>("set_filler_enabled", { enabled: !filler }).then(setFiller);
  }, [filler]);

  const togglePreempt = useCallback(() => {
    const next = preempt === "immediate" ? "after_sentence" : "immediate";
    void invoke<string>("set_filler_preempt_mode", { mode: next }).then((m) =>
      setPreempt(m === "immediate" ? "immediate" : "after_sentence"),
    );
  }, [preempt]);

  const toggleBargeIn = useCallback(() => {
    void invoke<boolean>("set_barge_in_enabled", { enabled: !bargeIn }).then(setBargeIn);
  }, [bargeIn]);

  const toggleBroadcast = useCallback(() => {
    void invoke<boolean>("set_broadcast_enabled", { enabled: !broadcast }).then(setBroadcast);
  }, [broadcast]);

  /**
   * 拖动播报音量。**界面先动、声音跟着动、落盘最后**：
   * 前两者每一下都做（Rust 侧对正在播的那句立即生效，拖的时候就能听出来），
   * 落盘等手停下 200ms 再做一次——它是写文件，没必要一拖几十次。
   */
  const changeVolume = useCallback((next: number) => {
    const v = clampVolume(next);
    setVolume(v);
    if (volumeCommit.current) clearTimeout(volumeCommit.current);
    volumeCommit.current = setTimeout(() => {
      volumeCommit.current = null;
      void invoke<number>("set_broadcast_volume", { percent: v })
        .then((applied) => setVolume(clampVolume(applied)))
        .catch(() => {});
    }, 200);
  }, []);

  const previewVolume = useCallback(() => {
    // 试听前把还没落下去的那一档先落下去：不然听到的是上一档。
    if (volumeCommit.current) {
      clearTimeout(volumeCommit.current);
      volumeCommit.current = null;
    }
    void invoke<number>("set_broadcast_volume", { percent: volume })
      .then(() => invoke("preview_broadcast_volume"))
      .catch(() => {});
  }, [volume]);

  return (
    <div className={`cset cset--${theme}`}>
      {/* 没有页内返回按钮：车机端出口只有底部导航一处（2026-08-28 产品定调）。 */}
      <header className="cset-head">
        <h1>设置</h1>
      </header>

      <div className="cset-body">
        {tauri ? (
          <>
            {sentinelAvailable && (
              <section className="cset-group">
                <h2>语音唤醒</h2>
                <Toggle
                  label="随时听着，喊名字就能唤醒"
                  hint={
                    sentinel
                      ? "不用按任何按钮，直接说「暖暖你好」就能叫她；说完一句话她会等你几秒再接着说。"
                      : "关着的时候麦克风完全不开，只能长按说话。打开后她会一直听着，等你喊「暖暖」。"
                  }
                  checked={sentinel}
                  onChange={toggleSentinel}
                />
                {sentinelError === "permission_denied" && (
                  <p className="cset-note cset-note--error">
                    没有麦克风权限，打不开。请在系统设置里允许本应用使用麦克风后再试。
                  </p>
                )}
                {sentinelError === "failed" && (
                  <p className="cset-note cset-note--error">这次没设置成功，请再试一次。</p>
                )}
              </section>
            )}

            <section className="cset-group">
              <h2>闲聊旁路</h2>
              <Toggle
                label="等待时说点什么"
                hint="查东西要花时间的时候，暖暖会说说她在做什么。也可以直接说「不要废话了」关掉，说「打开闲聊」开回来。"
                checked={filler}
                onChange={toggleFiller}
              />
              <Toggle
                label="正文来了立刻打断她"
                hint={
                  preempt === "immediate"
                    ? "回答一到就掐掉正在说的那句垫场。"
                    : "让她把那句说完，回答接在后面（默认）——一句话说到一半没了，比没说过更像出故障。"
                }
                checked={preempt === "immediate"}
                onChange={togglePreempt}
              />
            </section>

            {bargeInAvailable && (
              <section className="cset-group">
                <h2>打断</h2>
                <Toggle
                  label="她说话时可以出声打断"
                  hint="播报中说「停」「别说了」就能让她停下。关掉的话只能长按或点一下暖暖来打断。"
                  checked={bargeIn}
                  onChange={toggleBargeIn}
                />
              </section>
            )}

            {enRouteAvailable && (
              <section className="cset-group">
                <h2>途中提醒</h2>
                <Toggle
                  label="路上提醒停靠和歇脚"
                  hint="跟车时快到计划停靠点提前说一句；本段开得接近约定上限也提一下。也可以直接说「闭嘴」让这一段安静。"
                  checked={enRoute}
                  onChange={toggleEnRoute}
                />
                {enRoute && (
                  <div className="cset-choice" role="radiogroup" aria-label="提醒密度">
                    <span className="cset-choice__label">提醒密度</span>
                    <div className="cset-choice__opts">
                      {DENSITIES.map((d) => (
                        <button
                          key={d}
                          type="button"
                          role="radio"
                          aria-checked={density === d}
                          className={`cset-choice__opt${density === d ? " is-on" : ""}`}
                          onClick={() => chooseDensity(d)}
                        >
                          {densityLabel(d)}
                        </button>
                      ))}
                    </div>
                    <p className="cset-choice__hint">{describeDensity(density)}</p>
                  </div>
                )}
                <button type="button" className="cset-toggle cset-toggle--action" onClick={exportEnRouteLog}>
                  <span className="cset-toggle__text">
                    <span className="cset-toggle__label">导出最近提醒记录</span>
                    <span className="cset-toggle__hint">写到本机应用数据目录的 en-route-log.jsonl，只有判定与口令，不含对话内容；不会上传。</span>
                  </span>
                </button>
                {exportResult && (
                  <p className={`cset-note${exportResult.ok ? "" : " cset-note--error"}`}>{exportResult.text}</p>
                )}
              </section>
            )}

            <section className="cset-group">
              <h2>播报</h2>
              <Toggle
                label="出声播报"
                hint="关掉之后暖暖只在屏幕上回答，不出声。"
                checked={broadcast}
                onChange={toggleBroadcast}
              />
              <Toggle
                label="上车时主动提醒行程变化"
                hint="行程遇到暴雨、台风预警或路上要多开很久时，上车暖暖会说一句并问要不要调整。一份变化只说一次、一天最多一次；关掉后只在主页列表上打点。"
                checked={announce}
                onChange={toggleAnnounce}
              />
              {volumeAvailable && (
                <div className={`cset-slider${broadcast ? "" : " is-disabled"}`}>
                  <div className="cset-slider__head">
                    <span className="cset-slider__label">播报音量</span>
                    <span className="cset-slider__value" aria-live="polite">
                      {volume}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={volume}
                    disabled={!broadcast}
                    aria-label="播报音量"
                    onChange={(e) => changeVolume(Number(e.target.value))}
                  />
                  <div className="cset-slider__foot">
                    <span className="cset-slider__hint">
                      只管暖暖说话的响度，不动车内音乐。拖的时候她要是正在说，会立刻跟着变。
                    </span>
                    <button
                      type="button"
                      className="cset-slider__preview"
                      disabled={!broadcast}
                      onClick={previewVolume}
                    >
                      试听
                    </button>
                  </div>
                </div>
              )}
            </section>
          </>
        ) : (
          <section className="cset-group">
            <p className="cset-note">
              语音与播报的开关只在车机客户端里可用——浏览器走查读不到这台车的偏好。
            </p>
          </section>
        )}

        {/*
          界面音效（M64-03）。**在 tauri 判断之外**：它是纯前端行为，
          浏览器走查里同样生效，所以不该被"读不到这台车的偏好"那一支挡掉。
          也因此它不走 invoke 而走 localStorage——Rust 侧从头到尾不需要知道它。
        */}
        <section className="cset-group">
          <h2>界面音效</h2>
          <Toggle
            label="界面音效"
            hint="点「开始行程」时的出发音。不影响车内音乐与暖暖的播报——她说话时它自己会静下来。"
            checked={soundscape}
            onChange={toggleSoundscape}
          />
        </section>

        {/*
          当前身份（M49-04）。放在定位之前、语音之后：它是"这台设备是谁的"，
          比定位更靠近身份这件事。区块自己判环境，浏览器走查里整块不渲染。
        */}
        {/* 账号/当前使用人（M54-06，G2/G3）：紧贴「当前身份」——两者合起来才回答
            "这台设备是什么、现在替谁工作"。区块自己判环境，浏览器走查里不渲染。 */}
        <AccountSection />
        <IdentitySection
          onRoleChanged={() => {
            // 切成车机后要重新走绑定/声明，重载最直接——这一步不频繁，
            // 且局部重置身份状态要碰 BoardingGate 的内部相位，得不偿失。
            window.location.reload();
          }}
        />

        {/*
          定位。**不进 `tauri ?` 那个分支**：上面几组是 Tauri 才有的偏好
          （浏览器里读不到这台车的语音设置），而定位在浏览器里是真能用的
          ——`clients/shared/ui` 的端口在非 Tauri 环境退回 localStorage 版。
          放进去的话，走查时这一组会整块消失，而它恰恰是最需要走查的一组。
        */}
        <section className="cset-group">
          <h2>定位</h2>
          <LocationSettings onLocated={onLocated} />
        </section>

        <section className="cset-group">
          <h2>网关连接</h2>
          {tauri ? (
            <div className="cset-gateway">
              <GatewayForm active />
            </div>
          ) : (
            <p className="cset-note">同上：改服务器地址需要在车机客户端里操作。</p>
          )}
        </section>
      </div>
    </div>
  );
}
