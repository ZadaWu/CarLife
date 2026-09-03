/**
 * 车机的绑定与上车声明（施工单 M48-05，F-56-07；补 M48-04 欠的 UI）。
 *
 * 两个状态，一个组件：
 *  1. **未绑定**：展示自己的 deviceId 给车主扫，然后输入车主念回来的 6 位配对码。
 *     车机上**不输入任何账号口令**（FL-07 F-07-04 的"免密"就是这个意思）。
 *  2. **已绑定未声明**：列出这辆车的成员让人点选，或选访客模式。
 *     （`AUTO_DECLARE_OWNER` 为真时这一屏被跳过，直接以车主身份进入——见 boardingPolicy.ts，临时。）
 *
 * # 为什么声明这一步不能省、也不能替用户猜
 *
 * 车机是车辆的共享终端，坐进来的可能是任一授权成员（设计裁决 R4）。
 * 猜错的后果不是"体验差"，是妻子开车时助手用丈夫的偏好回答她，
 * 并且把她的行程记到他名下（P-11 的场景叙事）。
 *
 * # 已知简化（架构 §13-23）
 *
 * 只校验"声明的人在名单里"，**不校验声明的人就是本人**——名单内互选不可检测。
 * 家庭信任场景下选错是误操作而非攻击；公开部署前必须补 PIN/生物识别。
 * 这一条在界面上如实写出来，不假装它是个完整的身份验证。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { AUTO_DECLARE_OWNER } from "./boardingPolicy";
import { qrSvg } from "./qr";
import "./boarding.css";

/** 32 位 hex 按 4 个一组分开——真要手抄时，连成一串必错。 */
function groupHex(id: string): string {
  return (id.match(/.{1,4}/g) ?? [id]).join(" ");
}

interface Member {
  userId: string;
  displayName?: string;
  role: "owner" | "driver" | "passenger";
}

const ROLE_LABEL: Record<Member["role"], string> = {
  owner: "车主",
  driver: "驾驶",
  passenger: "乘坐",
};

export interface BoardingGateProps {
  /** 声明完成后把会话交出去（`guest` 为真时端上要播报降级话术）。 */
  onDeclared: (result: { sessionId: string; guest: boolean }) => void;
}

type Phase =
  | { kind: "probing" }
  | { kind: "unbound"; deviceId: string; degraded: boolean }
  | { kind: "declaring"; vin: string; members: Member[] }
  /**
   * 已绑定、但**取不到成员名单**（M54-02）。
   *
   * 它此前不存在，失败会落进 `skip` —— 于是整道门返回 `null`，
   * 现象是"点了『用作车机』，三个身份不见了"。
   * 门消失比门报错危险得多：后者能查，前者会被当成功能没做。
   */
  | { kind: "blocked"; vin: string; reason: string }
  | { kind: "skip" };

