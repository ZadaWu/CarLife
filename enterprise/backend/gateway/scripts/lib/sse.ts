/**
 * SSE 收流助手（施工单 M49-03 从 `e2e.ts` 搬出来，语义逐字不变）。
 *
 * 搬出来的唯一理由：`e2e-identity.mts` 要验"刷新期间流不断"，需要同一套收流逻辑。
 * 复制一份的话，两边会各自漂移——而"两个 e2e 对 SSE 的理解不一样"这种问题，
 * 表现是其中一条莫名其妙地开始红，没人会往"收流实现分叉了"上查。
 */

import type { EventEnvelope } from "@carlife/shared";

export interface CollectSseOptions {
  /** 断线重连用；不传就是从头收。 */
  lastEventId?: string;
  /** 收够了就停。 */
  until: (all: EventEnvelope[]) => boolean;
  timeoutMs?: number;
  /** 每收到一个封套调一次——刷新那条用例要在流进行中插动作。 */
  onEnvelope?: (e: EventEnvelope, all: EventEnvelope[]) => void;
}

/**
 * 消费 SSE 直到谓词满足或超时，返回收到的封套序列。
 *
 * `authHeaders` 是个函数而不是固定对象：刷新用例会在流进行中换 token，
 * 但**这一条流的 header 在建立时就定了**——正因如此它才能验"换了 token 流也不断"。
 */
export async function collectSse(
  gatewayUrl: string,
  sessionId: string,
  authHeaders: () => Record<string, string>,
  opts: CollectSseOptions,
): Promise<EventEnvelope[]> {
  const url = new URL(`${gatewayUrl}/v1/session/${sessionId}/stream`);
  if (opts.lastEventId) url.searchParams.set("lastEventId", opts.lastEventId);
  const controller = new AbortController();
  const res = await fetch(url, { headers: authHeaders(), signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`stream status=${res.status}`);

  const envelopes: EventEnvelope[] = [];
  let buffer = "";
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const env = JSON.parse(dataLine.slice(6)) as EventEnvelope;
        envelopes.push(env);
        opts.onEnvelope?.(env, envelopes);
      }
      if (opts.until(envelopes) || Date.now() > deadline) {
        controller.abort();
        break;
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  }
  return envelopes;
}

export const hasTurnEnd = (all: EventEnvelope[]): boolean =>
  all.some((e) => e.event.type === "update" && e.event.kind === "turn_end");

export const deltaText = (all: EventEnvelope[]): string =>
  all
    .filter((e) => e.event.type === "update" && e.event.kind === "delta")
    .map((e) => (e.event as { text: string }).text)
    .join("");
