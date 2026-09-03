/**
 * 档案页「车机终端」区（施工单 M51-01，F-56-03）。
 *
 * # 它补的是什么
 *
 * 绑定这条链的手机侧。车机屏显示自己的编号（M49-04 的二维码），车主在这里换一枚
 * 6 位配对码，再把码输回车机。M48-04 之后服务端、网络层、Tauri 命令全都就绪，
 * **只有这一屏一直不存在**——`request_pairing_code` 在 `clients/mobile/src` 里的
 * 调用次数是 0，于是整条流程在产品上走不通：车主拿不到码。
 *
 * # 与同页那个「车机」区不是一回事
 *
 * `cabin-section.tsx` 的「车机」指**舒适域能力**（空调分区、座椅通风、香氛），
 * 走 `fetch_cabin` / `bind_cabin`。本区是**车机终端设备**的绑定，走配对码。
 * 两者只是中文撞名。**别合并**——合了会同时毁掉两个功能。
 *
 * # 三条纪律
 *
 *  1. **owner-only 整区不渲染**（沿 `grants.tsx` 的 AC-55-5 纪律）：
 *     不是渲染出来点了再说"你没权限"。
 *  2. **不替服务端猜错误原因**：非车主与车不存在，服务端回同一句（防枚举），
 *     这里照抄，不加"你可能不是车主"这种推测。
 *  3. **不自动重发、不自动续期**：每台设备每小时只有 5 次配额，自动重发会静默吃掉它，
 *     而配额耗尽的表现是 429——到那时用户完全不知道自己"发过五次"。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { formatDeviceId, validateDeviceId } from "./device-id";

const PAIRING_TTL_FALLBACK = 60;

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 相机能不能用，**在渲染之前就要知道**。
 *
 * Tauri 在 macOS 走 WKWebView，`getUserMedia` 是否可用取决于 WebKit 版本与
 * Info.plist（本仓的 `tauri.conf.json` 两样都没配）。探测不到就不渲染扫码按钮——
 * 渲染一个点了报错的按钮违反 `SettingsScreen` 立的那条纪律。
 * 手输通路与它无关，任何情况下都在。
 */
function canScan(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    "BarcodeDetector" in window
  );
}

interface Issued {
  code: string;
  expiresAt: number;
  vinSuffix: string;
}

export interface PairingSectionProps {
  vin: string;
  /** 本人对这辆车的角色。只有 owner 能把车机绑到这辆车上。 */
  myRole: "owner" | "driver" | "passenger";
}

