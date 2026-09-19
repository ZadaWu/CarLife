/**
 * [F-09-07] 附件句柄按会话归属，发消息时不能换会话（2026-09-18 真机 INC）。
 *
 * 现场：拍照问诊里拍一张，屏幕上弹「上传失败 rejected: status=400
 * body={"error":"attachment_not_owned","handle":"U1gNHnV3…"}」。dev 库对得上——
 * 句柄落在 `sess-82141ba8`（02:23:36.431），18 ms 后端上又建了 `sess-a911010f` 并把消息发去那里。
 *
 * 根因是 `ensureUsableSession` 的退休判定读的是闭包里那一拍的 `lastInteractionAt`：
 * 上传那一步刚把会话换新（`setLastInteractionAt(undefined)`），发消息那一步却还看着旧值，
 * 于是"又该退休了"，再建一个。两道闸各守一半——判定读 ref、带附件时把会话钉住。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { createAttachmentSessions } from "../src/data/attachmentSessions";
import { explainAttachmentFailure } from "../src/data/attachmentFailure";

const APP = readFileSync(new URL("../src/app/index.tsx", import.meta.url), "utf8");

describe("[F-09-07][AC-9-1] 句柄 → 会话的账本", () => {
  it("上传进哪段会话，就钉在哪段", () => {
    const s = createAttachmentSessions();
    s.remember("h1", "sess-a");
    assert.equal(s.sessionFor(["h1"]), "sess-a");
  });

  it("一组句柄不在同一段会话时不钉——宁可让网关拒，也不把另一半悄悄丢掉", () => {
    const s = createAttachmentSessions();
    s.remember("h1", "sess-a");
    s.remember("h2", "sess-b");
    assert.equal(s.sessionFor(["h1", "h2"]), undefined);
  });

  it("不认识的句柄、空数组、undefined 都不钉", () => {
    const s = createAttachmentSessions();
    s.remember("h1", "sess-a");
    assert.equal(s.sessionFor(["h1", "unknown"]), undefined);
    assert.equal(s.sessionFor([]), undefined);
    assert.equal(s.sessionFor(undefined), undefined);
  });

  it("超出上限先淘汰最老的；重记同一个句柄要挪到队尾，不能被当成最老的淘汰掉", () => {
    const s = createAttachmentSessions(2);
    s.remember("h1", "sess-a");
    s.remember("h2", "sess-a");
    s.remember("h1", "sess-b"); // 重记 → h1 变成最新
    s.remember("h3", "sess-c"); // 淘汰的应该是 h2
    assert.equal(s.sessionFor(["h1"]), "sess-b");
    assert.equal(s.sessionFor(["h3"]), "sess-c");
    assert.equal(s.sessionFor(["h2"]), undefined);
  });
});

describe("[F-09-07][AC-9-1] 退休判定不读那一拍的 state", () => {
  it("canRetire 的 lastInteractionAt 来自 ref；ensureUsableSession 的 deps 里没有它", () => {
    const ensure = APP.slice(APP.indexOf("const ensureUsableSession"), APP.indexOf("const endCurrentSession"));
    assert.ok(ensure.includes("lastInteractionAt: lastInteractionRef.current"), "退休判定必须读 ref");
    const deps = ensure.slice(ensure.lastIndexOf("}, ["));
    assert.ok(!/\blastInteractionAt\b/.test(deps), "deps 里再出现 lastInteractionAt 就说明又捕回了 state");
  });

  it("setLastInteractionAt 同时写 ref 与 state——只写一边就等于没修", () => {
    assert.ok(/setLastInteractionAt = useCallback\([\s\S]*?lastInteractionRef\.current = ts;[\s\S]*?setLastInteractionAtState\(ts\)/.test(APP));
  });

  it("刚上传附件的那段会话必须原样返回，不进退休判定", () => {
    assert.ok(/if \(opts\?\.keep && opts\.keep === sid\) return sid;/.test(APP));
  });
});

describe("[F-09-07][AC-9-1] 发消息时把会话钉在上传的那一段", () => {
  it("upload 成功即记账，sendText 用这组句柄取 keep", () => {
    assert.ok(APP.includes("attachmentSessions.remember(r.handle, sessionId)"), "上传成功要记一笔");
    assert.ok(
      APP.includes("ensureUsableSession({ keep: attachmentSessions.sessionFor(attachments) })"),
      "发消息要带上 keep，否则退休判定仍可能换掉会话",
    );
  });
});

describe("[F-20-15] 失败提示说人话", () => {
  it("认得出的错误码换成下一步动作，不把 JSON 怼给车主", () => {
    const text = explainAttachmentFailure('rejected: status=400 body={"error":"attachment_not_owned","handle":"U1gN"}');
    assert.equal(text, "这张照片和当前对话对不上了，重拍一张就好");
    assert.ok(!text.includes("status=400"));
  });

  it("认不出的原样留着——排查还得靠它", () => {
    assert.equal(explainAttachmentFailure("network timeout"), "network timeout");
  });
});
