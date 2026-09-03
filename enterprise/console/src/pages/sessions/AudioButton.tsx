/**
 * 会话试听按钮（M60-02）。
 *
 * # 两种音频，措辞必须分开
 *
 * 车主那句是**端上真录进来的波形**（建轮时转存），点了就是当时的声音。
 * 助手那句服务端手里没有——合成发生在端上（豆包档直连火山），所以第一次点
 * 是**按当时下发的档位重新合成一遍**，之后才是取存下来的那份。
 * 按钮的文案与 title 据此区分：把补合成的说成"当时播的那段"是把一个
 * 不知道的事说成知道，与给模拟数据打真实标签是同一类错。
 *
 * # 为什么不是 `<audio controls src=…>`
 *
 * 后台接口要带 Authorization 头，`<audio src>` 带不了。所以先取 Blob
 * 再转 objectURL；组件卸载与重取时都要 revoke，不然一页听下来内存里
 * 攒着一堆音频。
 */

import { useEffect, useRef, useState, type JSX } from "react";

import { api, ApiError } from "../../api";

export type AudioKind = "asr" | "tts";

const ERROR_LABEL: Record<string, string> = {
  audio_not_stored: "这段录音没有存下来（早于试听功能上线）",
  message_not_found: "消息不存在",
  empty_content: "这条没有可合成的文本",
  config_unavailable: "配置层读不到，稍后再试",
  tts_quota_exceeded: "今日合成字符已达上界",
  synthesis_failed: "合成失败",
  audit_unavailable: "审计写入失败，已拒绝放行",
};

export function AudioButton({
  messageId,
  kind,
  stored,
}: {
  messageId: string;
  kind: AudioKind;
  /** 服务端已经存过这段音频——没存过的助手消息点下去会先合成，要多等几秒。 */
  stored: boolean;
}): JSX.Element {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  // 卸载时收干净：停播 + 释放 objectURL。
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const play = async (): Promise<void> => {
    if (state === "playing") {
      audioRef.current?.pause();
      setState("idle");
      return;
    }
    setError(null);
    // 已经取过就直接重放，不再打一次接口（也不再写一条审计）。
    if (urlRef.current && audioRef.current) {
      void audioRef.current.play();
      setState("playing");
      return;
    }
    setState("loading");
    try {
      const { blob } = await api.blob(`/console/messages/${messageId}/audio`);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const el = new Audio(url);
      el.onended = () => setState("idle");
      el.onerror = () => {
        setError("这段音频浏览器放不出来");
        setState("error");
      };
      audioRef.current = el;
      await el.play();
      setState("playing");
    } catch (e) {
      const code = e instanceof ApiError ? e.code : String(e);
      setError(
        (ERROR_LABEL[code] ?? code) +
          (e instanceof ApiError && e.message && e.message !== code ? `：${e.message}` : ""),
      );
      setState("error");
    }
  };

  const label =
    state === "loading" ? (stored || kind === "asr" ? "载入中…" : "合成中…") : state === "playing" ? "⏸ 停止" : "▶ 试听";
  const title =
    kind === "asr"
      ? "车主当时的原始录音"
      : stored
        ? "已存下的合成音（按当时下发的档位补合成，非端上播出的原始字节）"
        : "服务端没有端上播出的音频，点击按当时下发的档位补合成一次并存下来";

  return (
    <>
      <button
        type="button"
        className="ss-audio-btn"
        onClick={() => void play()}
        disabled={state === "loading"}
        title={title}
      >
        {label}
      </button>
      {error ? <span className="ss-audio-err">{error}</span> : null}
    </>
  );
}
