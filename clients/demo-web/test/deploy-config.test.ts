/**
 * [ACR-048/049] 创空间镜像的部署配置。
 *
 * 这个包已经不做对话了（落地页只有两个入口，对话在 /mobile/ 与 /cockpit/ 里），
 * 但 `infra/modelscope/` 那几份 nginx 模板与 entrypoint 仍然由它守着——
 * 它们没有别的归属，而每一条断言背后都是一次真踩过的坑：
 * 平台保留的 Authorization 头、cookie 里不能带空格、envsubst 漏 export 就 emerg。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("[ACR-048] 鉴权头不能用平台保留的名字", () => {
  it("垫片里不出现 authorization 作为请求头——魔搭把它保留给平台自己了", () => {
    // 看守对象是**现在真正发请求的地方**。demo-web 的 api.ts 随对话页一起删了，
    // 规则没过时：带 Authorization 的请求到不了容器，平台边缘直接回 403。
    const src = readFileSync(new URL("../../shared/ui/src/web-shim/gateway.ts", import.meta.url), "utf8");
    const offenders = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
      .filter((l) => /\bauthorization\s*:/i.test(l) && !/AUTH_HEADER/.test(l));
    assert.deepEqual(offenders, [], "带 Authorization 的请求到不了容器，平台直接回 403");
  });
  it("用的是 x-carlife-auth", () => {
    const src = readFileSync(new URL("../../shared/ui/src/web-shim/gateway.ts", import.meta.url), "utf8");
    assert.match(src, /export const AUTH_HEADER = "x-carlife-auth";/);
  });
  it("公共代理片段把合成变量发给网关，否则网关收不到鉴权", () => {
    const common = readFileSync(new URL("../../../infra/modelscope/proxy-common.conf.template", import.meta.url), "utf8");
    assert.match(common, /proxy_set_header\s+Authorization\s+\$carlife_auth;/);
  });
  it("http 上下文里两条通道都有 map：头优先、cookie 兜底，cookie 侧要补 Bearer 前缀", () => {
    const http = readFileSync(new URL("../../../infra/modelscope/http-context.conf.template", import.meta.url), "utf8");
    // 头优先：$carlife_auth 的空值分支落到 cookie 那个变量上
    assert.match(http, /map \$http_x_carlife_auth \$carlife_auth \{[^}]*\$carlife_auth_from_cookie/);
    // cookie 里存的是裸 token（带空格的 "Bearer " 在 cookie 值里非法），前缀在这儿补
    assert.match(http, /\$carlife_auth_from_cookie \{[^}]*"Bearer \$cookie_carlife_auth"/);
  });
  it("语音元数据在头缺席时能用 ?ms= 合成，且 ms 只认纯数字——它要被拼进请求头", () => {
    const http = readFileSync(new URL("../../../infra/modelscope/http-context.conf.template", import.meta.url), "utf8");
    assert.match(http, /map \$arg_ms \$audio_ms \{[^}]*\^\[0-9\]\{1,6\}\$/);
    assert.match(http, /"format":"pcm_s16le","sampleRateHz":16000,"channels":1/);
    assert.match(http, /map \$http_x_audio_meta \$audio_meta \{[^}]*\$audio_meta_synth/);
    const common = readFileSync(new URL("../../../infra/modelscope/proxy-common.conf.template", import.meta.url), "utf8");
    assert.match(common, /proxy_set_header X-Audio-Meta \$audio_meta;/);
  });
  it("entrypoint 不再用 sed 改 nginx 的配置——那条路栽过两次引号", () => {
    const sh = readFileSync(new URL("../../../infra/modelscope/entrypoint.sh", import.meta.url), "utf8");
    const sedLines = sh.split("\n").filter((l) => /sed -i/.test(l) && !l.trimStart().startsWith("#"));
    assert.deepEqual(sedLines.filter((l) => /nginx/.test(l)), [], "nginx 的配置一律走模板文件 + envsubst");
  });
  it("唯一剩下的 sed 是往编好的 JS 里换高德 key 占位符，且 key 先过 32 位十六进制校验——它要被写进 JS 文件", () => {
    const sh = readFileSync(new URL("../../../infra/modelscope/entrypoint.sh", import.meta.url), "utf8");
    const sedLines = sh.split("\n").filter((l) => /sed -i/.test(l) && !l.trimStart().startsWith("#"));
    assert.equal(sedLines.length, 1);
    assert.match(sedLines[0], /__CARLIFE_AMAP_JS_KEY__/);
    assert.match(sh, /grep -Eq '\^\[0-9a-fA-F\]\{32\}\$'/);
  });
  it("cookie 里不做 URL 编码、也不带 Bearer 前缀——编码后 nginx 取到的是编码串，拼出来的头是坏的（实测 401）", () => {
    // 写 cookie 的地方现在是两端的演示入口
    for (const app of ["mobile", "cockpit"]) {
      const src = readFileSync(new URL(`../../${app}/src/web-boot.ts`, import.meta.url), "utf8");
      const line = src.split("\n").find((l) => l.includes("carlife_auth=") && l.includes("token"));
      assert.ok(line, app + " 没找到设置 cookie 的那一行");
      assert.equal(/encodeURIComponent/.test(line!), false, app);
      assert.equal(/Bearer/.test(line!), false, app + "：前缀由 nginx 补，不写进 cookie");
    }
  });
});

describe("[ACR-048] 发消息单独限流", () => {
  const sh = readFileSync(new URL("../../../infra/modelscope/entrypoint.sh", import.meta.url), "utf8");
  const conf = readFileSync(new URL("../../../infra/modelscope/nginx.conf.template", import.meta.url), "utf8");
  it("发消息走自己的 zone，代价与读接口差一个量级", () => {
    const http = readFileSync(new URL("../../../infra/modelscope/http-context.conf.template", import.meta.url), "utf8");
    assert.match(http, /zone=turn:10m rate=\$\{DEMO_TURN_RATE\}/);
    assert.match(conf, /location ~ \^\/v1\/session\/\[\^\/\]\+\/messages\$/);
    assert.match(conf, /limit_req zone=turn/);
  });
  it("envsubst 要替换的变量都得先 export——漏一个就是 nginx 启动即 emerg", () => {
    const exported = /export ([A-Z_ ]+)/.exec(sh)![1].split(/\s+/).filter(Boolean);
    for (const v of ["DEMO_UPSTREAM", "DEMO_RATE", "DEMO_RATE_BURST", "DEMO_TURN_RATE", "DEMO_TURN_BURST", "DEMO_MAX_CONN"]) {
      assert.ok(exported.includes(v), v + " 没 export");
    }
  });
  it("两个 location 都 include 公共片段，SSE 那三行不会只在一条路上漂掉", () => {
    // 发消息与其余 /v1/ 两个 location 都得 include 它（高德代理那段也用，所以总数不止 2）
    // 终点按"缩进两格的右花括号"取：块里有 ${DEMO_TURN_BURST} 这种带花括号的变量，找第一个 } 会提前截断
    const block = (start: string) => conf.slice(conf.indexOf(start), conf.indexOf("\n  }", conf.indexOf(start)));
    for (const loc of ["location ~ ^/v1/session/[^/]+/messages$", "location /v1/ {"]) {
      assert.match(block(loc), /include \/etc\/nginx\/snippets\/proxy-common\.conf;/, loc);
    }
    const common = readFileSync(new URL("../../../infra/modelscope/proxy-common.conf.template", import.meta.url), "utf8");
    assert.match(common, /proxy_buffering off;/);
    assert.match(common, /chunked_transfer_encoding on;/);
    assert.match(common, /proxy_read_timeout 300s;/);
  });
});

describe("[ACR-049] 两端外框不把自己的深色摊给里面那层", () => {
  const frame = (name: string) => readFileSync(new URL("../public/" + name, import.meta.url), "utf8");

  /*
   * 2026-09-20 魔搭上的表现：手机端白卡上印近白字、底导变深海军蓝。
   * 链路是——外框自己是深色的，而 `color-scheme` 是继承属性，iframe 把它带进被嵌文档，
   * 里面那层的 `prefers-color-scheme` 于是报深色；手机端的主题跟随它，
   * 可它的深色只刷了一半（`--hud-*` 有深色值，`--m-card-bg` 一类面 token 没有）。
   * 演示面的对策是把主题钉死，不让外框的明暗渗进去。真正的半套深色是另一件事。
   */
  for (const [name, path] of [["手机端", "phone.html"], ["车机端", "pad.html"]] as const) {
    it(name + "外框把被嵌界面的主题钉成浅色", () => {
      assert.match(frame(path), /<iframe src="[a-z]+\/\?theme=light"/, path + " 的 iframe 少了 ?theme=light");
    });
    it(name + "外框在 iframe 边界上截断色彩方案的继承", () => {
      assert.match(frame(path), /iframe \{[^}]*color-scheme: light;/, path + " 的 iframe 规则少了 color-scheme");
    });
  }

  it("钉的这个参数名正是手机端读的那个——改名就得两头一起改", () => {
    const theme = readFileSync(new URL("../../mobile/src/app/theme.ts", import.meta.url), "utf8");
    assert.match(theme, /new URLSearchParams\(search\)\.get\("theme"\)/);
    assert.match(theme, /if \(q === "dark" \|\| q === "light"\) return q;/);
  });
});
