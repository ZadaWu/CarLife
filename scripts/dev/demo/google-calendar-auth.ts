/**
 * Google 日历一次性授权（施工单 M43-02，人工步骤——拿 refresh token）。
 *
 * 前置（人工，见 内部文档）：
 *   1. console.cloud.google.com 建项目 → 启用 Google Calendar API；
 *   2. OAuth 同意屏（External + 测试用户加自己的账号）；
 *   3. 创建 OAuth 客户端（桌面应用或 Web，重定向 URI 填 http://localhost:8123/callback）；
 *   4. 把 client id/secret 填进 .env 后跑本脚本：
 *
 *      corepack pnpm --silent tsx scripts/dev/demo/google-calendar-auth.ts
 *
 * 脚本起本机回调收 code，换出 refresh token **只打印一次**并提示写入 .env
 * （不代写——密钥进 .env 是显式动作）。
 */

import { createServer } from "node:http";

const CLIENT_ID = (process.env.GOOGLE_CAL_CLIENT_ID ?? "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CAL_CLIENT_SECRET ?? "").trim();
const PORT = 8123;
const REDIRECT = `http://localhost:${PORT}/callback`;

async function main(): Promise<void> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("缺 GOOGLE_CAL_CLIENT_ID / GOOGLE_CAL_CLIENT_SECRET（先在 Google Cloud 建 OAuth 客户端，见脚本头）");
    process.exit(1);
  }

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
      access_type: "offline",
      prompt: "consent", // 每次都发新 refresh token——不带它，二次授权拿不到
    }).toString();

  console.log("在浏览器打开并完成授权：\n\n" + authUrl + "\n\n等待回调……");

  const code = await new Promise<string>((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const c = u.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(c ? "<h3>授权完成，回终端看结果。</h3>" : "<h3>没拿到 code，重试。</h3>");
      srv.close();
      c ? resolve(c) : reject(new Error(`回调无 code：${u.search}`));
    });
    srv.listen(PORT);
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) {
    console.error(`换 token 失败（${res.status}）：${body.error ?? ""} ${body.error_description ?? ""}`);
    console.error("常见原因：OAuth 客户端类型/重定向 URI 不匹配，或该账号已授权过（去 myaccount.google.com/permissions 撤销后重跑）");
    process.exit(1);
  }

  console.log("\n拿到 refresh token（只打印这一次，自己写进 .env）：\n");
  console.log(`GOOGLE_CAL_REFRESH_TOKEN="${body.refresh_token}"`);
  console.log(`GOOGLE_CAL_CALENDAR_ID="<你的 Google 账号邮箱（主日历）>"`);
  console.log(`CARLIFE_CALENDAR_BACKEND=google  # 或 both`);
}

main().catch((err) => {
  console.error("授权失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