export function BoardingGate({ onDeclared }: BoardingGateProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "probing" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 自动以车主身份声明是否已试过（`AUTO_DECLARE_OWNER`）。试过且失败（名单里没有车主、
   * 或 create_session_as 抛错）就退回选择屏——自动路径不能把人锁在一个什么都不显示的屏上。
   */
  const [autoTried, setAutoTried] = useState(false);

  const loadMembers = useCallback(async (vin: string) => {
    const raw = await invoke<string>("vehicle_members", { vin });
    const parsed = JSON.parse(raw) as { members?: Member[] };
    setPhase({ kind: "declaring", vin, members: parsed.members ?? [] });
  }, []);

  /*
   * 探测分两段，**两个 catch 不能合并**（M54-02，2026-08-31 走查）。
   *
   * 合并过一次，代价是：换 Wi-Fi 之后车机上存的网关地址失效，
   * `loadMembers` 的 HTTP 调用抛错 → 与"不在 Tauri 里"共用一个 catch →
   * 相位落到 `skip` → 组件返回 `null` → **三个身份连同整道门一起无声消失**。
   * 用户看到的是"这个功能没了"，而真实原因在网络设置里。
   */
  const probe = useCallback(async () => {
    let role: string;
    try {
      role = await invoke<string>("device_role");
    } catch {
      // **只有这一处才是"不在 Tauri 里"**（浏览器走查）：连命令本身都不存在。
      // 网络失败不许走到这里——它有自己的相位。
      setPhase({ kind: "skip" });
      return;
    }
    if (role !== "cockpit") {
      // 私人身份：走 M48-02 的登录门，本组件不拦（车机模式才有声明这回事）。
      setPhase({ kind: "skip" });
      return;
    }
    // 已是车机角色：需要知道绑的是哪辆车才能列成员。
    const vin = await invoke<string>("bound_vin").catch(() => "");
    if (!vin) {
      /*
       * 凭证库降级时**在绑定屏就说**（M54-08）。用户遭遇的形态是
       * "每次重启都要重新输 6 位码"——他站的位置就是这一屏，警示放在
       * 设置页里他永远看不到。降级探测失败按"没降级"处理（老命令缺席时
       * 不该把整屏变红）。
       */
      const degraded = await invoke<boolean>("credential_storage_degraded").catch(() => false);
      setPhase({
        kind: "unbound",
        deviceId: await invoke<string>("device_id").catch(() => ""),
        degraded,
      });
      return;
    }
    /*
     * 已保存的声明 → **直接续用，不再让人重选**（M54-10，产品拍板：
     * "完成授权选择了使用者身份，以后重启打开都应该直接使用"）。
     * 续用失败不弹错误屏——最常见的失败是"这个人被移出了成员名单"（400），
     * 那正是该回到选择屏重选的时刻；把保存的声明清掉再走正常流程。
     */
    const saved = JSON.parse(
      await invoke<string>("boarding_declared").catch(() => '{"declared":false}'),
    ) as { declared: boolean; activeUserId?: string | null };
    if (saved.declared) {
      try {
        const raw = await invoke<string>("create_session_as", {
          activeUserId: saved.activeUserId ?? null,
        });
        onDeclared(JSON.parse(raw) as { sessionId: string; guest: boolean });
        setPhase({ kind: "skip" });
        return;
      } catch {
        await invoke("boarding_reset").catch(() => undefined);
      }
    }
    try {
      await loadMembers(vin);
    } catch (err) {
      /*
       * 失败前先纠一次绑定标记。
       *
       * 端上这份 vin 是配对当天的快照，而绑定在服务端还会变——无 VIN 建档
       * 拿的是 `PEND-xxx` 占位主键，车主补录真 VIN 之后服务端整条链都换了，
       * 快照却没有任何机制被更新。表现正是这一屏：车机"已绑定"，
       * 列成员恒回 404 vehicle_not_found。
       *
       * 它不能靠下面那句提示自愈：**改网关地址、重连 Wi-Fi、重装都不会好**，
       * 因为根因不在网络。所以这里向服务端问一次当前绑定，vin 真变了就重来。
       */
      const fresh = await invoke<string>("resync_bound_vin").catch(() => "");
      if (fresh && fresh !== vin) {
        try {
          await loadMembers(fresh);
          return;
        } catch (retry) {
          setPhase({ kind: "blocked", vin: fresh, reason: String(retry) });
          return;
        }
      }
      setPhase({ kind: "blocked", vin, reason: String(err) });
    }
  }, [loadMembers, onDeclared]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const confirmPairing = useCallback(async () => {
    if (busy || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const vin = await invoke<string>("confirm_pairing", { code, modelName: "车机" });
      setCode("");
      await loadMembers(vin);
    } catch (err) {
      /*
       * 服务端对"码错/过期/已用过"回同一句——刻意的，区分它们等于给爆破者
       * 一个进度条。所以这里也只能是合并的那一句。
       */
      setError(String(err).includes("invalid_pairing_code") ? "配对码无效或已过期，请重新扫码" : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, code, loadMembers]);

  const declare = useCallback(
    async (userId: string | null) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const raw = await invoke<string>("create_session_as", { activeUserId: userId });
        onDeclared(JSON.parse(raw) as { sessionId: string; guest: boolean });
      } catch (err) {
        setError(`无法开始：${String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, onDeclared],
  );

  /*
   * 临时策略（boardingPolicy.ts）：进入选择屏时若开关为真，直接替用户点「车主」。
   * 只自动一次；失败就显示原来的选择屏，错误原样露出——不吞。
   */
  useEffect(() => {
    if (!AUTO_DECLARE_OWNER || phase.kind !== "declaring" || autoTried) return;
    setAutoTried(true);
    const owner = phase.members.find((m) => m.role === "owner");
    if (!owner) {
      setError("成员名单里没有车主，无法自动进入；请手动选择。");
      return;
    }
    void declare(owner.userId);
  }, [phase, autoTried, declare]);

  if (phase.kind === "probing" || phase.kind === "skip") return null;

  if (phase.kind === "blocked") {
    return (
      <div className="boarding">
        <div className="boarding-card">
          <h1>连不上网关，列不出使用人</h1>
          {/*
            **不要再断言唯一原因**。这句原本只说"网关地址指着旧电脑"，
            而真实踩到的那次根因是端上绑定标记过期（`PEND-` 占位 VIN 补录后没同步），
            服务端明确回的是 404 vehicle_not_found——网络一点问题都没有。
            一句自信的错误归因会让人反复去改网络设置，比不给原因更费时间。
            纠偏已经在 `probe()` 里自动试过了，走到这一屏说明它没解决。
          */}
          <p className="boarding-hint">
            这台车机已经绑定车辆 {phase.vin.slice(-4)}，但取不到成员名单，
            所以没法让你选「现在是谁在用车」。可能是设置里的网关地址还指着旧的
            那台电脑，也可能是这辆车在服务端已经不存在或不再属于本机——
            下面那行是服务端的原话，`vehicle_not_found` 属于后者，改网关地址不会有用。
          </p>
          <p className="boarding-error">{phase.reason}</p>
          <div className="boarding-code-row">
            <button
              type="button"
              onClick={() => {
                setPhase({ kind: "probing" });
                void probe();
              }}
            >
              重试
            </button>
            {/*
              **必须留这条出路**：`.boarding` 是 `position: fixed; inset: 0` 的全屏遮罩，
              没有它，用户被挡在门外、进不去设置页，也就永远改不了网关地址——
              那比原来那个"门无声消失"的缺陷更糟。
              选择"先进去"不等于声明了身份：会话仍然没建，App 侧照旧会要求声明。
            */}
            <button type="button" className="boarding-guest" onClick={() => setPhase({ kind: "skip" })}>
              先进入设置改地址
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === "unbound") {
    return (
      <div className="boarding">
        <div className="boarding-card">
          <h1>把这台车机绑到你的车上</h1>
          <ol className="boarding-steps">
            <li>用手机 App 扫描下面这个二维码</li>
            <li>核对手机上显示的车辆尾号</li>
            <li>把手机给出的 6 位配对码输入这里</li>
          </ol>
          {/*
            二维码（M49-04）。编码器手写在 `qr.ts`，零依赖——本仓加依赖要先立 ACR。
            下面仍然把裸 deviceId 印出来：扫不动时还能手输，排障时也用得上。
            它不是秘密（拿到它也换不出凭证，还要过车主那一步）。
          */}
          <div
            className="boarding-qr"
            // 内容是本机算出来的固定形状 SVG（只有 rect / g），不含任何外部输入
            dangerouslySetInnerHTML={{ __html: qrSvg(phase.deviceId, { size: 300 }) }}
          />
          <p className="boarding-device-id">{groupHex(phase.deviceId)}</p>
          <div className="boarding-code-row">
            <input
              inputMode="numeric"
              maxLength={6}
              placeholder="6 位配对码"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <button type="button" disabled={busy || code.length !== 6} onClick={() => void confirmPairing()}>
              {busy ? "绑定中…" : "绑定"}
            </button>
          </div>
          <p className="boarding-hint">这台车机不需要输入账号口令。</p>
          {phase.degraded ? (
            <p className="boarding-error">
              本机无法安全保存凭证：这次绑定只在本次运行有效，重启后会再次要求配对码。
              （开发机上多半是二进制签名不稳定——用 dev:restart 重启会自动重签。）
            </p>
          ) : null}
          {error ? <p className="boarding-error">{error}</p> : null}
        </div>
      </div>
    );
  }

  // 自动声明进行中（开关为真且还没失败）：不摊开名单，只说一句在干什么——一个空屏会被当成卡死。
  if (AUTO_DECLARE_OWNER && !error) {
    return (
      <div className="boarding">
        <div className="boarding-card">
          <h1>正在以车主身份进入…</h1>
          <p className="boarding-hint">这台车机默认由车主使用。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="boarding">
      <div className="boarding-card">
        <h1>现在是谁在用车？</h1>
        <ul className="boarding-members">
          {phase.members.map((m) => (
            <li key={m.userId}>
              <button type="button" disabled={busy} onClick={() => void declare(m.userId)}>
                <span className="boarding-name">{m.displayName ?? m.userId}</span>
                <span className="boarding-role">{ROLE_LABEL[m.role]}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="boarding-guest"
              disabled={busy}
              onClick={() => void declare(null)}
            >
              <span className="boarding-name">访客模式</span>
              <span className="boarding-role">不读取个人偏好与日历</span>
            </button>
          </li>
        </ul>
        {/* 已知简化如实写在界面上（架构 §13-23）：这不是身份验证。 */}
        <p className="boarding-hint">选择只用于区分谁在用车，不作身份验证。</p>
        {error ? <p className="boarding-error">{error}</p> : null}
      </div>
    </div>
  );
}
