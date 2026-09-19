/**
 * ACR-045 端到端冒烟：端上的框随消息上行，服务端观察层直接用它当第一遍。
 *
 * 在隔离栈（18797 / 18798，不碰开发栈）上：把 `VISION_TRAINER_URL` 指到一个没人听的端口、检测那一遍选 yolo——
 * 这样**任何**向检测器要框的路都会失败；再带 `detections` 发一轮照片。观察层若仍出了 3 项且
 * trace `vision.model.detect === "client"`，就证明框来自端上、服务端没有向检测器要。
 *
 * 用法：set -a; source .env; set +a; node --import tsx scripts/dev/probe/vision-client-boxes.mts
 * 要 DEEPSEEK_API_KEY（第二遍描述）与本机 PG（trace_events）。
 */
import { readFileSync } from "node:fs";

import { GATEWAY, RUNTIME, assertPortsFree, bootStack, killStack, stackEnv, sweepPorts, waitHealthy } from "../../../evals/lib/stack";
import { issueEvalToken } from "../../../evals/lib/auth";
import { uploadAttachment } from "../../../evals/lib/attachments";

const ROOT = new URL("../../../", import.meta.url).pathname;
const PHOTO = `${ROOT}evals/vision-observe/photos/store-01.jpg`;
/** store-01 的人标真值（`cases.jsonl`，存储帧）转到 EXIF 转正后的坐标系——端上 ACR-044 给的就是这一套坐标。 */
const rot = (b: number[]): [number, number, number, number] => [1000 - b[3], b[0], 1000 - b[1], b[2]];
const DETECTIONS = {
  width: 3024,
  height: 4032,
  items: [
    { bbox: rot([169, 658, 191, 692]), name: "low_beam", conf: 0.92 },
    { bbox: rot([215, 660, 238, 696]), name: "auto_high_beam_standby", conf: 0.8 },
    { bbox: rot([261, 664, 277, 701]), name: "parking_lights", conf: 0.95 },
  ],
  inferMs: 310,
};

await assertPortsFree();
const procs = bootStack(
  stackEnv({
    CARLIFE_LLM: "",
    CARLIFE_VISION_DETECT_PROVIDER: "yolo",
    VISION_TRAINER_URL: "http://127.0.0.1:1", // 没人听：向检测器要框必失败
    CARLIFE_VISION_YOLO_MODEL: "probe-none",
    CARLIFE_VISION_DESCRIBE_PROVIDER: "deepseek",
  }),
  process.argv.includes("--verbose"),
);
try {
  await waitHealthy(`${RUNTIME}/internal/health/runtime`, "runtime", 120_000);
  await waitHealthy(`${GATEWAY}/healthz`, "gateway", 60_000);
  const token = issueEvalToken();
  const authed = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...((init.headers as Record<string, string>) ?? {}) } });
  const { sessionId } = (await (await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST", body: "{}" }))).json()) as { sessionId: string };
  const ac = new AbortController();
  let ended = false;
  const stream = (async () => {
    const res = await fetch(`${GATEWAY}/v1/session/${sessionId}/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += Buffer.from(chunk).toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
        buf = buf.slice(i + 2);
        if (!line) continue;
        const env = JSON.parse(line.slice(5));
        if ((env.event ?? env).kind === "turn_end") { ended = true; ac.abort(); return; }
      }
    }
  })().catch((e) => { if (!String(e).includes("abort")) throw e; });
  await new Promise((r) => setTimeout(r, 400));
  const up = await uploadAttachment(GATEWAY, sessionId, PHOTO, authed);
  const res = await fetch(`${GATEWAY}/v1/session/${sessionId}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "这几个灯什么意思", attachments: [up.handle], detections: { [up.handle]: DETECTIONS } }) }));
  if (!res.ok) throw new Error(`messages ${res.status}: ${await res.text()}`);
  await Promise.race([stream, new Promise((r) => setTimeout(r, 180_000))]);
  if (!ended) throw new Error("整轮没有 turn_end");
  await new Promise((r) => setTimeout(r, 2000));
  const { getPrisma } = await import("../../../enterprise/backend/shared/db/src/index");
  const prisma = getPrisma();
  const rows = (await prisma.traceEvent.findMany({ where: { sessionId, kind: "vision" }, orderBy: { at: "asc" } })) as Array<{ data: Record<string, unknown> }>;
  await prisma.$disconnect();
  const v = rows[rows.length - 1]?.data as { model?: { detect?: string }; items?: number; unreadable?: boolean; notes?: string[] } | undefined;
  const ok = v?.model?.detect === "client" && (v.items ?? 0) === 3 && !v.unreadable;
  console.log(JSON.stringify({ ok, sessionId, vision: v && { model: v.model, items: v.items, unreadable: v.unreadable, notes: v.notes } }, null, 1));
  if (!ok) process.exitCode = 1;
} finally {
  killStack(procs);
  await new Promise((r) => setTimeout(r, 1500));
  sweepPorts();
}