export function PairingSection({ vin, myRole }: PairingSectionProps) {
  const [raw, setRaw] = useState("");
  const [selfId, setSelfId] = useState<string | undefined>(undefined);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  // 本机 id 只用来拦"填了自己"，拿不到也不影响主流程。
  useEffect(() => {
    if (!isTauriEnv()) return;
    void invoke<string>("device_id")
      .then(setSelfId)
      .catch(() => undefined);
  }, []);

  const stopScan = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // 不停流的话相机灯会一直亮着，而用户以为自己已经退出了。
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => stopScan, [stopScan]);

  // 倒计时只是**呈现**，过期与否服务端说了算（车机那侧会报"配对码无效或已过期"）。
  useEffect(() => {
    if (!issued) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((issued.expiresAt - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [issued]);

  const check = validateDeviceId(raw, selfId);

  const request = useCallback(async () => {
    const v = validateDeviceId(raw, selfId);
    if (!v.ok) {
      setError(v.reason);
      return;
    }
    if (!isTauriEnv()) {
      setError("浏览器预览没有网关通道（真实绑定经 Tauri 命令走网关）。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = JSON.parse(
        await invoke<string>("request_pairing_code", { cockpitDeviceId: v.id, vin }),
      ) as { code: string; expiresInSec?: number; vinSuffix?: string };
      setIssued({
        code: res.code,
        expiresAt: Date.now() + (res.expiresInSec ?? PAIRING_TTL_FALLBACK) * 1000,
        vinSuffix: res.vinSuffix ?? "",
      });
    } catch (err) {
      const s = String(err);
      /*
       * 429 单独说：它与"绑定失败"是两件事，而混为一谈的后果是用户一直重试，
       * 每试一次都在把配额往下扣。其余一律照抄服务端那一句——
       * 非车主与车不存在服务端刻意回同一句（防枚举），这里不替它猜是哪一种。
       */
      setError(
        s.includes("too_many_pairing_requests")
          ? "这台车机一小时内取码次数已达上限（5 次），过一会儿再试。"
          : `取不到配对码：${s}`,
      );
    } finally {
      setBusy(false);
    }
  }, [raw, selfId, vin]);

  const startScan = useCallback(async () => {
    setError(null);
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      const el = videoRef.current;
      if (!el) {
        stopScan();
        return;
      }
      el.srcObject = stream;
      await el.play();
      const Detector = (window as unknown as { BarcodeDetector: new (o: unknown) => {
        detect: (s: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
      } }).BarcodeDetector;
      const det = new Detector({ formats: ["qr_code"] });
      const loop = async () => {
        if (!streamRef.current || !videoRef.current) return;
        try {
          const hits = await det.detect(videoRef.current);
          if (hits.length > 0) {
            // 扫来的也可能是别的码，交给同一套校验，不直接当成合法编号。
            setRaw(hits[0]!.rawValue);
            stopScan();
            return;
          }
        } catch {
          // 单帧检测失败很常见（画面还没稳），继续下一帧
        }
        rafRef.current = requestAnimationFrame(() => void loop());
      };
      rafRef.current = requestAnimationFrame(() => void loop());
    } catch (err) {
      stopScan();
      setError(`打不开相机：${String(err)}。可以改成手动输入车机屏上那串编号。`);
    }
  }, [stopScan]);

  // 非车主整区不渲染——入口本身就不该出现（AC-55-5 的同一条）。
  if (myRole !== "owner") return null;

  const expired = issued !== null && left <= 0;

  return (
    <section className="own-section own-pairing">
      <header className="own-section-head">
        <h3>车机终端</h3>
        <small>把车上那块屏绑到这辆车</small>
      </header>

      {issued === null ? (
        <>
          <ol className="own-pair-steps">
            <li>在车机屏上找到那串编号（下面有二维码可以扫）</li>
            <li>填到这里，取一枚 6 位配对码</li>
            <li>把配对码输回车机屏</li>
          </ol>

          <input
            className="own-pair-input"
            placeholder="车机屏上那串编号"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={formatDeviceId(raw)}
            onChange={(e) => setRaw(e.target.value)}
          />

          <div className="own-pair-actions">
            {/* 能力探测通过才出现——见文件头「相机能不能用」 */}
            {canScan() && !scanning ? (
              <button type="button" className="own-secondary" onClick={() => void startScan()}>
                扫码
              </button>
            ) : null}
            {scanning ? (
              <button type="button" className="own-secondary" onClick={stopScan}>
                停止扫码
              </button>
            ) : null}
            <button
              type="button"
              className="own-cta"
              disabled={busy || !check.ok}
              onClick={() => void request()}
            >
              {busy ? "取码中…" : "获取配对码"}
            </button>
          </div>

          {scanning ? (
            <video className="own-pair-video" ref={videoRef} muted playsInline />
          ) : null}

          {/* 输了一半时不报错刷屏：只有输入非空且不合法才说 */}
          {!check.ok && raw.trim().length > 0 && !error ? (
            <p className="own-muted">{check.reason}</p>
          ) : null}
        </>
      ) : (
        <>
          <p className="own-pair-confirm">
            核对一下：这枚码要绑的是车辆 <b>····{issued.vinSuffix}</b>
          </p>
          <p className={expired ? "own-pair-code own-pair-code--dead" : "own-pair-code"}>
            {issued.code}
          </p>
          {expired ? (
            <p className="own-error">这枚码已经过期，输进车机也不会通过。重新取一枚。</p>
          ) : (
            <p className="own-muted">{left} 秒内输进车机屏，过期要重新取。</p>
          )}
          <div className="own-pair-actions">
            <button
              type="button"
              className={expired ? "own-cta" : "own-secondary"}
              disabled={busy}
              onClick={() => {
                setIssued(null);
                setError(null);
              }}
            >
              重新获取
            </button>
          </div>
        </>
      )}

      {error ? <p className="own-error">{error}</p> : null}
    </section>
  );
}
