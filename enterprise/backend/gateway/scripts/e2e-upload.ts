/**
 * 多模态上传端到端（施工单 M8-04）。**真 MinIO + 真 PG**。
 *
 * 验的是通路本身，不是策略——策略在 `test/upload.test.ts` 里已经断言过。
 * 这里要证明的是：文件真的进了对象存储、句柄真的能取回原件、
 * 别人的句柄真的取不到、弱网重传真的不产生第二条记录。
 *
 * 运行（根目录，需 PG + MinIO）：
 *   corepack pnpm e2e:upload
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { assertPortsFree, shutdownSpawned } from "./lib/ports";
import { ensureDevCredentials, login } from "./lib/login";
import { PrismaClient, resolveTestDatabaseUrl } from "@carlife/db";

const GATEWAY = "http://localhost:18797";
// M48-02：demo-token 万能钥匙已删除，改为跑前登录换 token（见 lib/login.ts）。
let TOKEN = "";

function loadDotEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(
      new URL("../../../../.env", import.meta.url),
      "utf8",
    ).split("\n")) {
      const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

const ENV = {
  // M48-02：JWT 签名密钥没有默认值（默认密钥等于没有鉴权），端到端也必须显式给。
  CARLIFE_JWT_SECRET: "e2e-jwt-secret-0123456789abcdef",
  ...process.env,
  ...loadDotEnv(),
  CARLIFE_LLM: "fake",
  ASR_ENGINE: "fake",
  DATABASE_URL: resolveTestDatabaseUrl(),
  S3_ENDPOINT: "http://localhost:59000",
  S3_ACCESS_KEY_ID: "carlife",
  S3_SECRET_ACCESS_KEY: "carlife-secret",
  S3_BUCKET: "carlife-attachments-e2e",
  GATEWAY_PORT: "18797",
  AGENT_RUNTIME_PORT: "18798",
  AGENT_RUNTIME_URL: "http://localhost:18798",
};

const checks: Array<[boolean, string]> = [];
const check = (ok: boolean, label: string) => {
  checks.push([ok, label]);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
};

const authed = (init: RequestInit = {}, token = TOKEN): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
});

/** 一张最小的合法 PNG（1x1 透明）。内容不重要——网关本来就不解析。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function main(): Promise<void> {
  // spawn 之前先探端口（M46-01）：不检查的话，端口被占时本轮进程起不来，
  // 请求却会落到上一轮残留的进程上，报出看起来像业务故障的假错误。
  await assertPortsFree([
    [Number(ENV.GATEWAY_PORT), "gateway"],
    [Number(ENV.AGENT_RUNTIME_PORT), "agent-runtime"],
  ]);

  const gateway = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("../", import.meta.url).pathname,
    env: ENV,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true, // 杀得掉整组（M46-02）：npx 壳→tsx→node 三层，kill 只打到壳
  });

  try {
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${GATEWAY}/healthz`).catch(() => null)) break;
      await sleep(500);
    }
    await sleep(1500);

    // M48-02：先把测试库的开发账号解锁，再登录换 token（demo-token 已删除）。
    await ensureDevCredentials(ENV.DATABASE_URL);
    TOKEN = (await login(GATEWAY)).accessToken;

    const { sessionId } = (await (
      await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST" }))
    ).json()) as { sessionId: string };

    // ── 1. 上传一张图片 ────────────────────────────────────
    const idem = `e2e-${Date.now()}`;
    const up = await fetch(
      `${GATEWAY}/v1/session/${sessionId}/attachments`,
      authed({
        method: "POST",
        headers: {
          "content-type": "image/png",
          // 中文文件名必须 percent-encode：HTTP 头是 ByteString，直接塞会在客户端就抛。
          "x-filename": encodeURIComponent("故障灯.png"),
          "x-turn-id": "turn-e2e",
          "x-idempotency-key": idem,
        },
        body: PNG,
      }),
    );
    const created = (await up.json()) as {
      handle?: string;
      kind?: string;
      bytes?: number;
    };
    check(
      up.status === 201 && !!created.handle,
      `上传成功（201，句柄 ${created.handle?.slice(0, 8)}…）`,
    );
    check(
      created.kind === "image" && created.bytes === PNG.length,
      "类型与大小如实回报",
    );

    const meta = (await (
      await fetch(`${GATEWAY}/v1/session/${sessionId}/attachments`, authed())
    ).json()) as { attachments?: Array<{ filename?: string }> };
    check(
      meta.attachments?.[0]?.filename === "故障灯.png",
      "**中文文件名往返正确**——头里走 percent-encoding，服务端解回来",
    );

    // ── 2. 凭句柄取回原件，**逐字节相同** ──────────────────
    const got = await fetch(
      `${GATEWAY}/v1/attachments/${created.handle}`,
      authed(),
    );
    const back = Buffer.from(await got.arrayBuffer());
    check(
      got.status === 200 && back.equals(PNG),
      "凭句柄取回的字节与上传的完全一致",
    );
    check(
      got.headers.get("content-disposition") === "attachment",
      "**一律作为附件下载**——内联渲染用户上传的内容会变成 XSS",
    );

    // ── 3. 幂等：弱网重传不产生第二条 ──────────────────────
    const again = await fetch(
      `${GATEWAY}/v1/session/${sessionId}/attachments`,
      authed({
        method: "POST",
        headers: { "content-type": "image/png", "x-idempotency-key": idem },
        body: PNG,
      }),
    );
    const dup = (await again.json()) as { handle?: string; deduped?: boolean };
    check(
      dup.handle === created.handle && dup.deduped === true,
      "**同一幂等键重传返回原句柄**——端上因此可以放心重试（F-09-05）",
    );

    // ── 4. 附件与本轮绑定 ─────────────────────────────────
    const listed = (await (
      await fetch(
        `${GATEWAY}/v1/session/${sessionId}/attachments?turnId=turn-e2e`,
        authed(),
      )
    ).json()) as { attachments?: Array<{ id: string }> };
    check(
      listed.attachments?.length === 1,
      "按 turnId 查得到本轮附件（F-09-06 绑定）",
    );

    // ── 5. 视频：拒绝 + 给替代方案 ────────────────────────
    const video = await fetch(
      `${GATEWAY}/v1/session/${sessionId}/attachments`,
      authed({
        method: "POST",
        headers: { "content-type": "video/mp4" },
        body: Buffer.from("fake"),
      }),
    );
    const vjson = (await video.json()) as { error?: string; reason?: string };
    check(
      video.status === 415 && vjson.error === "video_unsupported",
      "视频被拒且单独归类，不是笼统的「格式不支持」",
    );
    check(
      /照片/.test(vjson.reason ?? "") && /语音|声音/.test(vjson.reason ?? ""),
      "**引导「拍照片 + 语音描述声音」**——用户会本能拍视频",
    );

    // ── 6. 安全：不存在的句柄、别人的句柄 ──────────────────
    const bogus = await fetch(
      `${GATEWAY}/v1/attachments/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      authed(),
    );
    check(bogus.status === 404, "猜出来的句柄取不到东西");

    // 造一条属于**别人**的附件，再用当前用户的合法 token 去取。
    // 不用"换一个账号登录"来构造：那验的是鉴权，不是归属校验——两码事。
    // 直接在库里造一条属于别人的记录，再用**当前用户的合法 token** 去取。
    const prisma = new PrismaClient({
      datasources: { db: { url: ENV.DATABASE_URL } },
    });
    const stolen = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    await prisma.attachment.create({
      data: {
        id: stolen,
        sessionId,
        userId: "somebody-else",
        kind: "image",
        contentType: "image/png",
        bytes: PNG.length,
        objectKey: `image/${stolen}`,
      },
    });
    const other = await fetch(`${GATEWAY}/v1/attachments/${stolen}`, authed());
    await prisma.attachment
      .delete({ where: { id: stolen } })
      .catch(() => undefined);
    await prisma.$disconnect();
    check(
      other.status === 404,
      "**别人的句柄拿到手也取不到**，且与「不存在」同为 404——区分二者就等于确认句柄存在",
    );

    // ── 7. 红线：网关不解析文件内容 ───────────────────────
    // **先剥注释再扫**：第一版没剥，结果命中了 storage.ts 里
    // "不读 EXIF" 这句说明自己——检查在扫自己的红线声明。
    const stripComments = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const src =
      stripComments(
        readFileSync(
          new URL("../src/upload/index.ts", import.meta.url),
          "utf8",
        ),
      ) +
      stripComments(
        readFileSync(
          new URL("../src/upload/storage.ts", import.meta.url),
          "utf8",
        ),
      );
    const parsing = /sharp|jimp|pdf-parse|exif|jpeg-js|png-js|ffmpeg/i.exec(
      src,
    );
    check(
      parsing === null,
      `网关代码中无文件解析逻辑（AC-09-8）${parsing ? `，命中 ${parsing[0]}` : ""}`,
    );
  } finally {
    await shutdownSpawned(
      [gateway],
      [Number(ENV.GATEWAY_PORT), Number(ENV.AGENT_RUNTIME_PORT)],
    );
  }

  const failed = checks.filter(([ok]) => !ok).length;
  console.log(
    `\n上传端到端：${checks.length - failed} passed, ${failed} failed`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
