/**
 * OpenAI 兼容端点客户端（施工单 M6-03，§8.2）。
 *
 * 换云端 / 换本地 Ollama **只改 base URL**（§8.2 表首行）——
 * 这正是选"OpenAI 兼容"而不是绑定某家 SDK 的理由。
 */

export interface OpenAiCompatConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAiCompatClient {
  complete(messages: ChatMessage[]): Promise<string>;
}

export function createOpenAiCompatClient(cfg: OpenAiCompatConfig): OpenAiCompatClient {
  return {
    async complete(messages) {
      const ctrl = new AbortController();
      // 审核层挂着不返回，比它判错更糟——超时是硬要求（§8.2：10s）。
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 10_000);
      try {
        const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: cfg.model, messages, temperature: 0, stream: false }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`审核端点 HTTP ${res.status}`);
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return body.choices?.[0]?.message?.content ?? "";
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
